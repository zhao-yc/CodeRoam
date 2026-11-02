import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Journal } from '../apps/bridge/journal.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { validateRequest } from '../packages/protocol/contracts.mjs';

/** 使用真实适配器、队列和账本，仅模拟原桌面 IPC 的快照与响应。 */
class Desktop extends EventEmitter {
  constructor() {
    super(); this.socket = { writable: true }; this.calls = []; this.revision = 0;
    this.state = { id: 'thread', title: '合成会话', turns: [{ turnId: 'original', status: 'inProgress', items: [] }], requests: [], threadRuntimeStatus: { type: 'active' } };
  }
  async connect() {}
  async findOwner(_id, hostId) { return { clientId: 'desktop', hostId }; }
  broadcast(_method, params) {
    if (params.following) queueMicrotask(() => this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: ++this.revision, conversationState: structuredClone(this.state) } } }));
  }
  async request(method, params) { this.calls.push({ method, params }); if (this.error) throw this.error; return { resultType: 'success', result: { ok: true } }; }
  idle() { this.state.turns.at(-1).status = 'completed'; this.state.threadRuntimeStatus.type = 'idle'; }
  next() { this.state.turns.push({ turnId: randomUUID(), status: 'inProgress', items: [] }); this.state.threadRuntimeStatus.type = 'active'; }
  close() {}
}
function fixture(t) {
  const client = new Desktop(), journal = new Journal(), adapter = new DesktopAdapter({ client });
  const agent = new BridgeAgent({ config: {}, adapter, journal });
  clearInterval(agent.messageQueue.timer);
  t.after(() => agent.close());
  const send = async (queueAction, extra = {}, requestId = randomUUID(), deviceId = 'phone') => agent.handleRequest({ v: 1, type: 'request', requestId, transportId: requestId, deviceId, method: 'turn.send', params: { threadId: 'thread', queueAction, ...extra } });
  return { client, journal, adapter, agent, queue: agent.messageQueue, send };
}

test('运行中发送只入队，重复请求不重复保存，手机退订后仍按顺序开始下一轮', async t => {
  const f = fixture(t), id = randomUUID();
  const first = await f.send('enqueue', { text: '第一条合成消息' }, id);
  assert.equal(first.result.queued, true);
  await f.send('enqueue', { text: '第一条合成消息' }, id);
  await f.send('enqueue', { text: '第二条合成消息' });
  assert.equal(f.queue.rows('thread').length, 2); assert.equal(f.client.calls.length, 0);
  await f.queue.pump(); assert.equal(f.client.calls.length, 0);
  f.adapter.unwatch('thread', 'phone');
  assert.ok(f.adapter.conversations.get('thread').watchers.has('message-queue'));
  f.client.idle(); await f.queue.pump();
  assert.equal(f.client.calls.length, 1); assert.equal(f.client.calls[0].method, 'thread-follower-start-turn');
  assert.equal(f.client.calls[0].params.turnStart.request.input[0].text, '第一条合成消息');
  await f.queue.pump(); assert.equal(f.client.calls.length, 1, '成功回执之后等待桌面确认新轮次，不能连发');
  f.client.next(); await f.queue.pump(); await f.queue.pump(); assert.equal(f.client.calls.length, 1);
  f.client.idle(); await f.queue.pump(); assert.equal(f.client.calls.length, 2);
  assert.equal(f.client.calls[1].params.turnStart.request.input[0].text, '第二条合成消息');
});

test('手动追加使用同一条队列正文，成功后移除且不会在空闲时再发送', async t => {
  const f = fixture(t), first = await f.send('enqueue', { text: '补充合成要求' });
  const queueId = first.result.queueId;
  const response = await f.send('steer', { queueId, expectedTurnId: 'original' });
  assert.equal(response.error, undefined); assert.equal(f.client.calls.length, 1);
  assert.equal(f.client.calls[0].method, 'thread-follower-steer-turn');
  assert.equal(f.client.calls[0].params.input[0].text, '补充合成要求');
  f.client.idle(); await f.queue.pump(); assert.equal(f.client.calls.length, 1); assert.equal(f.queue.rows('thread').length, 0);
});

