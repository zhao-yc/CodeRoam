import { historyThreadTitle, migrateHistoryTitles } from './history-thread-title.mjs';
import { createHash } from 'node:crypto';
import { BridgeError, WRITE_METHODS, requestFingerprint } from '../../packages/protocol/contracts.mjs';
import { validateTaskRequest } from '../../packages/protocol/tasks.mjs';

const FINISHED = ['succeeded', 'failed', 'canceled', 'skipped'];
const DAY = 86400000;
const unknownError = error => error?.outcomeUnknown === true || /超时|连接已关闭|not-connected|timeout/i.test(error?.message ?? '');
const parse = (value, fallback = null) => value ? JSON.parse(value) : fallback;

/** 每个实例使用自己的 SQLite 任务队列；传输回执与桌面执行彼此独立。 */
export class TaskQueue {
  constructor({ journal, execute, changed = () => {}, messagesChanged = () => {}, reconcile = async () => ({ state: 'unknown' }), ready = () => true, readTitle = () => '', readOperations = () => [], readConversation = () => null, now = Date.now }) {
    this.readOperations = readOperations; this.readTitle = readTitle; this.db = journal.db; this.execute = execute; this.changed = changed; this.reconcile = reconcile; this.ready = ready; this.now = now;
    this.readConversation = readConversation;
    this.messagesChanged = messagesChanged;
    this.watchers = new Set(); this.waiters = new Map(); this.closed = false; this.running = null;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS submission_tasks (
        position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, device_id TEXT NOT NULL,
        kind TEXT NOT NULL, method TEXT NOT NULL, payload TEXT, title TEXT NOT NULL DEFAULT '',
        thread_id TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, started_at INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0, result TEXT, UNIQUE(device_id,id)
      );
      CREATE TABLE IF NOT EXISTS submission_task_keys (
        device_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, error TEXT NOT NULL DEFAULT '', display_metadata TEXT, PRIMARY KEY(device_id,id)
      );
      CREATE TABLE IF NOT EXISTS submission_task_steps (
        task_position INTEGER NOT NULL, name TEXT NOT NULL, command_id TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY(task_position,name)
      );
      CREATE TABLE IF NOT EXISTS submission_task_scopes (
        task_position INTEGER NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(task_position,scope)
      );
      CREATE TABLE IF NOT EXISTS submission_queue_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, blocker_position INTEGER
      );
      INSERT OR IGNORE INTO submission_queue_state(singleton) VALUES (1);
    `);
    migrateHistoryTitles(this.db, 'submission_tasks', readTitle);
    if (!this.db.prepare('PRAGMA table_info(submission_task_keys)').all().some(column => column.name === 'display_metadata')) this.db.exec('ALTER TABLE submission_task_keys ADD COLUMN display_metadata TEXT');
    if (!this.db.prepare('PRAGMA table_info(submission_tasks)').all().some(column => column.name === 'attempt')) this.db.exec('ALTER TABLE submission_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(submission_tasks)').all().some(column => column.name === 'message_display')) this.db.exec('ALTER TABLE submission_tasks ADD COLUMN message_display TEXT');
    // 任务、去重状态与暂停标记一并恢复，不能留下 wait 永久等待的旧 running 状态。
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE submission_tasks SET state='unknown',stage='上次执行中断，等待核对',error='执行结果需要核对，不会自动重发',updated_at=? WHERE state='running'").run(this.now());
      this.db.prepare("UPDATE submission_task_steps SET state='unknown' WHERE state='running'").run();
      this.db.prepare('UPDATE submission_task_keys SET state=(SELECT t.state FROM submission_tasks t WHERE t.device_id=submission_task_keys.device_id AND t.id=submission_task_keys.id) WHERE EXISTS(SELECT 1 FROM submission_tasks t WHERE t.device_id=submission_task_keys.device_id AND t.id=submission_task_keys.id)').run();
      this.db.prepare("UPDATE submission_task_keys SET error=? WHERE state='unknown'").run(JSON.stringify({ code: 'OUTCOME_UNKNOWN', message: '上次执行中断，结果需要核对，不会自动重发', outcomeUnknown: true }));
      const unfinished = this.db.prepare("SELECT position FROM submission_tasks WHERE state='unknown' ORDER BY position LIMIT 1").get();
      if (unfinished) this.db.prepare('UPDATE submission_queue_state SET paused=1,blocker_position=? WHERE singleton=1').run(unfinished.position);
      // 兼容旧版已关闭的明确失败：隐藏操作已经确认放弃该项，恢复后续领取；未知结果仍保持暂停。
      else this.db.prepare("UPDATE submission_queue_state SET paused=0,blocker_position=NULL WHERE singleton=1 AND EXISTS(SELECT 1 FROM submission_tasks WHERE position=blocker_position AND state='failed' AND dismissed=1)").run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.start();
  }

  /** 独立定时器只领取任务，不依赖任何手机页面或订阅是否存在。 */
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { this.pump().catch(() => {}); }, 1000); this.timer.unref?.();
    queueMicrotask(() => { this.pump().catch(() => {}); });
  }

  /** 任务去重键不随展示历史清理，旧编号不能再次执行或改用其他正文。 */
  submit(deviceId, { taskId, kind, payload }) {
    if (this.closed) throw new BridgeError('TASK_QUEUE_CLOSED', '任务队列已关闭');
    this.cleanup();
    if (typeof deviceId !== 'string' || !deviceId || typeof taskId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(taskId) || !['command', 'newConversation'].includes(kind) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BridgeError('BAD_TASK', '提交任务参数无效');
    if (kind === 'command' && (!WRITE_METHODS.has(payload.method) || !payload.params || typeof payload.params !== 'object' || Array.isArray(payload.params))) throw new BridgeError('BAD_TASK', '此操作不在任务白名单中');
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new BridgeError('BAD_TASK', '提交任务内容过大');
    const fingerprint = requestFingerprint('tasks.submit', { kind, payload });
    const previous = this.db.prepare('SELECT * FROM submission_task_keys WHERE device_id=? AND id=?').get(deviceId, taskId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new BridgeError('REQUEST_ID_REUSED', '同一任务编号不能用于不同操作');
      return { accepted: true, taskId, duplicate: true, task: this.publicRow(this.row(deviceId, taskId)) ?? parse(previous.display_metadata), state: previous.state };
    }
    const time = this.now(), method = kind === 'command' ? payload.method : 'conversation.create';
    const threadId = kind === 'command' ? payload.params.threadId ?? '' : '';
    const projectId = kind === 'newConversation' ? payload.projectId ?? '' : payload.params.projectId ?? '';
    const title = kind === 'newConversation' ? String(payload.text ?? '').trim().split('\n')[0].slice(0, 60) || '新聊天' : this.commandTitle(method);
    const display = kind === 'command' && method === 'turn.send' ? this.messageDisplay(payload.params) : null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO submission_task_keys(device_id,id,fingerprint,state) VALUES (?,?,?,?)').run(deviceId, taskId, fingerprint, 'queued');
      const inserted = this.db.prepare("INSERT INTO submission_tasks(id,device_id,kind,method,payload,title,thread_id,project_id,thread_title,state,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'queued','等待执行',?,?)").run(taskId, deviceId, kind, method, encoded, title, threadId, projectId, historyThreadTitle(this.readTitle, threadId), time, time);
      if (display) this.db.prepare('UPDATE submission_tasks SET message_display=? WHERE position=?').run(JSON.stringify(display), Number(inserted.lastInsertRowid));
      const scope = kind === 'newConversation' ? 'task:' + taskId : payload.params.draftId ? 'draft:' + payload.params.draftId : threadId;
      if (scope) this.db.prepare('INSERT INTO submission_task_scopes(task_position,scope) VALUES (?,?)').run(Number(inserted.lastInsertRowid), scope);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const task = this.publicRow(this.row(deviceId, taskId));
    this.notify(); this.cleanup();
    queueMicrotask(() => { this.pump().catch(() => {}); });
    return { accepted: true, taskId, task };
  }

  /** 入库展示与提交任务同事务保存；忙时排队仍使用原有队列卡片，正文只进入聊天通道。 */
  messageDisplay(params) {
    if (params.queueAction && params.queueAction !== 'enqueue') return null;
    const snapshot = this.readConversation(params.threadId);
    if (!snapshot || snapshot.status !== 'idle' || snapshot.activeTurnId || snapshot.queuedMessages?.length || snapshot.approvals?.length || snapshot.pendingPlan || snapshot.questionGroups?.some(group => group.state === 'pending')) return null;
    const captions = [];
    if (params.images?.length) captions.push(`${params.images.length} 张图片`);
    if (params.attachments?.length) captions.push(`${params.attachments.length} 个附件`);
    return { text: params.text ?? '', summary: captions.join(' · ') };
  }

  /** 原生消息沿用执行编号；观察到真实正文后永久收口占位，翻页或重连不能再次补出。 */
  decorateMessages(snapshot) {
    const rows = this.db.prepare('SELECT * FROM submission_tasks WHERE thread_id=? AND message_display IS NOT NULL ORDER BY position').all(snapshot.threadId);
    const messages = snapshot.messages.filter(message => message.kind !== 'submittedMessage');
    for (const row of rows) {
      const id = this.executionId(row);
      if (messages.some(message => message.role === 'user' && message.id === id) || ['canceled', 'skipped'].includes(row.state)) {
        this.db.prepare('UPDATE submission_tasks SET message_display=NULL WHERE position=?').run(row.position);
        continue;
      }
      const display = parse(row.message_display);
      messages.push({ id, role: 'user', kind: 'submittedMessage', text: display.text, summary: display.summary, turnId: '', status: row.state });
    }
    return { ...snapshot, messages };
  }

  /** 展示标题仅描述动作，不把消息正文、路径或设备身份放入执行日志。 */
  commandTitle(method) {
    return ({ 'turn.send': '发送消息', 'turn.steer': '追加指令', 'turn.retry': '重试任务', 'turn.stop': '停止生成', 'approval.reply': '回复审批', 'question.reply': '回复问题', 'thread.settings.update': '修改执行设置', 'thread.permissions.update': '修改权限', 'thread.goal.update': '修改目标', 'thread.archive': '归档聊天', 'thread.delete': '永久删除聊天', 'thread.create': '创建聊天', 'thread.draft.open': '准备新聊天', 'thread.draft.update': '修改草稿设置', 'thread.draft.send': '发送新聊天' })[method] ?? '提交操作';
  }

  /** 原始任务仅在守护进程内部使用，展示投影另行剔除执行正文和设备编号。 */
  row(deviceId, id) { return this.db.prepare('SELECT * FROM submission_tasks WHERE device_id=? AND id=?').get(deviceId, id); }
  /** 每次人工重试使用独立命令编号，原失败回执仍保留且不会被 Journal 当成新执行。 */
  executionId(row) { return row.attempt ? 'task-retry-' + createHash('sha256').update(JSON.stringify([row.device_id, row.id, row.attempt])).digest('hex').slice(0, 48) : row.id; }
  /** 旧版已清理的删除、归档任务可由原目标还原，其他操作不能猜测丢失的输入。 */
  retryPayload(row) {
    if (row.payload) return parse(row.payload);
    if (row.kind === 'command' && row.thread_id && ['thread.delete', 'thread.archive'].includes(row.method)) return { method: row.method, params: { threadId: row.thread_id } };
    return null;
  }
  /** 只有确定失败且仍持有原输入或无正文目标的任务才开放重试。 */
  canRetry(row) { return row.state === 'failed' && !!this.retryPayload(row) && !this.db.prepare("SELECT 1 FROM submission_task_steps WHERE task_position=? AND state IN ('unknown','running') LIMIT 1").get(row.position); }
  /** 只把最近未确认步骤的命令编号交给只读核对器，避免以新编号误查或重放。 */
  internal(row) {
    const pending = this.db.prepare("SELECT command_id FROM submission_task_steps WHERE task_position=? AND state!='succeeded' ORDER BY updated_at DESC LIMIT 1").get(row.position);
    return { ...this.publicRow(row), deviceId: row.device_id, payload: parse(row.payload), commandId: this.executionId(row), pendingCommandId: pending?.command_id ?? this.executionId(row) };
  }
  /** 查询不返回执行参数、原始返回对象或步骤检查点中的私有数据。 */
  publicRow(row, includeResult = false) {
    if (!row) return null;
    const steps = this.db.prepare('SELECT name,state,updated_at FROM submission_task_steps WHERE task_position=? ORDER BY rowid').all(row.position).map(step => ({ name: step.name, state: step.state, at: step.updated_at }));
    const receipt = includeResult && row.state === 'succeeded' ? this.db.prepare('SELECT result FROM submission_task_keys WHERE device_id=? AND id=?').get(row.device_id, row.id) : null;
    const original = parse(receipt?.result), result = original && typeof original === 'object' && !Array.isArray(original) ? Object.fromEntries(Object.entries(original).filter(([key]) => ['ok', 'commandId', 'threadId', 'draftId', 'snapshot', 'settings', 'models', 'mode', 'revision', 'options', 'reviewer', 'queued', 'queueId', 'edited', 'canceled', 'draft', 'archived', 'deleted', 'deletedThreadIds', 'goal', 'goalRevision', 'messageAccepted', 'planReset', 'reconciled'].includes(key))) : null;
    return { id: row.id, position: row.position, kind: row.kind, method: row.method, title: row.title, threadTitle: row.thread_title ?? '', threadId: row.thread_id, projectId: row.project_id, state: row.state, stage: row.stage, error: row.error, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, updatedAt: row.updated_at, dismissed: !!row.dismissed, attempt: row.attempt ?? 0, canRetry: this.canRetry(row), steps, ...(result ? { result } : {}) };
  }

  /** 活跃列表使用服务端完成时间，刷新不会重新开始五秒倒计时。 */
  list(deviceId, { view = 'active', taskId, before, limit = 50, state } = {}) {
    this.cleanup();
    const queue = this.db.prepare('SELECT * FROM submission_queue_state WHERE singleton=1').get();
    const blocker = queue.blocker_position ? this.db.prepare('SELECT * FROM submission_tasks WHERE position=?').get(queue.blocker_position) : null;
    const conditions = ['device_id=?'], values = [deviceId];
    if (taskId) { conditions.push('id=?'); values.push(taskId); }
    else if (view === 'active') { conditions.push("dismissed=0 AND (state IN ('queued','running','failed','unknown','waiting_resume') OR (state='succeeded' AND completed_at>?))"); values.push(this.now() - 5000); }
    else { conditions.push("state IN ('succeeded','failed','canceled','skipped','unknown','waiting_resume')"); }
    const history = view === 'history' && !taskId;
    if (before !== undefined) {
      if (history) {
        // 编号只作原设备上一页的锚点，不能用编号大小截断完成时间不同的任务。
        const anchor = this.db.prepare('SELECT completed_at FROM submission_tasks WHERE device_id=? AND position=?').get(deviceId, before);
        if (!anchor) throw new BridgeError('TASK_HISTORY_CHANGED', '执行记录已变化，请刷新后继续查看');
        conditions.push('(completed_at<? OR (completed_at=? AND position<?))'); values.push(anchor.completed_at, anchor.completed_at, before);
      } else { conditions.push('position<?'); values.push(before); }
    }
    if (state) { conditions.push('state=?'); values.push(state); }
    const count = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50));
    const rows = this.db.prepare('SELECT * FROM submission_tasks WHERE ' + conditions.join(' AND ') + (history ? ' ORDER BY completed_at DESC,position DESC' : ' ORDER BY position') + ' LIMIT ?').all(...values, count + 1);
    const selected = rows.slice(0, count), tasks = selected.map(row => this.publicRow(row, !!taskId));
    if (taskId && !tasks.length) {
      const tombstone = this.db.prepare('SELECT display_metadata FROM submission_task_keys WHERE device_id=? AND id=?').get(deviceId, taskId);
      if (tombstone?.display_metadata) tasks.push(parse(tombstone.display_metadata));
    }
    // 状态操作只并入实时展示，不参与任务领取、暂停及控制。
    if (view === 'active' && !taskId) tasks.push(...this.readOperations(deviceId));
    return { supportsTaskQueue: true, revision: queue.revision, paused: !!queue.paused, blockerId: blocker?.device_id === deviceId ? blocker.id : '', tasks, now: this.now(), ...(rows.length > count ? { nextCursor: selected.at(-1).position } : {}) };
  }

  /** 状态事件只发给原提交设备；其他手机只能知道实例队列是否已暂停。 */
  watch(deviceId) { this.watchers.add(deviceId); return this.list(deviceId); }
  /** 页面退订仅停止展示事件，不撤销数据库中已经接纳的任务。 */
  unwatch(deviceId) { this.watchers.delete(deviceId); return { ok: true }; }
  /** 修订号先落盘，通知异常不改变已经保存的执行事实。 */
  notify(threadId) {
    this.db.prepare('UPDATE submission_queue_state SET revision=revision+1 WHERE singleton=1').run();
    try { this.messagesChanged(threadId); } catch { /* 聊天订阅恢复后仍可从入库记录补齐展示。 */ }
    for (const deviceId of this.watchers) { try { this.changed(deviceId, this.list(deviceId)); } catch { /* 展示通知失败不能回滚已持久化任务。 */ } }
  }

  /** 等待仅服务旧客户端，手机新版只等待 submit 的持久化接纳回执。 */
  wait(deviceId, id) {
    this.cleanup();
    const key = JSON.stringify([deviceId, id]);
    const record = this.db.prepare('SELECT * FROM submission_task_keys WHERE device_id=? AND id=?').get(deviceId, id);
    if (!record) return Promise.reject(new BridgeError('TASK_NOT_FOUND', '任务不存在或不属于当前设备'));
    if (FINISHED.includes(record.state) || record.state === 'unknown') return this.waitResult(record);
    return new Promise((resolve, reject) => { const entries = this.waiters.get(key) ?? []; entries.push({ resolve, reject }); this.waiters.set(key, entries); });
  }
  /** 未知或失败返回明确错误，不能让旧客户端误把接纳当成执行成功。 */
  waitResult(record) {
    if (parse(record.display_metadata)?.historyExpired === true) return Promise.reject(new BridgeError('TASK_RESULT_EXPIRED', '原执行记录已清理，请先核对电脑端结果；该任务不会重新执行'));
    if (record.state === 'succeeded') return Promise.resolve(parse(record.result, {}));
    const error = parse(record.error, null);
    return Promise.reject(new BridgeError(error?.code ?? (record.state === 'unknown' ? 'OUTCOME_UNKNOWN' : 'TASK_FAILED'), error?.message ?? '任务未执行成功，请查看提交任务列表', record.state === 'unknown'));
  }
  /** 原设备的旧请求等待者只在确定终态或未知状态时收口。 */
  settle(row) {
    const key = JSON.stringify([row.device_id, row.id]), entries = this.waiters.get(key);
    if (!entries) return;
    this.waiters.delete(key);
    const record = this.db.prepare('SELECT * FROM submission_task_keys WHERE device_id=? AND id=?').get(row.device_id, row.id);
    for (const waiter of entries) this.waitResult(record).then(waiter.resolve, waiter.reject);
  }

  /** 领取、执行和下一次领取共用实例级唯一 Promise，杜绝跨会话同时写入。 */
  pump() {
    if (this.running) return this.running;
    if (this.closed || !this.ready() || this.db.prepare('SELECT paused FROM submission_queue_state WHERE singleton=1').get().paused) return Promise.resolve();
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  /** 每次执行前重新检查实例就绪和暂停标记，失败之后不领取下一项。 */
  async drain() {
    while (!this.closed && this.ready() && !this.db.prepare('SELECT paused FROM submission_queue_state WHERE singleton=1').get().paused) {
      const row = this.db.prepare("SELECT * FROM submission_tasks WHERE state='queued' ORDER BY position LIMIT 1").get();
      if (!row) break;
      const time = this.now();
      this.db.prepare("UPDATE submission_tasks SET state='running',stage='正在执行',started_at=CASE WHEN started_at=0 THEN ? ELSE started_at END,updated_at=? WHERE position=? AND state='queued'").run(time, time, row.position);
      this.db.prepare("UPDATE submission_task_keys SET state='running' WHERE device_id=? AND id=?").run(row.device_id, row.id); this.notify();
      try {
        const result = await this.execute(this.internal(this.row(row.device_id, row.id)), this.context(row));
        this.finish(row, 'succeeded', result);
      } catch (error) {
        const state = unknownError(error) ? 'unknown' : 'failed';
        this.finish(row, state, null, { code: state === 'unknown' ? 'OUTCOME_UNKNOWN' : error?.code ?? 'TASK_FAILED', message: state === 'unknown' ? '执行结果需要核对，不会自动重发' : String(error?.message ?? '任务执行失败').slice(0, 2000), outcomeUnknown: state === 'unknown' });
      }
    }
  }

  /** 步骤编号由任务与名称确定，开始前先落盘；重入时只读取已经成功的检查点。 */
  context(row) {
    const commandId = name => 'task-' + createHash('sha256').update(JSON.stringify(row.attempt ? [row.device_id, row.id, name, row.attempt] : [row.device_id, row.id, name])).digest('hex').slice(0, 48);
    return {
      commandId,
      retainScope: scope => { this.db.prepare('INSERT OR IGNORE INTO submission_task_scopes(task_position,scope) VALUES (?,?)').run(row.position, scope); },
      update: changes => {
        const current = this.row(row.device_id, row.id);
        this.db.prepare('UPDATE submission_tasks SET thread_id=?,title=?,stage=?,updated_at=? WHERE position=?').run(changes.threadId ?? current.thread_id, changes.title ?? current.title, changes.stage ?? current.stage, this.now(), row.position);
        const target = changes.threadId ?? current.thread_id;
        const title = historyThreadTitle(this.readTitle, target) || (row.kind === 'newConversation' ? current.title : '');
        if (title) this.db.prepare("UPDATE submission_tasks SET thread_title=? WHERE position=? AND thread_title=''").run(title, row.position);
        this.notify();
      },
      step: async (name, operation) => {
        const previous = this.db.prepare('SELECT * FROM submission_task_steps WHERE task_position=? AND name=?').get(row.position, name);
        if (previous?.state === 'succeeded') return parse(previous.result);
        if (previous) throw new BridgeError('OUTCOME_UNKNOWN', '该步骤已经提交，请先核对原执行结果', true);
        this.db.prepare("INSERT INTO submission_task_steps(task_position,name,command_id,state,updated_at) VALUES (?,?,?,'running',?)").run(row.position, name, commandId(name), this.now());
        this.db.prepare('UPDATE submission_tasks SET stage=?,updated_at=? WHERE position=?').run(name, this.now(), row.position); this.notify();
        try {
          const result = await operation(commandId(name));
          this.db.prepare("UPDATE submission_task_steps SET state='succeeded',result=?,updated_at=? WHERE task_position=? AND name=?").run(JSON.stringify(result ?? null), this.now(), row.position, name); this.notify(); return result;
        } catch (error) {
          this.db.prepare('UPDATE submission_task_steps SET state=?,updated_at=? WHERE task_position=? AND name=?').run(unknownError(error) ? 'unknown' : 'failed', this.now(), row.position, name); throw error;
        }
      },
    };
  }

  /** 失败暂留原输入和已成功检查点供人工重试；成功、取消与跳过立即释放私有数据。 */
  finish(row, state, result = null, error = null, resolvedStep = null) {
    const time = this.now(), final = state !== 'unknown', release = final && state !== 'failed';
    const stage = ({ succeeded: '执行完成', failed: '执行失败，实例队列已暂停', unknown: '结果待核对，实例队列已暂停', canceled: '已取消', skipped: '人工跳过，原执行结果未确认' })[state];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE submission_tasks SET state=?,stage=?,error=?,result=?,completed_at=?,updated_at=?,payload=CASE WHEN ? THEN NULL ELSE payload END WHERE position=?').run(state, stage, error?.message ?? '', null, final ? time : 0, time, release ? 1 : 0, row.position);
      this.db.prepare('UPDATE submission_task_keys SET state=?,result=?,error=? WHERE device_id=? AND id=?').run(state, JSON.stringify(result ?? null), error ? JSON.stringify(error) : '', row.device_id, row.id);
      if (result?.queued === true) this.db.prepare('UPDATE submission_tasks SET message_display=NULL WHERE position=?').run(row.position);
      if (resolvedStep) this.db.prepare("UPDATE submission_task_steps SET state='succeeded',updated_at=? WHERE task_position=? AND name=?").run(time, row.position, resolvedStep.name);
      if (release) {
        this.db.prepare('UPDATE submission_task_steps SET result=NULL WHERE task_position=?').run(row.position);
        this.db.prepare('DELETE FROM submission_task_scopes WHERE task_position=?').run(row.position);
      }
      if (result?.threadId) this.db.prepare('UPDATE submission_tasks SET thread_id=? WHERE position=?').run(result.threadId, row.position);
      const current = this.row(row.device_id, row.id);
      const title = historyThreadTitle(this.readTitle, current.thread_id) || (row.kind === 'newConversation' ? current.title : '');
      if (title) this.db.prepare("UPDATE submission_tasks SET thread_title=? WHERE position=? AND thread_title=''").run(title, row.position);
      if (state === 'failed' || state === 'unknown') this.db.prepare('UPDATE submission_queue_state SET paused=1,blocker_position=? WHERE singleton=1').run(row.position);
      this.db.exec('COMMIT');
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
    this.notify(row.thread_id); this.settle(row); this.cleanup();
  }

  /** 取消、核对和恢复是数据库管理动作，不会排在已暂停的桌面业务队列后面。 */
  async control(deviceId, { taskId, action, confirmed, expectedAttempt }) {
    this.cleanup();
    const row = this.row(deviceId, taskId);
    if (!row) throw new BridgeError('TASK_NOT_FOUND', '任务不存在或不属于当前设备');
    const queue = this.db.prepare('SELECT * FROM submission_queue_state WHERE singleton=1').get();
    if (action === 'cancel') {
      if (row.state !== 'queued' || row.started_at) throw new BridgeError('TASK_ALREADY_STARTED', '任务已经开始，不能撤回尚未核对的桌面操作');
      this.finish(row, 'canceled');
    } else if (action === 'dismiss') {
      if (!['failed', 'unknown', 'waiting_resume', 'succeeded', 'canceled', 'skipped'].includes(row.state)) throw new BridgeError('TASK_ACTIVE', '正在等待或执行的任务不能关闭');
      if (row.state === 'failed') this.releaseRetryData(row.position);
      // 关闭明确失败的暂停原因时一并解除暂停，避免卡片消失后后续任务永久等待。
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('UPDATE submission_tasks SET dismissed=1 WHERE position=?').run(row.position);
        if (row.state === 'failed') this.db.prepare('UPDATE submission_queue_state SET paused=0,blocker_position=NULL WHERE singleton=1 AND blocker_position=?').run(row.position);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.notify();
      if (row.state === 'failed') queueMicrotask(() => { this.pump().catch(() => {}); });
    } else if (action === 'retry') {
      // 重复点击或旧回执只能对应原尝试；即使新尝试很快再次失败也不会重放旧点击。
      if (confirmed !== true || !Number.isSafeInteger(expectedAttempt) || expectedAttempt !== row.attempt) throw new BridgeError('TASK_RETRY_STALE', '任务已变化，请刷新后再重试');
      if (!this.canRetry(row)) throw new BridgeError('TASK_RETRY_UNAVAILABLE', '该任务不能直接重试，请先核对结果或重新提交');
      if (queue.paused && queue.blocker_position !== row.position) throw new BridgeError('TASK_NOT_BLOCKER', '请先处理当前导致队列暂停的任务');
      const payload = this.retryPayload(row);
      validateTaskRequest('tasks.submit', { taskId, kind: row.kind, payload }, taskId);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("DELETE FROM submission_task_steps WHERE task_position=? AND state='failed'").run(row.position);
        this.db.prepare("UPDATE submission_tasks SET state='queued',stage='等待重试',error='',payload=?,dismissed=0,started_at=0,completed_at=0,updated_at=?,attempt=attempt+1 WHERE position=?").run(JSON.stringify(payload), this.now(), row.position);
        this.db.prepare("UPDATE submission_task_keys SET state='queued',result=NULL,error='' WHERE device_id=? AND id=?").run(deviceId, taskId);
        if (queue.blocker_position === row.position) this.db.prepare('UPDATE submission_queue_state SET paused=0,blocker_position=NULL WHERE singleton=1').run();
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.notify(); queueMicrotask(() => { this.pump().catch(() => {}); });
    } else if (action === 'reconcile') {
      if (row.state !== 'unknown') return this.list(deviceId, { taskId });
      const status = await this.reconcile(this.internal(row));
      if (status?.state === 'done' && !status.error) {
        const pending = this.db.prepare("SELECT * FROM submission_task_steps WHERE task_position=? AND state!='succeeded' ORDER BY updated_at DESC LIMIT 1").get(row.position);
        if (row.kind === 'command' || !pending || pending.name === '发送首条消息') this.finish(row, 'succeeded', row.kind === 'newConversation' ? { ok: true, threadId: status.result?.threadId ?? row.thread_id } : status.result, null, pending);
        else {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            this.db.prepare("UPDATE submission_task_steps SET state='succeeded',result=?,updated_at=? WHERE task_position=? AND name=?").run(JSON.stringify(status.result ?? null), this.now(), row.position, pending.name);
            this.db.prepare("UPDATE submission_tasks SET state='waiting_resume',stage='已核对，等待人工继续',error='',updated_at=? WHERE position=?").run(this.now(), row.position);
            this.db.prepare("UPDATE submission_task_keys SET state='waiting_resume',error='' WHERE device_id=? AND id=?").run(deviceId, taskId);
            this.db.exec('COMMIT');
          } catch (error) { this.db.exec('ROLLBACK'); throw error; }
          this.notify();
        }
      } else if (status?.state === 'done' && status.error && !status.error.outcomeUnknown) this.finish(row, 'failed', null, status.error);
    } else if (action === 'skip') {
      if (!['unknown', 'failed'].includes(row.state) || confirmed !== true) throw new BridgeError('TASK_CONFIRMATION_REQUIRED', '请先在电脑核对，再明确确认跳过原任务');
      this.finish(row, 'skipped', null, { code: 'TASK_SKIPPED', message: '用户已在电脑核对并跳过，原执行结果未确认' });
      if (queue.blocker_position === row.position) this.resume();
    } else if (action === 'resume') {
      if (queue.blocker_position !== row.position) throw new BridgeError('TASK_NOT_BLOCKER', '请处理导致实例队列暂停的原任务');
      if (row.state === 'unknown') throw new BridgeError('TASK_NEEDS_RECONCILIATION', '请先核对结果，或确认已在电脑核对后跳过');
      if (!['failed', 'waiting_resume', 'succeeded', 'skipped', 'canceled'].includes(row.state)) throw new BridgeError('TASK_ACTIVE', '原任务仍在执行，请稍后核对');
      if (row.state === 'waiting_resume') {
        this.db.prepare("UPDATE submission_tasks SET state='queued',stage='等待继续执行',updated_at=? WHERE position=?").run(this.now(), row.position);
        this.db.prepare("UPDATE submission_task_keys SET state='queued' WHERE device_id=? AND id=?").run(deviceId, taskId);
      }
      this.resume();
    } else throw new BridgeError('BAD_TASK_ACTION', '不支持此任务管理操作');
    return this.list(deviceId, { taskId });
  }

  /** 恢复只解除领取暂停，不重试失败操作，也不把未知任务退回等待状态。 */
  resume() {
    this.db.prepare('UPDATE submission_queue_state SET paused=0,blocker_position=NULL WHERE singleton=1').run(); this.notify();
    queueMicrotask(() => { this.pump().catch(() => {}); });
  }

  /** 任务和步骤仍持有上传作用域时，附件回收器必须保留该作用域的文件。 */
  holdsScope(scope, deviceId) {
    if (typeof scope !== 'string' || !scope) return false;
    const conditions = deviceId === undefined ? '' : ' AND t.device_id=?';
    const values = deviceId === undefined ? [scope] : [scope, deviceId];
    return !!this.db.prepare("SELECT 1 FROM submission_task_scopes s JOIN submission_tasks t ON t.position=s.task_position WHERE s.scope=? AND t.state IN ('queued','running','unknown','waiting_resume','failed')" + conditions + ' LIMIT 1').get(...values);
  }

  /** 关闭或超过三十天时释放重试正文、步骤返回和附件租约，保留最小执行记录。 */
  releaseRetryData(position) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE submission_tasks SET payload=NULL WHERE position=?').run(position);
      this.db.prepare('UPDATE submission_task_steps SET result=NULL WHERE task_position=?').run(position);
      this.db.prepare('DELETE FROM submission_task_scopes WHERE task_position=?').run(position);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** 历史有时限和数量上限；暂停原因、未知任务以及长期去重键均不自动删除。 */
  cleanup() {
    for (const row of this.db.prepare("SELECT position FROM submission_tasks WHERE state='failed' AND payload IS NOT NULL AND completed_at<?").all(this.now() - 30 * DAY)) this.releaseRetryData(row.position);
    const blocker = this.db.prepare('SELECT blocker_position FROM submission_queue_state WHERE singleton=1').get().blocker_position ?? -1;
    const eligible = "state IN ('succeeded','failed','canceled','skipped') AND position!=?";
    const expired = this.db.prepare('SELECT position FROM submission_tasks WHERE ' + eligible + ' AND completed_at<?').all(blocker, this.now() - 30 * DAY);
    const excess = this.db.prepare('SELECT position FROM submission_tasks WHERE ' + eligible + ' ORDER BY position DESC LIMIT -1 OFFSET 1000').all(blocker);
    const positions = new Set([...expired, ...excess].map(row => row.position));
    if (!positions.size) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
    for (const position of positions) {
      const row = this.db.prepare('SELECT * FROM submission_tasks WHERE position=?').get(position);
      // 历史过期后仅保留去重所需的最小回执，不长期保存撤回草稿或原生设置快照。
      const result = { ...(row.thread_id ? { threadId: row.thread_id } : {}), historyExpired: true };
      const metadata = { ...this.publicRow(row), title: this.commandTitle(row.method), projectId: '', stage: '历史记录已清理，请核对电脑端结果', error: '', dismissed: true, canRetry: false, historyExpired: true, steps: [], result };
      this.db.prepare("UPDATE submission_task_keys SET result=NULL,error='',display_metadata=? WHERE device_id=? AND id=?").run(JSON.stringify(metadata), row.device_id, row.id);
      // 旧 command.status 也不能绕过保留期取回完整草稿；仅处理本任务明确关联且已结束的原命令。
      const commandIds = new Set([row.id, this.executionId(row), ...this.db.prepare('SELECT command_id FROM submission_task_steps WHERE task_position=?').all(position).map(step => step.command_id)]);
      const expiredReceipt = JSON.stringify({ error: { code: 'TASK_RESULT_EXPIRED', message: '原执行记录已清理，请先核对电脑端结果；该任务不会重新执行', outcomeUnknown: false } });
      for (const commandId of commandIds) this.db.prepare("UPDATE commands SET payload=? WHERE device_id=? AND command_id=? AND state='done'").run(expiredReceipt, row.device_id, commandId);
      this.db.prepare('DELETE FROM submission_task_steps WHERE task_position=?').run(position);
      this.db.prepare('DELETE FROM submission_task_scopes WHERE task_position=?').run(position);
      this.db.prepare('DELETE FROM submission_tasks WHERE position=?').run(position);
    }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** 关闭前等待当前有界桌面请求收口，之后禁止领取下一项。 */
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = null;
    await this.running?.catch(() => {});
    for (const entries of this.waiters.values()) for (const entry of entries) entry.reject(new BridgeError('TASK_QUEUE_CLOSED', '连接服务已停止，任务仍保存在数据库中'));
    this.waiters.clear(); this.watchers.clear();
  }
}
