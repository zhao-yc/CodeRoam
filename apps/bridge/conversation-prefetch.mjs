import { createHash } from 'node:crypto';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { normalizeConversation } from './conversation.mjs';
import { recentConversationPage, RECENT_CONVERSATION_OPTIONS } from './conversation-page.mjs';
import { executionPreview } from './execution-details.mjs';
import { questionPreviews } from './question-preview.mjs';

const MESSAGE_FIELDS = ['id', 'role', 'kind', 'summary', 'phase', 'workedMs', 'imageCount', 'detailRevision', 'text', 'turnId', 'status'];

/** 固定顺序且只复制展示用标量，内部对象不能借白名单字段进入缓存。 */
function displayFields(source, fields) {
  return Object.fromEntries(fields.filter(key => {
    const value = source?.[key];
    if (key === 'imageCount' || key === 'workedMs') return Number.isSafeInteger(value) && value >= 0;
    if (key === 'durationMs') return Number.isFinite(value) && value >= 0;
    return typeof value === 'string';
  }).map(key => [key, source[key]]));
}

/** 列表版本和预加载共用纯展示投影，不携带图片、权限或可操作的审批、问答目标。 */
export function conversationProjection(source) {
  const previews = questionPreviews(source);
  return {
    threadId: typeof source.threadId === 'string' ? source.threadId : '',
    title: typeof source.title === 'string' ? source.title : '未命名聊天',
    cwd: typeof source.cwd === 'string' ? source.cwd : '',
    messages: (source.messages ?? []).map(message => displayFields(executionPreview(message), MESSAGE_FIELDS)),
    turns: (source.turns ?? []).map(turn => displayFields(turn, ['turnId', 'status', 'durationMs', 'errorMessage'])),
    ...(source.latestTurn ? { latestTurn: displayFields(source.latestTurn, ['turnId', 'status']) } : {}),
    ...(previews.length ? { questionPreviews: previews } : {}),
  };
}

/** 版本只由可展示内容决定，实时 updatedAt、未读和运行状态均不参与。 */
export function conversationContentRevision(source) {
  const { threadId, ...content } = conversationProjection(source);
  return 'content:' + createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** 无实时快照时沿用索引的保存时间，绝不用当前时间伪造历史版本。 */
export function savedContentRevision(source) {
  return Number.isFinite(source?.updatedAt) ? 'saved:' + source.updatedAt : undefined;
}

/** 只读规范化已经存在的实时 entry，标题回退也不写回 entry 或原生状态。 */
export function existingConversationSnapshot(adapter, threadId) {
  const entry = adapter.conversations?.get(threadId);
  if (!entry?.state) return undefined;
  // 与 adapter.snapshot(state, undefined) 使用相同的默认消息窗口和标题优先级。
  const source = recentConversationPage(normalizeConversation(entry.state, RECENT_CONVERSATION_OPTIONS));
  let title = typeof entry.state.title === 'string' && entry.state.title.trim().length > 0 ? entry.state.title : undefined;
  if (!title) {
    let indexedTitle = entry.indexedTitle;
    if (!Object.hasOwn(entry, 'indexedTitle')) {
      try { indexedTitle = adapter.index?.readTitle?.(threadId) ?? ''; }
      catch { indexedTitle = ''; }
    }
    title = entry.lastTitle || indexedTitle || entry.state.fallbackSearchTitle;
  }
  if (typeof title === 'string' && title.trim().length > 0) source.title = title;
  return source;
}

/** 仅核对已有索引和内存，不建立订阅、不导航，也不触发原生已读同步。 */
export async function prefetchConversation(adapter, threadId, { isDeleting = () => false } = {}) {
  const verify = source => {
    if (isDeleting() || source?.archived || source?.deleted || source?.isArchived || source?.isDeleted) {
      throw new BridgeError('THREAD_NOT_FOUND', '这条聊天已不存在或已经归档，请刷新聊天列表');
    }
  };
  const verifyMembership = () => {
    if (typeof adapter.index?.containsThread === 'function' && !adapter.index.containsThread(threadId)) throw new BridgeError('THREAD_NOT_FOUND', '这条聊天已不存在或已经归档，请刷新聊天列表');
  };
  verify();
  verifyMembership();
  const entry = adapter.conversations?.get(threadId);
  verify(entry?.state);
  let source, contentRevision;
  if (entry?.state) {
    // 直接规范化已有状态，避免 adapter.snapshot 写入标题缓存或读取原生未读状态。
    source = existingConversationSnapshot(adapter, threadId);
    if (source.threadId !== threadId) throw new BridgeError('HISTORY_UNAVAILABLE', '此聊天的实时快照编号不一致');
    contentRevision = conversationContentRevision(source);
  } else {
    if (typeof adapter.index?.readHistory !== 'function') throw new BridgeError('HISTORY_UNAVAILABLE', '当前电脑暂不支持静默读取已保存历史');
    source = await adapter.index.readHistory(threadId);
    if (!source || source.threadId !== threadId) throw new BridgeError('HISTORY_UNAVAILABLE', '未取得此聊天的已保存历史');
    contentRevision = savedContentRevision(source);
    if (!contentRevision) throw new BridgeError('HISTORY_UNAVAILABLE', '已保存历史缺少稳定版本');
  }
  // 历史异步读取期间可能发生归档或删除，返回前再次核对，不能泄漏迟到快照。
  verify(source);
  verifyMembership();
  verify(adapter.conversations?.get(threadId)?.state);
  return {
    snapshot: { ...conversationProjection(source), readOnly: true, status: 'unknown', activeTurnId: '', approvals: [], questionGroups: [], updatedAt: 0 },
    contentRevision,
  };
}
