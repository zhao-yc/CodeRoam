import { ComposerPredictionReader } from './composer-prediction.mjs';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { threadMentionModules } from './thread-mention-modules.mjs';
import { threadMentionExpression } from './thread-mention-expression.mjs';
import { evaluateInstancePage } from './instance-binding.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new BridgeError('THREAD_MENTION_UNSUPPORTED', '当前电脑暂不支持此聊天引用，请刷新聊天或更新电脑连接服务');
const changed = () => new BridgeError('THREAD_MENTION_CHANGED', '电脑实例或聊天归属已变化，请重新选择引用');

/** 复用预测读取器的已核验端点；只检查能力及序列化引用，不发送、不导航、不读取聊天内容。 */
export class ThreadMentionDesktop extends ComposerPredictionReader {
  constructor({ instance, resolveModules = threadMentionModules, evaluateNative, ...options } = {}) {
    super(options);
    this.instance = instance;
    this.resolveModules = resolveModules;
    // 动态 import 必须 awaitPromise；预测专用的同步、throwOnSideEffect 通道不能执行它。
    this.evaluateNative = evaluateNative ?? options.evaluate ?? evaluateInstancePage;
    this.defaultDiscover = this.discover;
    this.endpointBinding = null;
  }

  /** 实例自带的已核验端口优先于平台扫描；切换实例先撤销旧端口，Mac 也不回退到 Windows 发现器。 */
  async bindEndpoints(instance) {
    if (instance && (!Number.isInteger(instance.port) || instance.port < 1 || instance.port > 65535 || typeof instance.executable !== 'string')) {
      this.endpointBinding = null; this.ports = []; this.discoveredAt = null; this.refreshNeeded = true;
      this.connections?.retain(new Set()); this.discover = async () => [];
      throw unavailable();
    }
    const key = instance ? JSON.stringify([instance.pid, instance.port, instance.executable, instance.generation]) : 'default';
    if (this.endpointBinding?.instance === instance && this.endpointBinding.key === key) return this.endpointBinding;
    const binding = { instance, key };
    this.endpointBinding = binding;
    this.ports = []; this.discoveredAt = null; this.refreshNeeded = true;
    this.connections?.retain(new Set());
    // 已在途的旧发现完成后再次清空；其结果不能覆盖新实例身份。
    await this.discovery?.catch(() => {});
    if (this.endpointBinding !== binding || this.closed) throw changed();
    this.ports = []; this.discoveredAt = null;
    this.discover = instance ? async () => this.endpointBinding === binding && instance.alive === true && JSON.stringify([instance.pid, instance.port, instance.executable, instance.generation]) === key ? [{ pid: instance.pid, port: instance.port, executable: instance.executable }] : [] : this.defaultDiscover;
    return binding;
  }

  /** 无编号时仍进行实时能力探测；失败返回 false，绝不缓存上次实例的成功结果。 */
  async capabilities(adapter, input = {}) {
    try { return (await this.prepare(adapter, { ...input, ids: [] })).supported === true; }
    catch { return false; }
  }

  /** adapter 的索引与候选授权由上层处理；这里再次约束订阅、原生主机、PID 与运行代次。 */
  async prepare(adapter, { threadId, deviceId, ids = [] } = {}) {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !uuid.test(id)) || threadId != null && (typeof threadId !== 'string' || !uuid.test(threadId))) throw new BridgeError('BAD_PARAMS', '聊天引用编号无效或超过二十条');
    const references = [...new Set(ids)].filter(id => id !== threadId).map(threadId => ({ hostId: 'local', threadId }));
    try {
      const instance = this.instance ?? adapter?.client?.instance ?? adapter?.native?.instance;
      if (this.instance && adapter?.client?.instance && this.instance !== adapter.client.instance) throw changed();
      const generation = instance?.generation;
      if (instance && instance.alive !== true) throw changed();
      adapter?.client?.assertCurrent?.();
      await instance?.verify?.();
      if (!instance && !adapter?.native?.processId) await adapter?.native?.connect?.();
      const pid = instance?.pid ?? adapter?.native?.processId;
      if (!Number.isInteger(pid) || pid <= 0) throw unavailable();
      const endpointBinding = await this.bindEndpoints(instance);
      const portNumber = instance?.port, executable = instance?.executable;
      const entry = threadId ? adapter.subscribed(threadId, deviceId) : null;
      const ownerHostId = entry?.owner?.hostId, ownerClientId = entry?.owner?.clientId;
      if (threadId && (!['local', 'durable'].includes(ownerHostId) || typeof ownerClientId !== 'string')) throw unavailable();
      const current = () => {
        if (this.closed || this.endpointBinding !== endpointBinding || instance && (instance.alive !== true || instance.generation !== generation || instance.pid !== pid || instance.port !== portNumber || instance.executable !== executable)) return false;
        if ((this.instance ?? adapter?.client?.instance ?? adapter?.native?.instance) !== instance) return false;
        if (!instance && adapter?.native?.processId !== pid) return false;
        if (threadId && (adapter.conversations.get(threadId) !== entry || !entry.watchers.has(deviceId) || entry.owner?.hostId !== ownerHostId || entry.owner?.clientId !== ownerClientId)) return false;
        try { adapter?.client?.assertCurrent?.(); } catch { return false; }
        return true;
      };
      const ports = (await this.endpoints()).filter(port => port.pid === pid && (portNumber == null || port.port === portNumber) && (executable == null || port.executable === executable));
      if (!current()) throw changed();
      if (ports.length !== 1) throw unavailable();
      const port = ports[0], modules = this.resolveModules(port.executable ?? executable);
      const expression = threadMentionExpression(modules, { threadId, ownerHostId, ids: references.map(value => value.threadId) });
      const results = [];
      for (const url of await this.targets(port)) {
        if (!current() || !this.trusted(port)) throw changed();
        try {
          const result = await this.evaluateNative(url, expression, JSON.stringify([port.port, port.pid]));
          if (result?.supported === true) results.push(result);
        } catch { /* 窗口不兼容只作能力失败，不泄露原始异常中的路径或内容。 */ }
      }
      await instance?.verify?.();
      if (!current() || !this.trusted(port)) throw changed();
      // 多个页面同时声称支持也拒绝，不能按窗口顺序猜测绑定。
      if (results.length !== 1) throw unavailable();
      const result = results[0];
      if (!Array.isArray(result.references) || result.references.length !== references.length || result.references.some((value, index) => !value || Object.keys(value).length !== 2 || value.hostId !== 'local' || value.threadId !== references[index].threadId) || typeof result.contextText !== 'string' || result.contextText.length > 32000) throw unavailable();
      if (references.length ? !result.contextText.includes('read_thread') || !result.contextText.includes(JSON.stringify(references)) : result.contextText !== '') throw unavailable();
      return { supported: true, references, contextText: result.contextText };
    } catch (error) {
      if (!ids.length) return { supported: false, references: [], contextText: '' };
      if (error?.code === 'THREAD_MENTION_CHANGED') throw changed();
      throw unavailable();
    }
  }
}
