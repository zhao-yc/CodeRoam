import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { ThreadListFeed } from '../apps/bridge/thread-list-feed.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { normalizeConversation } from '../apps/bridge/conversation.mjs';
import { conversationProjection, conversationContentRevision, existingConversationSnapshot, prefetchConversation } from '../apps/bridge/conversation-prefetch.mjs';
import { validateRequest, PROTOCOL_VERSION, READ_METHODS, WRITE_METHODS } from '../packages/protocol/contracts.mjs';

/** 所有输入均为合成会话，不读取桌面、私有配置或真实会话。 */
function state() {
  return { id: 'thread', title: '合成会话', cwd: '/workspace/demo', threadRuntimeStatus: { type: 'active' }, turns: [{ turnId: 'turn', status: 'inProgress', items: [{ id: 'message', type: 'agentMessage', text: '合成正文' }] }], requests: [] };
}

function request(params = { threadId: 'thread', view: 'prefetch' }) {
  return { v: 1, type: 'request', requestId: 'prefetch-request-0001', deviceId: 'phone', method: 'thread.history', params };
}

/** 用失败哨兵覆盖所有有副作用的入口，验证真正执行的 agent 路由。 */
function fixture(t) {
  const adapter = new EventEmitter();
  const entry = { state: state(), watchers: new Set(['existing-phone', 'list-status']), owner: { clientId: 'owner' }, revision: 7 };
  adapter.conversations = new Map([['thread', entry]]);
  adapter.index = { containsThread: () => true, readHistory: () => assert.fail('实时 entry 不应读取历史') };
  adapter.navigation = { current: { threadId: 'other', deviceId: 'existing-phone' } };
  adapter.native = { get unread() { assert.fail('预加载不能读取或同步原生已读'); } };
  for (const name of ['watch', 'unwatch', 'snapshot', 'connect', 'activateThread', 'refreshReadState']) adapter[name] = () => assert.fail('预加载不能调用 ' + name);
  const journal = { append: () => assert.fail('预加载不能写事件账本'), execute: () => assert.fail('预加载不能写操作账本') };
  const agent = new BridgeAgent({ config: {}, adapter, journal, newThreads: {} });
  agent.publish = () => assert.fail('预加载不能发布');
  agent.send = () => assert.fail('预加载不能额外推送');
  t.after(() => agent.threadListFeed.close());
  return { adapter, entry, agent };
}

test('共享投影严格白名单，稳定哈希忽略实时时间、未读和运行时对象', () => {
  const source = normalizeConversation(state());
  source.messages[0].images = ['合成图片数据'];
  source.messages[0].approvalTarget = { command: '合成审批目标' };
  source.messages[0].answers = { question: '合成答案' };
  source.turns[0].internal = { secret: '内部轮次' };
  const projected = conversationProjection(source), revision = conversationContentRevision(source);
  assert.deepEqual(Object.keys(projected), ['threadId', 'title', 'cwd', 'messages', 'turns', 'latestTurn']);
  assert.deepEqual(Object.keys(projected.messages[0]), ['id', 'role', 'kind', 'text', 'turnId', 'status']);
  assert.equal(JSON.stringify(projected).includes('合成图片数据'), false);
  assert.equal(JSON.stringify(projected).includes('合成答案'), false);
  const changed = { ...source, updatedAt: source.updatedAt + 999, hasUnreadTurn: true, status: 'idle', activeTurnId: 'another', activity: '运行摘要', notificationState: { state: 'waiting' }, permissionSettings: { mode: 'full-access' }, approvals: [{ id: 'approval' }], questionGroups: [{ answers: ['合成答案'] }] };
  assert.equal(conversationContentRevision(changed), revision);
  assert.equal(conversationContentRevision({ ...source, messages: source.messages.map(message => Object.fromEntries(Object.entries(message).reverse())) }), revision);
  assert.deepEqual(source.messages[0].images, ['合成图片数据']);
  for (const update of [
    value => { value.title += '新'; }, value => { value.cwd += '/new'; },
    ...['id', 'role', 'kind', 'summary', 'phase', 'text', 'turnId', 'status'].map(key => value => { value.messages[0][key] = '新' + key; }),
    value => { value.messages[0].imageCount = 1; }, value => { value.turns[0].status = 'failed'; },
    value => { value.turns[0].errorMessage = '合成错误'; }, value => { value.latestTurn.status = 'completed'; },
  ]) {
    const next = structuredClone(source); update(next);
    assert.notEqual(conversationContentRevision(next), revision);
  }
  projected.messages[0].text = '修改输出';
  assert.equal(source.messages[0].text, '合成正文');
});

