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
  // 新提交队列在任何明确失败后暂停整个实例；兼容场景必须显式处理原失败后继续。
  const resume = async (deviceId = 'phone') => { const { blockerId } = agent.taskQueue.list(deviceId); if (blockerId) await agent.taskQueue.control(deviceId, { taskId: blockerId, action: 'resume' }); };
  return { client, journal, adapter, agent, queue: agent.messageQueue, send, resume };
}

for (const [mode, binding] of [['普通启动', { directIpc: true }], ['多实例模式', { port: 9300 }]]) {
  test(mode + '发送占位在客户端确认成功时清除，实例核验和重复提交保护有效', async t => {
    const f = fixture(t);
    let verified = 0;
    f.client.instance = { ...binding, platform: 'win32', generation: randomUUID(), alive: true, ready: true, verify: async () => { verified++; } };
    f.client.idle();
    await f.adapter.watch('thread', 'phone');
    f.agent.taskQueue.ready = () => false;
    const taskId = randomUUID();
    const input = { taskId, kind: 'command', payload: { method: 'turn.send', params: { threadId: 'thread', text: '合成发送确认', queueAction: 'enqueue' } } };
    const request = { v: 1, type: 'request', requestId: randomUUID(), deviceId: 'phone', method: 'tasks.submit', params: input, expectedGeneration: f.client.instance.generation };
    const accepted = await f.agent.handleRequest(request);
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.result.accepted, true);
    assert.equal(f.client.calls.length, 0);
    assert.equal(f.agent.taskQueue.decorateMessages({ threadId: 'thread', messages: [] }).messages[0].status, 'queued');
    let confirm;
    const confirmation = new Promise(resolve => { confirm = resolve; });
    const original = f.client.request.bind(f.client);
    f.client.request = async (...args) => { const result = await original(...args); await confirmation; return result; };
    f.agent.taskQueue.ready = () => true;
    const sending = f.agent.taskQueue.pump();
    await new Promise(setImmediate);
    assert.equal(f.agent.taskQueue.decorateMessages({ threadId: 'thread', messages: [] }).messages[0].status, 'running');
    confirm();
    await sending;
    assert.equal(f.agent.taskQueue.row('phone', taskId).state, 'succeeded');
    assert.deepEqual(f.agent.taskQueue.decorateMessages({ threadId: 'thread', messages: [] }).messages, []);
    await f.agent.handleRequest({ ...request, requestId: randomUUID() });
    assert.equal(f.client.calls.length, 1);
    assert.equal(f.client.calls[0].method, 'thread-follower-start-turn');
    assert.equal(f.client.calls[0].params.turnStart.request.clientUserMessageId, taskId);
    assert.ok(verified > 0);
  });
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
  await f.resume();
  assert.equal((await f.send('cancel', { queueId: result.queueId }, randomUUID(), 'other-phone')).error.code, 'QUEUE_FORBIDDEN');
  await f.resume('other-phone');
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

test('编辑先撤回完整图文和附件，不投递正文且只返回原上传编号与展示信息', async t => {
  const f = fixture(t), image = 'data:image/png;base64,' + fs.readFileSync('apps/mobile/static/icons/check-dark.png').toString('base64');
  const uploadId = 'synthetic-upload-00001';
  f.adapter.attachments.metadata = (_device, _thread, id) => ({ metadata: { id, name: '合成附件.txt', size: 12, complete: true, privatePath: '/example/private/upload' } });
  const first = await f.send('enqueue', { text: '原合成消息', images: [image], attachments: [uploadId] });
  const commandId = randomUUID(), response = await f.send('edit', { queueId: first.result.queueId }, commandId);
  assert.equal(response.error, undefined); assert.equal(response.result.edited, true);
  assert.deepEqual(response.result.draft, { text: '原合成消息', images: [image], attachments: [{ id: uploadId, name: '合成附件.txt', size: 12 }] });
  assert.equal(f.queue.rows('thread')[0].state, 'editing'); assert.equal(f.client.calls.length, 0);
  const replay = await f.send('edit', { queueId: first.result.queueId }, commandId); assert.deepEqual(replay.result, response.result);
  const snapshot = f.queue.decorate({ threadId: 'thread' }); assert.equal(snapshot.supportsQueueEditing, true); assert.equal(JSON.stringify(snapshot).includes('base64'), false);
  assert.equal(JSON.stringify(response.result).includes('privatePath'), false);
});

test('撤回回执丢失可再次恢复，退出或切页不自动发送，后续排队消息正常执行', async t => {
  const f = fixture(t), first = await f.send('enqueue', { text: '撤回后编辑' });
  await f.send('enqueue', { text: '下一条合成消息' });
  await f.send('edit', { queueId: first.result.queueId });
  f.client.idle(); await f.queue.pump(); assert.equal(f.client.calls.length, 1);
  assert.equal(f.client.calls[0].params.turnStart.request.input[0].text, '下一条合成消息');
  const recovered = await f.send('edit', { queueId: first.result.queueId }); assert.equal(recovered.result.draft.text, '撤回后编辑');
  await f.send('cancel', { queueId: first.result.queueId }); await f.queue.pump(); assert.equal(f.client.calls.length, 1);
  assert.equal(f.queue.rows('thread').some(row => row.id === first.result.queueId), false);
});

