import { BridgeError, validateThreadMentionIds } from '../../packages/protocol/contracts.mjs';
import { ThreadMentionDesktop } from './thread-mention-desktop.mjs';
import { supportsDesktopIpcNewConversation } from './windows-ipc-mode.mjs';

const unavailable = () => new BridgeError('THREAD_MENTIONS_UNAVAILABLE', '当前电脑暂不支持聊天引用，请更新连接服务或重新连接');
const changed = () => new BridgeError('THREAD_MENTIONS_CHANGED', '所选电脑或聊天已变化，请重新选择引用后发送');
const maxSavedContextBytes = 32_000;
const maxSavedMessages = 24;

/** 使用只读历史已规范化的对话正文；额外识别旧格式的合成问答，避免把回答作为普通消息。 */
function visibleSavedMessages(snapshot) {
  const questionReplies = new Set();
  for (const turn of snapshot.sourceTurns ?? []) for (const item of turn.items ?? []) {
    if (item.type !== 'userMessage' && item.type !== 'steeringUserMessage') continue;
    const content = item.content ?? item.input ?? item.text;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : '').join('\n') : '';
    if (text.trimStart().startsWith('<send_user_message_question_reply>')) questionReplies.add(String(item.id));
  }
  return snapshot.messages.flatMap(message => {
    const user = message.role === 'user' && ['userMessage', 'steeringUserMessage'].includes(message.kind);
    const assistant = message.role === 'assistant' && ['agentMessage', 'assistantMessage'].includes(message.kind) && message.phase !== 'analysis';
    if ((!user && !assistant) || questionReplies.has(message.id) || typeof message.text !== 'string') return [];
    // 已保存的旧桥接消息可能把项目附件路径追加到实际模型输入；引用只复制正文。
    const text = (user ? message.text.split('\n\n# 用户附带的文件\n', 1)[0] : message.text).trim();
    return text ? [{ role: message.role, text }] : [];
  });
}

/** 按最终 JSON 字节量为每条引用分配预算，保留近期对话并完整处理多字节字符。 */
function savedContextEntry(reference, snapshot, budget) {
  const key = 'codex-mobile-reference-' + reference.threadId;
  const encode = (messages, truncated) => ({
    kind: 'untrusted', name: '已保存的引用聊天',
    // 原生会把不可信上下文放入标签，正文中的尖括号作为 JSON 数据编码。
    value: JSON.stringify({ threadId: reference.threadId, messages, truncated }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026'),
  });
  const fits = messages => Buffer.byteLength(JSON.stringify({ [key]: encode(messages, false) })) <= budget;
  const visible = visibleSavedMessages(snapshot), messages = [];
  let truncated = snapshot.historyTruncated === true || snapshot.messages.length >= maxSavedMessages || visible.length > 12;
  for (const message of visible.slice(-12).reverse()) {
    if (fits([message, ...messages])) { messages.unshift(message); continue; }
    const chars = Array.from(message.text);
    let low = 0, high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits([{ ...message, text: chars.slice(0, middle).join('') }, ...messages])) low = middle;
      else high = middle - 1;
    }
    if (low > 0) messages.unshift({ ...message, text: chars.slice(0, low).join('') });
    truncated = true;
    break;
  }
  return [key, encode(messages, truncated)];
}

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
  /** 普通实例只为新聊天提供已保存引用；现有聊天继续按原生能力判断。 */
  savedContextAvailable() {
    const { index } = this.adapter;
    if (!supportsDesktopIpcNewConversation(this.adapter) ||
      typeof index?.readHistory !== 'function' || typeof index?.readMentionThreads !== 'function' || typeof index?.listMentions !== 'function') return false;
    return true;
  }
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
    const savedContext = !params.excludeThreadId && this.savedContextAvailable();
    if (!savedContext && !await this.available()) throw unavailable();
    check();
    try { return { ...this.adapter.index.listMentions(params), supportsThreadMentions: true, ...(savedContext ? { threadMentionMode: 'savedContext' } : {}) }; }
    catch { throw new BridgeError('THREAD_MENTIONS_UNAVAILABLE', '聊天列表暂时无法读取，请稍后重试'); }
  }
  async select(ids, threadId, deviceId, { savedContext = false } = {}) {
    const selected = validateThreadMentionIds(ids), check = context(this.adapter, threadId, deviceId);
    if (!selected.length) return { mentions: [], references: [], contextText: '', check };
    if (selected.includes(threadId)) throw new BridgeError('THREAD_MENTION_SELF', '不能引用当前聊天，请选择其他聊天');
    if (savedContext && (!threadId || !this.savedContextAvailable())) throw unavailable();
    const read = () => {
      let rows;
      try { rows = this.adapter.index.readMentionThreads(selected); }
      catch { throw new BridgeError('THREAD_MENTIONS_UNAVAILABLE', '无法核对所选聊天，请重新连接电脑后再试'); }
      return selected.map(id => { const row = rows.find(row => row.id === id); if (!row) throw new BridgeError('THREAD_MENTION_UNAVAILABLE', '所选聊天已删除、归档或不可引用，请重新选择后发送'); return row; });
    };
    let mentions = read();
    if (savedContext) {
      const index = this.adapter.index;
      const assertSavedContext = () => { check(); if (this.adapter.index !== index || !this.savedContextAvailable()) throw changed(); };
      const references = selected.map(threadId => ({ hostId: 'local', threadId }));
      const budget = Math.min(8_000, Math.floor((maxSavedContextBytes - 1) / references.length)), entries = [];
      for (const reference of references) {
        assertSavedContext();
        let snapshot;
        try { snapshot = await index.readHistory(reference.threadId, { rawTurns: true, maxMessages: maxSavedMessages, maxCharacters: 16_000 }); }
        catch { throw new BridgeError('THREAD_MENTION_UNAVAILABLE', '暂时无法读取所选聊天的已保存正文，请重新选择后发送'); }
        assertSavedContext();
        if (snapshot?.threadId !== reference.threadId || snapshot.readOnly !== true || !Array.isArray(snapshot.messages)) throw unavailable();
        entries.push(savedContextEntry(reference, snapshot, budget));
      }
      mentions = read();
      return { mode: 'savedContext', mentions, references, contextText: '', additionalContext: Object.fromEntries(entries), check: () => { assertSavedContext(); read(); } };
    }
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
