import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V8PredictionCache } from './v8-prediction-cache.mjs';

const helper = fileURLToPath(new URL('./windows-prediction-memory.ps1', import.meta.url));
const unavailable = () => new Error('预测只读连接暂不可用');

/** 每个已核验主进程复用一个私有只读子进程；手机协议不接收 PID、地址或操作名。 */
export class PredictionMemoryTransport {
  constructor(identity, { launch = spawn } = {}) {
    this.identity = identity;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.buffer = '';
    const executable = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    this.child = launch(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-TargetProcessId', String(identity.pid), '-StartedAtMs', String(identity.startedAt ?? 0)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.readyTimer = setTimeout(() => this.close(), 10000);
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    // 辅助程序原始诊断可能包含路径，统一由固定错误替代，不能进入桥接日志。
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.close());
    this.child.on('exit', () => this.close());
    this.child.stdin.on('error', () => this.close());
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      if (newline > 256 * 1024) { this.close(); return; }
      const line = this.buffer.slice(0, newline).replace(/^\uFEFF/, '');
      this.buffer = this.buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { this.close(); return; }
      if (message.ready === false) { this.close(); return; }
      if (message.ready === true) {
        if (message.pid !== this.identity.pid || !Number.isSafeInteger(message.startedAtMs) ||
            this.identity.startedAt && message.startedAtMs !== this.identity.startedAt) { this.close(); return; }
        clearTimeout(this.readyTimer);
        this.resolveReady();
        continue;
      }
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(unavailable());
      else request.resolve(message.result);
    }
    if (this.buffer.length > 256 * 1024) this.close();
  }

  async request(op, params = {}) {
    await this.ready;
    if (this.closed) throw unavailable();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), op === 'read' ? 5000 : 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }
  findKeys(names) { return this.request('findKeys', { names }); }
  references(targets) { return this.request('references', { targets }); }
  async read(address, length) {
    const result = await this.request('read', { address, length });
    if (typeof result !== 'string') throw unavailable();
    const bytes = Buffer.from(result, 'base64');
    if (bytes.length !== length) throw unavailable();
    return bytes;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    this.rejectReady(unavailable());
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(unavailable()); }
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill();
  }
}

/** 读取身份始终来自已订阅的桌面实例，普通启动和多实例使用同一套缓存读取逻辑。 */
export class DesktopPredictionMemory {
  constructor({ platform = process.platform, open = identity => new PredictionMemoryTransport(identity) } = {}) {
    this.platform = platform;
    this.open = open;
    this.current = null;
    this.closed = false;
  }

  async read(adapter, hostId, threadId, turnId) {
    if (this.closed || this.platform !== 'win32') return { available: false };
    const instance = adapter.client?.instance;
    if (instance && (instance.alive !== true || instance.ready !== true || instance.platform !== 'win32')) return { available: false };
    let pid = instance?.pid;
    const native = adapter.native;
    if (!instance) {
      if (native?.platform !== 'win32') return { available: false };
      await native.connect();
      pid = native.processId;
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) return { available: false };
    const identity = { pid, startedAt: instance?.startedAt ?? 0 };
    const generation = instance?.generation;
    const nativeSocket = native?.socket;
    const key = JSON.stringify([identity.pid, identity.startedAt, instance?.generation]);
    if (this.current?.key !== key) {
      this.current?.transport.close();
      const transport = this.open(identity);
      this.current = { key, transport, cache: new V8PredictionCache(transport), tail: Promise.resolve() };
    }
    const current = this.current;
    // 各聊天共用进程扫描与短期结构缓冲，但每次读取独立串行核对完整查询键。
    const reading = current.tail.then(async () => {
      if (this.closed || this.current !== current) throw unavailable();
      adapter.client?.assertCurrent?.();
      const prediction = await current.cache.read(hostId, threadId, turnId);
      adapter.client?.assertCurrent?.();
      if (this.closed || this.current !== current || adapter.client?.instance !== instance || instance?.generation !== generation) throw unavailable();
      if (!instance && (adapter.native !== native || native.processId !== pid || native.socket !== nativeSocket || native.closed === true)) throw unavailable();
      return { available: true, prediction };
    });
    current.tail = reading.catch(() => {});
    try { return await reading; }
    catch {
      current.cache.anchors = null;
      current.cache.pages.clear();
      if (current.transport.closed && this.current === current) this.current = null;
      return { available: false };
    }
  }

  close() { this.closed = true; this.current?.transport.close(); this.current = null; }
}
