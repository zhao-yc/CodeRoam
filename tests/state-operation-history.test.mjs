import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StateOperationHistory } from '../apps/bridge/state-operation-history.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { validateRequest, validTaskSnapshot } from '../packages/protocol/contracts.mjs';

/** 使用真实 SQLite，只以合成编号和受控桌面动作验证两类记录的边界。 */
function fixture(t) {
  const journal = new Journal(); let now = 100000;
  const history = new StateOperationHistory({ db: journal.db, now: () => now });
  t.after(() => journal.close());
  const input = (method = 'thread.read', extra = {}) => ({ deviceId: 'synthetic-phone', requestId: randomUUID(), method, threadId: 'synthetic-thread', ...extra });
  return { journal, history, input, tick: (ms = 37) => { now += ms; } };
}

test('状态操作保存真实确认结果与耗时，不保存原回执和正文', async t => {
  const { history, input, tick } = fixture(t);
  await history.run(input(), async () => { tick(); return { secret: '合成私有回执' }; });
  const snapshot = history.list('synthetic-phone'), row = snapshot.tasks[0];
  assert.equal(validTaskSnapshot(snapshot), true);
  assert.equal(row.kind, 'operation'); assert.equal(row.title, '标记为已读');
  assert.equal(row.state, 'succeeded'); assert.equal(row.completedAt - row.startedAt, 37);
  assert.equal(JSON.stringify(snapshot).includes('合成私有回执'), false);
  assert.equal(history.list('another-phone').tasks.length, 0);
});

test('同编号并发只执行一次，已完成的同步重试只读取后台快照', async t => {
  const { history, input } = fixture(t); const request = input('thread.sync');
  let resolve, calls = 0, reads = 0;
  const execute = async () => { calls++; return new Promise(done => { resolve = done; }); };
  const first = history.run(request, execute), second = history.run(request, execute);
  await Promise.resolve(); resolve({ ok: true }); await Promise.all([first, second]);
  await history.run(request, execute, async () => { reads++; return { ok: true }; });
  assert.equal(calls, 1); assert.equal(reads, 1); assert.equal(history.list(request.deviceId).tasks.length, 1);
  assert.throws(() => history.run({ ...request, threadId: 'another-thread' }, execute), /不能用于不同操作/);
});

test('连续已读成功合并，新未读、未知状态与失败仍分别留痕', async t => {
  const { history, input } = fixture(t);
  await history.run(input(), async () => ({}));
  await history.run(input('thread.read', { alreadyRead: true }), async () => ({}));
  assert.equal(history.list('synthetic-phone').tasks.length, 1);
  await history.run(input(), async () => ({}));
  await assert.rejects(history.run(input('thread.read', { alreadyRead: true }), async () => { throw new Error('不应公开的异常路径'); }));
  const rows = history.list('synthetic-phone').tasks;
  assert.equal(rows.length, 3); assert.equal(rows[0].state, 'failed');
  assert.equal(JSON.stringify(rows).includes('不应公开的异常路径'), false);
  await history.run(input('thread.read', { alreadyRead: true }), async () => ({}));
  assert.equal(history.list('synthetic-phone').tasks.length, 4, '失败后的成功确认需单独留痕');
});

test('同设备同聊天的并发自动已读只执行并记录一次', async t => {
  const { history, input } = fixture(t); let done, calls = 0;
  const first = history.run(input(), () => { calls++; return new Promise(resolve => { done = resolve; }); });
  const second = history.run(input(), () => assert.fail('同一轮已读不应重复执行'));
  await Promise.resolve(); done({ read: true }); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(history.list('synthetic-phone').tasks.length, 1);
});

