import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../apps/bridge/journal.mjs';
import { TaskQueue } from '../apps/bridge/task-queue.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

/** 真实 SQLite 只配合合成执行器，不连接原桌面或使用个人会话。 */
function fixture(t, options = {}) {
  const journal = new Journal(), calls = [];
  const queue = new TaskQueue({ journal, execute: async task => { calls.push(task.id); return { ok: true, threadId: task.payload.params?.threadId }; }, ...options });
  t.after(async () => { await queue.close(); journal.close(); });
  return { journal, queue, calls };
}
const command = (taskId = randomUUID(), method = 'thread.settings.update', params = { threadId: 'synthetic-thread', changes: { effort: 'high' } }) => ({ taskId, kind: 'command', payload: { method, params } });

test('同实例跨聊天严格串行，提交立即落盘且不等待桌面', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const f = fixture(t, { execute: async task => { calls.push(task.payload.params.threadId); if (calls.length === 1) await gate; return { ok: true }; } });
  const first = f.queue.submit('phone', command(randomUUID(), 'turn.stop', { threadId: 'one' }));
  const second = f.queue.submit('phone', command(randomUUID(), 'turn.stop', { threadId: 'two' }));
  assert.equal(first.accepted, true); assert.equal(second.accepted, true);
  const running = f.queue.pump(); await Promise.resolve();
  assert.deepEqual(calls, ['one']); assert.equal(f.queue.list('phone').tasks[1].state, 'queued');
  release(); await running; assert.deepEqual(calls, ['one', 'two']);
});

test('不同实例独立执行，页面退订不影响已经接纳的任务', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = fixture(t, { execute: async () => { await gate; return { ok: true }; } }), second = fixture(t);
  first.queue.watch('phone'); first.queue.submit('phone', command()); first.queue.unwatch('phone');
  const blocked = first.queue.pump(); second.queue.submit('phone', command()); await second.queue.pump();
  assert.equal(second.calls.length, 1); release(); await blocked;
});

test('相同提交编号只执行一次，不同指纹及跨设备管理被拒绝', async t => {
  const f = fixture(t), request = command();
  f.queue.submit('phone', request); assert.equal(f.queue.submit('phone', request).duplicate, true);
  assert.throws(() => f.queue.submit('phone', { ...request, payload: { method: 'turn.stop', params: { threadId: 'other' } } }), { code: 'REQUEST_ID_REUSED' });
  await assert.rejects(f.queue.control('other-phone', { taskId: request.taskId, action: 'dismiss' }), { code: 'TASK_NOT_FOUND' });
  await f.queue.pump(); assert.equal(f.calls.length, 1);
  assert.equal((await f.queue.wait('phone', request.taskId)).ok, true);
  assert.equal(f.queue.submit('phone', request).duplicate, true);
  assert.equal(f.queue.list('other-phone', { taskId: request.taskId }).tasks.length, 0);
});

test('失败暂停整个实例，关闭失败项后自动执行后续任务且不重试原操作', async t => {
  let attempt = 0;
  const f = fixture(t, { execute: async () => { if (++attempt === 1) throw new BridgeError('SETTINGS_CHANGED', '合成设置变化'); return { ok: true }; } });
  const failed = command(), next = command(randomUUID(), 'turn.stop', { threadId: 'another' });
  f.queue.submit('phone', failed); f.queue.submit('phone', next); await f.queue.pump();
  assert.equal(attempt, 1); assert.equal(f.queue.list('phone').paused, true);
  const snapshots = []; f.queue.changed = (_device, snapshot) => snapshots.push(snapshot); f.queue.watch('phone');
  await f.queue.control('phone', { taskId: failed.taskId, action: 'dismiss' });
  await f.queue.wait('phone', next.taskId);
  assert.equal(attempt, 2); assert.equal(f.queue.list('phone').paused, false);
  assert.equal(f.queue.list('phone').blockerId, '');
  assert.ok(snapshots.every(snapshot => !snapshot.paused));
  const history = f.queue.list('phone', { taskId: failed.taskId }).tasks[0];
  assert.equal(history.state, 'failed'); assert.equal(history.dismissed, true);
  assert.equal(f.queue.row('phone', failed.taskId).payload, null);
  assert.equal(f.queue.submit('phone', failed).duplicate, true);
  await f.queue.control('phone', { taskId: failed.taskId, action: 'dismiss' }); await f.queue.pump();
  assert.equal(attempt, 2);
});

