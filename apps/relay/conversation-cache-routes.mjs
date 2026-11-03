import { randomUUID } from 'node:crypto';
import { validConversationCacheEvent } from '../../packages/protocol/contracts.mjs';

/** 中转仅保留路由和订阅目标，不保存正文、版本或增量。 */
export class ConversationCacheRoutes {
  constructor({ send, source, authorized }) {
    this.send = send;
    this.source = source;
    this.authorized = authorized;
    this.routes = new Map();
  }

  /** 给每个连接独立的上游编号，同配对多标签页也不能相互退订。 */
  watch(mobile, host, hostId, generation, { subscriptionId, threads, verify = [] }) {
    this.release(mobile.cacheWatches.get(hostId));
    const upstreamId = randomUUID();
    const route = { mobile, host, hostId, generation, subscriptionId, upstreamId, threads: new Set(threads.map(thread => thread.threadId)), verify: new Set(verify) };
    mobile.cacheWatches.set(hostId, route);
    this.routes.set(upstreamId, route);
    return route;
  }

  /** 按上游编号定向释放，旧请求的超时、退订和回执不会影响新订阅。 */
  release(route) {
    if (!route || !this.routes.delete(route.upstreamId)) return;
    route.mobile.cacheWatches.delete(route.hostId);
    const { host, hostId, generation, mobile, upstreamId } = route;
    if (this.source(host, hostId, generation)) this.send(host, { v: 1, type: 'request', requestId: randomUUID(), transportId: randomUUID(), deviceId: mobile.identity.id, hostId, generation, method: 'threads.cache.unwatch', params: { subscriptionId: upstreamId } });
  }

  unwatch(mobile, hostId, subscriptionId) {
    const route = mobile.cacheWatches.get(hostId);
    if (route?.subscriptionId === subscriptionId) this.release(route);
  }

  /** 清理失效路由，无效实例代次不接收旧退订。 */
  prune() {
    for (const route of this.routes.values()) {
      if (!this.source(route.host, route.hostId, route.generation) || !this.authorized(route.mobile.identity.hostIds, route.hostId)) this.release(route);
    }
  }

  forward(host, hostId, message) {
    if (!validConversationCacheEvent(message)) return;
    const route = this.routes.get(message.subscriptionId);
    if (!route || route.host !== host || route.hostId !== hostId || route.generation !== message.generation || route.mobile.identity.id !== message.deviceId || !this.source(host, hostId, route.generation)) return;
    // 仅核对是否还存在的会话不能借清理路由收到正文。
    if (!route.threads.has(message.threadId) && !(message.removed === true && route.verify.has(message.threadId))) return;
    if (!this.authorized(route.mobile.identity.hostIds, hostId)) { this.release(route); return; }
    const { v, type, generation, threadId, revision, baseRevision, snapshot, update, removed } = message;
    this.send(route.mobile, { v, type, hostId, generation, subscriptionId: route.subscriptionId, threadId, revision, baseRevision, snapshot, update, removed });
  }
}
