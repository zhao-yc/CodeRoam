import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { discoverPredictionPorts } from './composer-prediction.mjs';
import { deletionExpression } from './deletion-expression.mjs';
import { withDesktopUi } from './desktop-ui-coordinator.mjs';

const helper = fileURLToPath(new URL('./windows-delete-menu.ps1', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 每次删除独立连接已验证的原桌面页面，断线后不重连、不重放交互。 */
class DeletionPage {
  constructor(url) { this.url = url; this.pending = new Map(); this.sequence = 0; }
  /** 只连接调用方已校验的本机页面，连接失效后由上层保留未知结果。 */
  async connect() {
    this.socket = new WebSocket(this.url, { handshakeTimeout: 2000, maxPayload: 256 * 1024, perMessageDeflate: false });
    this.socket.on('message', data => {
      let message; try { message = JSON.parse(data); } catch { this.close(); return; }
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error || message.result?.exceptionDetails) entry.reject(new Error('删除页面交互失败'));
      else entry.resolve(message.result);
    });
    this.socket.on('error', () => this.close()); this.socket.on('close', () => this.close());
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    return this;
  }
  /** 调试帧仅供固定交互步骤调用，手机协议不开放浏览器命令。 */
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) { reject(new Error('原桌面页面已断开')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('删除页面响应超时')); this.close(); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  /** 只有固定侧栏定位步骤能够产生右键坐标，手机不能传入坐标或浏览器命令。 */
  async step(phase, params) {
    if (phase === 'focus') { await this.request('Page.bringToFront', {}); return { state: 'focused' }; }
    const response = await this.request('Runtime.evaluate', { expression: deletionExpression(phase, params.hostId, params.threadId, params.commandId), returnByValue: true, timeout: 1500 });
    const result = response?.result?.value;
    if (phase !== 'open' || result?.state !== 'ready') return result;
    if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new Error('菜单位置无效');
    await this.request('Input.dispatchMouseEvent', { type: 'mousePressed', x: result.x, y: result.y, button: 'right', buttons: 2, clickCount: 1 });
    await this.request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: result.x, y: result.y, button: 'right', buttons: 0, clickCount: 1 });
    return { state: 'opened' };
  }
  /** 清理本次连接并拒绝全部在途响应，不能复用迟到帧。 */
  close() {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('原桌面页面已断开')); }
    this.pending.clear(); this.socket?.terminate();
  }
}