test('预加载直接规范化实时 entry，返回纯展示只读快照且完全保留订阅、导航、未读和发布状态', async t => {
  const { agent, adapter, entry } = fixture(t);
  entry.state.requests = [{ id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: '合成命令目标' } }];
  const before = structuredClone(entry), navigation = structuredClone(adapter.navigation), published = [...agent.published];
  const response = await agent.handleRequest(request());
  assert.equal(response.error, undefined);
  assert.deepEqual(Object.keys(response.result), ['snapshot', 'contentRevision']);
  const { snapshot, contentRevision } = response.result;
  assert.equal(snapshot.readOnly, true); assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.activeTurnId, '');
  assert.deepEqual(snapshot.approvals, []); assert.deepEqual(snapshot.questionGroups, []); assert.equal(snapshot.updatedAt, 0);
  assert.equal(snapshot.permissionSettings, undefined); assert.equal(snapshot.hasUnreadTurn, undefined);
  assert.equal(snapshot.supportsTurnRetry, undefined); assert.equal(snapshot.pendingPlan, undefined);
  assert.equal(JSON.stringify(snapshot).includes('合成命令目标'), false);
  assert.equal(contentRevision, conversationContentRevision(normalizeConversation(entry.state)));
  assert.deepEqual(entry, before); assert.deepEqual(adapter.navigation, navigation); assert.deepEqual([...agent.published], published);
  assert.equal(adapter.conversations.size, 1); assert.equal(agent.threadLocks.size, 0);
  const feed = new ThreadListFeed(adapter, () => assert.fail('只读摘要不能推送'));
  t.after(() => feed.close());
  assert.equal(feed.contentSummary({ id: 'thread', updatedAt: 42 }).contentRevision, contentRevision);
});

test('缺少实时状态时只读历史，保存版本与列表一致且不创建 entry', async t => {
  const { agent, adapter } = fixture(t);
  adapter.conversations.clear();
  const source = { ...normalizeConversation(state()), updatedAt: 42, readOnly: true };
  let reads = 0;
  adapter.index.readHistory = (...args) => { reads++; assert.deepEqual(args, ['thread']); return source; };
  const response = await agent.handleRequest(request());
  assert.equal(response.error, undefined); assert.equal(response.result.contentRevision, 'saved:42');
  assert.equal(agent.threadListFeed.contentSummary({ id: 'thread', updatedAt: 42 }).contentRevision, 'saved:42');
  assert.equal(reads, 1); assert.equal(adapter.conversations.size, 0);
  assert.equal(response.result.snapshot.readOnly, true);
  assert.deepEqual(source, { ...normalizeConversation({ ...state() }), updatedAt: 42, readOnly: true });
});