test('未关闭失败项可手动继续，重复关闭旧失败项不能解除新暂停原因', async t => {
  let attempt = 0;
  const f = fixture(t, { execute: async () => { attempt++; throw new BridgeError('SYNTHETIC_FAILURE', '合成失败'); } });
  const first = command(), second = command(), third = command();
  for (const request of [first, second, third]) f.queue.submit('phone', request);
  await f.queue.pump();
  await f.queue.control('phone', { taskId: first.taskId, action: 'resume' }); await f.queue.pump();
  assert.equal(attempt, 2); assert.equal(f.queue.list('phone').blockerId, second.taskId);
  await f.queue.control('phone', { taskId: first.taskId, action: 'dismiss' }); await f.queue.pump();
  assert.equal(attempt, 2); assert.equal(f.queue.list('phone').paused, true);
  assert.equal(f.queue.list('phone').blockerId, second.taskId);
});

test('重启恢复旧版已关闭失败项的队列，不越过未知任务，也不重放失败项', async t => {
  for (const unknown of [false, true]) {
    const journal = new Journal(), calls = [];
    const queue = new TaskQueue({ journal, execute: async () => { throw new BridgeError('SYNTHETIC_FAILURE', '合成失败'); } });
    const first = command(), next = command(); queue.submit('phone', first); queue.submit('phone', next); await queue.pump();
    // 构造旧版已经隐藏失败卡片、但暂停标记尚未解除的持久化现场。
    journal.db.prepare('UPDATE submission_tasks SET dismissed=1 WHERE id=?').run(first.taskId);
    if (unknown) journal.db.prepare("UPDATE submission_tasks SET state='unknown' WHERE id=?").run(first.taskId);
    await queue.close();
    const restored = new TaskQueue({ journal, execute: async task => { calls.push(task.id); return { ok: true }; } });
    try {
      await restored.pump();
      assert.deepEqual(calls, unknown ? [] : [next.taskId]);
      assert.equal(restored.list('phone').paused, unknown);
      assert.equal(restored.list('phone', { taskId: first.taskId }).tasks[0].state, unknown ? 'unknown' : 'failed');
    } finally { await restored.close(); journal.close(); }
  }
});

test('未知结果不可重发，核对不到不能继续，明确人工跳过会留下说明', async t => {
  let attempt = 0;
  const f = fixture(t, { execute: async () => { if (++attempt === 1) throw new BridgeError('OUTCOME_UNKNOWN', '合成超时', true); return { ok: true }; } });
  const first = command(), second = command();
  f.queue.submit('phone', first); f.queue.submit('phone', second); await f.queue.pump();
  await assert.rejects(f.queue.wait('phone', first.taskId), { code: 'OUTCOME_UNKNOWN' });
  await f.queue.control('phone', { taskId: first.taskId, action: 'reconcile' });
  await f.queue.control('phone', { taskId: first.taskId, action: 'dismiss' });
  assert.equal(f.queue.list('phone', { view: 'history', state: 'unknown' }).tasks[0].id, first.taskId);
  await assert.rejects(f.queue.control('phone', { taskId: first.taskId, action: 'resume' }), { code: 'TASK_NEEDS_RECONCILIATION' });
  await assert.rejects(f.queue.control('phone', { taskId: first.taskId, action: 'skip' }), { code: 'TASK_CONFIRMATION_REQUIRED' });
  await f.queue.control('phone', { taskId: first.taskId, action: 'skip', confirmed: true }); await f.queue.pump();
  assert.equal(attempt, 2); assert.match(f.queue.list('phone', { taskId: first.taskId }).tasks[0].stage, /原执行结果未确认/);
});

test('重启恢复等待任务，在途任务改为未知并暂停，任何步骤都不自动重放', async t => {
  const temporaryRoot = path.join(process.cwd(), '.cache'); fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'synthetic-task-queue-')), file = path.join(directory, 'journal.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = new Journal(file), queue = new TaskQueue({ journal, ready: () => false, execute: async () => ({ ok: true }) }), first = command(), second = command();
  queue.submit('phone', first); queue.submit('phone', second);
  journal.db.prepare("UPDATE submission_tasks SET state='running' WHERE id=?").run(first.taskId);
  await queue.close(); journal.close();
  const restoredJournal = new Journal(file), calls = [], restored = new TaskQueue({ journal: restoredJournal, execute: async task => { calls.push(task.id); return { ok: true }; } });
  await restored.pump(); assert.deepEqual(calls, []);
  assert.deepEqual(restored.list('phone').tasks.map(row => row.state), ['unknown', 'queued']);
  await assert.rejects(restored.wait('phone', first.taskId), { code: 'OUTCOME_UNKNOWN' });
  await restored.control('phone', { taskId: first.taskId, action: 'skip', confirmed: true }); await restored.pump();
  assert.deepEqual(calls, [second.taskId]); await restored.close(); restoredJournal.close();
});