/** 先打开原生删除弹窗，校验其实际会话编号，再提交原桌面的永久删除。 */
export class DesktopDeleteController {
  constructor({ platform = process.platform, discover = discoverPredictionPorts, fetcher = fetch, launch = spawn, openPage = async url => new DeletionPage(url).connect(), diagnostic = () => {}, diagnosticPath = null } = {}) {
    this.platform = platform; this.discover = discover; this.fetcher = fetcher; this.launch = launch; this.openPage = openPage; this.diagnostic = diagnostic; this.diagnosticPath = diagnosticPath;
  }
  /** 仅保存固定阶段、计数及错误码；不记录标题、正文、令牌或页面内容。 */
  record(params, state) {
    try { this.diagnostic(state); } catch {}
    if (!this.diagnosticPath) return;
    const entry = { at: new Date().toISOString(), commandId: /^[a-zA-Z0-9-]{8,160}$/.test(params.commandId ?? '') ? params.commandId : '', phase: state.phase };
    for (const key of ['target', 'dialog', 'matched', 'ready', 'committed', 'selected']) if (typeof state[key] === 'boolean') entry[key] = state[key];
    for (const key of ['targetCount', 'visibleCount', 'aliasCount', 'pageCount', 'candidateCount']) if (Number.isInteger(state[key]) && state[key] >= 0) entry[key] = Math.min(10000, state[key]);
    if (/^DELETE_[A-Z_]{1,60}$/.test(state.code ?? '')) entry.code = state.code;
    try { fs.appendFileSync(this.diagnosticPath, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch {}
  }
  delete(params, beforeCommit) { return withDesktopUi(() => this.run(params, beforeCommit)); }
  /** 菜单选择只打开确认框，帮助进程不能直接提交删除，也不能接收任意命令。 */
  selectMenu(processId, deadline, action = 'select', params = {}) {
    return new Promise((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const child = this.launch(executable, ['-NoProfile', '-NonInteractive', '-STA', '-File', helper], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', done = false;
      const finish = success => { if (done) return; done = true; clearTimeout(timer); child.kill(); success ? resolve() : reject(new BridgeError(action === 'activate' ? 'DELETE_WINDOW_UNAVAILABLE' : 'DELETE_MENU_UNAVAILABLE', action === 'activate' ? '无法激活原桌面窗口，请稍后重试' : '原桌面永久删除菜单不可用，请确认目标对话在列表中')); };
      const timer = setTimeout(() => finish(false), Math.max(1, Math.min(7000, deadline - Date.now())));
      child.on('error', () => finish(false)); child.on('exit', () => finish(false)); child.stdin.on('error', () => finish(false)); child.stderr.on('data', () => {});
      child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.length > 4096) return finish(false); if (output.includes('\n')) { try { const result=JSON.parse(output.trim());this.record(params,{phase:'menu-'+action,selected:result.selected===true});finish(result.selected === true); } catch { finish(false); } } });
      child.stdin.end(JSON.stringify({ processId, deadline, action }) + '\n');
    });
  }
  async run(params, beforeCommit) {
    if (this.platform !== 'win32' || params.hostId !== 'local' || !params.native) throw new BridgeError('DELETE_UNSUPPORTED', '此电脑暂不支持手机永久删除，请使用 Windows 原桌面');
    let page, committed = false;
    const pages = [];
    try {
      await params.native.navigate(params.threadId);
      const ports = (await this.discover()).filter(port => port.pid === params.native.processId);
      if (ports.length !== 1) throw new BridgeError('DELETE_UNSUPPORTED', '未找到已验证的原桌面页面，请确认桌面连接服务已更新');
      const port = ports[0];
      const response = await this.fetcher('http://127.0.0.1:' + port.port + '/json/list', { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!response.ok) throw new Error();
      const body = await response.text(); if (body.length > 256 * 1024) throw new Error();
      const targets = JSON.parse(body).filter(target => target.type === 'page' && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(target.url) && /^[a-zA-Z0-9-]{1,100}$/.test(target.id));
      // 原桌面导航只改变一个窗口；只在包含已核对正式编号的侧栏行的唯一页面打开菜单。
      for (const target of targets) {
        const candidate = await this.openPage('ws://127.0.0.1:' + port.port + '/devtools/page/' + target.id);
        pages.push(candidate);
      }
      let candidates = [];
      const locateUntil = Math.min(params.deadline - 1000, Date.now() + 8000);
      do {
        candidates = [];
        for (const candidate of pages) { const state = await candidate.step('inspect', params); this.record(params, { phase: 'locate', ...state }); if (state.target === true) candidates.push(candidate); }
        if (candidates.length === 1) break;
        if (candidates.length > 1) break;
        await pause(150);
      } while (Date.now() < locateUntil);
      this.record(params, { phase: 'located', pageCount: pages.length, candidateCount: candidates.length });
      if (candidates.length !== 1) { candidates.forEach(candidate => candidate.close()); throw new BridgeError('DELETE_TARGET_UNAVAILABLE', candidates.length > 1 ? '原桌面多个窗口包含该对话，请关闭重复窗口后重试' : '原桌面尚未显示目标对话，请展开对应项目后重试'); }
      page = candidates[0];
      await page.step('focus', params);
      await this.selectMenu(port.pid, params.deadline, 'activate', params);
      if ((await page.step('open', params))?.state !== 'opened') throw new BridgeError('DELETE_TARGET_CHANGED', '原桌面目标已变化，尚未删除对话');
      this.record(params, { phase: 'opened', ...await page.step('inspect', params) });
      await this.selectMenu(port.pid, params.deadline, 'select', params);
      let state;
      const waitUntil = Math.min(params.deadline - 1000, Date.now() + 5000);
      do { state = await page.step('inspect', params); if (state.matched && state.ready) break; await pause(100); } while (Date.now() < waitUntil);
      if (!state?.matched || !state.ready) throw new BridgeError('DELETE_TARGET_CHANGED', '无法核对原生删除弹窗的会话编号，尚未删除对话');
      await beforeCommit(); committed = true;
      if ((await page.step('commit', params))?.state !== 'submitted') throw new BridgeError('DELETE_OUTCOME_UNKNOWN', '删除目标已变化，请核对原操作结果', true);
      do {
        state = await page.step('inspect', params);
        if (!state.dialog) { this.record(params, { phase: 'completed', committed }); return; }
        await pause(150);
      } while (Date.now() < params.deadline - 500);
      throw new BridgeError('DELETE_OUTCOME_UNKNOWN', '原桌面尚未确认删除完成，请核对原操作结果', true);
    } catch (error) {
      this.record(params, { phase: 'failed', code: error.code, committed });
      if (committed) throw new BridgeError('DELETE_OUTCOME_UNKNOWN', '永久删除结果需要核对，请勿重复提交', true);
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('DELETE_UNAVAILABLE', '原桌面删除连接未就绪，尚未删除对话');
    } finally { if (page) await page.step('cancel', params).catch(() => {}); pages.forEach(candidate => candidate.close()); }
  }
}