test('旧轮次追加失败保留队列；其他设备不能操作；取消不会发送正文', async t => {
  const f = fixture(t), { result } = await f.send('enqueue', { text: '合成消息' });
  assert.equal((await f.send('steer', { queueId: result.queueId, expectedTurnId: 'stale' })).error.code, 'STALE_TURN');
  assert.equal((await f.send('cancel', { queueId: result.queueId }, randomUUID(), 'other-phone')).error.code, 'QUEUE_FORBIDDEN');
  assert.equal(f.queue.rows('thread').length, 1);
  assert.equal((await f.send('cancel', { queueId: result.queueId })).result.canceled, true);
  assert.equal(f.client.calls.length, 0); assert.equal(f.queue.rows('thread').length, 0);
});

test('超时、发送失败和未知结果都暂停队列，后续轮询不自动重发', async t => {
  for (const unknown of [true, false]) {
    const f = fixture(t); await f.send('enqueue', { text: '合成消息' });
    f.client.error = Object.assign(new Error(unknown ? 'IPC timeout' : '模拟发送失败'), { outcomeUnknown: unknown });
    f.client.idle(); await f.queue.pump(); await f.queue.pump();
    assert.equal(f.queue.rows('thread')[0].state, unknown ? 'unknown' : 'failed'); assert.equal(f.client.calls.length, 1);
    assert.equal(f.queue.decorate({ threadId: 'thread' }).queuedMessages[0].error.includes('模拟发送失败'), false);
  }
});

test('重建队列把崩溃中的发送标为未知，已排队消息保留，删除清理队列', async t => {
  const f = fixture(t); await f.send('enqueue', { text: '合成消息' });
  f.journal.db.prepare("UPDATE message_queue SET state='sending'").run();
  f.queue.close();
  const { MessageQueue } = await import('../apps/bridge/message-queue.mjs');
  const restored = new MessageQueue({ journal: f.journal, adapter: f.adapter, exclusive: (_id, fn) => fn(), changed: () => {} });
  restored.close(); assert.equal(restored.rows('thread')[0].state, 'unknown');
  restored.forget(['thread']); assert.equal(restored.rows('thread').length, 0);
});

test('队列参数限制操作名、轮次和附件编号，不接受手机传入路径或新正文替换追加消息', () => {
  const request = params => ({ v: 1, type: 'request', requestId: randomUUID(), method: 'turn.send', params: { threadId: 'thread', ...params } });
  for (const params of [{ queueAction: 'invalid' }, { queueAction: 'steer', queueId: 'entry' }, { queueAction: 'steer', queueId: 'entry', expectedTurnId: 'turn', text: '替换消息' }, { queueAction: 'enqueue', text: '合成', cwd: '/tmp/example' }, { queueAction: 'enqueue', attachments: ['../example'] }]) assert.throws(() => validateRequest(request(params)));
  assert.doesNotThrow(() => validateRequest(request({ queueAction: 'enqueue', text: '合成', attachments: [] })));
});

test('排队图片原样追加，展示快照只含数量，追加成功不重复发送图片', async t => {
  const f = fixture(t), image = 'data:image/png;base64,' + fs.readFileSync('apps/mobile/static/icons/check-dark.png').toString('base64');
  const { result } = await f.send('enqueue', { images: [image] });
  const snapshot = f.queue.decorate({ threadId: 'thread' });
  assert.equal(snapshot.queuedMessages[0].imageCount, 1); assert.equal(JSON.stringify(snapshot).includes('base64'), false);
  await f.send('steer', { queueId: result.queueId, expectedTurnId: 'original' });
  assert.deepEqual(f.client.calls[0].params.input, [{ type: 'image', url: image }]);
  f.client.idle(); await f.queue.pump(); assert.equal(f.client.calls.length, 1);
});
