import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeServerMessageQueue } from '../apps/bridge/native-server-message-queue.mjs';
import { MessageQueue } from '../apps/bridge/message-queue.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

function fixture(t) {
  const f = { rows: [], calls: [] };
  const entry = { state: { id: 'synthetic-thread', cwd: '/example/workspace' }, owner: { clientId: 'synthetic-owner', hostId: 'local' }, watchers: new Set(['synthetic-phone']) };
  const instance = { pid: 1, startedAt: 1, generation: 1, port: null, executable: '/example/Codex', codexHome: '/example/home', alive: true, verify: async () => {} };
  const adapter = new EventEmitter();
  Object.assign(adapter, {
    conversations: new Map([['synthetic-thread', entry]]),
    client: { instance, async request(method, params) { f.calls.push({ method, params }); if (f.sendError) throw f.sendError; return { resultType: 'success', result: { result: { turnId: 'synthetic-turn' } } }; } },
    subscribed() { return entry; },
    snapshot() { return { threadId: 'synthetic-thread', activeTurnId: f.turnId ?? 'synthetic-turn', status: f.status ?? 'active', ...adapter.nativeQueue.snapshot('synthetic-thread') }; },
    async watch() { await adapter.nativeQueue.refresh('synthetic-thread', 'synthetic-phone', { force: true }); return adapter.snapshot(); },
    unwatch() {}, attachments: { materialize() { return []; } },
  });
  const client = {
    async list() { if (f.readError) throw f.readError; return structuredClone(f.rows); },
    async enqueue(threadId, input, commandId) {
      const row = { id: 'synthetic-native-' + commandId, clientUserMessageId: commandId, input };
      f.rows.push(row); f.calls.push({ action: 'enqueue', row }); f.afterEnqueue?.(); return row;
    },
    async remove(threadId, id) {
      f.calls.push({ action: 'remove', id }); if (f.removeError) throw f.removeError;
      const at = f.rows.findIndex(row => row.id === id); if (at < 0) return false;
      f.rows.splice(at, 1); f.afterRemove?.(); return true;
    },
  };
  adapter.nativeQueue = new NativeServerMessageQueue({ adapter, createClient: () => client, readStored: () => f.stored ?? [] });
  const journal = new Journal();
  const queue = new MessageQueue({ journal, adapter, exclusive: (_id, fn) => fn(), changed() {} });
  clearInterval(queue.timer);
  Object.assign(f, { adapter, entry, instance, queue, journal, native: adapter.nativeQueue });
  f.add = (text = '合成电脑消息', extra = {}) => f.rows.push({ id: 'synthetic-native-' + f.rows.length, clientUserMessageId: 'synthetic-message-' + f.rows.length, input: [{ type: 'text', text, text_elements: [] }], ...extra });
  f.read = async () => { await f.native.refresh('synthetic-thread', 'synthetic-phone', { force: true }); return f.native.snapshot('synthetic-thread'); };
  f.send = (queueAction, extra = {}, commandId = 'synthetic-command') => {
    const params = { threadId: 'synthetic-thread', queueAction, ...extra };
    return journal.execute('synthetic-phone', commandId, 'turn.send', params, () => queue.operate(params, commandId, 'synthetic-phone'));
  };
  t.after(() => { queue.close(); f.native.close(); journal.close(); });
  return f;
}

test('普通启动没有调试端口也发布电脑原生队列能力', async t => {
  const f = fixture(t); f.add(); const snapshot = await f.read();
  assert.equal(snapshot.supportsNativeMessageQueue, true);
  assert.equal(snapshot.queuedMessages[0].text, '合成电脑消息');
  assert.equal(snapshot.queuedMessages[0].source, 'desktop');
  assert.equal(snapshot.queuedMessages[0].nativeId, undefined);
  assert.equal(snapshot.queuedMessages[0].row, undefined);
});

test('手机入队使用逐条后端接口并保留电脑并发消息，不生成旧发送副本', async t => {
  const f = fixture(t); f.add('电脑已有消息');
  f.afterEnqueue = () => f.add('电脑并发新增消息');
  const result = await f.send('enqueue', { text: '手机合成正文' });
  assert.match(result.queueId, /^desktop-/);
  assert.deepEqual(f.rows.map(row => row.input[0].text), ['电脑已有消息', '手机合成正文', '电脑并发新增消息']);
  assert.equal(f.queue.rows('synthetic-thread').length, 0);
  await f.queue.pump(); assert.equal(f.calls.filter(call => call.action === 'enqueue').length, 1);
});

test('原生文件上下文只公开正文及附件数量，复杂项隐藏编辑和追加', async t => {
  const f = fixture(t);
  f.add('# Files mentioned by the user:\n## 合成附件: /example/private/attachment.txt\n\n## My request:\n分析合成附件');
  const row = (await f.read()).queuedMessages[0];
  assert.equal(row.text, '分析合成附件'); assert.equal(row.attachmentCount, 1);
  assert.equal(row.canEdit, false); assert.equal(row.canSteer, false);
  assert.equal(JSON.stringify(row).includes('/example/private'), false);
});

