import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { IpcClient } from '../../packages/protocol/ipc-client.mjs';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

/** 只调用已加载桌面的固定只读协调查询，不建立第二个 AppHost、不写页面状态。 */
export function instanceProbeExpression(nonce) {
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) throw new Error('实例探测编号无效');
  return `(async()=>{const services=(await import('app://-/assets/app-shared-b9a49a97ca55.js')).Vct;if(!services?.clientCoordination)throw Error('INSTANCE_UNSUPPORTED');await services.clientCoordination.threadStreamFollowingStatusRequested({hostId:'local',conversationId:${JSON.stringify(nonce)}});return true})()`;
}

/** 调试地址只能由已核验的回环监听端口及固定页面编号构造，永不信任返回的远程地址。 */
export async function instancePages(instance, fetcher = fetch) {
  if (!Number.isInteger(instance.port) || instance.port < 1 || instance.port > 65535) return [];
  const response = await fetcher(`http://127.0.0.1:${instance.port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!response.ok) throw new Error('实例页面不可用');
  const text = await response.text(); if (text.length > 256 * 1024) throw new Error('实例页面清单超限');
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => row.type === 'page' && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(row.url) && /^[a-zA-Z0-9-]{1,100}$/.test(row.id)).slice(0, 12).map(row => `ws://127.0.0.1:${instance.port}/devtools/page/${row.id}`);
}

/** 固定身份查询等待 Promise 完成；连接用完即关闭，不改动原应用的连接和调试设置。 */
export function queryInstancePage(url, nonce) {
  return evaluateInstancePage(url, instanceProbeExpression(nonce)).then(value => { if (value !== true) throw new Error('实例协调接口暂不兼容'); });
}

/** 固定原桌面服务查询的公共传输，不接收手机代码或调试地址。 */
export function evaluateInstancePage(url, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 2000, maxPayload: 256 * 1024, perMessageDeflate: false });
    let done = false;
    const finish = (error,value) => { if (done) return; done = true; clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('实例身份查询超时')), 8000);
    socket.on('error', () => finish(new Error('实例页面连接失败')));
    socket.on('close', () => finish(new Error('实例页面已关闭')));
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 6000 } })));
    socket.on('message', data => { try { const message = JSON.parse(data.toString()); if (message.id === 1) finish(message.error || message.result?.exceptionDetails ? new Error('实例协调接口暂不兼容') : null,message.result?.result?.value); } catch { finish(new Error('实例页面返回无效')); } });
  });
}

/** 主进程执行器与页面有独立 IPC 客户端；只读枚举原管理器实际持有的会话编号。 */
export async function readInstanceOwnership(instance, { pages = instancePages, evaluate = evaluateInstancePage } = {}) {
  const expression = `(async()=>{const s=(await import('app://-/assets/app-shared-b9a49a97ca55.js')).Vct;const out=[];for(const hostId of ['local','durable']){const opened=await s.appServerManagers.open(hostId);if(opened.status!=='ready')continue;const m=opened.manager;const active=(await m.getWorkInProgress()).map(x=>x.conversationId).filter(x=>typeof x==='string');const cached=await m.getCachedThreadIds();const ids=[...new Set([...active,...cached])].slice(0,256);for(let i=0;i<ids.length;i+=16){const rows=await Promise.all(ids.slice(i,i+16).map(async id=>({id,role:await m.getStreamRole(id)})));for(const row of rows)if(row.role?.role==='owner')out.push({hostId,threadId:row.id});}}return out})()`;
  for (const url of await pages(instance)) {
    try { const result = await evaluate(url, expression); if (Array.isArray(result)) return result.filter(row => ['local', 'durable'].includes(row?.hostId) && /^[0-9a-f-]{36}$/i.test(row.threadId)); } catch { }
  }
  throw new BridgeError('INSTANCE_NOT_READY', '无法核对实例后台所有者，请稍后重试');
}

/** 只在所有已发现实例均完成归属核对且唯一持有探测会话时，绑定后台响应来源。 */
export async function bindBackendOwners(runtimes, { readOwnership = readInstanceOwnership, discoverOwner = (runtime, row) => IpcClient.prototype.request.call(runtime.client, 'thread-owner-discovery', { hostId: row.hostId, conversationId: row.threadId }, 1, { timeoutMs: 1000 }) } = {}) {
  const inventories = await Promise.all(runtimes.map(async runtime => ({ runtime, owned: await readOwnership(runtime.instance) })));
  for (const { runtime, owned } of inventories) {
    const completed = new Set();
    let verified = false;
    for (const row of owned) {
      if (completed.has(row.hostId)) continue;
      if (inventories.some(other => other.runtime !== runtime && other.owned.some(item => item.hostId === row.hostId && item.threadId === row.threadId))) continue;
      const response = await discoverOwner(runtime, row);
      if (response.resultType !== 'success' || !/^[0-9a-f-]{36}$/i.test(response.handledByClientId ?? '')) continue;
      // 再回读所选进程，归属核验期间发生改变时不能接纳迟到的后台身份。
      const current = await Promise.all(runtimes.map(async other => ({ runtime: other, owned: await readOwnership(other.instance) })));
      const owners = current.filter(other => other.owned.some(item => item.hostId === row.hostId && item.threadId === row.threadId));
      if (runtime.instance.alive && owners.length === 1 && owners[0].runtime === runtime) { runtime.client.allowedClients.add(response.handledByClientId); verified = true; }
      completed.add(row.hostId);
    }
    if (owned.length && !verified) runtime.instance.ready = false;
  }
}

