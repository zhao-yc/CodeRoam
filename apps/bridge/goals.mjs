import { createHash } from 'node:crypto';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { GOAL_STATUSES, validateGoalUpdate } from '../../packages/protocol/goals.mjs';

/** 仅投影原桌面的目标字段，不从报告或普通消息推断目标。 */
export function normalizeGoal(state) {
  const source = state?.threadGoal;
  if (!source || source.threadId !== state.id || typeof source.objective !== 'string' || !GOAL_STATUSES.has(source.status)) return null;
  const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
  return { objective: source.objective.slice(0, 4000), status: source.status, tokenBudget: Number.isFinite(source.tokenBudget) && source.tokenBudget > 0 ? source.tokenBudget : null, tokensUsed: number(source.tokensUsed), timeUsedSeconds: number(source.timeUsedSeconds), createdAt: number(source.createdAt), updatedAt: number(source.updatedAt) };
}

/** 使用目标内容和生命周期生成稳定版本；清除目标后回到明确的空版本。 */
export function goalRevision(goal) {
  // 原生 updatedAt 也会随用量记账变化，不能把它当作内容版本。
  return goal ? createHash('sha256').update(JSON.stringify([goal.objective, goal.status, goal.tokenBudget, goal.createdAt])).digest('hex') : 'none';
}

/** 所有读写要求已有实时订阅，操作后只采用桌面广播的最终状态。 */
export async function readGoal(adapter, threadId, deviceId, deadline = Date.now() + 10000) {
  const entry = adapter.subscribed(threadId, deviceId), owner = entry.owner;
  if (Date.now() >= deadline) throw new BridgeError('GOAL_READ_UNAVAILABLE', '目标读取未完成，请刷新后核对');
  await adapter.watch(threadId, deviceId, { fresh: true, history: false, snapshotTimeoutMs: Math.max(1, Math.min(6000, deadline - Date.now() - 500)) });
  if (adapter.subscribed(threadId, deviceId) !== entry || entry.owner?.clientId !== owner.clientId || entry.owner?.hostId !== owner.hostId) throw new BridgeError('GOAL_CHANGED', '聊天所有者已变化，请重新同步目标');
  if (!Object.hasOwn(entry.state, 'threadGoal')) throw new BridgeError('GOAL_UNSUPPORTED', '当前桌面暂不支持目标，请更新电脑端');
  const goal = normalizeGoal(entry.state);
  if (entry.state.threadGoal != null && goal == null) throw new BridgeError('GOAL_UNSUPPORTED', '电脑端目标格式已变化，请更新连接服务');
  return { goal, goalRevision: goalRevision(goal), supportsGoals: true, supportsGoalControl: adapter.goalController.available };
}

export async function updateGoal(adapter, params, commandId, deviceId) {
  const deadline = Date.now() + 25000;
  validateGoalUpdate(params);
  let current = await readGoal(adapter, params.threadId, deviceId, deadline);
  const verify = async () => {
    const latest = await readGoal(adapter, params.threadId, deviceId, deadline);
    if (latest.goalRevision !== params.expectedRevision) throw new BridgeError('GOAL_CHANGED', '电脑端目标已经变化，请刷新后重新操作');
    const exists = latest.goal !== null;
    if (params.action === 'create' ? exists : !exists) throw new BridgeError('GOAL_CHANGED', exists ? '此聊天已有目标，请刷新后编辑' : '目标已清除，请刷新后新建');
    if (params.action === 'pause' && latest.goal.status !== 'active') throw new BridgeError('GOAL_CHANGED', '目标当前未运行，请刷新后核对');
    if (params.action === 'resume' && !['paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(latest.goal.status)) throw new BridgeError('GOAL_CHANGED', '目标当前无需继续，请刷新后核对');
    return latest;
  };
  current = await verify();
  const entry = adapter.subscribed(params.threadId, deviceId);
  await adapter.goalController.perform({ ...params, commandId, title: entry.state.title ?? entry.state.fallbackSearchTitle ?? '', previousGoal: current.goal, deadline }, verify);
  // 原生按钮提交后可能先收到旧快照，有限回读，不重放任何界面操作。
  try { while (Date.now() < deadline) {
    const result = await readGoal(adapter, params.threadId, deviceId, deadline);
    const goal = result.goal;
    const matched = params.action === 'clear' ? goal === null
      : params.action === 'pause' ? goal?.status === 'paused'
      : params.action === 'resume' ? goal !== null && goal.status === 'active'
      : goal !== null && goal.objective === params.objective.trim();
    if (matched) return { ok: true, commandId, ...result };
    await new Promise(resolve => setTimeout(resolve, 180));
  } } catch (error) { error.outcomeUnknown = true; throw error; }
  throw new BridgeError('GOAL_OUTCOME_UNKNOWN', '桌面尚未确认目标操作，请先核对结果', true);
}