test('组合中间步骤核对后自动继续，成功步骤复用检查点而不重复创建', async t => {
  let creates = 0, sends = 0, known = false;
  const f = fixture(t, {
    execute: async (_task, context) => {
      const created = await context.step('创建聊天', async () => { creates++; throw new BridgeError('OUTCOME_UNKNOWN', '创建回执未知', true); });
      return context.step('发送首条消息', async () => { sends++; return { ok: true, threadId: created.threadId }; });
    },
    reconcile: async task => { assert.match(task.pendingCommandId, /^task-/); return known ? { state: 'done', result: { threadId: 'created' } } : { state: 'unknown' }; },
  });
  const taskId = randomUUID(); f.queue.submit('phone', { taskId, kind: 'newConversation', payload: { projectId: 'project', text: '合成消息' } }); await f.queue.pump();
  known = true; await f.queue.pump();
  assert.equal(f.queue.list('phone').paused, false);
  assert.equal(creates, 1); assert.equal(sends, 1); assert.equal(f.queue.list('phone', { taskId }).tasks[0].state, 'succeeded');
});

test('仅尚未开始的任务可取消，取消不会提交桌面写入', async t => {
  const f = fixture(t, { ready: () => false }), request = command();
  f.queue.submit('phone', request); await f.queue.control('phone', { taskId: request.taskId, action: 'cancel' });
  assert.equal(f.queue.list('phone').tasks.length, 0); assert.deepEqual(f.calls, []);
  assert.equal(f.queue.list('phone', { view: 'history' }).tasks[0].state, 'canceled');
});

test('五秒展示按完成时间计算，定点查询和历史仍可读取且不泄露执行正文', async t => {
  let time = 10000;
  const f = fixture(t, { now: () => time, execute: async () => ({ ok: true, settings: { effort: 'high' }, result: { privateBody: '不可展示' } }) }), request = command();
  f.queue.watch('phone'); f.queue.submit('phone', request); await f.queue.pump();
  const shown = f.queue.list('phone').tasks[0]; assert.equal(shown.result, undefined);
  assert.deepEqual(f.queue.list('phone', { taskId: request.taskId }).tasks[0].result, { ok: true, settings: { effort: 'high' } });
  assert.equal('payload' in shown, false); assert.equal('deviceId' in shown, false);
  time += 5000; assert.equal(f.queue.list('phone').tasks.length, 0);
  assert.equal(f.queue.list('phone', { taskId: request.taskId }).tasks.length, 1);
  assert.equal(f.queue.list('phone', { view: 'history' }).tasks.length, 1);
  assert.equal(f.journal.db.prepare('SELECT payload FROM submission_tasks WHERE id=?').get(request.taskId).payload, null);
});

test('历史过期只清理展示数据，永久去重仍拒绝原任务重放', async t => {
  let time = 10000; const f = fixture(t, { now: () => time }), request = command();
  f.queue.submit('phone', request); await f.queue.pump(); time += 31 * 86400000;
  assert.equal(f.queue.list('phone', { view: 'history' }).tasks.length, 0);
  const receipt = f.queue.list('phone', { taskId: request.taskId }).tasks[0];
  assert.equal(receipt.state, 'succeeded'); assert.equal(receipt.historyExpired, true); assert.equal(receipt.result.historyExpired, true); assert.equal(receipt.result.ok, undefined);
  assert.equal(f.queue.submit('phone', request).duplicate, true); await f.queue.pump(); assert.equal(f.calls.length, 1);
  await assert.rejects(f.queue.wait('phone', request.taskId), { code: 'TASK_RESULT_EXPIRED' });
});

