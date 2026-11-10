import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageQueue } from '../apps/bridge/message-queue.mjs';
import { Journal } from '../apps/bridge/journal.mjs';

/** 使用真实旧队列表与路由；只替换桌面接口，确保两套执行器不会重复接收同一消息。 */
function fixture(t) {
  const f = { calls: [], snapshot: { threadId: 'synthetic-thread', status: 'active', activeTurnId: 'synthetic-turn', supportsNativeMessageQueue: true, queuedMessages: [], approvals: [], questionGroups: [] } };
  const journal = new Journal();
  const nativeQueue = { operate() { assert.fail('手机不能写入电脑队列'); } };
  const adapter = { nativeQueue, async watch() { return f.snapshot; }, unwatch() {}, async operate(method, params) { f.calls.push({ method, params }); return { ok: true }; } };
  f.queue = new MessageQueue({ journal, adapter, exclusive: (_id, fn) => fn(), changed() {} });
  clearInterval(f.queue.timer);
  f.send = (queueAction, extra = {}, id = 'synthetic-command') => f.queue.operate({ threadId: 'synthetic-thread', queueAction, ...extra }, id, 'synthetic-phone');
  t.after(() => { f.queue.close(); journal.close(); });
  return f;
}

test('手机排队只写入独立账本，追加一次后移除', async t => {
  const f = fixture(t);
  const { queueId, queued } = await f.send('enqueue', { text: '手机合成排队消息' });
  assert.equal(queued, true);
  assert.equal(f.queue.rows('synthetic-thread').length, 1);
  assert.equal(f.queue.decorate(f.snapshot).queuedMessages[0].source, 'mobile');
  await f.queue.pump();
  assert.equal(f.calls.length, 0);
  await f.send('steer', { queueId, expectedTurnId: 'synthetic-turn' });
  f.snapshot.status = 'idle'; f.snapshot.activeTurnId = '';
  await f.queue.pump();
  assert.deepEqual(f.calls.map(call => call.method), ['turn.steer']);
  assert.equal(f.calls[0].params.text, '手机合成排队消息');
  assert.equal(f.queue.rows('synthetic-thread').length, 0);
});

test('手机自动发送等待电脑队列清空且可读，电脑项只读', async t => {
  const f = fixture(t);
  f.snapshot.status = 'idle'; f.snapshot.activeTurnId = '';
  f.snapshot.queuedMessages = [{ id: 'desktop-existing', text: '电脑合成消息', source: 'desktop', canCancel: true }];
  const result = await f.send('enqueue', { text: '手机后续消息' });
  assert.equal(result.queued, true);
  const [desktop, mobile] = f.queue.decorate(f.snapshot).queuedMessages;
  assert.deepEqual([desktop.source, mobile.source], ['desktop', 'mobile']);
  for (const capability of ['canCancel', 'canEdit', 'canSteer']) assert.equal(desktop[capability], false);
  for (const action of ['cancel', 'edit', 'steer']) {
    await assert.rejects(f.send(action, { queueId: desktop.id }), { code: 'DESKTOP_QUEUE_READ_ONLY' });
  }
  await f.queue.pump();
  f.snapshot.queuedMessages = [];
  f.snapshot.supportsNativeMessageQueue = false;
  await f.queue.pump();
  assert.equal(f.calls.length, 0);
  f.snapshot.supportsNativeMessageQueue = true;
  await f.queue.pump();
  assert.deepEqual(f.calls.map(call => call.method), ['turn.send']);
});

test('电脑队列不可读时仍可排队；正在运行时允许显式追加手机项', async t => {
  const f = fixture(t);
  f.snapshot.supportsNativeMessageQueue = false;
  const { queueId } = await f.send('enqueue', { text: '合成追加' });
  await f.send('steer', { queueId, expectedTurnId: 'synthetic-turn' });
  assert.deepEqual(f.calls.map(call => call.method), ['turn.steer']);
});

test('真正空闲且没有待办时继续直接发送，回执不谎报排队', async t => {
  const f = fixture(t); f.snapshot.status = 'idle'; f.snapshot.activeTurnId = '';
  const result = await f.send('enqueue', { text: '直接合成消息' });
  assert.equal(result.queued, false); assert.equal(f.calls[0].method, 'turn.send');
});

test('读取电脑队列期间取消手机消息，自动投递不得发送已取消的正文', async t => {
  const f = fixture(t);
  const { queueId } = await f.send('enqueue', { text: '待取消的合成消息' });
  f.snapshot.status = 'idle'; f.snapshot.activeTurnId = '';
  let done;
  f.queue.adapter.watch = () => new Promise(resolve => { done = resolve; });
  const pumping = f.queue.pump();
  await f.send('cancel', { queueId });
  done(f.snapshot);
  await pumping;
  assert.equal(f.calls.length, 0);
});
