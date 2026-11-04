import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageQueue } from '../apps/bridge/message-queue.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

/** 使用真实旧队列表与路由；只替换桌面接口，确保两套执行器不会重复接收同一消息。 */
function fixture(t) {
  const f = { calls: [], snapshot: { threadId: 'synthetic-thread', status: 'active', activeTurnId: 'synthetic-turn', supportsNativeMessageQueue: true, queuedMessages: [], approvals: [], questionGroups: [] } };
  const journal = new Journal();
  const entry = { state: { cwd: '/example/workspace' }, owner: { clientId: 'synthetic-owner', hostId: 'local' } };
  const nativeQueue = { used: new Set(['synthetic-thread']), async operate(action, params, id, device, message) {
    f.calls.push({ action, params, id, device, message }); if (f.failure) throw f.failure;
    return action === 'edit' ? { ok: true, edited: true, draft: { text: '原生撤回的合成正文', images: [], attachments: [] } } : { ok: true, queued: action === 'enqueue', queueId: 'desktop-synthetic-id', ...(action === 'cancel' ? { canceled: true } : {}) };
  } };
  const adapter = { nativeQueue, async watch() { return f.snapshot; }, subscribed() { return entry; }, unwatch() {}, attachments: { materialize() { return []; } }, async operate(method, params) { f.calls.push({ method, params }); return { ok: true }; } };
  f.queue = new MessageQueue({ journal, adapter, exclusive: (_id, fn) => fn(), changed() {} });
  clearInterval(f.queue.timer);
  f.send = (queueAction, extra = {}, id = 'synthetic-command') => f.queue.operate({ threadId: 'synthetic-thread', queueAction, ...extra }, id, 'synthetic-phone');
  t.after(() => { f.queue.close(); journal.close(); });
  return f;
}

test('运行中手机消息只进入原生队列，旧账本不保存可再次发送的副本', async t => {
  const f = fixture(t);
  const result = await f.send('enqueue', { text: '手机合成排队消息' });
  assert.equal(result.queued, true); assert.equal(f.queue.rows('synthetic-thread').length, 0);
  assert.deepEqual(f.calls.map(call => call.action), ['enqueue']);
  assert.equal(f.calls[0].message.text, '手机合成排队消息');
  assert.equal(f.calls[0].message.context.workPermissions, undefined);
  assert.equal(f.calls[0].message.submissionOptions, undefined);
  await f.queue.pump(); assert.equal(f.calls.length, 1);
});

test('原生排队与旧记录合并展示；空闲发送不能越过已有电脑排队消息', async t => {
  const f = fixture(t);
  f.snapshot.status = 'idle'; f.snapshot.activeTurnId = '';
  f.snapshot.queuedMessages = [{ id: 'desktop-existing', text: 'PC 合成消息', source: 'desktop' }];
  await f.send('enqueue', { text: '手机后续消息' });
  assert.equal(f.calls[0].action, 'enqueue');
  f.queue.db.prepare("INSERT INTO message_queue(id,thread_id,device_id,command_id,payload,state) VALUES (?,?,?,?,?,'queued')").run('synthetic-legacy', 'synthetic-thread', 'synthetic-phone', 'synthetic-old-command', JSON.stringify({ text: '旧合成消息', images: [], attachments: [] }));
  const snapshot = f.queue.decorate(f.snapshot);
  assert.deepEqual(snapshot.queuedMessages.map(message => message.source), ['desktop', 'legacy']);
  assert.equal(snapshot.queuedMessages[0].id, 'desktop-existing');
});

test('真正空闲且没有待办时继续直接发送，回执不谎报排队', async t => {
  const f = fixture(t); f.snapshot.status = 'idle'; f.snapshot.activeTurnId = '';
  const result = await f.send('enqueue', { text: '直接合成消息' });
  assert.equal(result.queued, false); assert.equal(f.calls[0].method, 'turn.send');
});

test('原生写入结果未知或原生连接失效时不能再存入旧队列补发', async t => {
  const f = fixture(t); f.failure = new BridgeError('OUTCOME_UNKNOWN', '合成未知结果', true);
  await assert.rejects(f.send('enqueue', { text: '合成未知正文' }), error => error.outcomeUnknown);
  assert.equal(f.queue.rows('synthetic-thread').length, 0); assert.equal(f.calls.length, 1);
  f.snapshot.supportsNativeMessageQueue = false;
  await assert.rejects(f.send('enqueue', { text: '合成断线正文' }), error => error.code === 'NATIVE_QUEUE_UNAVAILABLE');
  assert.equal(f.queue.rows('synthetic-thread').length, 0); assert.equal(f.calls.length, 1);
});

test('原生编辑结果先落入旧账本，重复恢复和清理不会再次修改原生队列', async t => {
  const f = fixture(t);
  const result = await f.send('edit', { queueId: 'desktop-synthetic-id' });
  assert.equal(result.draft.text, '原生撤回的合成正文');
  assert.equal(f.queue.rows('synthetic-thread')[0].state, 'editing');
  assert.equal((await f.send('edit', { queueId: 'desktop-synthetic-id' }, 'synthetic-recovery')).draft.text, result.draft.text);
  await f.send('cancel', { queueId: 'desktop-synthetic-id' }, 'synthetic-cleanup');
  assert.equal(f.calls.length, 1); assert.equal(f.queue.rows('synthetic-thread').length, 0);
});
