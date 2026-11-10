import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeServerMessageQueue } from '../apps/bridge/native-server-message-queue.mjs';
import { MessageQueue } from '../apps/bridge/message-queue.mjs';
import { Journal } from '../apps/bridge/journal.mjs';

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

test('原生文件上下文只公开正文及附件数量，复杂项隐藏编辑和追加', async t => {
  const f = fixture(t);
  f.add('# Files mentioned by the user:\n## 合成附件: /example/private/attachment.txt\n\n## My request:\n分析合成附件');
  const row = (await f.read()).queuedMessages[0];
  assert.equal(row.text, '分析合成附件'); assert.equal(row.attachmentCount, 1);
  assert.equal(row.canEdit, false); assert.equal(row.canSteer, false);
  assert.equal(JSON.stringify(row).includes('/example/private'), false);
});

test('原生队列只读，旧客户端重复操作也不会修改电脑消息', async t => {
  const f = fixture(t); f.add();
  const { id, canCancel } = (await f.read()).queuedMessages[0];
  assert.equal(canCancel, false);
  for (const action of ['steer', 'edit', 'cancel']) {
    await assert.rejects(f.send(action, { queueId: id, expectedTurnId: 'synthetic-turn' }, action), { code: 'DESKTOP_QUEUE_READ_ONLY' });
    await assert.rejects(f.send(action, { queueId: id, expectedTurnId: 'synthetic-turn' }, action), { code: 'DESKTOP_QUEUE_READ_ONLY' });
  }
  assert.equal(f.rows.length, 1);
  assert.equal(f.queue.rows('synthetic-thread').length, 0);
  assert.equal(f.calls.length, 0);
});

test('历史未知追加占位保持冻结，后台泵不会恢复投递', async t => {
  const f = fixture(t);
  f.journal.db.prepare("INSERT INTO message_queue(id,thread_id,device_id,command_id,payload,state) VALUES (?,?,?,?,?,'unknown')").run('desktop-synthetic-unknown', 'synthetic-thread', 'synthetic-phone', 'synthetic-prior-command', JSON.stringify({ threadId: 'synthetic-thread', text: '合成未知正文', images: [], attachments: [] }));
  await f.queue.pump();
  assert.equal(f.queue.rows('synthetic-thread')[0].state, 'unknown');
  assert.equal(f.calls.length, 0);
});

test('电脑队列读取失败后关闭写操作能力并保留已知展示', async t => {
  const f = fixture(t); f.add(); await f.read(); f.readError = Error('synthetic-read-error');
  const row = (await f.read()).queuedMessages[0];
  assert.equal(row.text, '合成电脑消息'); assert.equal(row.canSteer, false);
  assert.equal((await f.send('enqueue', { text: '合成新正文' })).queued, true);
});

test('兼容原生特殊上下文队列只读展示安全字段', async t => {
  const f = fixture(t);
  f.stored = [{ id: 'synthetic-stored-id', text: '合成特殊设置消息', submissionOptions: { model: 'synthetic-model' }, context: { fileAttachments: [{ path: '/example/private/file.txt' }] } }];
  const row = (await f.read()).queuedMessages[0];
  assert.equal(row.text, '合成特殊设置消息'); assert.equal(row.attachmentCount, 1);
  assert.equal(row.canEdit, false); assert.equal(row.canSteer, false);
  assert.equal(JSON.stringify(row).includes('/example/private'), false);
  assert.equal(row.canCancel, false);
  await assert.rejects(f.send('cancel', { queueId: row.id }), { code: 'DESKTOP_QUEUE_READ_ONLY' });
  assert.equal(f.stored.length, 1);
  assert.equal(f.calls.length, 0);
});
