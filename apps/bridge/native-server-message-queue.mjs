import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { instanceCodexPath } from './thread-creation.mjs';
import { NativeServerQueueClient } from './native-server-queue-client.mjs';
import { readStoredMessageQueue } from './native-stored-message-queue.mjs';

const publicId = id => 'desktop-' + createHash('sha256').update(id).digest('hex').slice(0, 48);
const unavailable = () => new BridgeError('NATIVE_QUEUE_UNAVAILABLE', '电脑原生队列暂未就绪，请重新同步后重试');

/** 只生成原生已支持的输入格式，文件路径来自电脑准备阶段，手机不能指定。 */
function queuedInput(message) {
  const context = message.context;
  const files = context.fileAttachments ?? [];
  const prefix = files.length ? '# Files mentioned by the user:\n' + files.map(file => '## ' + file.label + ': ' + file.path).join('\n') + '\n\n## My request:\n' : '';
  const text = prefix + context.prompt;
  return [
    ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
    ...(context.imageAttachments ?? []).map(image => ({ type: 'image', url: image.src })),
    ...(message.pluginInputs ?? []),
  ];
}

/** 公开展示只保留用户正文，原生文件上下文和本机路径留在私有缓存。 */
function describe(row) {
  const texts = row.input.filter(item => item.type === 'text');
  const raw = texts.map(item => item.text).join('\n');
  const marker = [...raw.matchAll(/## My request(?: for Codex)?:\r?\n/g)].at(-1);
  const prefix = marker ? raw.slice(0, marker.index) : '';
  const imageInputs = row.input.filter(item => ['image', 'localImage'].includes(item.type));
  const markedText = texts.some(item => item.text_elements?.length);
  const text = markedText ? '包含复杂上下文的电脑排队消息' : marker ? raw.slice(marker.index + marker[0].length).trim() : raw;
  return {
    id: publicId(row.id), nativeId: row.id, row, source: 'desktop', text: text.slice(0, 32000),
    imageCount: imageInputs.length, attachmentCount: (prefix.match(/^## /gm) ?? []).length,
    state: 'queued', error: '', canCancel: true, canEdit: false, canSteer: false,
  };
}

/** 兼容队列只读原生持久快照，特殊上下文始终交给原桌面解释和移除。 */
function describeStored(message) {
  const mutable = !['sending', 'outcome-unknown', 'pending'].includes(message.submission?.status);
  return {
    id: publicId(message.id), nativeId: message.id, row: { stored: true }, source: 'desktop',
    text: message.text.slice(0, 32000), imageCount: message.context?.imageAttachments?.length ?? 0,
    attachmentCount: message.context?.fileAttachments?.length ?? 0,
    state: message.submission?.status === 'outcome-unknown' ? 'unknown' : mutable ? 'queued' : 'sending',
    error: message.pausedReason ? '电脑已暂停此消息，请在电脑核对后继续' : '',
    canCancel: mutable, canEdit: false, canSteer: false,
  };
}

/** 普通启动和多实例共用官方持久队列；辅助连接只做队列读写，执行权留给原桌面。 */
export class NativeServerMessageQueue {
  constructor({ adapter, createClient = options => new NativeServerQueueClient(options), readStored = readStoredMessageQueue, intervalMs = 5000 } = {}) {
    this.adapter = adapter; this.createClient = createClient; this.readStored = readStored;
    this.queues = new Map(); this.reads = new Map(); this.used = new Set(); this.closed = false;
    this.timer = setInterval(() => this.poll(), intervalMs); this.timer.unref();
    this.supportsSubmissionOptions = false;
  }

  snapshot(threadId) {
    const value = this.queues.get(threadId);
    if (!value) return {};
    return {
      supportsNativeMessageQueue: value.supported,
      queuedMessages: value.messages.map(({ nativeId, row, ...message }) => ({ ...message, ...(!value.supported ? { canEdit: false, canCancel: false, canSteer: false, error: '电脑队列连接中断，请重新同步' } : {}) })),
    };
  }

  context(threadId, deviceId) {
    const adapter = this.adapter, entry = adapter.subscribed(threadId, deviceId);
    const instance = adapter.client?.instance ?? adapter.native?.instance;
    const owner = { ...entry.owner };
    if (owner.hostId !== 'local' || entry.state?.ephemeral === true) throw unavailable();
    const stamp = instance && JSON.stringify([instance.pid, instance.startedAt, instance.generation, instance.executable, instance.codexHome]);
    const check = () => {
      const current = adapter.subscribed(threadId, deviceId);
      adapter.client?.assertCurrent?.();
      if (this.closed || current !== entry || current.owner.clientId !== owner.clientId || current.owner.hostId !== owner.hostId || (adapter.client?.instance ?? adapter.native?.instance) !== instance || instance && (instance.alive !== true || stamp !== JSON.stringify([instance.pid, instance.startedAt, instance.generation, instance.executable, instance.codexHome]))) throw new BridgeError('NATIVE_QUEUE_CHANGED', '电脑队列归属已变化，请同步后重试');
    };
    const cwd = entry.state.cwd ?? entry.state.environments?.[0]?.cwd;
    if (!cwd) throw unavailable();
    const codexHome = instance?.codexHome ?? (adapter.index?.filePath ? path.dirname(adapter.index.filePath) : process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const executable = instance?.executable;
    const client = this.createClient({
      codexHome,
      ...(instance ? { resolveCli: () => instanceCodexPath({ platform: instance.platform, executable }) } : {}),
    });
    return { entry, instance, owner, cwd, codexHome, client, check };
  }

  async refresh(threadId, deviceId, { force = false } = {}) {
    if (this.closed) return false;
    if (this.reads.has(threadId)) return this.reads.get(threadId);
    const previous = this.queues.get(threadId);
    if (!force && previous && Date.now() - previous.at < 1500) return previous.supported;
    const reading = this.read(threadId, deviceId).finally(() => this.reads.delete(threadId));
    this.reads.set(threadId, reading); return reading;
  }

  async read(threadId, deviceId) {
    const previous = this.queues.get(threadId);
    try {
      const context = this.context(threadId, deviceId);
      await context.instance?.verify?.(); context.check();
      const messages = (await context.client.list(threadId, context.cwd)).map(describe);
      const ids = new Set(messages.map(row => row.nativeId));
      const stored = this.readStored(context.codexHome, threadId).filter(row => !ids.has(row.id) && (row.submission?.hostId == null || row.submission.hostId === context.owner.hostId));
      messages.push(...stored.map(describeStored));
      context.check();
      const changed = !previous?.supported || JSON.stringify(previous.messages) !== JSON.stringify(messages);
      this.queues.set(threadId, { supported: true, messages, at: Date.now(), deviceId });
      this.used.add(threadId);
      if (changed) this.adapter.emit('conversation', this.adapter.snapshot(context.entry.state));
      return true;
    } catch {
      this.queues.set(threadId, { supported: false, messages: previous?.messages ?? [], at: Date.now(), deviceId });
      return false;
    }
  }

  async operate(action, params, commandId, deviceId, message) {
    const { threadId } = params;
    // 辅助进程与原桌面的队列锁不共享，删除后另发追加不能保证只消费一次。
    // 撤回后重发也存在同样竞态，旧客户端必须在任何删除副作用前被拦截。
    if (action === 'steer' || action === 'edit') throw new BridgeError('NATIVE_QUEUE_CONVERSION_UNAVAILABLE', '当前电脑版本暂不支持手机撤回或追加原生排队消息，请在电脑处理');
    if (!await this.refresh(threadId, deviceId, { force: true })) throw unavailable();
    const context = this.context(threadId, deviceId);
    await context.instance?.verify?.(); context.check();
    if (action === 'enqueue') {
      if (message.submissionOptions) throw new BridgeError('NATIVE_QUEUE_SETTINGS_UNSUPPORTED', '所选设置暂不能随电脑队列发送，请核对消息设置');
      const row = await context.client.enqueue(threadId, queuedInput(message), commandId, context.cwd);
      try { context.check(); } catch { throw new BridgeError('OUTCOME_UNKNOWN', '电脑入队结果需要核对，请勿重复提交', true); }
      await this.refresh(threadId, deviceId, { force: true });
      return { ok: true, queued: true, queueId: publicId(row.id) };
    }
    const row = this.queues.get(threadId).messages.find(value => value.id === params.queueId);
    if (!row || action !== 'cancel' || !row.canCancel) throw new BridgeError('NATIVE_QUEUE_CHANGED', '这条电脑排队消息已变化，请重新同步');
    let removed = false;
    try {
      if (row.row.stored) {
        // 本地 follower 的基础协议版本不带顶层 hostId，带上该字段须使用下一版本。
        const response = await this.adapter.client.request('thread-follower-remove-queued-message', { conversationId: threadId, messageId: row.nativeId }, 1, { targetClientId: context.owner.clientId, timeoutMs: 15000 });
        removed = response.resultType === 'success' && response.result?.removed?.message != null;
      } else removed = await context.client.remove(threadId, row.nativeId, context.cwd);
      if (!removed) throw new BridgeError('NATIVE_QUEUE_CHANGED', '这条电脑排队消息已处理，请重新同步');
      try { context.check(); } catch { throw new BridgeError('OUTCOME_UNKNOWN', '电脑队列操作结果需要核对，请勿重复提交', true); }
      return { ok: true, canceled: true };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (row.row.stored) throw new BridgeError('OUTCOME_UNKNOWN', '电脑取消结果需要核对，请勿重复提交', true);
      throw unavailable();
    } finally {
      await this.refresh(threadId, deviceId, { force: true });
      const entry = this.adapter.conversations.get(threadId);
      if (entry?.state) this.adapter.emit('conversation', this.adapter.snapshot(entry.state));
    }
  }

  poll() {
    for (const [threadId] of this.queues) {
      const entry = this.adapter.conversations.get(threadId);
      const deviceId = [...entry?.watchers ?? []].find(id => typeof id === 'string' && !['list-status', 'message-queue', 'conversation-cache'].includes(id) && !id.startsWith('status:') && !id.startsWith('submission:'));
      if (!deviceId) { this.queues.delete(threadId); continue; }
      this.refresh(threadId, deviceId, { force: true }).catch(() => {});
    }
  }

  forget(threadId) { this.queues.delete(threadId); }
  close() { this.closed = true; clearInterval(this.timer); this.queues.clear(); }
}
