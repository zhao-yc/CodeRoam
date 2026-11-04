import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { ComposerPredictionReader } from './composer-prediction.mjs';
import { instanceBindingModules } from './instance-binding-modules.mjs';
import { nativeMessageQueueExpression } from './native-message-queue-expression.mjs';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

const publicId = id => 'desktop-' + createHash('sha256').update(id).digest('hex').slice(0, 48);
const hints = {
  NATIVE_QUEUE_CHANGED: '电脑排队消息或聊天归属已变化，请同步后重试',
  NATIVE_QUEUE_TURN_CHANGED: '当前任务已变化，消息仍保留在电脑队列中',
  NATIVE_QUEUE_COMPLEX: '这条电脑消息包含手机暂不能完整处理的内容，请在电脑操作',
  NATIVE_QUEUE_FULL: '最多排队20条消息，请先处理已有消息',
  NATIVE_QUEUE_BUSY: '电脑队列操作较多，请稍后重试',
  NATIVE_QUEUE_UNAVAILABLE: '电脑原生队列连接未就绪，请重新同步后重试',
};

/** 原始桌面异常只在本机解析固定代码，路径、队列上下文和系统错误不回传手机。 */
export function evaluateNativeMessageQueue(url, expression, write = false) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 2000, maxPayload: 6 * 1024 * 1024, perMessageDeflate: false });
    let finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(value); };
    const unknown = () => new BridgeError(write ? 'OUTCOME_UNKNOWN' : 'NATIVE_QUEUE_UNAVAILABLE', write ? '电脑队列操作结果需要核对，请勿重复提交' : hints.NATIVE_QUEUE_UNAVAILABLE, write);
    const timer = setTimeout(() => finish(unknown()), 9000);
    socket.on('error', () => finish(unknown())); socket.on('close', () => finish(unknown()));
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, timeout: 8000 } })));
    socket.on('message', data => {
      let message; try { message = JSON.parse(data); } catch { return; }
      if (message.id !== 1) return;
      const description = message.result?.exceptionDetails?.exception?.description ?? '';
      const code = Object.keys(hints).find(code => new RegExp('(?:Error: |^)' + code + '(?:\\n|$)').test(description));
      if (code) return finish(new BridgeError(code, hints[code]));
      if (message.error || message.result?.exceptionDetails) return finish(unknown());
      finish(null, message.result?.result?.value);
    });
  });
}

/** 始终绑定原实例和原会话所有者，手机离开后由 PC 自己继续调度已入队消息。 */
export class NativeMessageQueue extends ComposerPredictionReader {
  constructor({ adapter, evaluateNative = evaluateNativeMessageQueue, resolveModules = instanceBindingModules, ...options } = {}) {
    super({ ...options, evaluate: () => {} }); this.adapter = adapter; this.evaluateNative = evaluateNative; this.resolveModules = resolveModules;
    this.queues = new Map(); this.reads = new Map(); this.used = new Set();
    this.queueTimer = setInterval(() => this.poll(), 2000); this.queueTimer.unref();
  }

  /** 公开编号不携带原生上下文；快照只包含展示字段和逐条能力。 */
  snapshot(threadId) {
    const value = this.queues.get(threadId);
    if (!value) return {};
    return { supportsNativeMessageQueue: value.supported, queuedMessages: value.messages.map(({ nativeId, ...message }) => ({ ...message, ...(!value.supported ? { canEdit: false, canCancel: false, canSteer: false, error: '电脑队列连接中断，请重新同步' } : {}) })) };
  }

  context(threadId, deviceId) {
    const adapter = this.adapter, entry = adapter.subscribed(threadId, deviceId), instance = adapter.client?.instance ?? adapter.native?.instance;
    const owner = { ...entry.owner }, generation = instance?.generation, pid = instance?.pid ?? adapter.native?.processId;
    const stamp = instance && JSON.stringify([instance.pid, instance.startedAt, instance.port, instance.generation, instance.executable]);
    const check = () => {
      const current = adapter.subscribed(threadId, deviceId);
      adapter.client?.assertCurrent?.();
      if (this.closed || current !== entry || (adapter.client?.instance ?? adapter.native?.instance) !== instance || current.owner?.clientId !== owner.clientId || current.owner?.hostId !== owner.hostId || instance && (instance.alive !== true || instance.generation !== generation || stamp !== JSON.stringify([instance.pid, instance.startedAt, instance.port, instance.generation, instance.executable]))) throw new BridgeError('NATIVE_QUEUE_CHANGED', hints.NATIVE_QUEUE_CHANGED);
    };
    return { instance, entry, owner, pid, check };
  }

  /** 首帧读取和周期刷新共用一次请求；普通启动只声明无能力，不开启端口或重启桌面。 */
  async refresh(threadId, deviceId, { force = false } = {}) {
    if (this.closed) return false;
    if (this.reads.has(threadId)) return this.reads.get(threadId);
    const cached = this.queues.get(threadId);
    if (!force && cached && Date.now() - cached.at < 1500) return cached.supported;
    const reading = this.read(threadId, deviceId).finally(() => this.reads.delete(threadId));
    this.reads.set(threadId, reading); return reading;
  }

