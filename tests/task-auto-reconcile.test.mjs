import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Journal } from '../apps/bridge/journal.mjs';
import { TaskQueue } from '../apps/bridge/task-queue.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

const command = () => ({ taskId: randomUUID(), kind: 'command', payload: { method: 'turn.stop', params: { threadId: 'synthetic-thread' } } });
const unknown = () => new BridgeError('OUTCOME_UNKNOWN', '合成回执丢失', true);

/** 合成执行器与真实 SQLite 验证后台恢复，不连接真实会话。 */
function fixture(t, options = {}) {
  const journal = new Journal(), calls = [], snapshots = [];
  const queue = new TaskQueue({ journal, execute: async task => { calls.push(task.id); if (calls.length === 1) throw unknown(); return { ok: true }; }, changed: (_device, snapshot) => snapshots.push(snapshot), ...options });
  t.after(async () => { await queue.close(); journal.close(); });
  return { journal, queue, calls, snapshots };
}

test('后台无需手机订阅即确认成功、解除暂停并执行下一项，原任务不重发', async t => {
  let receipt;
  const f = fixture(t, { reconcile: async task => { receipt = task.pendingCommandId; return { state: 'done', result: { ok: true } }; } });
  const first = command(), next = command(); f.queue.submit('phone', first); f.queue.submit('phone', next);
  await f.queue.pump(); assert.equal(f.queue.list('phone').paused, true);
  await f.queue.pump();
  assert.equal(receipt, first.taskId); assert.deepEqual(f.calls, [first.taskId, next.taskId]);
  assert.equal(f.queue.list('phone').paused, false); assert.equal(f.queue.row('phone', first.taskId).state, 'succeeded');
  assert.equal(f.queue.submit('phone', first).duplicate, true);
  assert.equal((await f.queue.wait('phone', first.taskId)).ok, true);
});

test('未知、未找到和只读查询异常均保留暂停，每项至少五秒后再查', async t => {
  for (const outcome of ['unknown', 'not_found', 'throws', 'unknown-error']) {
    let time = 10000, checks = 0, known = false;
    const f = fixture(t, { now: () => time, reconcile: async () => { checks++; if (known) return { state: 'done', result: { ok: true } }; if (outcome === 'throws') throw Error('合成索引不可读'); return outcome === 'unknown-error' ? { state: 'done', error: { outcomeUnknown: true } } : { state: outcome }; } });
    const first = command(), next = command(); f.queue.submit('phone', first); f.queue.submit('phone', next);
    await f.queue.pump(); await f.queue.pump(); await f.queue.pump();
    assert.equal(checks, 1); assert.equal(f.queue.row('phone', first.taskId).state, 'unknown'); assert.deepEqual(f.calls, [first.taskId]);
    known = true; time += 4999; await f.queue.pump(); assert.equal(checks, 1);
    time++; await f.queue.pump(); assert.equal(checks, 2); assert.equal(f.queue.list('phone').paused, false); assert.equal(f.calls.length, 2);
  }
});

test('真实定时调度在页面退订且未知卡片关闭后仍自动恢复', async t => {
  const f = fixture(t, { reconcile: async () => ({ state: 'done', result: { ok: true } }) });
  const first = command(), next = command(); f.queue.watch('phone'); f.queue.submit('phone', first); f.queue.submit('phone', next);
  await f.queue.pump(); f.queue.unwatch('phone'); await f.queue.control('phone', { taskId: first.taskId, action: 'dismiss' });
  await Promise.race([f.queue.wait('phone', next.taskId), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('后台自动恢复超时')), 3500); t.after(() => clearTimeout(timer)); })]);
  assert.equal(f.queue.row('phone', first.taskId).state, 'succeeded'); assert.equal(f.queue.row('phone', first.taskId).dismissed, 1);
  assert.deepEqual(f.calls, [first.taskId, next.taskId]);
});

test('重启遗留在途任务在原实例恢复就绪后自动核对，下一项失败仍独立暂停', async t => {
  const directory = mkdtempSync(path.join(process.cwd(), '.cache/auto-reconcile-')), file = path.join(directory, 'journal.sqlite');
  const first = command(), next = command(), journal = new Journal(file);
  const original = new TaskQueue({ journal, ready: () => false, execute: async () => ({ ok: true }) });
  original.submit('phone', first); original.submit('phone', next);
  journal.db.prepare("UPDATE submission_tasks SET state='running' WHERE id=?").run(first.taskId);
  await original.close(); journal.close();
  let ready = false, checks = 0; const calls = [], restoredJournal = new Journal(file);
  const restored = new TaskQueue({ journal: restoredJournal, ready: () => ready, reconcile: async () => { checks++; return { state: 'done', result: { ok: true } }; }, execute: async task => { calls.push(task.id); throw new BridgeError('SYNTHETIC_FAILURE', '合成下一项失败'); } });
  t.after(async () => { await restored.close(); restoredJournal.close(); rmSync(directory, { recursive: true, force: true }); });
  await restored.pump(); assert.equal(checks, 0);
  ready = true; await restored.pump();
  assert.equal(checks, 1); assert.deepEqual(calls, [next.taskId]); assert.equal(restored.row('phone', first.taskId).state, 'succeeded');
  assert.equal(restored.list('phone').blockerId, next.taskId); assert.equal(restored.list('phone').paused, true);
});

