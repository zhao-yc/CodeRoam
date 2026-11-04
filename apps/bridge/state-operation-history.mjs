import { historyThreadTitle, migrateHistoryTitles } from './history-thread-title.mjs';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

const TITLES = { 'thread.sync': '重新同步聊天', 'thread.read': '标记为已读' };
const DAY = 86400000;

/** 状态操作独立留痕，不领取提交队列执行槽，也不改变其暂停状态。 */
export class StateOperationHistory {
  constructor({ db, readTitle = () => '', now = Date.now }) {
    this.readTitle = readTitle; this.db = db; this.now = now; this.pending = new Map(); this.reads = new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS state_operation_history (
      position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL, request_id TEXT NOT NULL, method TEXT NOT NULL,
      thread_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, completed_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(device_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS state_operation_device ON state_operation_history(device_id,completed_at,position);`);
    migrateHistoryTitles(db, 'state_operation_history', readTitle);
    // 只标注中断结果，不恢复执行，更不能暂停另一类任务。
    db.prepare("UPDATE state_operation_history SET state='unknown',error='上次操作中断，结果未确认',completed_at=? WHERE state='running'").run(now());
    this.cleanup();
  }

  /** 同编号只执行一次；已完成同步重读后台快照，绝不再次导航桌面。 */
  run({ deviceId, requestId, method, threadId, alreadyRead = false }, execute, duplicate = async () => ({ threadId, read: true })) {
    if (!Object.hasOwn(TITLES, method)) throw new BridgeError('METHOD_NOT_ALLOWED', '此状态操作不支持记录');
    const key = JSON.stringify([deviceId, requestId]);
    const previous = this.db.prepare('SELECT * FROM state_operation_history WHERE device_id=? AND request_id=?').get(deviceId, requestId);
    if (previous && (previous.method !== method || previous.thread_id !== threadId)) throw new BridgeError('REQUEST_ID_REUSED', '同一操作编号不能用于不同操作');
    if (this.pending.has(key)) return this.pending.get(key);
    if (previous) {
      if (previous.state === 'succeeded') return duplicate();
      throw new BridgeError(previous.state === 'failed' ? 'STATE_OPERATION_FAILED' : 'OUTCOME_UNKNOWN', previous.error, previous.state !== 'failed');
    }
    const readKey = method === 'thread.read' ? JSON.stringify([deviceId, threadId]) : null;
    if (readKey && this.reads.has(readKey)) return this.reads.get(readKey);
    this.cleanup();
    // 原生仍明确为已读时，合并连续成功确认；新未读或未知状态会留下新的记录。
    const coalesced = method === 'thread.read' && alreadyRead && this.db.prepare('SELECT state FROM state_operation_history WHERE device_id=? AND thread_id=? AND method=? ORDER BY completed_at DESC,position DESC LIMIT 1').get(deviceId, threadId, method)?.state === 'succeeded';
    const time = this.now(), id = randomUUID();
    const insert = () => this.db.prepare('INSERT INTO state_operation_history(id,device_id,request_id,method,thread_id,thread_title,state,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, deviceId, requestId, method, threadId, historyThreadTitle(this.readTitle, threadId), 'running', time);
    if (!coalesced) insert();
    const operation = Promise.resolve().then(execute).then(result => {
      if (!coalesced) this.db.prepare("UPDATE state_operation_history SET state='succeeded',completed_at=? WHERE id=?").run(this.now(), id);
      return result;
    }, error => {
      if (coalesced) insert();
      // 只保存受控错误说明，不保存原生回执、正文、路径或未知异常文本。
      const unknown = error?.outcomeUnknown === true || /TIMEOUT|UNAVAILABLE|CLOSED/.test(error?.code ?? '');
      const message = unknown ? '电脑未确认操作结果，请核对后重新操作' : error?.code === 'SUBSCRIPTION_CANCELED' ? '聊天已切换，操作已取消' : '状态操作未完成，请检查电脑连接后重试';
      this.db.prepare('UPDATE state_operation_history SET state=?,error=?,completed_at=? WHERE id=?').run(unknown ? 'unknown' : 'failed', message, this.now(), id);
      throw error;
    }).finally(() => { this.pending.delete(key); if (readKey) this.reads.delete(readKey); });
    this.pending.set(key, operation);
    if (readKey) this.reads.set(readKey, operation);
    return operation;
  }

  /** 两类历史分别分页，游标只能引用当前设备的状态操作记录。 */
  list(deviceId, { before, limit = 30, state } = {}) {
    this.cleanup();
    const conditions = ['device_id=?'], values = [deviceId];
    if (before !== undefined) {
      const anchor = this.db.prepare('SELECT completed_at FROM state_operation_history WHERE device_id=? AND position=?').get(deviceId, before);
      if (!anchor) throw new BridgeError('TASK_HISTORY_CHANGED', '状态操作记录已变化，请刷新后继续查看');
      conditions.push('(completed_at<? OR (completed_at=? AND position<?))'); values.push(anchor.completed_at, anchor.completed_at, before);
    }
    if (state) { conditions.push('state=?'); values.push(state); }
    const count = Math.max(1, Math.min(100, limit));
    const rows = this.db.prepare('SELECT * FROM state_operation_history WHERE ' + conditions.join(' AND ') + ' ORDER BY completed_at DESC,position DESC LIMIT ?').all(...values, count + 1);
    const tasks = rows.slice(0, count).map(row => ({ id: row.id, position: row.position, kind: 'operation', method: row.method, title: TITLES[row.method], threadTitle: row.thread_title ?? '', threadId: row.thread_id, projectId: '', state: row.state, stage: row.state === 'running' ? '等待电脑确认' : '', error: row.error, createdAt: row.created_at, startedAt: row.created_at, completedAt: row.completed_at, updatedAt: row.completed_at || row.created_at, dismissed: false, steps: [], canRetry: false }));
    return { supportsTaskQueue: true, supportsOperationHistory: true, revision: 0, paused: false, blockerId: '', tasks, now: this.now(), ...(rows.length > count ? { nextCursor: tasks.at(-1).position } : {}) };
  }

  /** 状态操作保留最近三十天、每设备最多一千条结果，运行中的操作不清理。 */
  cleanup() {
    this.db.prepare("DELETE FROM state_operation_history WHERE state!='running' AND completed_at<?").run(this.now() - 30 * DAY);
    this.db.exec("DELETE FROM state_operation_history WHERE position IN (SELECT position FROM (SELECT position,ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY completed_at DESC,position DESC) AS rank FROM state_operation_history WHERE state!='running') WHERE rank>1000)");
  }
}