test('附件保留精确到设备，组合目标作用域和未知任务跨重启仍可追踪', async t => {
  const f = fixture(t, { execute: async (_task, context) => { context.retainScope('draft:synthetic'); throw new BridgeError('OUTCOME_UNKNOWN', '合成回执未知', true); } });
  const taskId = randomUUID(); f.queue.submit('phone', { taskId, kind: 'newConversation', payload: { projectId: 'project', text: '合成消息' } });
  assert.equal(f.queue.holdsScope('task:' + taskId, 'phone'), true); assert.equal(f.queue.holdsScope('task:' + taskId, 'other'), false);
  await f.queue.pump(); assert.equal(f.queue.holdsScope('draft:synthetic', 'phone'), true);
  await f.queue.control('phone', { taskId, action: 'skip', confirmed: true }); assert.equal(f.queue.holdsScope('draft:synthetic', 'phone'), false);
});

test('历史分页、状态筛选和通知均限定原提交设备', async t => {
  const events = [], f = fixture(t, { changed: (deviceId, snapshot) => events.push({ deviceId, snapshot }) });
  f.queue.watch('one'); f.queue.watch('two');
  for (let i = 0; i < 3; i++) f.queue.submit('one', command());
  f.queue.submit('two', command()); await f.queue.pump();
  const page = f.queue.list('one', { view: 'history', limit: 2 }); assert.equal(page.tasks.length, 2); assert.ok(page.nextCursor);
  assert.equal(f.queue.list('one', { view: 'history', before: page.nextCursor }).tasks.length, 1);
  assert.equal(f.queue.list('two', { view: 'history', state: 'succeeded' }).tasks.length, 1);
  assert.ok(events.some(event => event.deviceId === 'one' && event.snapshot.tasks.length === 3));
  assert.ok(events.filter(event => event.deviceId === 'two').every(event => event.snapshot.tasks.length <= 1));
});

test('历史按实际完成时间倒序分页，提交编号交错、同毫秒和待核对记录均不重不漏', t => {
  const f = fixture(t, { ready: () => false, now: () => 1000000 }), ids = [];
  for (const completedAt of [400000, 700000, 500000, 700000, 0, 100000]) {
    const request = command(); ids.push(request.taskId); f.queue.submit('phone', request);
    f.queue.finish(f.queue.row('phone', request.taskId), completedAt ? 'succeeded' : 'unknown', completedAt ? { ok: true } : null);
    f.journal.db.prepare('UPDATE submission_tasks SET completed_at=? WHERE id=?').run(completedAt, request.taskId);
  }
  const queued = command(); f.queue.submit('phone', queued);
  const actual = []; let before;
  do {
    const page = f.queue.list('phone', { view: 'history', limit: 2, ...(before === undefined ? {} : { before }) });
    actual.push(...page.tasks.map(task => task.id)); before = page.nextCursor;
  } while (before !== undefined);
  assert.deepEqual(actual, [ids[3], ids[1], ids[2], ids[0], ids[5], ids[4]]);
  assert.equal(new Set(actual).size, 6);
  assert.deepEqual(f.queue.list('phone').tasks.map(task => task.id), [ids[4], queued.taskId]);
  const page = f.queue.list('phone', { view: 'history', state: 'succeeded', limit: 2 });
  assert.deepEqual(page.tasks.map(task => task.id), [ids[3], ids[1]]);
  assert.deepEqual(f.queue.list('phone', { view: 'history', state: 'succeeded', before: page.nextCursor }).tasks.map(task => task.id), [ids[2], ids[0], ids[5]]);
});

test('较早提交的任务后来重试成功，刷新历史会按新的完成时间移到最前', async t => {
  let time = 10000, firstAttempt = true;
  const f = fixture(t, { now: () => time, execute: async () => { if (firstAttempt) { firstAttempt = false; throw new BridgeError('SYNTHETIC_FAILURE', '合成首次失败'); } return { ok: true }; } });
  const first = command(), second = command(); f.queue.submit('phone', first); await f.queue.pump();
  time = 20000; await f.queue.control('phone', { taskId: first.taskId, action: 'resume' }); f.queue.submit('phone', second); await f.queue.pump();
  assert.deepEqual(f.queue.list('phone', { view: 'history' }).tasks.map(task => task.id), [second.taskId, first.taskId]);
  time = 30000; await f.queue.control('phone', { taskId: first.taskId, action: 'retry', confirmed: true, expectedAttempt: 0 }); await f.queue.pump();
  const records = f.queue.list('phone', { view: 'history' }).tasks;
  assert.deepEqual(records.map(task => task.id), [first.taskId, second.taskId]); assert.equal(records[0].createdAt, 10000); assert.equal(records[0].completedAt, 30000);
});

