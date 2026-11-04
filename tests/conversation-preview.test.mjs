import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTick } from 'node:timers/promises';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { ThreadCacheFeed } from '../apps/bridge/thread-cache.mjs';
import { conversationContentRevision } from '../apps/bridge/conversation-prefetch.mjs';
import { BridgeError, validateRequest, validConversationPreviewEvent } from '../packages/protocol/contracts.mjs';

const threadId = 'synthetic-preview-chat';
const snapshot = (suffix = '') => ({
  threadId, title: '合成聊天', cwd: '/synthetic/preview',
  messages: [{ id: 'message', role: 'assistant', text: '合成回复'.repeat(120) + suffix, turnId: 'turn', status: 'inProgress' }],
  turns: [{ turnId: 'turn', status: 'inProgress' }],
  status: 'active', activeTurnId: 'turn', approvals: [{ id: 'approval' }], questionGroups: [], updatedAt: 1,
});
const request = params => ({ v: 1, type: 'request', requestId: randomUUID(), transportId: randomUUID(), deviceId: 'phone', method: 'thread.watch', params: { threadId, previewId: randomUUID(), ...params } });

/** 独立账本和合成索引覆盖来源核对，不读取开发电脑的真实会话。 */
function fixture(t) {
  const journal = new Journal(), adapter = new EventEmitter(), sent = [];
  let current = snapshot(), source = 'one';
  adapter.conversations = new Map();
  adapter.close = () => {};
  adapter.threadMentions = { available: async () => false, close() {} };
  adapter.reads = 0;
  adapter.index = {
    list: () => [{ id: threadId }],
    historyCacheSource: () => { if (source == null) throw new BridgeError('THREAD_NOT_FOUND', '合成聊天已移除'); return source; },
    readHistory: () => { adapter.reads++; return current; },
    containsThread: () => source != null,
    visibleThreadIds: ids => new Set(source == null ? [] : ids),
  };
  adapter.watch = async () => current;
  const agent = new BridgeAgent({ config: {}, adapter, journal });
  agent.threadCache.remember(threadId);
  agent.send = event => { sent.push(event); return true; };
  t.after(() => agent.close());
  return { adapter, journal, agent, sent, change: (value, next) => { current = value; source = next; } };
}

test('首帧编号仅用于详情订阅，只读事件拒绝审批和运行权限', () => {
  const message = request();
  assert.doesNotThrow(() => validateRequest(message));
  for (const params of [{ previewId: 'short' }, { previewId: 1 }]) assert.throws(() => validateRequest(request(params)), { code: 'BAD_PARAMS' });
  assert.throws(() => validateRequest({ ...message, method: 'thread.history' }), { code: 'BAD_PARAMS' });
  const event = { v: 1, type: 'thread.preview', transportId: message.transportId, previewId: message.params.previewId, deviceId: 'phone', threadId,
    contentRevision: conversationContentRevision(snapshot()), snapshot: { ...snapshot(), readOnly: true, status: 'unknown', activeTurnId: '', approvals: [], updatedAt: 0 } };
  assert.equal(validConversationPreviewEvent(event), true);
  for (const changed of [{ readOnly: false }, { approvals: [{ id: 'approval' }] }, { activeTurnId: 'turn' }, { status: 'active' }]) {
    assert.equal(validConversationPreviewEvent({ ...event, snapshot: { ...event.snapshot, ...changed } }), false);
  }
});

test('PC 首帧按来源版本复用 SQLite，仅历史变化时重新解析', async t => {
  const f = fixture(t);
  f.agent.threadCache.save(snapshot(), 'one');
  const first = await f.agent.threadCache.preview(threadId);
  assert.equal(f.adapter.reads, 0);
  assert.equal(first.snapshot.readOnly, true);
  assert.deepEqual(first.snapshot.approvals, []);
  assert.equal(first.contentRevision, conversationContentRevision(snapshot()));
  f.change(snapshot('新'), 'two');
  const second = await f.agent.threadCache.preview(threadId);
  assert.equal(f.adapter.reads, 1);
  assert.equal(second.snapshot.messages[0].text, snapshot('新').messages[0].text);
  await f.agent.threadCache.preview(threadId);
  assert.equal(f.adapter.reads, 1);
  f.change(snapshot(), null);
  await assert.rejects(f.agent.threadCache.preview(threadId), { code: 'THREAD_NOT_FOUND' });
});

