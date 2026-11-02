import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

/** 只使用本机配置或已安装桌面附带的 CLI，手机不能指定程序、命令或工作目录。 */
export function desktopCodexPath(configuredPath, { platform = process.platform, env = process.env, exists = fs.existsSync, directories = fs.readdirSync } = {}) {
  for (const candidate of [configuredPath, env.CODEX_CLI_PATH]) if (candidate && path.isAbsolute(candidate) && exists(candidate)) return candidate;
  if (platform === 'win32') {
    const root = path.join(env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps');
    try {
      const installs = directories(root).filter(name => /^OpenAI\.Codex_[\d.]+_x64__/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const name of installs) {
        const candidate = path.join(root, name, 'app', 'resources', 'codex.exe');
        if (exists(candidate)) return candidate;
      }
    } catch { /* 无权读取安装目录时，保留明确的能力错误。 */ }
  }
  throw new BridgeError('CREATION_UNSUPPORTED', '未找到桌面附带的 Codex，请更新电脑连接服务或配置本机 CLI 路径');
}

/** 短连接只读取配置或创建空会话；轮次执行仍交给原桌面所有者。 */
export class ThreadCreationClient {
  constructor({ codexHome = path.join(os.homedir(), '.codex'), codexCliPath, launch = spawn, resolveCli = desktopCodexPath, timeoutMs = 12000 } = {}) {
    this.codexHome = codexHome; this.codexCliPath = codexCliPath; this.launch = launch; this.resolveCli = resolveCli; this.timeoutMs = timeoutMs;
  }

  async run(cwd, action) {
    const executable = this.resolveCli(this.codexCliPath);
    const child = this.launch(executable, ['app-server', '--listen', 'stdio://'], { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: this.codexHome } });
    const pending = new Map(), decoder = new StringDecoder('utf8'); let nextId = 0, buffer = '', closed = false;
    const fail = () => {
      closed = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new BridgeError('CREATION_CONNECTION_LOST', 'Codex 创建连接已中断，请先核对操作结果', entry.method === 'thread/start')); }
      pending.clear();
    };
    child.on('error', fail); child.on('exit', fail);
    child.stdin.on('error', fail);
    // 原始诊断可能含配置与路径，不向手机、日志或异常文本透传。
    child.stderr.on('data', () => {});
    child.stdout.on('data', data => {
      buffer += decoder.write(data);
      if (buffer.length > 4 * 1024 * 1024) { fail(); child.kill(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        const entry = pending.get(message.id); if (!entry) continue;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) {
          const error = new BridgeError('CREATION_REJECTED', entry.method === 'thread/start' ? 'Codex 未能创建会话，请核对电脑端项目与配置' : '暂时无法读取项目的 Codex 设置');
          error.cause = message.error; entry.reject(error);
        }
        else entry.resolve(message.result);
      }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      if (closed) { reject(new BridgeError('CREATION_UNAVAILABLE', 'Codex 创建连接暂不可用')); return; }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        const creating = method === 'thread/start';
        reject(new BridgeError(creating ? 'CREATION_TIMEOUT' : 'CREATION_NOT_READY', creating ? 'Codex 创建响应超时，请先核对操作结果' : 'Codex 创建连接未就绪，请重新连接后重试', creating));
      }, this.timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    try {
      await request('initialize', { clientInfo: { name: 'codex_mobile_bridge', title: '掌上 Codex', version: '0.1.0' } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      return await action(request);
    } finally {
      child.stdin.end();
      // 只清理本次创建的辅助进程，不停止桌面或其他 Codex 进程。
      const timer = setTimeout(() => { child.kill(); }, 1000); timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }

  readConfig(cwd) {
    return this.run(cwd, async request => {
      const response = await request('config/read', { cwd, includeLayers: false });
      if (response.config?.model == null) {
        const catalog = await request('model/list', { limit: 100 });
        response.defaultModel = catalog.data?.find(model => model.isDefault === true) ?? null;
      }
      return response;
    });
  }
  async create(cwd, title = '新对话', onCreated = () => {}) {
    return this.run(cwd, async request => {
      const result = await request('thread/start', { cwd });
      const threadId = result?.thread?.id;
      if (typeof threadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(threadId)) throw new BridgeError('CREATION_OUTCOME_UNKNOWN', '创建结果需要在电脑端核对，请勿重复创建', true);
      try {
        onCreated({ threadId });
        // 当前桌面版本在设置标题后才落盘空会话，必须完成这一步再交给原桌面接管。
        await request('thread/name/set', { threadId, name: title });
      } catch (error) { error.outcomeUnknown = true; throw error; }
      return { threadId };
    });
  }
}
