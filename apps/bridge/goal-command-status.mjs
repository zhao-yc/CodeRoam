import { requestFingerprint } from '../../packages/protocol/contracts.mjs';
import { normalizeGoal, goalRevision } from './goals.mjs';

const transitions = [
  { action: 'pause', before: 'active', after: 'paused' },
  ...['paused', 'blocked', 'usageLimited', 'budgetLimited'].map(before => ({ action: 'resume', before, after: 'active' })),
];

/** 只核对暂停或继续的最终状态；正文、预算及创建身份必须仍匹配原请求指纹。 */
function matches(fingerprint, threadId, goal, transition) {
  return fingerprint === requestFingerprint('thread.goal.update', { threadId, action: transition.action, expectedRevision: goalRevision({ ...goal, status: transition.before }) });
}

/** 核对未知目标请求只读桌面，不重放控件操作；其他操作继续保留原有未知状态。 */
export async function goalCommandStatus(adapter, journal, deviceId, commandId) {
  const original = journal.status(deviceId, commandId);
  if (original.state !== 'unknown' || typeof journal.unknownFingerprint !== 'function') return original;
  const fingerprint = journal.unknownFingerprint(deviceId, commandId);
  if (!fingerprint) return original;
  for (const [threadId, entry] of adapter.conversations ?? []) {
    if (!entry.watchers?.has(deviceId) || !entry.owner || !entry.state) continue;
    const cached = normalizeGoal(entry.state);
    if (!cached) continue;
    const transition = transitions.find(value => matches(fingerprint, threadId, cached, value));
    if (!transition) continue;
    try {
      const fresh = await adapter.readGoal(threadId, deviceId);
      if (!fresh.goal || fresh.goal.status !== transition.after || !matches(fingerprint, threadId, fresh.goal, transition)) return original;
      return journal.confirmObservedGoal(deviceId, commandId, fingerprint, { ok: true, commandId, ...fresh, reconciled: true });
    } catch { return original; }
  }
  return original;
}
