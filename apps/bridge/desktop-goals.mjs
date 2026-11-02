import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { withDesktopUi } from './desktop-ui-coordinator.mjs';

const helperPath = fileURLToPath(new URL('./windows-goals.ps1', import.meta.url));
const phases = new Set(['initialize', 'navigation', 'activate-window', 'select-main-thread', 'wait-goal-ui', 'read-composer', 'open-goal-menu', 'select-goal-mode', 'await-commit', 'fill-objective', 'submit-goal', 'confirm-replacement']);
const actions = new Set(['create', 'edit', 'pause', 'resume', 'clear']);

// 原生错误只映射固定代码和中文提示，不把界面文字或目标正文透传到手机及账本。
const uiErrors = new Map([
  ['GOAL_UI_CHANGED', '电脑目标内容已变化，请刷新目标后重试'],
  ['GOAL_DESKTOP_DRAFT', '电脑输入框已有草稿或附件，请先处理后再操作目标'],
  ['GOAL_UI_SIDECHAT_ACTIVE', '电脑仍停在侧边聊天，未能切回主会话，请在电脑打开主会话后重试'],
  ['GOAL_UI_LAYOUT_LOADING', '电脑主会话的目标栏尚未加载完成，请稍后重试'],
  ['GOAL_UI_THREAD_CHANGED', '电脑当前会话已变化，已停止目标操作，请重新打开该会话后重试'],
  ['GOAL_UI_FOREGROUND_CHANGED', '电脑前台窗口已切换，已停止目标操作，请稍后重试'],
  ['GOAL_UI_TAB_UNSUPPORTED', '此电脑版本暂不支持主会话标签校验，请在电脑管理目标'],
]);

/** 提交后的任何失败都保留待核对状态，不能根据错误代码自动重放。 */
function nativeError(message, committed) {
  const known = uiErrors.has(message.code);
  const unknown = committed || message.outcomeUnknown === true;
  const hint = unknown ? '目标操作结果需要核对，请勿重复操作' : known ? uiErrors.get(message.code) : '电脑目标界面已变化或暂不可用，请刷新后重试';
  return new BridgeError(known ? message.code : 'GOAL_UI_UNAVAILABLE', hint, unknown);
}

/** 只启动项目固定的原生目标帮助程序；手机不能传入脚本、控件、路径或任意命令。 */
export class DesktopGoalController {
  constructor({ platform = process.platform, launch = spawn, executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), diagnosticPath = null } = {}) {
    this.launch = launch; this.executable = executable; this.diagnosticPath = diagnosticPath;
    this.available = platform === 'win32' && fs.existsSync(executable) && fs.existsSync(helperPath);
  }

  /** 只记录固定阶段、代码和请求编号；诊断写入失败不能改变原操作结果。 */
  record(params, stage, message = {}) {
    if (!this.diagnosticPath) return;
    const entry = { at: new Date().toISOString(), commandId: /^[a-zA-Z0-9-]{16,80}$/.test(params.commandId ?? '') ? params.commandId : '', action: actions.has(params.action) ? params.action : '', stage,
      phase: phases.has(message.phase) ? message.phase : '', code: /^GOAL_[A-Z_]{1,60}$/.test(message.code ?? '') ? message.code : '',
      errorKind: /^[A-Za-z]{1,80}$/.test(message.errorKind ?? '') ? message.errorKind : '', outcomeUnknown: message.outcomeUnknown === true };
    try { fs.appendFileSync(this.diagnosticPath, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch {}
  }

  perform(params, beforeCommit) {
    if (!this.available) throw new BridgeError('GOAL_CONTROL_UNAVAILABLE', '此电脑暂不支持目标操作，请使用 Windows 桌面连接服务');
    return withDesktopUi(() => this.run(params, beforeCommit));
  }

  run(params, beforeCommit) {
    if (Date.now() >= params.deadline) throw new BridgeError('GOAL_UI_BUSY', '电脑界面正忙，请稍后重试');
    return new Promise((resolve, reject) => {
      const child = this.launch(this.executable, ['-NoProfile', '-NonInteractive', '-STA', '-File', helperPath], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8'); let buffer = '', committed = false, settled = false, verifying = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.stdin.end(); child.kill();
        this.record(params, error ? 'failed' : 'completed', error ?? {});
        if (error) reject(error); else resolve();
      };
      const lost = () => finish(new BridgeError('GOAL_UI_CONNECTION_LOST', committed ? '目标操作结果需要核对，请勿重复操作' : '电脑目标界面暂不可用，请稍后重试', committed));
      const timer = setTimeout(() => finish(new BridgeError('GOAL_UI_TIMEOUT', committed ? '目标操作结果需要核对，请勿重复操作' : '电脑目标界面未就绪，请稍后重试', committed)), Math.max(1, params.deadline - Date.now() - 1000));
      child.on('error', lost); child.on('exit', lost); child.stdin.on('error', lost);
      child.stderr.on('data', () => {});
      child.stdout.on('data', data => {
        buffer += decoder.write(data);
        if (buffer.length > 65536) return lost();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message; try { message = JSON.parse(line); } catch { lost(); return; }
          if (['ready', 'done', 'error'].includes(message.stage)) this.record(params, message.stage, message);
          if (message.stage === 'ready' && !verifying) {
            verifying = true;
            Promise.resolve().then(beforeCommit).then(() => {
              if (settled) return;
              committed = true; child.stdin.write(JSON.stringify({ commit: true }) + '\n');
            }, error => finish(error));
          } else if (message.stage === 'done' && committed) finish();
          else if (message.stage === 'error') finish(nativeError(message, committed));
        }
      });
      // 正文只走进程标准输入，不进入命令行或日志。
      child.stdin.write(JSON.stringify(params) + '\n');
    });
  }
}