test('单次订阅先定向发只读首帧，桌面同时加载，最终只补新增文本和实时状态', async t => {
  const f = fixture(t);
  f.agent.threadCache.save(snapshot(), 'one');
  let finish, started = false;
  f.adapter.watch = () => { started = true; return new Promise(resolve => { finish = resolve; }); };
  const message = request({ activate: true }), pending = f.agent.handleRequest(message);
  await nextTick();
  assert.equal(started, true);
  const preview = f.sent.find(event => event.type === 'thread.preview');
  assert.equal(validConversationPreviewEvent(preview), true);
  assert.equal(preview.transportId, message.transportId);
  assert.equal(preview.previewId, message.params.previewId);
  assert.equal(preview.snapshot.approvals.length, 0);
  finish(snapshot('流式追加'));
  const response = await pending;
  assert.equal(response.error, undefined);
  assert.equal(response.result.desktopActivated, true);
  assert.equal(response.result.contentBaseRevision, preview.contentRevision);
  assert.equal(response.result.snapshot.messages, undefined);
  assert.deepEqual(response.result.contentUpdate.appends, [{ id: 'message', text: '流式追加', status: 'inProgress' }]);
  assert.equal(response.result.snapshot.approvals[0].id, 'approval');
});

test('预览基线不随后台两版窗口淘汰，断线续接已有版本时不发送旧预览', async t => {
  const f = fixture(t);
  f.agent.threadCache.save(snapshot(), 'one');
  let finish;
  f.adapter.watch = () => new Promise(resolve => { finish = resolve; });
  const pending = f.agent.handleRequest(request());
  await nextTick();
  const preview = f.sent.find(event => event.type === 'thread.preview');
  f.agent.threadCache.save(snapshot('一'));
  f.agent.threadCache.save(snapshot('二'));
  finish(snapshot('三'));
  const first = (await pending).result;
  assert.equal(first.contentBaseRevision, preview.contentRevision);
  assert.equal(first.contentUpdate.appends[0].text, '三');
  f.adapter.watch = async () => snapshot('三');
  const prior = f.sent.filter(event => event.type === 'thread.preview').length;
  const resumed = (await f.agent.handleRequest(request({ contentRevision: first.contentRevision }))).result;
  assert.equal(f.sent.filter(event => event.type === 'thread.preview').length, prior);
  assert.equal(resumed.contentBaseRevision, first.contentRevision);
});

test('快速实时回执不等待慢历史预览，迟到或失败的预览不会覆盖实时结果', async t => {
  const f = fixture(t);
  let finish;
  f.adapter.index.readHistory = () => new Promise(resolve => { finish = resolve; });
  const response = await f.agent.handleRequest(request());
  assert.equal(response.error, undefined);
  assert.equal(response.result.snapshot.messages[0].text, snapshot().messages[0].text);
  assert.equal(response.result.contentBaseRevision, undefined);
  finish(snapshot('迟到'));
  await nextTick();
  assert.equal(f.sent.some(event => event.type === 'thread.preview'), false);
  f.change(snapshot(), null);
  const failed = await f.agent.handleRequest(request());
  assert.equal(failed.error, undefined);
  assert.equal(failed.result.snapshot.messages[0].text, snapshot().messages[0].text);
});

test('明确归档或删除向当前详情发送一次移除，不依赖手机缓存订阅', async t => {
  const f = fixture(t);
  f.agent.publish(snapshot());
  f.agent.threadCache.forget(threadId);
  f.agent.threadCache.forget(threadId);
  assert.equal(f.sent.filter(event => event.type === 'thread.removed').length, 1);
  assert.equal(f.agent.published.has(threadId), false);
  const feed = new ThreadCacheFeed({ adapter: f.adapter, db: f.journal.db, send: () => {}, blocked: () => false, removed: id => f.sent.push({ type: 'observed-removal', id }) });
  t.after(() => feed.close());
  f.adapter.conversations.set(threadId, { watchers: new Set(['phone']) });
  f.change(snapshot(), null);
  feed.checkMembership();
  assert.equal(f.sent.at(-1).type, 'observed-removal');
});
