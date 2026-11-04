import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Journal } from '../apps/bridge/journal.mjs';
import { TaskQueue } from '../apps/bridge/task-queue.mjs';
import { StateOperationHistory } from '../apps/bridge/state-operation-history.mjs';
import { validTaskSnapshot } from '../packages/protocol/tasks.mjs';

/** 使用真实 SQLite 与合成标题验证记录快照、旧库迁移及实例隔离。 */
test('标题入库后不依赖聊天列表，改名、删除和重启不改变快照', async t => {
  const journal = new Journal(); let title = '提交时的聊天名称';
  let queue = new TaskQueue({ journal, readTitle: () => title, execute: async () => ({ ok: true }) });
  t.after(async () => { await queue.close(); journal.close(); });
  const request = { taskId: randomUUID(), kind: 'command', payload: { method: 'thread.delete', params: { threadId: 'synthetic-title' } } };
  queue.submit('phone', request); title = ''; await queue.pump();
  assert.equal(queue.row('phone', request.taskId).thread_title, '提交时的聊天名称');
  await queue.close();
  queue = new TaskQueue({ journal, readTitle: () => '更名后的聊天', execute: async () => { throw Error('不应重放'); } });
  const snapshot = queue.list('phone', { view: 'history' });
  assert.equal(snapshot.tasks[0].threadTitle, '提交时的聊天名称');
  assert.ok(validTaskSnapshot(snapshot));
  assert.equal(queue.submit('phone', request).task.threadTitle, '提交时的聊天名称');
});

test('状态操作同样保存标题，旧库补齐标题只发生在守护进程', async t => {
  const journal = new Journal(); t.after(() => journal.close());
  let history = new StateOperationHistory({ db: journal.db });
  const input = { deviceId: 'phone', requestId: randomUUID(), method: 'thread.read', threadId: 'synthetic-archived' };
  await history.run(input, async () => ({ ok: true }));
  // 模拟没有标题列的旧账本，补齐时允许使用归档聊天的索引标题。
  journal.db.exec('ALTER TABLE state_operation_history DROP COLUMN thread_title');
  history = new StateOperationHistory({ db: journal.db, readTitle: () => '原归档聊天' });
  assert.equal(history.list('phone').tasks[0].threadTitle, '原归档聊天');
  assert.ok(validTaskSnapshot(history.list('phone')));
  history = new StateOperationHistory({ db: journal.db, readTitle: () => '改名后的聊天' });
  assert.equal(history.list('phone').tasks[0].threadTitle, '原归档聊天');
  const other = new StateOperationHistory({ db: journal.db, readTitle: () => '第二条快照' });
  await other.run({ ...input, requestId: randomUUID(), method: 'thread.sync' }, async () => ({}));
  assert.equal(other.list('phone').tasks[0].threadTitle, '第二条快照');
});

test('旧任务账本迁移和新聊天绑定编号时保存标题，标题读取失败不阻断执行', async t => {
  const journal = new Journal(); let queue = new TaskQueue({ journal, ready: () => false });
  t.after(async () => { await queue.close(); journal.close(); });
  const request = { taskId: randomUUID(), kind: 'command', payload: { method: 'turn.stop', params: { threadId: 'synthetic-old' } } };
  queue.submit('phone', request); await queue.close();
  journal.db.exec('ALTER TABLE submission_tasks DROP COLUMN thread_title');
  queue = new TaskQueue({ journal, ready: () => false, readTitle: () => '旧记录补全' });
  assert.equal(queue.list('phone').tasks[0].threadTitle, '旧记录补全');
  queue.readTitle = () => { throw Error('索引暂不可用'); };
  const created = queue.submit('phone', { taskId: randomUUID(), kind: 'newConversation', payload: { text: '新聊天标题', projectId: 'synthetic-project' } });
  queue.context(queue.row('phone', created.taskId)).update({ threadId: 'synthetic-new' });
  assert.equal(queue.list('phone', { taskId: created.taskId }).tasks[0].threadTitle, '新聊天标题');
});
