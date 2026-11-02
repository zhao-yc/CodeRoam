import { randomUUID } from 'node:crypto';
import { BridgeError, validatePluginIds } from '../../packages/protocol/contracts.mjs';
import { validateImages } from '../../packages/protocol/images.mjs';

const WATCHER = 'message-queue';

/** 队列只保存在连接服务自己的账本中；手机退出不影响已经确认入队的消息。 */
export class MessageQueue {
  constructor({ journal, adapter, exclusive, changed, blocked = () => false }) {
    this.db = journal.db; this.adapter = adapter; this.exclusive = exclusive; this.changed = changed; this.blocked = blocked;
    this.closed = false; this.pumping = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_queue (
      position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      thread_id TEXT NOT NULL, device_id TEXT NOT NULL, command_id TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
      previous_turn TEXT NOT NULL DEFAULT '', UNIQUE(device_id, command_id)
    )`);
    // 崩溃前已开始发送的消息必须人工核对，绝不能当作待发送消息重放。
    this.db.prepare("UPDATE message_queue SET state='unknown', error='发送结果需要核对，请先查看聊天；此消息不会自动重发' WHERE state='sending'").run();
    this.timer = setInterval(() => this.pump(), 1000); this.timer.unref();
  }

  rows(threadId) { return this.db.prepare('SELECT * FROM message_queue WHERE thread_id=? ORDER BY position').all(threadId); }

  /** 快照只公开展示信息和附件数量，不回传设备身份、图片正文或本地路径。 */
  decorate(snapshot) {
    const queuedMessages = this.rows(snapshot.threadId).map(row => {
      const payload = JSON.parse(row.payload);
      return { id: row.id, text: payload.text, imageCount: payload.images.length, attachmentCount: payload.attachments.length, state: row.state, error: row.error, ...(payload.plugins?.length ? { plugins: payload.plugins.map(({id,displayName}) => ({id,displayName})) } : {}) };
    });
    return { ...snapshot, supportsMessageQueue: true, supportsQueueEditing: true, queuedMessages };
  }

  async snapshot(threadId) {
    return this.adapter.watch(threadId, WATCHER, { fresh: true, history: false });
  }

  /** 入队与普通写操作共用会话锁、请求账本；仅确认保存后通知手机清空原草稿。 */
  async operate(params, commandId, deviceId) {
    const { threadId, queueAction } = params;
    if (this.blocked(threadId)) throw new BridgeError('DELETE_IN_PROGRESS', '该聊天正在删除，不能操作排队消息');
    if (queueAction === 'enqueue') {
      const pluginIds = validatePluginIds(params.pluginIds);
      const images = validateImages(params.images), text = params.text ?? '', attachments = params.attachments ?? [];
      if (typeof text !== 'string' || text.length > 32000 || (!text.trim() && !images.length && !attachments.length)) throw new BridgeError('BAD_PARAMS', '请输入消息或选择附件');
      if (this.rows(threadId).length >= 20) throw new BridgeError('QUEUE_FULL', '最多排队20条消息，请先处理已有消息');
      const snapshot = await this.snapshot(threadId);
      if (snapshot.readOnly) throw new BridgeError('HISTORY_READ_ONLY', '请先连接原桌面聊天再排队');
      let selection;
      try {
        selection = pluginIds.length ? await this.adapter.selectPlugins(threadId, WATCHER, pluginIds) : null;
        selection?.check();
      } catch (error) { this.release(threadId); throw error; }
      const plugins = selection?.plugins.map(({id,displayName}) => ({id,displayName}));
      const id = randomUUID();
      this.db.prepare("INSERT INTO message_queue(id,thread_id,device_id,command_id,payload,state) VALUES (?,?,?,?,?,'queued')").run(id, threadId, deviceId, commandId, JSON.stringify({ threadId, text, images, attachments, ...(plugins?.length ? {pluginIds: plugins.map(plugin => plugin.id), plugins} : {}) }));
      this.changed(threadId);
      return { ok: true, queued: true, queueId: id };
    }
    const row = this.rows(threadId).find(item => item.id === params.queueId);
    if (!row) throw new BridgeError('QUEUE_CHANGED', '这条排队消息已处理，请重新同步');
    if (row.device_id !== deviceId) throw new BridgeError('QUEUE_FORBIDDEN', '只能处理本设备发送的排队消息');
    if (queueAction === 'edit') return this.withdrawForEdit(row);
    if (queueAction === 'cancel') {
      this.db.prepare('DELETE FROM message_queue WHERE id=?').run(row.id); this.changed(threadId); this.release(threadId);
      return { ok: true, canceled: true };
    }
    if (queueAction !== 'steer' || row.state !== 'queued') throw new BridgeError('QUEUE_CHANGED', '这条消息已开始发送或需要核对，不能重复追加');
    const snapshot = await this.snapshot(threadId);
    if (!snapshot.activeTurnId || snapshot.activeTurnId !== params.expectedTurnId) throw new BridgeError('STALE_TURN', '当前任务已经变化，消息仍保留在队列中');
    return this.deliver(row, 'turn.steer', snapshot.activeTurnId);
  }

  /** 先停止自动投递，再回传完整草稿；手机确认恢复前保留可再次读取的撤回记录。 */
  withdrawForEdit(row) {
    if (!['queued', 'editing'].includes(row.state)) throw new BridgeError('QUEUE_CHANGED', '这条消息已开始发送或需要核对，不能撤回编辑');
    const payload = JSON.parse(row.payload);
    const attachments = payload.attachments.map(id => {
      const { metadata } = this.adapter.attachments.metadata(row.device_id, row.thread_id, id);
      if (!metadata.complete) throw new BridgeError('UPLOAD_INCOMPLETE', '原附件尚未就绪，消息仍保留，请先核对附件');
      return { id, name: metadata.name, size: metadata.size };
    });
    // 只返回原上传编号和显示信息，不允许手机获得服务器文件路径。
    const draft = { text: payload.text, images: payload.images, attachments, ...(payload.plugins?.length ? { plugins: payload.plugins.map(({ id, displayName }) => ({ id, displayName })) } : {}) };
    this.db.prepare("UPDATE message_queue SET state='editing',error='' WHERE id=?").run(row.id);
    this.changed(row.thread_id);
    return { ok: true, edited: true, queueId: row.id, draft };
  }

  /** 发送前先落盘占位；断线或超时保留未知状态，明确失败也暂停队列供用户处理。 */
  async deliver(row, method, previousTurn) {
    this.db.prepare("UPDATE message_queue SET state='sending', previous_turn=? WHERE id=?").run(previousTurn, row.id); this.changed(row.thread_id);
    try {
      // 展示名称只供队列快照使用；投递重新解析编号和最新名称，不信任持久化的标记。
      const { plugins, ...params } = JSON.parse(row.payload);
      const result = await this.adapter.operate(method, { ...params, expectedTurnId: previousTurn }, row.id, row.device_id);
      if (method === 'turn.steer') this.db.prepare('DELETE FROM message_queue WHERE id=?').run(row.id);
      else this.db.prepare("UPDATE message_queue SET state='dispatched' WHERE id=?").run(row.id);
      this.changed(row.thread_id); this.release(row.thread_id); return result;
    } catch (error) {
      const unknown = error.outcomeUnknown || /timeout|超时|连接已关闭|not-connected/i.test(error.message);
      // 空闲快照之后桌面先开始了另一任务时安全回队，绝不改为追加。
      const state = error.code === 'TURN_ACTIVE' || error.code === 'STALE_TURN' ? 'queued' : unknown ? 'unknown' : 'failed';
      const pluginFailure = ['PLUGIN_UNAVAILABLE','PLUGINS_UNAVAILABLE','PLUGINS_CHANGED'].includes(error.code);
      this.db.prepare('UPDATE message_queue SET state=?,error=? WHERE id=?').run(state, state === 'queued' ? '' : unknown ? '发送结果需要核对，请先查看聊天；此消息不会自动重发' : pluginFailure ? '所选插件已不可用或目录已变化，队列已暂停；请取消此消息并重新选择插件发送' : '发送失败，请核对聊天和附件后取消此消息并重新发送', row.id);
      this.changed(row.thread_id); throw error;
    }
  }

  /** 刷新原桌面事实后按先进先出发送；切页、重连和进程恢复都不依赖手机页面。 */
  async drain(threadId) {
    if (this.closed || this.blocked(threadId)) return;
    const rows = this.rows(threadId).filter(row => row.state !== 'editing'); if (!rows.length) return;
    const snapshot = await this.snapshot(threadId); if (this.closed) return;
    const head = rows[0];
    if (head.state === 'dispatched') {
      const latestTurn = snapshot.turns?.at(-1)?.turnId ?? snapshot.activeTurnId;
      // 收到成功回执还不够，必须观察到新轮次，防止桌面状态尚未广播时连发。
      if (latestTurn && latestTurn !== head.previous_turn) {
        this.db.prepare('DELETE FROM message_queue WHERE id=?').run(head.id); this.changed(threadId); this.release(threadId);
      }
      return;
    }
    if (head.state !== 'queued' || snapshot.status !== 'idle' || snapshot.activeTurnId || snapshot.readOnly || snapshot.approvals?.length || snapshot.pendingPlan || snapshot.questionGroups?.some(group => group.state === 'pending' && group.kind === 'native')) return;
    await this.deliver(head, 'turn.send', snapshot.turns?.at(-1)?.turnId ?? '');
  }

  async pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      const threads = this.db.prepare('SELECT DISTINCT thread_id FROM message_queue').all();
      await Promise.allSettled(threads.map(row => this.exclusive(row.thread_id, () => this.drain(row.thread_id))));
    } finally { this.pumping = false; }
  }

  release(threadId) { if (!this.rows(threadId).length) this.adapter.unwatch(threadId, WATCHER); }

  /** 归档或永久删除成功后撤销对应排队消息，避免以后重新唤醒会话。 */
  forget(threadIds) {
    for (const id of threadIds) { this.db.prepare('DELETE FROM message_queue WHERE thread_id=?').run(id); this.release(id); }
  }

  close() { this.closed = true; clearInterval(this.timer); }
}