test('预加载沿用 v1 history 白名单，拒绝额外参数、错误方法和无效聊天编号', () => {
  assert.equal(PROTOCOL_VERSION, 1); assert.equal(READ_METHODS.has('thread.history'), true); assert.equal(READ_METHODS.has('thread.prefetch'), false); assert.equal(WRITE_METHODS.has('thread.history'), false);
  assert.equal(validateRequest(request()).method, 'thread.history');
  for (const extra of [{ activate: true }, { page: true }, { before: 'cursor' }, { reportId: 'report' }, { imageMessageId: 'message' }, { limit: 10 }, { script: '合成脚本' }, { status: 'idle' }]) {
    assert.throws(() => validateRequest(request({ threadId: 'thread', view: 'prefetch', ...extra })), error => error.code === 'BAD_PARAMS');
  }
  for (const threadId of ['', ' ', 1, null, 'a'.repeat(201)]) assert.throws(() => validateRequest(request({ threadId, view: 'prefetch' })));
  assert.throws(() => validateRequest({ ...request(), method: 'thread.watch' }), error => error.code === 'BAD_PARAMS');
  for (const view of ['prefetc', '', null, false, {}]) assert.throws(() => validateRequest(request({ threadId: 'thread', view })), error => error.code === 'BAD_PARAMS');
  assert.equal(validateRequest(request({ threadId: 'thread', page: true })).params.page, true);
  assert.equal(validateRequest(request({ threadId: 'thread', view: 'file-report', reportId: 'report' })).params.view, 'file-report');
});

test('归档、删除和无身份请求在读取前拒绝，即使内存还留有快照', async t => {
  const { agent, adapter, entry } = fixture(t);
  adapter.index.containsThread = () => false;
  assert.equal((await agent.handleRequest(request())).error.code, 'THREAD_NOT_FOUND');
  adapter.index.containsThread = () => true;
  for (const field of ['archived', 'deleted', 'isArchived', 'isDeleted']) {
    entry.state[field] = true;
    assert.equal((await agent.handleRequest(request())).error.code, 'THREAD_NOT_FOUND'); delete entry.state[field];
  }
  agent.deletingIds.add('thread');
  assert.equal((await agent.handleRequest(request())).error.code, 'THREAD_NOT_FOUND'); agent.deletingIds.clear();
  assert.equal((await agent.handleRequest({ ...request(), deviceId: undefined })).error.code, 'UNAUTHENTICATED');
  assert.equal((await agent.handleRequest(request({ threadId: 'thread', view: 'prefetch', activate: false }))).error.code, 'BAD_PARAMS');
});

test('旧 adapter 缺少 containsThread 时安全降级；历史不可用、读错会话和缺失版本明确失败', async t => {
  const { agent, adapter } = fixture(t);
  adapter.index.containsThread = undefined;
  assert.equal((await agent.handleRequest(request())).result.snapshot.readOnly, true);
  adapter.conversations.clear(); adapter.index.readHistory = undefined;
  assert.equal((await agent.handleRequest(request())).error.code, 'HISTORY_UNAVAILABLE');
  for (const source of [null, { threadId: 'other', updatedAt: 42 }, { threadId: 'thread', messages: [] }]) {
    adapter.index.readHistory = () => source;
    assert.equal((await agent.handleRequest(request())).error.code, 'HISTORY_UNAVAILABLE');
  }
  adapter.index.readHistory = () => ({ ...normalizeConversation(state()), updatedAt: 0 });
  assert.equal((await agent.handleRequest(request())).result.contentRevision, 'saved:0');
});

test('历史读取途中归档、删除或失去索引成员资格时不返回迟到内容', async t => {
  const { agent, adapter } = fixture(t);
  adapter.conversations.clear();
  for (const action of ['archive', 'delete', 'deleted-source']) {
    let finish, exists = true;
    adapter.index.containsThread = () => exists;
    adapter.index.readHistory = () => new Promise(resolve => { finish = resolve; });
    const pending = agent.handleRequest(request());
    if (action === 'archive') exists = false;
    if (action === 'delete') agent.deletingIds.add('thread');
    finish({ ...normalizeConversation(state()), updatedAt: 42, ...(action === 'deleted-source' ? { deleted: true } : {}) });
    const response = await pending;
    assert.equal(response.error.code, 'THREAD_NOT_FOUND'); assert.equal(response.result, undefined);
    agent.deletingIds.clear();
  }
});