test('超时保留未确认状态；恢复不重发、不影响提交队列暂停标记', async t => {
  const { history, input, journal } = fixture(t); const request = input('thread.sync');
  await assert.rejects(history.run(request, async () => { throw Object.assign(new Error('合成超时'), { code: 'DESKTOP_NATIVE_TIMEOUT' }); }));
  assert.equal(history.list(request.deviceId).tasks[0].state, 'unknown');
  assert.throws(() => history.run(request, async () => assert.fail('不能重发')), /未确认/);
  const another = input();
  journal.db.prepare('INSERT INTO state_operation_history(id,device_id,request_id,method,thread_id,state,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), another.deviceId, another.requestId, another.method, another.threadId, 'running', 100000);
  const recovered = new StateOperationHistory({ db: journal.db, now: () => 100100 });
  assert.equal(recovered.list(another.deviceId).tasks.every(row => row.state === 'unknown'), true);
  assert.equal(journal.db.prepare("SELECT 1 FROM sqlite_master WHERE name='submission_queue_state'").get(), undefined);
});

test('分页按完成时间且隔离设备，清理限制不删除运行中操作', async t => {
  const { history, input, journal, tick } = fixture(t);
  for (let i = 0; i < 4; i++) { await history.run(input(), async () => tick()); }
  const first = history.list('synthetic-phone', { limit: 2 });
  const second = history.list('synthetic-phone', { limit: 2, before: first.nextCursor });
  assert.equal(new Set([...first.tasks, ...second.tasks].map(row => row.id)).size, 4);
  assert.throws(() => history.list('another-phone', { before: first.nextCursor }), /刷新/);
  journal.db.prepare("UPDATE state_operation_history SET completed_at=1 WHERE state='succeeded'").run();
  tick(31 * 86400000); history.cleanup(); assert.equal(history.list('synthetic-phone').tasks.length, 0);
});

test('新分类只允许只读历史查询，不能提交状态任务或夹带设备身份', () => {
  const request = params => ({ v: 1, type: 'request', requestId: randomUUID(), method: 'tasks.list', params });
  validateRequest(request({ view: 'history', category: 'operation', limit: 20, state: 'running' }));
  for (const params of [{ category: 'operation' }, { view: 'history', category: 'other' }, { view: 'history', category: 'operation', taskId: randomUUID() }, { view: 'history', category: 'operation', deviceId: 'another-phone' }]) assert.throws(() => validateRequest(request(params)));
  assert.throws(() => validateRequest({ ...request({}), method: 'tasks.submit', params: { taskId: randomUUID(), kind: 'operation', payload: { method: 'thread.read', params: { threadId: 'synthetic-thread' } } } }));
});

test('真实 Agent 只记录主动同步和已读，队列暂停仍可独立执行', async t => {
  const journal = new Journal(), adapter = new EventEmitter(); let navigated = 0, read = 0;
  adapter.index = { list: () => [] }; adapter.conversations = new Map(); adapter.close = () => {};
  adapter.readActivityInventory = async () => ({ complete: true, threadIds: [] });
  adapter.native = { unread: new Map(), platform: 'win32' };
  adapter.watch = async (threadId, deviceId, { activate }) => { if (activate) navigated++; return { threadId, title: '合成聊天', cwd: '', status: 'idle', activeTurnId: '', messages: [], questionGroups: [], approvals: [], updatedAt: 100 }; };
  adapter.markRead = async threadId => { read++; adapter.native.unread.set(threadId, false); return { threadId, read: true }; };
  const nativeDrafts = new EventEmitter(); nativeDrafts.close = () => {};
  const agent = new BridgeAgent({ config: {}, adapter, journal, nativeDrafts, newThreads: {} });
  t.after(() => agent.close());
  agent.taskQueue.db.prepare('UPDATE submission_queue_state SET paused=1 WHERE singleton=1').run();
  const request = (method, params, requestId = randomUUID()) => agent.handleRequest({ v: 1, type: 'request', requestId, method, params, deviceId: 'synthetic-phone' });
  await request('thread.watch', { threadId: 'synthetic-thread' });
  const id = randomUUID(); await request('thread.watch', { threadId: 'synthetic-thread', activate: true }, id);
  await request('thread.watch', { threadId: 'synthetic-thread', activate: true }, id);
  await request('thread.read', { threadId: 'synthetic-thread' }); await request('thread.read', { threadId: 'synthetic-thread' });
  const result = await request('tasks.list', { view: 'history', category: 'operation' });
  assert.equal(result.error, undefined); assert.equal(validTaskSnapshot(result.result), true);
  assert.equal(result.result.tasks.length, 2); assert.equal(navigated, 1); assert.equal(read, 2);
  const tasks = (await request('tasks.list', { view: 'history' })).result;
  assert.equal(tasks.tasks.length, 0); assert.equal(tasks.paused, true);
});
