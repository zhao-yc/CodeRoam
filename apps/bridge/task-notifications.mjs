import {turnStatus} from './turn-failure.mjs';

/** 通知只携带结构化身份，不把正文、问题答案或审批命令广播到列表。 */
export function taskNotificationState(turns, questions, approvals, plan) {
  const latest = turns.at(-1);
  const pending = questions.filter(group => group.state === 'pending').map(group => ({kind:'question', id:group.id, turnId:group.turnId}));
  pending.push(...approvals.map(item => ({kind:'approval', id:item.id, turnId:item.turnId})));
  if (plan) pending.push({kind:'plan', id:plan.id, turnId:plan.turnId});
  return {latestTurnId:latest?.turnId ?? '', latestTurnStatus:turnStatus(latest), pending};
}
