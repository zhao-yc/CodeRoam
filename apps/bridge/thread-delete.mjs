import { randomUUID } from 'node:crypto';
import { BridgeError, requestFingerprint } from '../../packages/protocol/contracts.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const idle = snapshot => snapshot.status === 'idle' && !snapshot.activeTurnId && !snapshot.approvals.length && !snapshot.questionGroups.some(group => group.kind === 'native' && group.state === 'pending');

/** 只停止已核对的原桌面任务；永久删除始终交给原桌面的删除流程。 */
export async function deleteThread(adapter, controller, threadId, deviceId, checkpoint = () => {}, commandId = randomUUID(), lockRelated = async () => () => {}) {
  const entry = adapter.subscribed(threadId, deviceId), owner = { ...entry.owner };
  const deadline = Date.now() + 50000, watcher = 'delete:' + commandId;
  const observed = new Map(), temporary = new Set();
  let release = () => {}, committed = false;
  const assertTime = () => { if (Date.now() >= deadline) throw new BridgeError('DELETE_TIMEOUT', '删除准备超时，对话尚未确认删除，请重新核对'); };
  const rootCurrent = () => {
    const current = adapter.subscribed(threadId, deviceId);
    if (current !== entry || current.owner?.clientId !== owner.clientId || current.owner?.hostId !== owner.hostId) throw new BridgeError('THREAD_CHANGED', '会话连接已变化，已停止删除');
  };
  try {
    rootCurrent();
    if (owner.hostId !== 'local') throw new BridgeError('DELETE_UNSUPPORTED', '此类会话暂不支持手机永久删除，请在原桌面操作');
    const tree = adapter.index.readDeletionTree(threadId);
    if (!tree.length || tree[0].id !== threadId) throw new BridgeError('THREAD_NOT_FOUND', '目标对话已不存在，请刷新列表');
    const ids = tree.map(item => item.id), fingerprint = JSON.stringify(tree);
    release = await lockRelated(ids);
    // 子对话只能从只读索引的关联关系派生，手机不能提交任意删除编号。
    const refresh = async item => {
      assertTime();
      const found = await adapter.discoverOwner(item.id, 800);
      if (observed.has(item.id)) {
        const previous = observed.get(item.id);
        if (previous?.clientId !== found?.clientId || previous?.hostId !== found?.hostId) throw new BridgeError('THREAD_CHANGED', '关联对话的连接已变化，已停止删除');
      } else observed.set(item.id, found);
      if (!found) {
        if (item.id === threadId) throw new BridgeError('OWNER_UNAVAILABLE', '目标对话的原桌面连接已不可用');
        return null;
      }
      if (found.hostId !== owner.hostId) throw new BridgeError('THREAD_CHANGED', '关联对话不属于当前电脑，已停止删除');
      temporary.add(item.id);
      const snapshot = await adapter.watch(item.id, watcher, { fresh: true, history: false, ownerTimeoutMs: 800, snapshotTimeoutMs: 2000 });
      rootCurrent();
      return snapshot;
    };
    for (const item of tree) {
      const snapshot = await refresh(item);
      if (!snapshot || idle(snapshot)) continue;
      if (!snapshot.activeTurnId) throw new BridgeError('DELETE_STOP_FAILED', '无法确认待停止的任务，对话尚未删除');
      const turnId = snapshot.activeTurnId;
      try { await adapter.operate('turn.stop', { threadId: item.id, expectedTurnId: turnId }, commandId + '-stop-' + item.id, watcher); }
      catch { throw new BridgeError('DELETE_STOP_FAILED', '未能确认任务停止，对话尚未删除，请核对原桌面任务状态'); }
      // 停止请求被接收并不代表任务已停止；必须等待新的原桌面快照。
      while (true) {
        const stopped = await refresh(item);
        if (!stopped) throw new BridgeError('DELETE_STOP_FAILED', '停止后无法核对任务状态，对话尚未删除');
        if (idle(stopped)) break;
        if (stopped.activeTurnId && stopped.activeTurnId !== turnId) throw new BridgeError('THREAD_CHANGED', '停止期间启动了新的任务，已停止删除');
        if (Date.now() + 250 >= deadline - 10000) throw new BridgeError('DELETE_STOP_FAILED', '任务尚未确认停止，对话尚未删除');
        await pause(200);
      }
    }
    const verify = async () => {
      assertTime(); rootCurrent();
      if (JSON.stringify(adapter.index.readDeletionTree(threadId)) !== fingerprint) throw new BridgeError('THREAD_CHANGED', '关联对话已变化，请重新确认删除范围');
      for (const item of tree) {
        const snapshot = await refresh(item);
        if (snapshot && !idle(snapshot)) throw new BridgeError('THREAD_BUSY', '任务状态已变化，对话尚未删除，请重新确认');
      }
      // 在真正删除前保存范围；进程中断后仍能只读核对全部目标是否已消失。
      checkpoint({ deletionPending: true, threadId, deletedThreadIds: ids });
    };
    // 控制器负责区分“尚未点击”与“提交后未知”；仅保存核对范围不代表删除已经发生。
    await controller.delete({ threadId, hostId: owner.hostId, commandId, deadline, native: adapter.native }, verify);
    committed = true;
    if (adapter.index.existingThreadIds(ids).length) throw new BridgeError('DELETE_OUTCOME_UNKNOWN', '删除尚未全部确认，请核对原操作结果，勿重复提交', true);
    const result = { threadId, deleted: true, deletedThreadIds: ids };
    checkpoint(result);
    for (const id of ids) for (const subscriber of [...adapter.conversations.get(id)?.watchers ?? []]) adapter.unwatch(id, subscriber);
    return result;
  } catch (error) {
    if (committed) throw new BridgeError('DELETE_OUTCOME_UNKNOWN', '永久删除结果需要核对，请勿重复提交', true);
    throw error;
  } finally {
    for (const id of temporary) adapter.unwatch(id, watcher);
    release();
  }
}

/** 已提交但回执丢失时只读原生索引；归档或仅部分删除都不能确认成功。 */
export function deletionCommandStatus(adapter, journal, deviceId, commandId) {
  const original = journal.status(deviceId, commandId), pending = original.result;
  if (original.state !== 'unknown' || pending?.deletionPending !== true || typeof pending.threadId !== 'string' || !Array.isArray(pending.deletedThreadIds) || !pending.deletedThreadIds.includes(pending.threadId)) return original;
  const fingerprint = journal.unknownFingerprint(deviceId, commandId);
  if (fingerprint !== requestFingerprint('thread.delete', { threadId: pending.threadId })) return original;
  try {
    if (adapter.index.existingThreadIds(pending.deletedThreadIds).length) return original;
    return journal.confirmObservedDeletion(deviceId, commandId, fingerprint, { threadId: pending.threadId, deleted: true, deletedThreadIds: pending.deletedThreadIds });
  } catch { return original; }
}
