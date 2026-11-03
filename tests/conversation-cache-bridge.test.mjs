import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTick } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { StateReader } from '../apps/bridge/state-reader.mjs';
import { ThreadCacheFeed, CACHE_THREAD_LIMIT, CACHE_WATCHER } from '../apps/bridge/thread-cache.mjs';
import { conversationContentRevision } from '../apps/bridge/conversation-prefetch.mjs';
import { BridgeError, validConversationCacheEvent } from '../packages/protocol/contracts.mjs';

const threadId = 'synthetic-thread';
const subscriptionId = 'synthetic-cache-id-01';
const text = '合成消息正文'.repeat(100);

/** 仅使用合成对话和独立临时账本。 */
function snapshot(suffix = '', id = threadId) {
  return { threadId: id, title: '合成对话', cwd: '/workspace/demo', messages: [{ id: 'message', role: 'assistant', kind: 'message', text: text + suffix, turnId: 'turn', status: 'inProgress' }], turns: [{ turnId: 'turn', status: 'inProgress' }], status: 'active', activeTurnId: 'turn', approvals: [{ id: 'approval', detail: '合成审批，仅实时' }], questionGroups: [], updatedAt: 10 };
}

function fixture(t, journal = new Journal()) {
  const data = new Map([[threadId, { source: 'one', snapshot: snapshot() }]]), sent = [];
  const adapter = new EventEmitter();
  adapter.conversations = new Map();
  adapter.index = {
    list: () => [...data.keys()].map(id => ({ id })),
    containsThread: id => data.has(id),
    visibleThreadIds: ids => new Set(ids.filter(id => data.has(id))),
    historyCacheSource: id => {
      if (!data.has(id)) throw new BridgeError('THREAD_NOT_FOUND', '合成聊天已移除');
      return data.get(id).source;
    },
    readHistory: id => { adapter.reads++; return data.get(id).snapshot; },
  };
  adapter.reads = 0;
  adapter.unwatch = (id, watcher) => adapter.conversations.get(id)?.watchers.delete(watcher);
  const feed = new ThreadCacheFeed({ adapter, db: journal.db, send: event => sent.push(event), blocked: () => false });
  t.after(() => { feed.close(); journal.close(); });
  return { feed, sent, data, journal, adapter };
}

test('后台缓存按设备隔离、静默复用相同版本，仅文件版本变化时补发增量', async t => {
  const f = fixture(t), before = conversationContentRevision(snapshot());
  f.feed.watch('phone-a', { subscriptionId, threads: [{ threadId, revision: before }] });
  f.feed.watch('phone-b', { subscriptionId, threads: [{ threadId, revision: '' }] });
  await f.feed.refresh();
  await f.feed.refresh();
  assert.equal(f.adapter.reads, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].deviceId, 'phone-b');
  assert.equal(f.sent[0].snapshot.approvals, undefined);
  assert.equal(f.sent[0].snapshot.status, undefined);
  assert.equal(validConversationCacheEvent(f.sent[0]), true);

  f.feed.unwatch('phone-b', { subscriptionId });
  f.data.set(threadId, { source: 'two', snapshot: snapshot('新增') });
  await f.feed.refresh();
  const event = f.sent.at(-1);
  assert.equal(f.adapter.reads, 2);
  assert.equal(f.sent.length, 2);
  assert.equal(event.deviceId, 'phone-a');
  assert.equal(event.baseRevision, before);
  assert.deepEqual(event.update.appends, [{ id: 'message', text: '新增', status: 'inProgress' }]);
  assert.equal(validConversationCacheEvent(event), true);

  f.data.delete(threadId);
  await f.feed.refresh();
  assert.deepEqual(f.sent.at(-1), { v: 1, type: 'thread.cache.event', deviceId: 'phone-a', subscriptionId, threadId, revision: '', removed: true });
  assert.equal(f.feed.row(threadId), undefined);
});