test('完成时间分页锚点限定原设备，已清理或其他设备的锚点统一要求刷新', t => {
  const f = fixture(t, { ready: () => false }), request = command(); f.queue.submit('other-phone', request);
  f.queue.finish(f.queue.row('other-phone', request.taskId), 'succeeded', { ok: true });
  const before = f.queue.row('other-phone', request.taskId).position;
  assert.throws(() => f.queue.list('phone', { view: 'history', before }), { code: 'TASK_HISTORY_CHANGED' });
  f.journal.db.prepare('DELETE FROM submission_tasks WHERE id=?').run(request.taskId);
  assert.throws(() => f.queue.list('other-phone', { view: 'history', before }), { code: 'TASK_HISTORY_CHANGED' });
});

test('推送和历史不含撤回草稿或原生快照，仅原设备定点查询返回必要业务回执', async t => {
  const events = [], f = fixture(t, { changed: (_device, snapshot) => events.push(snapshot), execute: async () => ({ ok: true, draft: { text: '合成私有正文', images: ['synthetic-image'] }, snapshot: { draftId: randomUUID(), settings: { effort: 'high' } }, result: { raw: '不可展示的原始回执' } }) });
  const request = command(); f.queue.watch('phone'); f.queue.submit('phone', request); await f.queue.pump();
  assert.equal(JSON.stringify(events).includes('合成私有正文'), false);
  assert.equal(JSON.stringify(f.queue.list('phone', { view: 'history' })).includes('synthetic-image'), false);
  const final = f.queue.list('phone', { taskId: request.taskId }).tasks[0];
  assert.equal(final.result.draft.text, '合成私有正文'); assert.equal(final.result.result, undefined);
  assert.equal(f.queue.list('other', { taskId: request.taskId }).tasks.length, 0);
});

test('撤回编辑回执在保留期内可取回，过期后正文图片和原生快照从去重数据彻底释放', async t => {
  let time = 10000, calls = 0;
  const privateText = '仅用于清理验证的合成草稿正文', privateImage = 'synthetic-private-image-data';
  const f = fixture(t, { now: () => time, execute: async () => { calls++; return { ok: true, draft: { text: privateText, images: [privateImage] }, snapshot: { settings: { effort: 'high' } } }; } });
  const request = command(randomUUID(), 'turn.send', { threadId: 'thread', queueAction: 'edit', queueId: 'synthetic-queue-id' });
  f.queue.submit('phone', request); await f.queue.pump();
  assert.equal(f.queue.list('phone', { taskId: request.taskId }).tasks[0].result.draft.text, privateText);
  assert.equal((await f.queue.wait('phone', request.taskId)).draft.images[0], privateImage);
  time += 31 * 86400000;
  // wait 本身也触发保留期清理，不能靠一直不打开历史而长期保存正文。
  await assert.rejects(f.queue.wait('phone', request.taskId), { code: 'TASK_RESULT_EXPIRED' });
  const stored = f.journal.db.prepare('SELECT * FROM submission_task_keys WHERE device_id=? AND id=?').get('phone', request.taskId);
  assert.equal(stored.result, null); assert.equal(stored.error, ''); assert.equal(stored.state, 'succeeded');
  assert.equal(JSON.stringify(stored).includes(privateText), false); assert.equal(JSON.stringify(stored).includes(privateImage), false); assert.equal(JSON.stringify(stored).includes('settings'), false);
  const tombstone = f.queue.list('phone', { taskId: request.taskId }).tasks[0];
  assert.equal(tombstone.historyExpired, true); assert.equal(tombstone.result.ok, undefined); assert.equal(tombstone.result.draft, undefined); assert.deepEqual(tombstone.steps, []);
  assert.equal(f.queue.submit('phone', request).duplicate, true); await f.queue.pump(); assert.equal(calls, 1);
});