/** 将每个已核验页面发出的随机查询与 IPC 广播来源关联，不能按全局所有者响应先后猜测。 */
export async function bindInstanceClients(client, instance, { pages = instancePages, query = queryInstancePage, timeoutMs = 4000 } = {}) {
  const ids = new Set();
  for (const url of await pages(instance)) {
    const nonce = randomUUID();
    let accept;
    const observed = new Promise(resolve => { accept = resolve; });
    const listener = message => { if (message.method === 'thread-stream-following-status-requested' && message.params?.conversationId === nonce && message.params?.hostId === 'local' && /^[0-9a-f-]{36}$/i.test(message.sourceClientId ?? '')) accept(message.sourceClientId); };
    client.on('broadcast', listener);
    let timer;
    try {
      const value = await Promise.all([query(url, nonce), Promise.race([observed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('实例广播握手超时')), timeoutMs); })])]);
      ids.add(value[1]);
    } catch { /* 主窗口和辅助页面能力不同，只接纳完成双向核验的客户端。 */ }
    finally { clearTimeout(timer); client.off('broadcast', listener); }
  }
  if (!ids.size) throw new BridgeError('INSTANCE_NOT_READY', '实例连接尚未就绪，请在电脑启用本机连接后重试');
  return ids;
}

/** 任何会话发现、请求和广播都限制在当前运行代次绑定的客户端集合内。 */
export class InstanceIpcClient extends IpcClient {
  constructor({ instance, ...options }) { super(options); this.instance = instance; this.allowedClients = new Set(); }
  assertCurrent() { if (!this.instance.alive || !this.instance.ready || !this.allowedClients.size) throw new BridgeError('INSTANCE_NOT_READY', '所选实例连接尚未就绪，请稍后核对原操作', this.instance.wasReady === true); }
  async findOwner(threadId, hostId = 'local', timeoutMs = this.timeoutMs) {
    this.assertCurrent();
    for (const targetClientId of this.allowedClients) {
      try {
        const result = await this.request('thread-owner-discovery', { hostId, conversationId: threadId }, 1, { targetClientId, timeoutMs });
        if (result.resultType === 'success' && result.handledByClientId === targetClientId) return { ...result.result, clientId: targetClientId, hostId };
      } catch (error) { if (error.code !== 'IPC_TIMEOUT') throw error; }
    }
    return null;
  }
  /** 全局查询只用于报告归属冲突，结果绝不能用于订阅、发送或自动接管。 */
  async ownedElsewhere(threadId) {
    this.assertCurrent();
    const result = await IpcClient.prototype.request.call(this, 'thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1, { timeoutMs: 750 });
    return result.resultType === 'success' && !this.allowedClients.has(result.handledByClientId);
  }
  request(method, params, version, options = {}) {
    if (method !== 'initialize') { this.assertCurrent(); if (!options.targetClientId || !this.allowedClients.has(options.targetClientId)) return Promise.reject(new BridgeError('INSTANCE_CHANGED', '聊天所属实例已变化，请重新连接')); }
    return super.request(method, params, version, options).then(result => {
      if (method !== 'initialize' && result.resultType === 'success' && result.handledByClientId !== options.targetClientId) throw new BridgeError('INSTANCE_CHANGED', '桌面响应归属已变化，已停止操作');
      return result;
    });
  }
  broadcast(method, params, version, targets) { this.assertCurrent(); if (!targets?.length || targets.some(id => !this.allowedClients.has(id))) throw new BridgeError('INSTANCE_CHANGED', '聊天所属实例已变化，已停止操作'); return super.broadcast(method, params, version, targets); }
  handleMessage(message) {
    if (message.type === 'broadcast' && message.method === 'client-status-changed' && message.params?.status === 'disconnected' && this.allowedClients.delete(message.params.clientId) && !this.allowedClients.size) this.instance.ready = false;
    if (message.type === 'broadcast' && message.method !== 'thread-stream-following-status-requested' && !this.allowedClients.has(message.sourceClientId)) return;
    super.handleMessage(message);
  }
  handleClose() { this.allowedClients.clear(); this.instance.ready = false; super.handleClose(); }
}
