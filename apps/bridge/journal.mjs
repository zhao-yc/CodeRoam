import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { BridgeError, requestFingerprint } from '../../packages/protocol/contracts.mjs';

/** 在自有数据库中记录事件和操作结果，绝不向 Codex 数据库写入。 */
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
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('epoch', randomUUID());
    this.epoch = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('epoch').value;
    // 上次进程退出时未收口的操作不能自动重放，结果需要通过会话状态核对。
    this.db.prepare("UPDATE commands SET state='unknown' WHERE state='pending'").run();
  }

  append(threadId, payload) {
    const result = this.db.prepare('INSERT INTO events(thread_id,payload) VALUES (?,?)').run(threadId, JSON.stringify(payload));
    const seq = Number(result.lastInsertRowid);
    this.db.prepare('DELETE FROM events WHERE seq <= ?').run(seq - 2000);
    return { v: 1, type: 'event', epoch: this.epoch, seq, threadId, ...payload };
  }

  latestSeq() { return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq; }

  replay(threadId, epoch, afterSeq) {
    if (epoch !== this.epoch || !Number.isSafeInteger(afterSeq) || afterSeq < 0) return null;
    const oldest = this.db.prepare('SELECT MIN(seq) AS seq FROM events').get().seq;
    if (oldest !== null && afterSeq < oldest - 1) return null;
    return this.db.prepare('SELECT seq,payload FROM events WHERE thread_id=? AND seq>? ORDER BY seq').all(threadId, afterSeq).map(row => ({ v: 1, type: 'event', epoch: this.epoch, seq: row.seq, threadId, ...JSON.parse(row.payload) }));
  }

  status(deviceId, commandId) {
    const row = this.db.prepare('SELECT state,payload FROM commands WHERE device_id=? AND command_id=?').get(deviceId, commandId);
    return row ? { state: row.state, ...(row.payload ? JSON.parse(row.payload) : {}) } : { state: 'not_found' };
  }

  /** 保留操作回执用于去重，移除已永久删除对话的桥接历史缓存。 */
  forgetThreads(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare('DELETE FROM events WHERE thread_id IN (' + placeholders + ')').run(...ids);
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
      const unknown = error.outcomeUnknown || /超时|连接已关闭|not-connected|timeout/i.test(error.message);
      if(claimed&&!unknown)this.db.prepare('DELETE FROM question_submissions WHERE thread_id=? AND group_id=?').run(params.threadId,params.questionGroupId);
      const partial = this.db.prepare('SELECT payload FROM commands WHERE device_id=? AND command_id=?').get(deviceId, commandId)?.payload;
      const payload = { ...(partial ? JSON.parse(partial) : {}), error: { code: unknown ? 'OUTCOME_UNKNOWN' : error.code ?? 'OPERATION_FAILED', message: unknown ? '连接中断，操作结果需要核对' : error.message, outcomeUnknown: !!unknown } };
      this.db.prepare('UPDATE commands SET state=?,payload=? WHERE device_id=? AND command_id=?').run(unknown ? 'unknown' : 'done', JSON.stringify(payload), deviceId, commandId);
      if (unknown) throw new BridgeError('OUTCOME_UNKNOWN', payload.error.message, true);
      throw error;
    }
  }

  close() { this.db.close(); }
}