test('已发送或待核对状态拒绝编辑，跨设备和过期附件也不能借编辑改变原队列', async t => {
  const f = fixture(t), first = await f.send('enqueue', { text: '合成消息' }), queueId = first.result.queueId;
  assert.equal((await f.send('edit', { queueId }, randomUUID(), 'other-phone')).error.code, 'QUEUE_FORBIDDEN');
  await f.resume('other-phone');
  for (const state of ['sending', 'dispatched', 'unknown', 'failed']) {
    f.journal.db.prepare('UPDATE message_queue SET state=? WHERE id=?').run(state, queueId);
    assert.equal((await f.send('edit', { queueId })).error.code, 'QUEUE_CHANGED'); assert.equal(f.queue.rows('thread')[0].state, state);
    await f.resume();
  }
  f.journal.db.prepare("UPDATE message_queue SET state='queued',payload=? WHERE id=?").run(JSON.stringify({ threadId: 'thread', text: '合成附件', images: [], attachments: ['synthetic-upload-00001'] }), queueId);
  f.adapter.attachments.metadata = () => { throw Object.assign(Error('附件已过期'), { code: 'UPLOAD_EXPIRED' }); };
  assert.equal((await f.send('edit', { queueId })).error.code, 'UPLOAD_EXPIRED'); assert.equal(f.queue.rows('thread')[0].state, 'queued'); assert.equal(f.client.calls.length, 0);
});

test('空闲聊天的排队偏好直接发送，回执不谎报排队，重复请求也不重复投递', async t => {
  const f = fixture(t); f.client.idle(); const commandId = randomUUID();
  const first = await f.send('enqueue', { text: '空闲时正常发送' }, commandId);
  assert.equal(first.error, undefined); assert.equal(first.result.queued, false); assert.equal(f.queue.rows('thread').length, 0);
  assert.equal(f.client.calls.length, 1); assert.equal(f.client.calls[0].method, 'thread-follower-start-turn');
  assert.equal(f.client.calls[0].params.turnStart.request.input[0].text, '空闲时正常发送');
  assert.equal(f.adapter.conversations.get('thread')?.watchers.has('message-queue') ?? false, false);
  const replay = await f.send('enqueue', { text: '空闲时正常发送' }, commandId); assert.equal(replay.result.queued, false); await f.queue.pump(); assert.equal(f.client.calls.length, 1);
});

test('空闲判断后的明确轮次竞争才转排队，超时和未知结果不会再次保存正文', async t => {
  const f = fixture(t); f.client.idle(); const original = f.adapter.operate.bind(f.adapter); let attempted = 0;
  f.adapter.operate = (...args) => { if (attempted++ === 0) throw Object.assign(Error('任务已开始'), { code: 'TURN_ACTIVE' }); return original(...args); };
  const accepted = await f.send('enqueue', { text: '竞争后的合成消息' }); assert.equal(accepted.result.queued, true); assert.equal(f.queue.rows('thread').length, 1); assert.equal(f.client.calls.length, 0);
  await f.queue.pump(); assert.equal(f.client.calls.length, 1);
  const other = fixture(t); other.client.idle(); other.client.error = Object.assign(Error('IPC timeout'), { outcomeUnknown: true });
  const unknown = await other.send('enqueue', { text: '结果未知的合成消息' }); assert.equal(unknown.error.outcomeUnknown, true); assert.equal(other.queue.rows('thread').length, 0);
  await other.queue.pump(); assert.equal(other.client.calls.length, 1);
});

test('已有待发消息时空闲也不越过队列，已撤回的编辑记录不造成假排队', async t => {
  const f = fixture(t); await f.send('enqueue', { text: '已有第一条' }); f.client.idle();
  const next = await f.send('enqueue', { text: '追加到已有队尾' }); assert.equal(next.result.queued, true); assert.equal(f.client.calls.length, 0);
  await f.queue.pump(); assert.equal(f.client.calls[0].params.turnStart.request.input[0].text, '已有第一条');
  const other = fixture(t), first = await other.send('enqueue', { text: '已撤回的旧消息' }); await other.send('edit', { queueId: first.result.queueId }); other.client.idle();
  const direct = await other.send('enqueue', { text: '不等待编辑记录的新消息' }); assert.equal(direct.result.queued, false); assert.equal(other.queue.rows('thread')[0].state, 'editing'); assert.equal(other.client.calls.length, 1);
});

test('审批、原生问题、计划确认和未知状态不能被空闲直发绕过', async t => {
  for (const blocker of [{ approvals: [{ id: 'synthetic-approval' }] }, { pendingPlan: { id: 'synthetic-plan' } }, { questionGroups: [{ kind: 'native', state: 'pending' }] }, { status: 'unknown' }]) {
    const f = fixture(t); f.client.idle(); f.queue.snapshot = async () => ({ threadId: 'thread', status: 'idle', activeTurnId: '', approvals: [], questionGroups: [], ...blocker });
    const result = await f.send('enqueue', { text: '等待状态确认' }); assert.equal(result.result.queued, true); assert.equal(f.queue.rows('thread').length, 1); assert.equal(f.client.calls.length, 0);
  }
});