test('确定失败只更新结果并保持暂停，不自动重试或放行下一项', async t => {
  const f = fixture(t, { reconcile: async () => ({ state: 'done', error: { code: 'SYNTHETIC_FAILURE', message: '合成失败' } }) });
  const first = command(); f.queue.submit('phone', first); f.queue.submit('phone', command());
  await f.queue.pump(); await f.queue.pump();
  assert.equal(f.queue.row('phone', first.taskId).state, 'failed'); assert.equal(f.queue.list('phone').paused, true); assert.equal(f.calls.length, 1);
});

test('后台与手动核对复用原查询，成功通知发出前结果和解除暂停均已落盘', async t => {
  let release, checks = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { reconcile: async () => { checks++; await gate; return { state: 'done', result: { ok: true } }; } });
  const first = command(); f.queue.submit('phone', first); await f.queue.pump();
  const observed = [];
  f.queue.watch('phone'); f.queue.changed = (_device, snapshot) => {
    const task = snapshot.tasks.find(task => task.id === first.taskId);
    if (task?.state === 'succeeded') observed.push([snapshot.paused, f.journal.db.prepare('SELECT paused FROM submission_queue_state').get().paused, f.journal.db.prepare('SELECT state FROM submission_task_keys WHERE id=?').get(first.taskId).state]);
  };
  const background = f.queue.pump(); const manual = f.queue.control('phone', { taskId: first.taskId, action: 'reconcile' });
  assert.equal(checks, 1); release(); await Promise.all([background, manual]);
  assert.deepEqual(observed, [[false, 0, 'succeeded']]);
  assert.equal(f.queue.row('phone', first.taskId).state, 'succeeded'); assert.equal(f.calls.length, 1);
});

test('人工跳过后迟到成功不能覆盖跳过记录或解除下一项失败的暂停', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { reconcile: async () => { await gate; return { state: 'done', result: { ok: true } }; }, execute: async task => { if (task.id === first.taskId) throw unknown(); throw new BridgeError('SYNTHETIC_FAILURE', '合成下一项失败'); } });
  const first = command(), next = command(); f.queue.submit('phone', first); f.queue.submit('phone', next); await f.queue.pump();
  const checking = f.queue.control('phone', { taskId: first.taskId, action: 'reconcile' });
  await f.queue.control('phone', { taskId: first.taskId, action: 'skip', confirmed: true }); await f.queue.pump();
  release(); await checking;
  assert.equal(f.queue.row('phone', first.taskId).state, 'skipped'); assert.equal(f.queue.list('phone').blockerId, next.taskId); assert.equal(f.queue.list('phone').paused, true);
});

test('关闭期间迟到核对不写结果、不恢复队列，关闭等待查询收口', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { reconcile: async () => { await gate; return { state: 'done', result: { ok: true } }; } });
  const first = command(); f.queue.submit('phone', first); await f.queue.pump();
  const checking = f.queue.pump(), closing = f.queue.close(); release(); await Promise.all([checking, closing]);
  assert.equal(f.queue.row('phone', first.taskId).state, 'unknown'); assert.equal(f.queue.list('phone').paused, true);
});

test('旧账本多项未知分属不同手机时，确认首项不能越过下一项未知结果', async t => {
  const first = command(), other = command(), next = command();
  let ready = false;
  const f = fixture(t, { ready: () => ready, execute: async task => { f.calls.push(task.id); return { ok: true }; }, reconcile: async task => task.id === first.taskId ? { state: 'done', result: { ok: true } } : { state: 'unknown' } });
  f.queue.submit('phone', first); f.queue.submit('other-phone', other); f.queue.submit('phone', next);
  f.queue.finish(f.queue.row('other-phone', other.taskId), 'unknown'); f.queue.finish(f.queue.row('phone', first.taskId), 'unknown');
  ready = true; await f.queue.pump();
  assert.equal(f.queue.row('phone', first.taskId).state, 'succeeded'); assert.equal(f.queue.row('other-phone', other.taskId).state, 'unknown');
  assert.equal(f.queue.list('other-phone').blockerId, other.taskId); assert.equal(f.queue.list('phone').paused, true); assert.deepEqual(f.calls, []);
});
