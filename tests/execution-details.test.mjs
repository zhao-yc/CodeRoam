import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { normalizeConversation } from '../apps/bridge/conversation.mjs';
import { RECENT_CONVERSATION_OPTIONS, recentConversationPage } from '../apps/bridge/conversation-page.mjs';
import { conversationProjection } from '../apps/bridge/conversation-prefetch.mjs';
import { messageWindowUpdate } from '../apps/bridge/updates.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { StateReader } from '../apps/bridge/state-reader.mjs';
import { validateRequest } from '../packages/protocol/contracts.mjs';

const command = { id: 'command', type: 'commandExecution', command: 'echo synthetic', output: '合成执行输出' };
const state = { id: 'thread', turns: [{ turnId: 'turn', status: 'completed', items: [command] }] };

test('首屏、旧缓存和预加载只保留执行摘要，正文变动通过版本替换传递', () => {
  const full = normalizeConversation(state);
  const preview = normalizeConversation(state, RECENT_CONVERSATION_OPTIONS);
  assert.equal(preview.messages[0].text, '');
  assert.equal(preview.messages[0].summary, command.command);
  assert.match(preview.messages[0].detailRevision, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(recentConversationPage(full)).includes(command.output));
  assert.ok(!JSON.stringify(conversationProjection(full)).includes(command.output));
  const changed = normalizeConversation({ ...state, turns: [{ ...state.turns[0], items: [{ ...command, output: '后续输出' }] }] }, RECENT_CONVERSATION_OPTIONS);
  const update = messageWindowUpdate(preview.messages, changed.messages);
  assert.equal(update.appends.length, 0);
  assert.equal(update.upserts[0].detailRevision, changed.messages[0].detailRevision);
});

test('大量日志不会耗尽正文预算，记录标题与顺序仍然完整', () => {
  const items = Array.from({ length: 59 }, (_, index) => ({ ...command, id: 'command-' + index, output: '合成日志'.repeat(10000) }));
  items.unshift({ id: 'prompt', type: 'userMessage', content: '合成提问' });
  const page = recentConversationPage(normalizeConversation({ id: 'thread', turns: [{ turnId: 'turn', items }] }, RECENT_CONVERSATION_OPTIONS));
  assert.equal(page.messages.length, 60);
  assert.equal(page.messages[0].id, 'prompt');
  assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) < 24 * 1024);
  assert.ok(page.messages.slice(1).every(message => message.text === '' && message.summary === command.command));
});

test('详情请求只接受聊天和记录编号，不能夹带分页、路径或写操作', () => {
  const request = { v: 1, type: 'request', requestId: 'synthetic-execution-request', method: 'thread.history', params: { threadId: 'thread', executionMessageId: 'command' } };
  assert.equal(validateRequest(request), request);
  for (const params of [{ ...request.params, page: true }, { ...request.params, path: '/example/file' }, { ...request.params, executionMessageId: '' }]) {
    assert.throws(() => validateRequest({ ...request, params }));
  }
  assert.throws(() => validateRequest({ ...request, method: 'turn.send' }));
});

test('普通与独立实例复用只读接口，退订或实例换代丢弃详情', async t => {
  for (const instance of [undefined, { alive: true, ready: true, generation: 'synthetic-generation' }]) {
    const client = Object.assign(new EventEmitter(), { close() {}, instance });
    const adapter = new DesktopAdapter({ client });
    t.after(() => adapter.close());
    const entry = { state, watchers: new Set(['phone']), owner: null, waiters: [] };
    adapter.conversations.set('thread', entry);
    await assert.rejects(adapter.executionDetail('thread', 'command', 'other'), { code: 'SUBSCRIPTION_REQUIRED' });
    const result = await adapter.executionDetail('thread', 'command', 'phone');
    assert.equal(result.message.text, 'echo synthetic\n合成执行输出');
    entry.state = null;
    let release;
    adapter.index = { readExecution: () => new Promise(resolve => { release = resolve; }) };
    const pending = adapter.executionDetail('thread', 'command', 'phone');
    entry.watchers.clear();
    release(result.message);
    await assert.rejects(pending, { code: 'SUBSCRIPTION_CANCELED' });
  }
});

test('旧日志和投影历史都能按编号读取窗口外详情，投影遵守分叉边界', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-execution-detail-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  const index = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  index.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,archived INTEGER)');
  try {
    const file = path.join(home, 'sessions/thread.jsonl');
    const record = { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn', item: { ...command, type: 'CommandExecution' } } };
    fs.writeFileSync(file, [JSON.stringify({ type: 'session_meta', payload: { id: 'thread' } }), JSON.stringify(record)].join('\n') + '\n');
    index.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('thread', '合成聊天', '', file, 1, 0);
    const reader = new StateReader(home);
    assert.equal(reader.readHistory('thread', { page: true }).messages[0].text, '');
    assert.equal(reader.readExecution('thread', 'command').text, 'echo synthetic\n合成执行输出');
    const projection = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
    try {
      projection.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,item_json TEXT,item_type TEXT,updated_at_ordinal INTEGER);CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,error_json TEXT,duration_ms INTEGER,rollout_end_ordinal INTEGER)');
      projection.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run('thread', 'turn', 'command', 1, JSON.stringify(command), command.type, 1);
      assert.equal(reader.readExecution('thread', 'command').text, 'echo synthetic\n合成执行输出');
      const child = path.join(home, 'sessions/child.jsonl');
      fs.writeFileSync(child, JSON.stringify({ type: 'session_meta', payload: { id: 'child', history_base: { thread_id: 'thread', end_ordinal_exclusive: 1 } } }) + '\n');
      index.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('child', '合成分叉', '', child, 1, 0);
      assert.equal(reader.readExecution('child', 'command'), undefined);
    } finally { projection.close(); }
  } finally { index.close(); fs.rmSync(home, { recursive: true }); }
});

test('手机详情只在打开后请求，失败可重试，关闭和切换后忽略旧回执', async () => {
  const source = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
  const start = source.indexOf('function readExecutionDetail()');
  const end = source.indexOf('// 执行输出变化时', start);
  const requests = [];
  const ref = value => ({ value });
  const context = vm.createContext({ clearTimeout() {}, executionDetailTimer: 0, executionDetailRequest: 0, executionDetailText: ref(''), executionDetailLoading: ref(false), executionDetailError: ref(''), selectedExecution: ref({ id: 'command', detailRevision: 'revision', text: '' }), selectedExecutionId: ref('command'), pageHostId: ref('host'), pageThreadId: ref('thread'), isCurrentPage: () => true, connection: { connected: true }, bridge: { request: (method, params) => new Promise((resolve, reject) => { requests.push({ method, params, resolve, reject }); }) } });
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' }) + ';globalThis.read=readExecutionDetail', context);
  assert.equal(requests.length, 0);
  context.read();
  assert.equal(requests[0].params.executionMessageId, 'command');
  requests[0].reject(new Error('合成失败'));
  await new Promise(setImmediate);
  assert.equal(context.executionDetailError.value, '合成失败');
  context.read();
  requests[1].resolve({ threadId: 'thread', message: { id: 'command', kind: 'commandExecution', text: '合成详情' } });
  await new Promise(setImmediate);
  assert.equal(context.executionDetailText.value, '合成详情');
  context.read();
  context.selectedExecutionId.value = '';
  requests[2].resolve({ threadId: 'thread', message: { id: 'command', kind: 'commandExecution', text: '迟到详情' } });
  await new Promise(setImmediate);
  assert.equal(context.executionDetailText.value, '合成详情');
});
