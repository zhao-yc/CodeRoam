import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { BridgeError, requestFingerprint } from '../../packages/protocol/contracts.mjs';

const EVENT_COUNT_LIMIT = 2000;
const EVENT_BYTES_LIMIT = 4 * 1024 * 1024;

/** 实例核验明确拒绝时，文案里的超时属于探测阶段，不能覆盖执行结果。 */
export function isCommandOutcomeUnknown(error) {
  if (error?.code === 'INSTANCE_NOT_READY' && error.outcomeUnknown === false) return false;
  return error?.outcomeUnknown === true || /超时|连接已关闭|not-connected|timeout/i.test(error?.message ?? '');
}

/** 展示事件只驻留内存，操作结果及时写入自有账本，绝不向 Codex 数据库写入。 */
export class Journal {
  constructor(filePath = ':memory:') {
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (device_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, payload TEXT, PRIMARY KEY(device_id,command_id));
      CREATE TABLE IF NOT EXISTS question_submissions (thread_id TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY(thread_id,group_id));
      CREATE TABLE IF NOT EXISTS conversation_cache (
        thread_id TEXT PRIMARY KEY, revision TEXT NOT NULL, snapshot TEXT NOT NULL,
        previous_revision TEXT, previous_snapshot TEXT, saved_source TEXT NOT NULL, touched_at INTEGER NOT NULL
      );
    `);
    // 展示流只在本进程内续接；重启更换代次，旧游标必须重新取得完整窗口。
    this.epoch = randomUUID();
    this.eventSequence = 0; this.eventRows = []; this.eventBytes = 0; this.eventDiscardedThrough = 0; this.closed = false;
    this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('epoch', this.epoch);
    // 旧展示事件不作为执行账本；仅启动时清理，commands 和任务表仍保留原持久化语义。
    this.db.exec('DELETE FROM events');
    // 上次进程退出时未收口的操作不能自动重放，结果需要通过会话状态核对。
    this.db.prepare("UPDATE commands SET state='unknown' WHERE state='pending'").run();
  }

  /** 热事件只序列化一次；队列保留不可变字符串，调用方修改快照不会污染重放。 */
  append(threadId, payload) {
    if (this.closed) throw new Error('账本已关闭，不能继续发布聊天事件');
    const seq = this.eventSequence + 1;
    const event = { ...payload, v: 1, type: 'event', epoch: this.epoch, seq, threadId };
    const serialized = JSON.stringify(event), bytes = Buffer.byteLength(serialized);
    this.eventSequence = seq;
    this.eventRows.push({ threadId, seq, serialized, bytes }); this.eventBytes += bytes;
    while (this.eventRows.length > EVENT_COUNT_LIMIT || this.eventBytes > EVENT_BYTES_LIMIT) {
      const discarded = this.eventRows.shift();
      this.eventBytes -= discarded.bytes; this.eventDiscardedThrough = Math.max(this.eventDiscardedThrough, discarded.seq);
    }
    return event;
  }

  /** 序号属于本进程展示流，不访问执行账本或旧事件表。 */
  latestSeq() {
    if (this.closed) throw new Error('账本已关闭，无法读取聊天事件游标');
    return this.eventSequence;
  }

  /** 全局淘汰水位保守拒绝缺口；不同会话占用序号造成的正常跳号不视为缺帧。 */
  replay(threadId, epoch, afterSeq) {
    if (this.closed || epoch !== this.epoch || !Number.isSafeInteger(afterSeq) || afterSeq < this.eventDiscardedThrough || afterSeq < 0 || afterSeq > this.eventSequence) return null;
    return this.eventRows.filter(row => row.threadId === threadId && row.seq > afterSeq).map(row => JSON.parse(row.serialized));
  }

  status(deviceId, commandId) {
    const row = this.db.prepare('SELECT state,payload FROM commands WHERE device_id=? AND command_id=?').get(deviceId, commandId);
    return row ? { state: row.state, ...(row.payload ? JSON.parse(row.payload) : {}) } : { state: 'not_found' };
  }

  /** 保留操作回执用于去重，移除已永久删除对话的桥接历史缓存。 */
  forgetThreads(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const forgotten = new Set(ids);
    this.eventRows = this.eventRows.filter(row => {
      if (!forgotten.has(row.threadId)) return true;
      this.eventBytes -= row.bytes; this.eventDiscardedThrough = Math.max(this.eventDiscardedThrough, row.seq);
      return false;
    });
    this.db.prepare('DELETE FROM question_submissions WHERE thread_id IN (' + placeholders + ')').run(...ids);
    this.db.prepare('DELETE FROM conversation_cache WHERE thread_id IN (' + placeholders + ')').run(...ids);
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_list_index'").get())this.db.prepare('DELETE FROM thread_list_index WHERE id IN ('+placeholders+')').run(...ids);
  }

  /** 仅按原请求指纹和完整删除范围收口未知结果，不重放删除。 */
  confirmObservedDeletion(deviceId, commandId, fingerprint, result) {
    const previous = this.db.prepare("SELECT payload FROM commands WHERE device_id=? AND command_id=? AND fingerprint=? AND state='unknown'").get(deviceId, commandId, fingerprint);
    if (!previous) return this.status(deviceId, commandId);
    this.forgetThreads(result.deletedThreadIds);
    const payload = { result, resolution: { source: 'desktop-deletion-state', confirmedAt: Date.now(), previousError: previous.payload ? JSON.parse(previous.payload).error ?? null : null } };
    this.db.prepare("UPDATE commands SET state='done',payload=? WHERE device_id=? AND command_id=? AND fingerprint=? AND state='unknown'").run(JSON.stringify(payload), deviceId, commandId, fingerprint);
    return this.status(deviceId, commandId);
  }

  /** 只提供当前设备未知请求的指纹，不能跨设备查询或重放操作。 */
  unknownFingerprint(deviceId, commandId) {
    return this.db.prepare("SELECT fingerprint FROM commands WHERE device_id=? AND command_id=? AND state='unknown'").get(deviceId, commandId)?.fingerprint ?? null;
  }

  /** 原请求及目标身份已核对后，以桌面最终状态收口，保留原未知错误供审计。 */
  confirmObservedGoal(deviceId, commandId, fingerprint, result) {
    const row = this.db.prepare("SELECT payload FROM commands WHERE device_id=? AND command_id=? AND fingerprint=? AND state='unknown'").get(deviceId, commandId, fingerprint);
    if (!row) return this.status(deviceId, commandId);
    const previous = row.payload ? JSON.parse(row.payload) : {};
    const payload = { result, resolution: { source: 'desktop-goal-state', confirmedAt: Date.now(), previousError: previous.error ?? null } };
    this.db.prepare("UPDATE commands SET state='done',payload=? WHERE device_id=? AND command_id=? AND fingerprint=? AND state='unknown'").run(JSON.stringify(payload), deviceId, commandId, fingerprint);
    return this.status(deviceId, commandId);
  }

  /** 权限核对只收口原指纹对应的最终状态，不重放权限切换。 */
  confirmObservedPermission(deviceId, commandId, fingerprint, result) {
    const row = this.db.prepare("SELECT payload FROM commands WHERE device_id=? AND command_id=? AND fingerprint=? AND state='unknown'").get(deviceId, commandId, fingerprint);
    if (!row) return this.status(deviceId, commandId);
    const previous = row.payload ? JSON.parse(row.payload) : {};
    const payload = { result, resolution: { source: 'desktop-permission-state', confirmedAt: Date.now(), previousError: previous.error ?? null } };
    this.db.prepare("UPDATE commands SET state='done',payload=? WHERE device_id=? AND command_id=? AND fingerprint=? AND state='unknown'").run(JSON.stringify(payload), deviceId, commandId, fingerprint);
    return this.status(deviceId, commandId);
  }

  /** 创建得到编号后立即存入自有账本，后续持久化失败仍能核对已创建的目标。 */
  checkpoint(deviceId, commandId, result) {
    this.db.prepare("UPDATE commands SET payload=? WHERE device_id=? AND command_id=? AND state='pending'").run(JSON.stringify({ result }), deviceId, commandId);
  }

  async execute(deviceId, commandId, method, params, operation) {
    const fingerprint = requestFingerprint(method, params);
    const previous = this.db.prepare('SELECT * FROM commands WHERE device_id=? AND command_id=?').get(deviceId, commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new BridgeError('REQUEST_ID_REUSED', '同一请求编号不能用于不同操作');
      if (previous.state !== 'done') throw new BridgeError('OUTCOME_UNKNOWN', '操作已经提交，正在核对执行结果，请勿重新发送', true);
      const result = JSON.parse(previous.payload);
      if (result.error) throw Object.assign(new BridgeError(result.error.code, result.error.message, result.error.outcomeUnknown), result.error);
      return result.result;
    }
    this.db.prepare('INSERT INTO commands(device_id,command_id,fingerprint,state) VALUES (?,?,?,?)').run(deviceId, commandId, fingerprint, 'pending');
    let claimed=false;
    try {
      // 题组级占位跨手机、跨请求编号、跨进程重启防重复，未知结果继续保留。
      if(method==='question.reply') {
        claimed=this.db.prepare('INSERT OR IGNORE INTO question_submissions(thread_id,group_id) VALUES (?,?)').run(params.threadId,params.questionGroupId).changes===1;
        if(!claimed) throw new BridgeError('QUESTION_SUBMITTED','这组回答已提交，请重新同步并核对结果');
      }
      const result = await operation();
      this.db.prepare("UPDATE commands SET state='done',payload=? WHERE device_id=? AND command_id=?").run(JSON.stringify({ result }), deviceId, commandId);
      return result;
    } catch (error) {
      const unknown = isCommandOutcomeUnknown(error);
      if(claimed&&!unknown)this.db.prepare('DELETE FROM question_submissions WHERE thread_id=? AND group_id=?').run(params.threadId,params.questionGroupId);
      const partial = this.db.prepare('SELECT payload FROM commands WHERE device_id=? AND command_id=?').get(deviceId, commandId)?.payload;
      const payload = { ...(partial ? JSON.parse(partial) : {}), error: { code: unknown ? 'OUTCOME_UNKNOWN' : error.code ?? 'OPERATION_FAILED', message: unknown ? '连接中断，操作结果需要核对' : error.message, outcomeUnknown: !!unknown } };
      this.db.prepare('UPDATE commands SET state=?,payload=? WHERE device_id=? AND command_id=?').run(unknown ? 'unknown' : 'done', JSON.stringify(payload), deviceId, commandId);
      if (unknown) throw new BridgeError('OUTCOME_UNKNOWN', payload.error.message, true);
      throw error;
    }
  }

  /** 释放展示正文引用；执行记录此前已按原路径及时写入 SQLite。 */
  close() {
    if (this.closed) return;
    this.closed = true; this.eventRows = []; this.eventBytes = 0; this.eventDiscardedThrough = this.eventSequence;
    this.db.close();
  }
}
