import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** 使用原桌面的平台默认通道，私有配置可指定另一套 Codex 用户目录。 */
export function defaultIpcSocketPath({ platform = process.platform, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  return platform === 'win32' ? '\\\\.\\pipe\\codex-ipc' : path.join(codexHome, 'ipc', 'ipc.sock');
}

/** 编码 Codex 本地 IPC 的四字节小端长度加 UTF-8 JSON 消息。 */
export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** 增量解析粘包和半包，并在分配大块内存前检查长度上限。 */
export class FrameDecoder {
  constructor(onMessage, maxBytes = 256 * 1024 * 1024) {
    this.onMessage = onMessage;
    this.maxBytes = maxBytes;
    this.header = Buffer.alloc(4);
    this.headerUsed = 0;
    this.body = null;
    this.bodyUsed = 0;
  }

  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.body === null) {
        const size = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + size);
        this.headerUsed += size;
        offset += size;
        if (this.headerUsed < 4) continue;
        const length = this.header.readUInt32LE(0);
        this.headerUsed = 0;
        if (length === 0 || length > this.maxBytes) throw new Error('IPC 消息长度超出允许范围');
        this.body = Buffer.allocUnsafe(length);
        this.bodyUsed = 0;
      }
      const size = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
      chunk.copy(this.body, this.bodyUsed, offset, offset + size);
      offset += size;
      this.bodyUsed += size;
      if (this.bodyUsed === this.body.length) {
        const body = this.body;
        this.body = null;
        this.bodyUsed = 0;
        this.onMessage(JSON.parse(body.toString('utf8')));
      }
    }
  }
}

/** 接入已经运行的 Codex IPC；本类不会启动、重启或修改桌面客户端。 */
export class IpcClient extends EventEmitter {
  constructor({ socketPath = defaultIpcSocketPath(), timeoutMs = 5000, clientType = 'codex-mobile-bridge' } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.clientType = clientType;
    this.clientId = 'initializing-client';
    this.pending = new Map();
    this.socket = null;
    this.closed = true;
  }

  async connect() {
    if (!this.closed) return;
    this.closed = false;
    this.clientId = 'initializing-client';
    this.socket = net.createConnection(this.socketPath);
    const decoder = new FrameDecoder(message => this.handleMessage(message));
    this.socket.on('data', chunk => {
      try { decoder.push(chunk); } catch (error) { this.emit('protocolError', error); this.socket.destroy(error); }
    });
    this.socket.on('error', error => this.emit('transportError', error));
    this.socket.on('close', () => this.handleClose());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error('连接本地 IPC 超时')); }, this.timeoutMs);
      const onError = error => { clearTimeout(timer); reject(error); };
      this.socket.once('error', onError);
      this.socket.once('connect', () => { clearTimeout(timer); this.socket.off('error', onError); resolve(); });
    });
    const response = await this.request('initialize', { clientType: this.clientType }, 0);
    this.clientId = response.result.clientId;
    this.emit('ready', this.clientId);
  }

  request(method, params, version, { targetClientId, hostId, timeoutMs = this.timeoutMs } = {}) {
    if (!this.socket?.writable) return Promise.reject(new Error('本地 IPC 尚未连接'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Object.assign(new Error(`IPC 请求超时：${method}`), { code: 'IPC_TIMEOUT', method })); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket.write(encodeFrame({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, targetClientId, hostId, timeoutMs }));
      } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  broadcast(method, params, version, targetClientIds) {
    if (!this.socket?.writable) throw new Error('本地 IPC 尚未连接');
    this.socket.write(encodeFrame({ type: 'broadcast', method, params, version, sourceClientId: this.clientId, targetClientIds }));
  }

  async findOwner(threadId, hostId = 'local', timeoutMs = this.timeoutMs) {
    const result = await this.request('thread-owner-discovery', { hostId, conversationId: threadId }, 1, {timeoutMs});
    if (result.resultType === 'error' && result.error === 'no-client-found') return null;
    return { clientId: result.handledByClientId, hostId, ...result.result };
  }

  handleMessage(message) {
    if (message.type === 'client-discovery-request') {
      // 本服务只跟随桌面所有者，及时明确拒绝所有权询问，避免拖慢其他桌面请求。
      this.socket?.write(encodeFrame({ type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false} }));
    } else if (message.type === 'request') {
      this.socket?.write(encodeFrame({type:'response',requestId:message.requestId,resultType:'error',error:'no-handler-for-request'}));
    } else if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.resultType === 'error' && message.error !== 'no-client-found') {
        pending.reject(Object.assign(new Error(`IPC 请求失败：${message.error}`), { code: message.error }));
      } else pending.resolve(message);
    } else {
      this.emit('message', message);
      if (message.type === 'broadcast') this.emit('broadcast', message);
    }
  }

  handleClose() {
    this.closed = true;
    for (const { timer, reject } of this.pending.values()) { clearTimeout(timer); reject(new Error('本地 IPC 连接已关闭')); }
    this.pending.clear();
    this.emit('disconnected');
  }

  close() {
    this.socket?.destroy();
  }
}
