import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { Journal } from '../apps/bridge/journal.mjs';

export const plugin = (id = 'search@example', extra = {}) => ({ id, name: 'search', installed: true, enabled: true, interface: { displayName: '资料检索', shortDescription: '检索合成资料' }, ...extra });
export const directory = (...plugins) => ({ marketplaces: [{ name: 'example', path: '/private/example/market.json', plugins }], marketplaceLoadErrors: [{ marketplacePath: '/private/example/broken.json', message: '合成私有诊断' }] });
export const request = (method, params) => ({ v: 1, type: 'request', requestId: randomUUID(), deviceId: 'phone', method, params });

/** 只模拟桌面传输及目录响应，保留真实协议、适配器、账本和队列实现。 */
class Desktop extends EventEmitter {
  constructor(active, home) {
    super(); this.socket = { writable: true }; this.calls = []; this.revision = 0;
    this.instance = { id: 'example-instance', generation: randomUUID(), pid: 100, startedAt: 1, codexHome: home, executable: path.resolve('fixture-desktop/Codex.exe'), alive: true, ready: true };
    this.state = { id: 'thread', title: '合成聊天', cwd: path.resolve('fixture-project'), turns: [{ turnId: 'original', status: active ? 'inProgress' : 'completed', items: [] }], requests: [], threadRuntimeStatus: { type: active ? 'active' : 'idle' } };
  }
  async connect() {}
  assertCurrent() { if (!this.instance.alive || !this.instance.ready) throw new Error('合成实例失效'); }
  async findOwner(_id, hostId) { return { clientId: 'desktop', hostId }; }
  broadcast(_method, params) {
    if (params.following) queueMicrotask(() => this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { conversationId: 'thread', hostId: 'local', change: { type: 'snapshot', revision: ++this.revision, conversationState: structuredClone(this.state) } } }));
  }
  async request(method, params, version, options) {
    this.calls.push({ method, params, version, options });
    if (this.error) throw this.error;
    return { resultType: 'success', result: { ok: true } };
  }
  idle() { this.state.turns.at(-1).status = 'completed'; this.state.threadRuntimeStatus.type = 'idle'; }
  close() {}
}

/** 每个用例独立使用内存账本，目录与身份数据全部为合成数据。 */
export function fixture(t, { active = false } = {}) {
  const home = path.resolve('fixture-home'), client = new Desktop(active, home), adapter = new DesktopAdapter({ client }), journal = new Journal();
  const f = { client, adapter, journal, data: directory(plugin()), reads: [], onCatalog: null, projectCwd: client.state.cwd };
  f.creation = { codexHome: home, codexCliPath: path.resolve('fixture-desktop/resources/codex.exe'), async run(cwd, action) {
    return action(async (method, params) => {
      f.reads.push({ cwd, method, params });
      await f.onCatalog?.();
      return structuredClone(f.data);
    });
  } };
  f.newThreads = { creation: f.creation, project(id) { if (id !== 'project') throw new Error('合成项目不存在'); return { id, cwd: f.projectCwd }; } };
  f.agent = new BridgeAgent({ config: {}, adapter, journal, newThreads: f.newThreads });
  f.queue = f.agent.messageQueue; clearInterval(f.queue.timer);
  f.send = params => f.agent.handleRequest(request('turn.send', { threadId: 'thread', ...params }));
  f.enqueue = params => f.send({ queueAction: 'enqueue', ...params });
  t.after(() => f.agent.close());
  return f;
}

/** 在确定目录请求已进入异步阶段后再改变订阅或身份，避免依赖定时器竞态。 */
export function pauseCatalog(f) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.onCatalog = async () => { enter(); await gate; };
  return { entered, release };
}