test('标题只读回退与列表版本一致，修改返回值不污染已有 entry', async t => {
  const { adapter, entry } = fixture(t);
  delete entry.state.title; entry.indexedTitle = '合成索引标题';
  const before = structuredClone(entry);
  const result = await prefetchConversation(adapter, 'thread');
  assert.equal(result.snapshot.title, '合成索引标题');
  result.snapshot.messages[0].text = '手机缓存改动';
  assert.deepEqual(entry, before);
});

test('普通列表和归档列表返回版本时保留原有行字段和响应结构', async t => {
  const { agent, adapter, entry } = fixture(t);
  const row = { id: 'thread', title: '合成会话', cwd: '/workspace/demo', updatedAt: 42, status: 'active', approvalCount: 1 };
  adapter.list = async () => [row];
  const listRequest = { ...request(), method: 'threads.list', params: {} };
  let response = await agent.handleRequest(listRequest);
  assert.deepEqual(response.result.threads, [{ ...row, contentRevision: conversationContentRevision(normalizeConversation(entry.state)) }]);
  response = await agent.handleRequest({ ...listRequest, params: { archived: true } });
  assert.deepEqual(response.result, { threads: [row], archived: true });
  assert.equal(Object.hasOwn(row, 'contentRevision'), false);
  adapter.conversations.clear();
  response = await agent.handleRequest(listRequest);
  assert.equal(response.result.threads[0].contentRevision, undefined);
  assert.equal(response.result.threads[0].status, 'active');
});

test('与真实 adapter.snapshot 的默认规范化窗口及全部标题回退一致', () => {
  const client = new EventEmitter();
  const adapter = new DesktopAdapter({ client, goalController: { available: false }, index: { readTitle: () => '合成索引标题' } });
  for (const fields of [
    { title: '明确标题', fallbackSearchTitle: '回退标题' }, { title: '', fallbackSearchTitle: '回退标题' },
    { title: ' ', fallbackSearchTitle: '回退标题' }, { title: undefined, indexedTitle: '缓存标题' },
    { title: undefined, indexedTitle: '', lastTitle: '最近标题' }, { title: undefined },
    { title: undefined, indexedTitle: '' },
  ]) {
    const { indexedTitle, lastTitle, ...titleFields } = fields;
    const source = { ...state(), ...titleFields };
    source.turns[0].items = Array.from({ length: 100 }, (_, index) => ({ id: 'message-' + index, type: 'agentMessage', text: '合成正文'.repeat(40) }));
    const entry = { state: source, watchers: new Set(), ...(Object.hasOwn(fields, 'indexedTitle') ? { indexedTitle } : {}), ...(lastTitle ? { lastTitle } : {}) };
    adapter.conversations.set('thread', entry);
    const before = structuredClone(entry);
    const prefetch = existingConversationSnapshot(adapter, 'thread');
    assert.deepEqual(entry, before);
    assert.equal(conversationContentRevision(prefetch), conversationContentRevision(adapter.snapshot(source)));
  }
});

test('预加载保留展示消息中的原生回答行，但不返回问答对象或操作目标', async t => {
  const { agent, entry } = fixture(t);
  entry.state.turns[0].items.push({ id: 'reply', type: 'userInputResponse', completed: true, requestId: 'question', questions: [{ id: 'choice', title: '合成选择' }], answers: { choice: ['合成已答展示'] } });
  const response = await agent.handleRequest(request());
  const reply = response.result.snapshot.messages.find(message => message.id === 'reply');
  assert.equal(reply.role, 'user'); assert.equal(reply.kind, 'userInputResponse'); assert.match(reply.text, /合成已答展示/);
  assert.deepEqual(response.result.snapshot.questionGroups, []);
  assert.equal(reply.requestId, undefined); assert.equal(reply.answers, undefined);
});
