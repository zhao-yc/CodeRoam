export const TURN_FAILURE_FALLBACK = '任务执行失败，未提供具体原因';
export const MAX_TURN_ERROR_CHARACTERS = 6000;
export const TURN_METADATA_BUDGET_BYTES = 64 * 1024;
export const TURN_ERROR_TRUNCATED = '\n\n[错误内容已截断，请在电脑端查看完整原因]';
const BUDGET_OMISSION = '错误内容因同步大小限制已省略，请在电脑端查看完整原因';

/** 保留原文前缀并明确提示截断，不把受限内容伪装为完整错误。 */
function boundedErrorMessage(message) {
  if (message.length <= MAX_TURN_ERROR_CHARACTERS) return message;
  let prefix = message.slice(0, MAX_TURN_ERROR_CHARACTERS - TURN_ERROR_TRUNCATED.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + TURN_ERROR_TRUNCATED;
}

/** 审查终止必须同时具备中断状态和专用标记，单次工具拒绝不能改变整轮结果。 */
export function turnStatus(turn) {
  if (turn?.status === 'interrupted' && turn.items?.some(item => item.type === 'autoReviewInterruptionWarning')) return 'reviewStopped';
  return turn?.error || turn?.status === 'failed' ? 'failed' : turn?.status ?? '';
}

/** 仅同步错误原文与可见审查理由，禁止序列化审查动作、工具参数和内部堆栈。 */
export function turnMetadata(turn) {
  const status = turnStatus(turn);
  const review = status === 'reviewStopped' ? [...(turn.items ?? [])].reverse().find(item => item.type === 'automaticApprovalReview' && item.status === 'denied') : null;
  const rationale = typeof review?.rationale === 'string' ? review.rationale.trim() : '';
  let message = typeof turn.error === 'string' ? turn.error : turn.error?.message;
  if (status === 'reviewStopped') message = ['本轮操作已被自动审查终止', rationale].filter(Boolean).join('\n\n');
  return {
    turnId: turn.turnId, status,
    ...(Number.isFinite(turn.durationMs) && turn.durationMs >= 0 ? {durationMs: turn.durationMs} : {}),
    ...(['failed', 'reviewStopped'].includes(status) ? {errorMessage: typeof message === 'string' && message.trim() ? boundedErrorMessage(message) : TURN_FAILURE_FALLBACK} : {})
  };
}

/** 最新失败优先保留原因，其余先保留状态；预算按实际 JSON 的 UTF-8 字节计算。 */
export function boundedTurnMetadata(turns, latestTurnId, selectedTurnIds) {
  const candidates = [...new Map(turns.map(turn => [turn.turnId, turnMetadata(turn)])).values()];
  const newest = [...candidates].reverse();
  const latest = newest.find(turn => turn.turnId === latestTurnId);
  const priority = [...(latest ? [latest] : []), ...newest.filter(turn => turn !== latest && selectedTurnIds.has(turn.turnId)), ...newest.filter(turn => turn !== latest && !selectedTurnIds.has(turn.turnId))];
  const kept = new Map();
  const cost = turn => Buffer.byteLength(JSON.stringify(turn)) + 1;
  let bytes = 2;
  for (const turn of priority) {
    const base = turn === latest || !['failed', 'reviewStopped'].includes(turn.status) ? turn : {...turn, errorMessage:BUDGET_OMISSION};
    const size = cost(base);
    if (bytes + size > TURN_METADATA_BUDGET_BYTES) continue;
    kept.set(turn.turnId, base); bytes += size;
  }
  for (const turn of priority) {
    const base = kept.get(turn.turnId);
    if (!base || base === turn) continue;
    const nextBytes = bytes - cost(base) + cost(turn);
    if (nextBytes <= TURN_METADATA_BUDGET_BYTES) {kept.set(turn.turnId, turn); bytes = nextBytes;}
  }
  return candidates.filter(turn => kept.has(turn.turnId)).map(turn => kept.get(turn.turnId));
}

/** 只有已加载到时间线末端才声明最新轮次，历史岛或分页不能冒充当前状态。 */
export function latestTurnSummary(state, turns) {
  const history = state.turnHistory?.history;
  if (history?.entitiesByKey) {
    const island = history.islands?.at(-1);
    const lastEntry = island?.entries?.at(-1);
    if (island?.newerBoundary?.status !== 'exhausted' || !history.entitiesByKey[lastEntry?.value]) return undefined;
  }
  const latest = turns.at(-1);
  return typeof latest?.turnId === 'string' && latest.turnId ? {turnId: latest.turnId, status: turnStatus(latest)} : undefined;
}

/** 投影中的空 JSON 不算错误；损坏但非空的错误记录仍按失败显示通用原因。 */
export function projectedTurnMetadata(saved, turnId, limit = Number.MAX_SAFE_INTEGER) {
  const complete = saved && Number.isSafeInteger(saved.rollout_end_ordinal) && saved.rollout_end_ordinal < limit;
  let error;
  if (complete && saved.error_json) {
    try { error = JSON.parse(saved.error_json); }
    catch { error = {}; }
  }
  return turnMetadata({turnId, status: complete ? saved.status : '', error, ...(complete ? {durationMs: saved.duration_ms} : {})});
}
