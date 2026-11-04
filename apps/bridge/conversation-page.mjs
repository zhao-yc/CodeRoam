// 手机首屏、实时推送和历史翻页共用一页预算；单条超长消息保留完整内容。
export const CONVERSATION_PAGE_SIZE = 20;
export const CONVERSATION_PAGE_BYTES = 24 * 1024;
export const RECENT_CONVERSATION_OPTIONS = { maxMessages: CONVERSATION_PAGE_SIZE, maxCharacters: Number.MAX_SAFE_INTEGER, preserveDialogue: false };

/** 返回连续的最近一页，按实际 UTF-8 大小限制，不跳过中间消息。 */
export function recentConversationPage(snapshot) {
  const source = snapshot.messages ?? [], messages = [];
  let bytes = 0;
  for (let index = source.length - 1; index >= 0; index--) {
    const message = source[index], size = Buffer.byteLength(JSON.stringify(message));
    if (messages.length && (messages.length >= CONVERSATION_PAGE_SIZE || bytes + size > CONVERSATION_PAGE_BYTES)) break;
    messages.unshift(message); bytes += size;
  }
  if (messages.length === source.length) return snapshot;
  const ids = new Set(messages.map(message => message.turnId));
  const turns = snapshot.turns ?? [];
  const first = turns.findIndex(turn => ids.has(turn.turnId));
  return { ...snapshot, messages, turns: turns.filter((turn, index) => ids.has(turn.turnId) || turn.turnId === snapshot.latestTurn?.turnId || first >= 0 && index >= first && turn.status === 'failed') };
}
