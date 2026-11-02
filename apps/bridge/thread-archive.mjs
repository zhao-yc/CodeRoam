import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { normalizeConversation } from './conversation.mjs';
import { randomUUID } from 'node:crypto';

/** 由原桌面工具归档已有所有者的会话，不修改 Codex 索引或启动执行轮次。 */
export async function archiveThread(adapter, nativeClient, threadId, deviceId, checkpoint = () => {}, commandId = randomUUID()) {
  const entry = adapter.subscribed(threadId, deviceId), owner = entry.owner;
  const deadline=Date.now()+14000;
  const verify=async()=>{
    await adapter.watch(threadId, deviceId, { fresh: true, history: false });
    if (adapter.subscribed(threadId, deviceId) !== entry || entry.owner?.clientId !== owner.clientId || entry.owner?.hostId !== owner.hostId) throw new BridgeError('THREAD_CHANGED', '聊天连接已变化，请重新同步后归档');
    if (!adapter.index?.containsThread(threadId)) throw new BridgeError('THREAD_NOT_FOUND', '聊天已不存在或已经归档，请刷新列表');
    const snapshot = normalizeConversation(entry.state);
    // 原生归档可能卸载会话；运行或等待审批时先让用户完成或停止任务。
    if (snapshot.status !== 'idle' || snapshot.activeTurnId || snapshot.approvals.length || snapshot.questionGroups.some(group => group.kind === 'native' && group.state === 'pending')) throw new BridgeError('THREAD_BUSY', '请先完成或停止当前任务，再归档聊天');
  };
  await verify();
  await nativeClient.archive({threadId,hostId:owner.hostId,commandId,deadline},verify);
  const result = { threadId, archived: true };
  try {
    checkpoint(result);
    for (const watcher of [...entry.watchers]) adapter.unwatch(threadId, watcher);
  } catch {
    throw new BridgeError('ARCHIVE_OUTCOME_UNKNOWN', '电脑已归档，连接服务仍需核对回执', true);
  }
  return result;
}