test('同编号追加复用成功回执，双队列出队且后台泵不会再次发送', async t => {
  const f = fixture(t); f.add(); const id = (await f.read()).queuedMessages[0].id;
  const params = { queueId: id, expectedTurnId: 'synthetic-turn' };
  assert.equal((await f.send('steer', params)).queued, false);
  assert.equal((await f.send('steer', params)).queued, false);
  assert.equal(f.rows.length, 0); assert.equal(f.queue.rows('synthetic-thread').length, 0);
  assert.equal(f.calls.filter(call => call.method === 'thread-follower-steer-turn').length, 1);
  assert.equal(f.calls.find(call => call.method)?.params.clientUserMessageId, 'synthetic-message-0');
  await f.queue.pump(); assert.equal(f.calls.length, 2);
});

test('追加轮次过期时保留原生消息，不能移除或发送', async t => {
  const f = fixture(t); f.add(); const id = (await f.read()).queuedMessages[0].id;
  await assert.rejects(f.send('steer', { queueId: id, expectedTurnId: 'synthetic-old-turn' }), error => error.code === 'STALE_TURN');
  assert.equal(f.rows.length, 1); assert.equal(f.calls.length, 0);
});

test('删除后轮次变化保留未知占位，不恢复可重复发送的草稿', async t => {
  const f = fixture(t); f.add(); const id = (await f.read()).queuedMessages[0].id;
  f.afterRemove = () => { f.turnId = 'synthetic-next-turn'; };
  await assert.rejects(f.send('steer', { queueId: id, expectedTurnId: 'synthetic-turn' }), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(f.queue.rows('synthetic-thread')[0].state, 'unknown');
  await f.queue.pump(); assert.equal(f.calls.filter(call => call.method).length, 0);
});

test('追加断线后同编号重试和后台恢复均不重新发送', async t => {
  const f = fixture(t); f.add(); const id = (await f.read()).queuedMessages[0].id;
  f.sendError = Error('synthetic-transport-closed');
  const params = { queueId: id, expectedTurnId: 'synthetic-turn' };
  await assert.rejects(f.send('steer', params), error => error.code === 'OUTCOME_UNKNOWN');
  await assert.rejects(f.send('steer', params), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(f.queue.rows('synthetic-thread')[0].state, 'unknown');
  await f.queue.pump(); assert.equal(f.calls.filter(call => call.method).length, 1);
});

test('移除结果未知时正文留在未知账本中，不继续追加', async t => {
  const f = fixture(t); f.add(); const id = (await f.read()).queuedMessages[0].id;
  f.removeError = new BridgeError('OUTCOME_UNKNOWN', '合成未知结果', true);
  await assert.rejects(f.send('steer', { queueId: id, expectedTurnId: 'synthetic-turn' }), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(f.queue.rows('synthetic-thread')[0].state, 'unknown');
  assert.equal(f.calls.filter(call => call.method).length, 0);
});

test('原生撤回先落盘恢复草稿，再次编辑不重复删除', async t => {
  const f = fixture(t); f.add(); const id = (await f.read()).queuedMessages[0].id;
  const result = await f.send('edit', { queueId: id });
  assert.equal(result.draft.text, '合成电脑消息');
  assert.equal(f.rows.length, 0); assert.equal(f.queue.rows('synthetic-thread')[0].state, 'editing');
  assert.equal((await f.send('edit', { queueId: id }, 'synthetic-recover')).draft.text, result.draft.text);
  assert.equal(f.calls.filter(call => call.action === 'remove').length, 1);
});

test('写入后实例归属变化只报告未知，不转入旧发送队列', async t => {
  const f = fixture(t); f.afterEnqueue = () => { f.instance.generation++; };
  await assert.rejects(f.send('enqueue', { text: '合成正文' }), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(f.queue.rows('synthetic-thread').length, 0);
  assert.equal(f.rows.length, 1);
});

test('电脑队列读取失败后关闭写操作能力并保留已知展示', async t => {
  const f = fixture(t); f.add(); await f.read(); f.readError = Error('synthetic-read-error');
  const row = (await f.read()).queuedMessages[0];
  assert.equal(row.text, '合成电脑消息'); assert.equal(row.canSteer, false);
  await assert.rejects(f.send('enqueue', { text: '合成新正文' }), error => error.code === 'NATIVE_QUEUE_UNAVAILABLE');
});

test('兼容原生特殊上下文队列只展示安全字段并通过原所有者取消', async t => {
  const f = fixture(t);
  f.stored = [{ id: 'synthetic-stored-id', text: '合成特殊设置消息', submissionOptions: { model: 'synthetic-model' }, context: { fileAttachments: [{ path: '/example/private/file.txt' }] } }];
  const row = (await f.read()).queuedMessages[0];
  assert.equal(row.text, '合成特殊设置消息'); assert.equal(row.attachmentCount, 1);
  assert.equal(row.canEdit, false); assert.equal(row.canSteer, false);
  assert.equal(JSON.stringify(row).includes('/example/private'), false);
  f.adapter.client.request = async (method, params) => {
    assert.equal(method, 'thread-follower-remove-queued-message'); assert.equal(params.messageId, 'synthetic-stored-id');
    f.stored = []; return { resultType: 'success', result: { removed: { message: { id: params.messageId } } } };
  };
  assert.equal((await f.send('cancel', { queueId: row.id })).canceled, true);
});