test('仅核对手机缓存成员时不读取正文，查库成功确认移除后才通知目标订阅', async t => {
  const f = fixture(t), cached = 'outside-window';
  const present = f.adapter.index.visibleThreadIds;
  f.adapter.index.list = () => [{ id: threadId }];
  f.data.set(cached, { source: 'one', snapshot: snapshot('', cached) });
  f.feed.watch('phone-a', { subscriptionId, threads: [], verify: [cached] });
  f.feed.watch('phone-b', { subscriptionId, threads: [{ threadId, revision: '' }], verify: [threadId] });
  await f.feed.refresh();
  assert.deepEqual([...f.feed.targets], [threadId]);
  assert.equal(f.adapter.reads, 1);
  assert.deepEqual(f.sent.map(event => [event.deviceId, event.threadId]), [['phone-b', threadId]]);

  f.data.delete(cached);
  f.adapter.index.visibleThreadIds = () => { throw new Error('合成索引暂时不可读'); };
  await f.feed.refresh();
  assert.equal(f.sent.length, 1);
  f.adapter.index.visibleThreadIds = present;
  await f.feed.refresh();
  await f.feed.refresh();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.at(-1), { v: 1, type: 'thread.cache.event', deviceId: 'phone-a', subscriptionId, threadId: cached, revision: '', removed: true });

  f.data.delete(threadId);
  await f.feed.refresh();
  assert.equal(f.sent.filter(event => event.threadId === threadId && event.removed).length, 1);
});

test('替换后台订阅后，继续中的扫描不会给新订阅发送旧核对目标的移除', async t => {
  const f = fixture(t), old = 'previous-cached', current = 'current-cached';
  f.adapter.index.list = () => [{ id: threadId }];
  f.data.set(old, { source: 'one', snapshot: snapshot('', old) });
  f.data.set(current, { source: 'one', snapshot: snapshot('', current) });
  f.feed.watch('phone', { subscriptionId, threads: [], verify: [old] });
  const scanning = f.feed.refresh();
  f.feed.unwatch('phone', { subscriptionId });
  f.feed.watch('phone', { subscriptionId, threads: [], verify: [current] });
  f.data.delete(old);
  f.data.delete(current);
  await scanning;
  await f.feed.refresh();
  assert.deepEqual(f.sent.map(event => [event.threadId, event.removed]), [[current, true]]);
});

test('历史并发请求合并并重读变化文件，归档途中产生的旧正文不重新进入缓存', async t => {
  const f = fixture(t);
  f.feed.remember(threadId);
  let resolve;
  f.adapter.index.readHistory = () => ++f.adapter.reads === 1 ? new Promise(done => { resolve = done; }) : snapshot('新');
  const first = f.feed.readSaved(threadId), second = f.feed.readSaved(threadId);
  assert.equal(first, second);
  await nextTick();
  f.data.set(threadId, { source: 'two', snapshot: snapshot('新') });
  resolve(snapshot());
  assert.equal((await first).messages[0].text, text + '新');
  assert.equal(f.adapter.reads, 2);
  assert.equal(f.feed.row(threadId).revision, conversationContentRevision(snapshot('新')));

  f.data.get(threadId).source = 'three';
  f.adapter.index.readHistory = () => new Promise(done => { resolve = done; });
  const late = f.feed.readSaved(threadId);
  await nextTick();
  f.data.delete(threadId);
  f.feed.forget(threadId);
  resolve(snapshot('迟到的归档正文'));
  await assert.rejects(late, { code: 'THREAD_NOT_FOUND' });
  assert.equal(f.feed.row(threadId), undefined);
});