  async read(threadId, deviceId) {
    let context;
    try {
      context = this.context(threadId, deviceId);
      if (!context.instance && !Number.isInteger(context.pid)) { await this.adapter.native?.connect?.(); context = this.context(threadId, deviceId); }
      const { instance, pid } = context;
      if (instance && !instance.port || !Number.isInteger(pid)) return this.unavailable(threadId);
      await instance?.verify?.(); context.check();
      const ports = instance ? [{ pid, port: instance.port, executable: instance.executable }] : (await this.endpoints()).filter(port => port.pid === pid);
      if (ports.length !== 1) return this.unavailable(threadId);
      const port = ports[0], modules = this.resolveModules(port.executable);
      const previous = this.queues.get(threadId), urls = await this.targets(port);
      // 同进程多个页面可能代理同一管理器；复用已绑定页面，不跨页面重放写操作。
      if (previous?.binding && urls.includes(previous.binding.url)) urls.sort((a, b) => Number(b === previous.binding.url) - Number(a === previous.binding.url));
      for (const url of urls) {
        let result;
        try { result = await this.evaluateNative(url, nativeMessageQueueExpression(modules, 'read', { hostId: context.owner.hostId, threadId })); } catch { continue; }
        context.check();
        if (!result?.supported || !Array.isArray(result.messages) || result.messages.length > 200) continue;
        const messages = result.messages.map(message => {
          if (typeof message.id !== 'string' || !message.id || message.id.length > 200 || typeof message.text !== 'string' || !Number.isInteger(message.imageCount) || !Number.isInteger(message.attachmentCount)) throw Error('队列数据无效');
          return { id: publicId(message.id), nativeId: message.id, source: 'desktop', text: message.text.slice(0,32000), imageCount:message.imageCount,attachmentCount:message.attachmentCount,state:message.state,error:message.error,canEdit:message.canEdit===true,canCancel:message.canCancel===true,canSteer:message.canSteer===true };
        });
        const binding = { url, modules, context, port };
        const changed = !previous?.supported || JSON.stringify(previous.messages) !== JSON.stringify(messages);
        this.queues.set(threadId, { at: Date.now(), supported: true, messages, binding, deviceId });
        this.used.add(threadId);
        if (changed && context.entry.state) this.adapter.emit('conversation', this.adapter.snapshot(context.entry.state));
        return true;
      }
    } catch { /* 不兼容和身份变化均保持未知，不能把原始桌面异常发送到手机。 */ }
    return this.unavailable(threadId);
  }

  unavailable(threadId) {
    const previous = this.queues.get(threadId);
    if (previous) {
      const changed=previous.supported;previous.supported = false; previous.at = Date.now();
      const entry=this.adapter.conversations.get(threadId);
      if(changed&&entry?.state)this.adapter.emit('conversation',this.adapter.snapshot(entry.state));
    }
    return false;
  }

  /** 只有已验证页面可写；任何写后断线都保持未知，不转入另一队列补发。 */
  async operate(action, params, commandId, deviceId, message) {
    const { threadId } = params;
    if (!await this.refresh(threadId, deviceId, { force: true })) throw new BridgeError('NATIVE_QUEUE_UNAVAILABLE', hints.NATIVE_QUEUE_UNAVAILABLE);
    const value = this.queues.get(threadId), binding = value.binding;
    const context = this.context(threadId, deviceId); context.check(); await context.instance?.verify?.(); context.check();
    if (binding.context.owner.clientId !== context.owner.clientId || binding.context.owner.hostId !== context.owner.hostId) throw new BridgeError('NATIVE_QUEUE_CHANGED', hints.NATIVE_QUEUE_CHANGED);
    const row = action === 'enqueue' ? null : value.messages.find(row => row.id === params.queueId);
    if (action !== 'enqueue' && (!row || row[action === 'edit' ? 'canEdit' : action === 'steer' ? 'canSteer' : 'canCancel'] !== true)) throw new BridgeError('NATIVE_QUEUE_CHANGED', hints.NATIVE_QUEUE_CHANGED);
    const result = await this.evaluateNative(binding.url, nativeMessageQueueExpression(binding.modules, action, { hostId: context.owner.hostId, threadId, id: row?.nativeId, expectedTurnId: params.expectedTurnId, commandId, ...(message ? { message } : {}) }), true);
    // 写后身份失效不能把已执行动作报告为明确失败，让旧任务进入人工核对。
    try { context.check(); } catch { throw new BridgeError('OUTCOME_UNKNOWN', '电脑队列操作结果需要核对，请勿重复提交', true); }
    if (!result?.ok) throw new BridgeError('OUTCOME_UNKNOWN', '电脑未确认队列操作结果，请勿重复提交', true);
    await this.refresh(threadId, deviceId, { force: true });
    const { nativeId, ...publicResult } = result;
    return { ...publicResult, ...(nativeId ? { queueId: publicId(nativeId) } : {}) };
  }

  /** 只跟随仍有详情观察者的会话；后台列表缓存不会额外读取所有电脑队列。 */
  poll() {
    for (const [threadId, value] of this.queues) {
      const entry = this.adapter.conversations.get(threadId);
      const deviceId = [...entry?.watchers ?? []].find(id => typeof id === 'string' && !['list-status', 'conversation-cache', 'message-queue'].includes(id) && !id.startsWith('status:') && !id.startsWith('submission:'));
      if (!deviceId) { this.queues.delete(threadId); continue; }
      this.refresh(threadId, deviceId, { force: true }).catch(() => {});
    }
  }

  forget(threadId) { this.queues.delete(threadId); }
  close() { clearInterval(this.queueTimer); this.queues.clear(); super.close(); }
}
