import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { encodeFrame, FrameDecoder } from '../../packages/protocol/ipc-client.mjs';

const frameLimit = 256 * 1024 * 1024;
const statusMethod = 'client-status-changed';
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const validPeer = peer => Number.isSafeInteger(peer?.pid) && peer.pid > 0 && Number.isSafeInteger(peer.startedAt) && peer.startedAt > 0;

/** 原桌面 IPC 的本机路由。进程身份只由宿主提供，帧内自报身份不参与绑定。 */
export class WindowsIpcRouter extends EventEmitter {
  #connections = new Map();
  #clients = new Map();
  #requests = new Map();
  #discoveries = new Map();
  #closed = false;

  constructor({ initializeTimeoutMs = 10000, discoveryTimeoutMs = 10000, requestTimeoutMs = 10000, maxRequestTimeoutMs = 300000, maxClients = 128, maxRequestsPerClient = 64, maxFrameBytes = frameLimit } = {}) {
    super();
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.initializeTimeoutMs = initializeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRequestTimeoutMs = maxRequestTimeoutMs;
    this.maxClients = maxClients;
    this.maxRequestsPerClient = maxRequestsPerClient;
    this.maxFrameBytes = maxFrameBytes;
  }

  get ready() { return !this.#closed; }

  /** 宿主从已接受的管道句柄核验 PID 与启动时间后，才能把连接交给路由。 */
  accept(socket, identity) {
    if (this.#closed || !validPeer(identity) || this.#connections.has(socket) || this.#connections.size >= this.maxClients) throw new Error('本地 IPC 对端身份或连接状态无效');
    const peer = { socket, pid: identity.pid, startedAt: identity.startedAt, id: null, clientType: null, requests: new Set(), initializeTimer: null };
    const decoder = new FrameDecoder(message => this.#receive(peer, message), this.maxFrameBytes);
    this.#connections.set(socket, peer);
    const disconnect = () => this.#disconnect(peer);
    peer.initializeTimer = this.#timer(disconnect, this.initializeTimeoutMs);
    socket.on('data', chunk => {
      if (!this.#connections.has(socket)) return;
      try { decoder.push(chunk); } catch { disconnect(); }
    });
    socket.on('end', disconnect);
    socket.on('close', disconnect);
    socket.on('error', disconnect);
  }

  /** 同一 PID 被系统复用后，旧进程的 UUID 不会被归入新实例。 */
  clientIds(identity) {
    if (!validPeer(identity) || this.#closed) return new Set();
    return new Set([...this.#clients.values()].filter(peer => peer.pid === identity.pid && peer.startedAt === identity.startedAt).map(peer => peer.id));
  }

  /** 核对连接服务自己的初始化回执确实来自本路由。 */
  ownsClient(clientId, pid) { return !this.#closed && this.#clients.get(clientId)?.pid === pid; }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const peer of this.#connections.values()) this.#disconnect(peer);
    this.emit('close');
  }

  #receive(peer, message) {
    if (!message || typeof message !== 'object' || !this.#connections.has(peer.socket)) return;
    if (message.type === 'request' && message.method === 'initialize') {
      this.#initialize(peer, message);
      return;
    }
    if (!peer.id) return;
    switch (message.type) {
      case 'broadcast': this.#broadcast(peer, message); break;
      case 'request': this.#request(peer, message); break;
      case 'response': this.#response(peer, message); break;
      case 'client-discovery-response': this.#discoveryResponse(peer, message); break;
    }
  }

  #initialize(peer, { requestId, version, params }) {
    if (!validKey(requestId) || (version ?? 0) !== 0 || !validKey(params?.clientType)) return;
    const first = peer.id == null;
    if (first) {
      clearTimeout(peer.initializeTimer);
      peer.id = randomUUID();
      peer.clientType = params.clientType;
      this.#clients.set(peer.id, peer);
    }
    if (!this.#write(peer, { type: 'response', requestId, resultType: 'success', method: 'initialize', handledByClientId: peer.id, result: { clientId: peer.id } })) {
      this.#disconnect(peer);
      return;
    }
    if (first) {
      this.#notifyStatus(peer, 'connected');
      this.emit('clientsChanged', { pid: peer.pid, startedAt: peer.startedAt });
    }
  }

  #broadcast(peer, message) {
    const targets = message.targetClientIds;
    if (!validKey(message.method) || message.method === statusMethod || (targets != null && (!Array.isArray(targets) || targets.length > this.maxClients || !targets.every(validKey)))) return;
    const selected = targets == null ? null : new Set(targets);
    this.#sendBroadcast(peer, { ...message, sourceClientId: peer.id }, selected);
  }

  #notifyStatus(peer, status) {
    if (this.#closed) return;
    this.#sendBroadcast(peer, { type: 'broadcast', method: statusMethod, sourceClientId: peer.id, version: 0, params: { clientId: peer.id, clientType: peer.clientType, status } }, null);
  }

  #sendBroadcast(source, message, targets) {
    const frame = this.#encode(message);
    if (frame == null) return;
    for (const peer of this.#clients.values()) {
      if (peer !== source && (targets == null || targets.has(peer.id))) this.#send(peer, frame);
    }
  }

  #request(source, message) {
    if (!validKey(message.requestId) || !validKey(message.method)) return;
    if (source.requests.size >= this.maxRequestsPerClient) {
      this.#write(source, { type: 'response', requestId: message.requestId, resultType: 'error', error: 'request-timeout' });
      return;
    }
    const targeted = message.targetClientId == null ? null : this.#clients.get(message.targetClientId);
    const candidates = message.targetClientId == null ? [...this.#clients.values()].filter(peer => peer !== source) : targeted && targeted !== source ? [targeted] : [];
    const request = {
      id: randomUUID(), source, message: { ...message, sourceClientId: source.id }, target: null,
      discoveries: new Set(), timer: null,
    };
    source.requests.add(request);
    this.#requests.set(request.id, request);
    if (!candidates.length) { this.#fail(request, 'no-client-found'); return; }
    for (const candidate of candidates) {
      const id = randomUUID();
      request.discoveries.add(id);
      this.#discoveries.set(id, { candidate, request });
    }
    request.timer = this.#timer(() => this.#fail(request, 'no-client-found'), this.discoveryTimeoutMs);
    for (const id of request.discoveries) {
      const { candidate } = this.#discoveries.get(id);
      const probe = { type: 'client-discovery-request', requestId: id, request: request.message };
      if (!this.#write(candidate, probe)) this.#declineDiscovery(request, id);
    }
  }

  #discoveryResponse(peer, message) {
    const found = this.#discoveries.get(message.requestId);
    // 发现回执只能来自该询问的实际对端，伪造 UUID 或猜中请求编号也不能接管。
    if (!found || found.candidate !== peer) return;
    const { request } = found;
    if (message.response?.canHandle !== true) { this.#declineDiscovery(request, message.requestId); return; }
    this.#clearDiscoveries(request);
    clearTimeout(request.timer);
    request.target = peer;
    const requested = request.message.timeoutMs;
    const timeout = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, this.maxRequestTimeoutMs) : this.requestTimeoutMs;
    request.timer = this.#timer(() => this.#fail(request, 'request-timeout'), timeout);
    if (!this.#write(peer, { ...request.message, requestId: request.id })) this.#fail(request, 'request-timeout');
  }

  #declineDiscovery(request, id) {
    this.#discoveries.delete(id);
    request.discoveries.delete(id);
    if (!request.discoveries.size && !request.target) this.#fail(request, 'no-client-found');
  }

  #response(peer, message) {
    const request = this.#requests.get(message.requestId);
    if (!request || request.target !== peer || !['success', 'error'].includes(message.resultType)) return;
    this.#finish(request, { ...message, requestId: request.message.requestId, sourceClientId: peer.id, handledByClientId: peer.id });
  }

  #fail(request, error) {
    this.#finish(request, { type: 'response', requestId: request.message.requestId, resultType: 'error', error });
  }

  #finish(request, message = null) {
    if (!this.#requests.delete(request.id)) return;
    clearTimeout(request.timer);
    this.#clearDiscoveries(request);
    request.source.requests.delete(request);
    if (message) this.#write(request.source, message);
  }

  #clearDiscoveries(request) {
    for (const id of request.discoveries) this.#discoveries.delete(id);
    request.discoveries.clear();
  }

  #disconnect(peer) {
    if (!this.#connections.delete(peer.socket)) return;
    clearTimeout(peer.initializeTimer);
    peer.socket.destroy();
    if (peer.id) this.#clients.delete(peer.id);
    for (const request of peer.requests) this.#finish(request);
    for (const request of this.#requests.values()) {
      // 已派发的请求可能已经执行，沿用现有客户端能识别的未知结果。
      if (request.target === peer) this.#fail(request, 'request-timeout');
    }
    for (const [id, { candidate, request }] of this.#discoveries) {
      if (candidate === peer) this.#declineDiscovery(request, id);
    }
    if (peer.id) {
      this.#notifyStatus(peer, 'disconnected');
      this.emit('clientsChanged', { pid: peer.pid, startedAt: peer.startedAt });
    }
  }

  #timer(callback, timeout) {
    const timer = setTimeout(callback, timeout);
    timer.unref();
    return timer;
  }

  #encode(message) {
    const frame = encodeFrame(message);
    return frame.length - 4 <= this.maxFrameBytes ? frame : null;
  }

  #write(peer, message) {
    const frame = this.#encode(message);
    return frame != null && this.#send(peer, frame);
  }

  #send(peer, frame) {
    const { socket } = peer;
    if (this.#closed || !socket.writable || !this.#connections.has(socket)) return false;
    // 断开持续积压的接收端，避免无界排队；正文只随协议发送。
    if (socket.writableLength + frame.length <= this.maxFrameBytes + 4) {
      try { socket.write(frame); return true; } catch { }
    }
    this.#disconnect(peer);
    return false;
  }
}