test('清理关联原命令和组合步骤回执，保护其他设备、无关及未知和执行中命令', async t => {
  let time = 10000, f;
  const text = '合成关联命令私有正文', result = { ok: true, draft: { text, images: ['synthetic-command-image'] } };
  const method = 'turn.send', params = { threadId: 'thread', text: '合成输入' };
  f = fixture(t, { now: () => time, execute: async (task, context) => task.kind === 'newConversation' ? context.step('发送首条消息', id => f.journal.execute(task.deviceId, id, method, params, async () => result)) : f.journal.execute(task.deviceId, task.id, method, params, async () => result) });
  const completed = command(), unknown = command(), pending = command(), compositeId = randomUUID(), unrelatedId = randomUUID();
  for (const request of [completed, unknown, pending]) f.queue.submit('phone', request);
  f.queue.submit('phone', { taskId: compositeId, kind: 'newConversation', payload: { projectId: 'project', text: '合成组合消息' } }); await f.queue.pump();
  const composite = f.queue.row('phone', compositeId), stepId = f.journal.db.prepare('SELECT command_id FROM submission_task_steps WHERE task_position=?').get(composite.position).command_id;
  f.journal.db.prepare("UPDATE commands SET state='unknown' WHERE device_id='phone' AND command_id=?").run(unknown.taskId);
  f.journal.db.prepare("UPDATE commands SET state='pending' WHERE device_id='phone' AND command_id=?").run(pending.taskId);
  await f.journal.execute('phone', unrelatedId, method, params, async () => result);
  await f.journal.execute('other-phone', completed.taskId, method, params, async () => result);
  const fingerprint = f.journal.db.prepare("SELECT fingerprint FROM commands WHERE device_id='phone' AND command_id=?").get(completed.taskId).fingerprint;
  time += 31 * 86400000; f.queue.cleanup();
  for (const commandId of [completed.taskId, stepId]) {
    const status = f.journal.status('phone', commandId); assert.equal(status.state, 'done'); assert.equal(status.error.code, 'TASK_RESULT_EXPIRED');
    assert.equal(JSON.stringify(status).includes(text), false); assert.equal(JSON.stringify(status).includes('synthetic-command-image'), false);
  }
  assert.equal(f.journal.db.prepare("SELECT fingerprint FROM commands WHERE device_id='phone' AND command_id=?").get(completed.taskId).fingerprint, fingerprint);
  assert.equal(f.journal.status('phone', unrelatedId).result.draft.text, text);
  assert.equal(f.journal.status('other-phone', completed.taskId).result.draft.text, text);
  for (const request of [unknown, pending]) assert.equal(f.journal.status('phone', request.taskId).result.draft.text, text);
  assert.equal(f.journal.status('phone', unknown.taskId).state, 'unknown'); assert.equal(f.journal.status('phone', pending.taskId).state, 'pending');
  let replayed = false;
  await assert.rejects(f.journal.execute('phone', completed.taskId, method, params, async () => { replayed = true; }), { code: 'TASK_RESULT_EXPIRED' }); assert.equal(replayed, false);
});

test('失败事件发出时数据库已同时持久化暂停、终态和去重结果', async t => {
  const failures = [], f = fixture(t, { changed: (_device, snapshot) => {
    if (snapshot.tasks.some(task => task.state === 'failed')) failures.push(snapshot.paused);
  }, execute: async () => { throw new BridgeError('SYNTHETIC_FAILURE', '合成执行失败'); } });
  const request = command(); f.queue.watch('phone'); f.queue.submit('phone', request); await f.queue.pump();
  assert.deepEqual(failures, [true]);
  assert.equal(f.journal.db.prepare('SELECT state FROM submission_task_keys WHERE id=?').get(request.taskId).state, 'failed');
  assert.deepEqual(JSON.parse(f.queue.row('phone', request.taskId).payload), request.payload);
});

test('终结历史最多保留一千条，数量清理保留原提交的去重墓碑', async t => {
  const f = fixture(t, { ready: () => false });
  const insert = f.journal.db.prepare("INSERT INTO submission_tasks(id,device_id,kind,method,state,created_at,completed_at,updated_at) VALUES (?,'phone','command','turn.stop','succeeded',?,?,?)");
  const insertKey = f.journal.db.prepare("INSERT INTO submission_task_keys(device_id,id,fingerprint,state,result) VALUES ('phone',?,'synthetic-fingerprint','succeeded','{}')");
  const time = Date.now(), ids = [];
  f.journal.db.exec('BEGIN');
  for (let i = 0; i < 1003; i++) { const id = randomUUID(); ids.push(id); insert.run(id, time, time, time); insertKey.run(id); }
  f.journal.db.exec('COMMIT');
  f.queue.cleanup();
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS count FROM submission_tasks').get().count, 1000);
  const oldest = f.queue.list('phone', { taskId: ids[0] }).tasks[0];
  assert.equal(oldest.result.historyExpired, true); assert.equal(oldest.id, ids[0]);
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS count FROM submission_task_keys').get().count, 1003);
});
