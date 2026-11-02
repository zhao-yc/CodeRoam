import { BridgeError, validateThreadMentionIds } from '../../packages/protocol/contracts.mjs';
import { ThreadMentionDesktop } from './thread-mention-desktop.mjs';

const unavailable = () => new BridgeError('THREAD_MENTIONS_UNAVAILABLE', '当前电脑暂不支持聊天引用，请更新连接服务或重新连接');
const changed = () => new BridgeError('THREAD_MENTIONS_CHANGED', '所选电脑或聊天已变化，请重新选择引用后发送');

/** 捕获实例原值和订阅身份，异步核验结束及真正提交前均需重新检查。 */
function context(adapter, threadId, deviceId) {
  const client = adapter.client, instance = client?.instance, generation = instance?.generation;
  const entry = threadId ? adapter.subscribed(threadId, deviceId) : null;
  const ownerId = entry?.owner?.clientId, hostId = entry?.owner?.hostId;
  return () => {
    if (adapter.stopped || adapter.client !== client || client?.instance !== instance || instance?.generation !== generation) throw changed();
    client?.assertCurrent?.();
    if (entry) {
      const current = adapter.subscribed(threadId, deviceId);
      if (current !== entry || current.owner?.clientId !== ownerId || current.owner?.hostId !== hostId) throw changed();
    }
  };
}

/** 候选只读本机索引，原生上下文仅由已核验桌面生成，手机不能提供原生路径。 */
export class ThreadMentionService {
  constructor(adapter, desktop = new ThreadMentionDesktop()) { this.adapter = adapter; this.desktop = desktop; this.supported = false; this.checkedAt = 0; this.checking = null; }
  async available() {
    const identity = JSON.stringify([this.adapter.client?.instance?.id,this.adapter.client?.instance?.generation]);
    if (this.identity === identity && Date.now() - this.checkedAt < 15000) return this.supported;
    if (!this.checking) this.checking = (async () => {
      try { const check = context(this.adapter); const result = await this.desktop.prepare(this.adapter, { ids: [] }); check(); this.supported = result?.supported === true; }
      catch { this.supported = false; }
      this.identity = identity; this.checkedAt = Date.now(); return this.supported;
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  async list(params) {
    const check = context(this.adapter);
    if (!await this.available()) throw unavailable();
    check();
    try { return { ...this.adapter.index.listMentions(params), supportsThreadMentions: true }; }
    catch { throw new BridgeError('THREAD_MENTIONS_UNAVAILABLE', '聊天列表暂时无法读取，请稍后重试'); }
  }
  async select(ids, threadId, deviceId) {
    const selected = validateThreadMentionIds(ids), check = context(this.adapter, threadId, deviceId);
    if (!selected.length) return { mentions: [], references: [], contextText: '', check };
    if (selected.includes(threadId)) throw new BridgeError('THREAD_MENTION_SELF', '不能引用当前聊天，请选择其他聊天');
    const read = () => {
      let rows;
      try { rows = this.adapter.index.readMentionThreads(selected); }
      catch { throw new BridgeError('THREAD_MENTIONS_UNAVAILABLE', '无法核对所选聊天，请重新连接电脑后再试'); }
      return selected.map(id => { const row = rows.find(row => row.id === id); if (!row) throw new BridgeError('THREAD_MENTION_UNAVAILABLE', '所选聊天已删除、归档或不可引用，请重新选择后发送'); return row; });
    };
    let mentions = read();
    const result = await this.desktop.prepare(this.adapter, { threadId, deviceId, ids: selected });
    check(); mentions = read();
    if (!result?.supported || result.references?.length !== selected.length || typeof result.contextText !== 'string' || !result.contextText.trim()) throw unavailable();
    this.supported = true;
    return { ...result, mentions, check: () => { check(); read(); } };
  }
  close() { this.supported = false; this.desktop.close(); }
}

/** 用户可见正文与恢复草稿使用相同引用标记，读取指令只进入模型上下文。 */
export function threadMentionPrompt(text, selection) {
  if (!selection?.mentions.length) return text;
  const links = selection.mentions.map(mention => {
    const reference = selection.references.find(reference => reference.threadId === mention.id);
    if (!reference || typeof reference.hostId !== 'string' || !/^[a-zA-Z0-9._:-]+$/.test(reference.hostId)) throw unavailable();
    const title = mention.title.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 200).replace(/[\\\[\]]/g, '\\$&');
    return `[@${title}](thread://${mention.id}?hostId=${encodeURIComponent(reference.hostId)})`;
  });
  return text + (text ? '\n\n' : '') + links.join(' ');
}
