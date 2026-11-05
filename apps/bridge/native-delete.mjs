import { BridgeError } from '../../packages/protocol/contracts.mjs';

/** 原桌面先释放会话写入者，再由同一用户目录的官方接口永久删除；两种启动方式共用此流程。 */
export class NativeDeleteController {
  constructor({ adapter, archiveController, creation }) {
    this.adapter = adapter;
    this.archiveController = archiveController;
    this.creation = creation;
  }

  async delete(params, beforeCommit) {
    const { threadId, hostId, commandId, deadline, deletionTree, verifyArchive } = params;
    if (hostId !== 'local' || !this.creation?.run || !deletionTree?.length || deletionTree[0].id !== threadId) {
      throw new BridgeError('DELETE_UNSUPPORTED', '当前连接尚未提供完整的原生删除接口，请更新电脑连接服务');
    }
    const ids = deletionTree.map(item => item.id);
    let committed = false;
    const observedDeleted = targets => {
      try { return this.adapter.index.existingThreadIds(targets).length === 0; }
      catch { return false; } // 索引不可读时保留未知，不能将只读核对失败当作明确未提交。
    };
    const assertCurrent = async () => {
      if (Date.now() >= deadline) throw new BridgeError('DELETE_TIMEOUT', '删除未能在规定时间内完成');
      const client = this.adapter.client;
      client?.assertCurrent?.();
      await client?.instance?.verify?.();
      client?.assertCurrent?.();
    };
    try {
      // 初始化失败发生在归档前。辅助进程不加载或执行会话，也不直接写入原桌面数据库。
      await this.creation.run(this.creation.codexHome, async request => {
        await assertCurrent();
        await beforeCommit();
        for (const item of [...deletionTree].reverse()) {
          if (item.archived) continue;
          await this.archiveController.archive({ threadId: item.id, hostId, commandId: commandId + '-archive-' + item.id, deadline }, async () => {
            await assertCurrent();
            await verifyArchive(item);
            committed = true;
          });
        }
        // 归档只用于释放原持有者。仅在全部目标从含归档区的索引消失后才确认永久删除。
        for (const item of [...deletionTree].reverse()) {
          await assertCurrent();
          const current = this.adapter.index.readDeletionTree(threadId);
          if (current.some(row => !ids.includes(row.id) || !row.archived)) throw new BridgeError('THREAD_CHANGED', '删除范围或归档状态已变化，已停止删除');
          if (!this.adapter.index.existingThreadIds([item.id]).length) continue;
          committed = true;
          try { await request('thread/delete', { threadId: item.id }); }
          catch (error) {
            // 官方接口可能已删除但未回执。只读确认原编号，不重放请求。
            if (!observedDeleted([item.id])) throw error;
          }
        }
      });
    } catch (error) {
      if (committed) {
        if (observedDeleted(ids)) return;
        throw new BridgeError('DELETE_OUTCOME_UNKNOWN', '删除未完全确认，部分聊天可能已归档或删除，请核对原操作，勿重复提交', true);
      }
      if (error instanceof BridgeError && !error.code.startsWith('CREATION_')) throw error;
      throw new BridgeError('DELETE_UNAVAILABLE', '原生删除连接未就绪，聊天尚未删除，请稍后重试');
    }
  }
}