test('持久缓存最多二十条并可在重启后使用，失去 IPC 身份时不写入迟到内容', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-thread-cache-'));
  const database = path.join(directory, 'journal.sqlite');
  const journal = new Journal(database);
  const feed = new ThreadCacheFeed({ adapter: {}, db: journal.db, send: () => {}, blocked: () => false });
  for (let index = 0; index < CACHE_THREAD_LIMIT; index++) feed.save(snapshot('', 'old-' + index));
  feed.save(snapshot(), 'one');
  assert.equal(journal.db.prepare('SELECT COUNT(*) AS total FROM conversation_cache').get().total, CACHE_THREAD_LIMIT);
  feed.close();
  journal.close();

  const f = fixture(t, new Journal(database));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  f.feed.watch('phone', { subscriptionId, threads: [{ threadId, revision: '' }] });
  await f.feed.refresh();
  assert.equal(f.adapter.reads, 0);
  assert.equal(f.sent[0].revision, conversationContentRevision(snapshot()));
  const owner = { clientId: 'old-owner' };
  f.adapter.client = { allowedClients: new Set() };
  f.adapter.conversations.set(threadId, { owner, state: {}, watchers: new Set([CACHE_WATCHER]) });
  f.feed.captureLive(snapshot('拒绝的实时内容'));
  assert.equal(f.feed.row(threadId).revision, f.sent[0].revision);
  f.journal.forgetThreads([threadId]);
  assert.equal(f.feed.row(threadId), undefined);
});

test('详情相同正文省略窗口，已知基线只回变化，实时权限仍取自正常订阅', async t => {
  const adapter = new EventEmitter(), journal = new Journal(), sent = [];
  adapter.conversations = new Map();
  adapter.close = () => {};
  adapter.threadMentions = { available: async () => false, close() {} };
  let current = snapshot(), watches = 0;
  adapter.watch = async (id, deviceId, { activate }) => {
    assert.deepEqual([id, deviceId, activate], [threadId, 'phone', false]);
    watches++;
    return current;
  };
  const agent = new BridgeAgent({ config: {}, adapter, journal });
  agent.send = event => sent.push(event);
  t.after(() => agent.close());
  agent.threadCache.save(current);
  const revision = conversationContentRevision(current);
  const call = contentRevision => agent.handleRequest({ v: 1, type: 'request', transportId: 'synthetic-transport', requestId: 'synthetic-request-01', deviceId: 'phone', method: 'thread.watch', params: { threadId, contentRevision } });

  const first = (await call(revision)).result;
  assert.equal(first.snapshot.messages, undefined);
  assert.equal(first.snapshot.approvals[0].id, 'approval');
  assert.equal(first.contentBaseRevision, revision);
  assert.equal(first.contentUpdate, undefined);
  assert.equal(sent.length, 0);
  current = { ...current, updatedAt: 11 };
  const repeat = (await call(revision)).result;
  assert.equal(repeat.seq, first.seq);
  assert.equal(sent.length, 0);

  current = snapshot('更新');
  const next = (await call(revision)).result;
  assert.equal(next.snapshot.messages, undefined);
  assert.equal(next.contentBaseRevision, revision);
  assert.deepEqual(next.contentUpdate.appends, [{ id: 'message', text: '更新', status: 'inProgress' }]);
  assert.equal(next.contentRevision, conversationContentRevision(current));
  assert.equal(sent[0].excludeTransportId, 'synthetic-transport');
  assert.equal(sent[0].contentRevision, next.contentRevision);
  const full = (await call('content:' + 'f'.repeat(64))).result;
  assert.equal(full.snapshot.messages[0].text, text + '更新');
  assert.equal(full.contentBaseRevision, undefined);
  assert.equal(watches, 4);
});

test('会话历史来源指纹检查实际文件变化及归档', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-history-source-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions'), file = path.join(sessions, 'synthetic.jsonl');
  fs.mkdirSync(sessions);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: threadId } }) + '\n');
  const index = new StateReader(home), db = new DatabaseSync(index.filePath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(threadId, '合成对话', '/workspace/demo', file, 1, 0);
  const first = index.historyCacheSource(threadId);
  assert.equal(index.historyCacheSource(threadId), first);
  assert.deepEqual(index.visibleThreadIds([threadId, 'missing']), new Set([threadId]));
  fs.appendFileSync(file, '{}\n');
  assert.notEqual(index.historyCacheSource(threadId), first);
  db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run(threadId);
  db.close();
  assert.deepEqual(index.visibleThreadIds([threadId]), new Set());
  assert.throws(() => index.historyCacheSource(threadId), { code: 'THREAD_NOT_FOUND' });
  assert.throws(() => new StateReader(path.join(home, 'unavailable')).visibleThreadIds([threadId]));
});
