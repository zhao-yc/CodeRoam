export const GOAL_ACTIONS = new Set(['create', 'edit', 'pause', 'resume', 'clear']);
export const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);

/** 目标操作仅接受固定字段；版本不包含持续增长的用量，避免正常输出使操作失效。 */
export function validateGoalUpdate(params) {
  const fail = () => { throw Object.assign(new Error('目标操作参数无效，请刷新后重试'), { code: 'BAD_PARAMS' }); };
  if (Object.keys(params).some(key => !['threadId', 'action', 'objective', 'expectedRevision'].includes(key))) fail();
  if (!GOAL_ACTIONS.has(params.action) || typeof params.expectedRevision !== 'string' || !/^(none|[a-f0-9]{64})$/.test(params.expectedRevision)) fail();
  if (['create', 'edit'].includes(params.action)) {
    if (typeof params.objective !== 'string' || !params.objective.trim() || params.objective.length > 4000) fail();
  } else if (params.objective !== undefined) fail();
  return params;
}
