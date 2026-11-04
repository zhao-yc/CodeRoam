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

test('无人订阅时缓存换版不读出旧正文，上一版仍可续接且同版来源变化不旋转基线', t => {
  const f = fixture(t);
  let largeReadBytes = 0;
  // 统计真实 SQLite 返回到 JS 的长字符串，验证低分配路径而非模拟写入结果。
  f.feed.db = new Proxy(f.journal.db, { get(db, key) {
    if (key === 'prepare') return sql => {
      const statement = db.prepare(sql);
      return new Proxy(statement, { get(target, method) {
        if (method === 'get') return (...args) => {
          const row = target.get(...args);
          for (const value of Object.values(row ?? {})) if (typeof value === 'string' && value.length > 256) largeReadBytes += Buffer.byteLength(value);
          return row;
        };
        const value = Reflect.get(target, method, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    const value = Reflect.get(db, key, db);
    return typeof value === 'function' ? value.bind(db) : value;
  } });
  f.feed.cacheStore.db = f.feed.db;
  const first = snapshot(), second = snapshot('乙'), third = snapshot('乙丙');
  f.feed.save(first, 'source-1');
  f.feed.save(second, 'source-2');
  f.feed.save(second, 'source-3');
  assert.equal(largeReadBytes, 0);
  assert.equal(f.feed.row(threadId).previous_revision, conversationContentRevision(first));
  assert.equal(f.feed.baseline(threadId, conversationContentRevision(first)).messages[0].text, text);
  f.feed.save(third, 'source-4');
  assert.equal(f.feed.baseline(threadId, conversationContentRevision(first)), undefined);
  assert.equal(f.feed.baseline(threadId, conversationContentRevision(second)).messages[0].text, text + '乙');
  f.feed.watch('phone', { subscriptionId, threads: [{ threadId, revision: conversationContentRevision(third) }] });
  const beforeSubscribed = largeReadBytes;
  f.feed.save(snapshot('乙丙丁'), 'source-5');
  assert.equal(largeReadBytes, beforeSubscribed);
  assert.deepEqual(f.sent.at(-1).update.appends, [{ id: 'message', text: '丁', status: 'inProgress' }]);
});

test('复用列表最近排序时仍核验成员，旧列表不能让已删除正文继续驻留', async t => {
  const f = fixture(t);
  f.feed.listRows = () => [{ id: threadId }];
  f.adapter.index.list = () => { throw new Error('已有列表时不重复扫描排序'); };
  await f.feed.refresh();
  assert.equal(f.adapter.reads, 1);
  assert.ok(f.feed.row(threadId));
  f.data.delete(threadId);
  await f.feed.refresh();
  assert.equal(f.feed.row(threadId), undefined);
  assert.equal(f.adapter.reads, 1);
});

test('订阅者可跨磁盘与RAM两版续接，事件声明实际计算差异的基线', t => {
  const f = fixture(t), first=snapshot(), second=snapshot('乙'), third=snapshot('乙丙');
  f.feed.save(first,'one');f.feed.cacheStore.flush();
  f.feed.save(second,'two');f.feed.cacheStore.flush();
  f.feed.save(third,'three');
  const previous=conversationContentRevision(first);
  f.feed.watch('phone',{subscriptionId,threads:[{threadId,revision:previous}]});
  f.feed.deliverStored(threadId,conversationContentRevision(third));
  assert.equal(f.sent.at(-1).baseRevision,previous);
  assert.deepEqual(f.sent.at(-1).update.appends,[{id:'message',text:'乙丙',status:'inProgress'}]);
  assert.equal(validConversationCacheEvent(f.sent.at(-1)),true);
});

test('持续输出立即推送，固定1500毫秒窗口只保存最新段，同版本不重复写盘', t => {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const f=fixture(t),first=snapshot();
  f.feed.watch('phone',{subscriptionId,threads:[{threadId,revision:conversationContentRevision(first)}]});
  f.feed.save(first,'one');
  for(let index=1;index<=7;index++){
    t.mock.timers.tick(200);f.feed.save(snapshot('增'.repeat(index)),'source-'+index);
  }
  const disk=()=>f.journal.db.prepare('SELECT * FROM conversation_cache WHERE thread_id=?').get(threadId);
  assert.equal(f.sent.length,7);assert.equal(disk(),undefined);
  t.mock.timers.tick(100);
  assert.equal(JSON.parse(disk().snapshot).messages[0].text,text+'增'.repeat(7));
  const before=f.journal.db.prepare('SELECT total_changes() AS count').get().count;
  f.feed.save(snapshot('增'.repeat(7)),'source-7');t.mock.timers.tick(1500);
  assert.equal(f.journal.db.prepare('SELECT total_changes() AS count').get().count,before);
});

test('完成失败和中断均立即保存，推送抛错也不能丢终态或阻止内部退订',t=>{
  const f=fixture(t);
  for(const status of ['completed','failed','interrupted']){
    const terminal={...snapshot(status),status:'idle',activeTurnId:'',turns:[{turnId:'turn',status}],latestTurn:{turnId:'turn',status}};
    f.feed.save(terminal);
    assert.equal(JSON.parse(f.journal.db.prepare('SELECT snapshot FROM conversation_cache WHERE thread_id=?').get(threadId).snapshot).latestTurn.status,status);
  }
  f.adapter.client={allowedClients:new Set(['owner'])};
  const entry={owner:{clientId:'owner'},state:{},watchers:new Set([CACHE_WATCHER,'detail-page'])};
  f.adapter.conversations.set(threadId,entry);f.feed.activity.add(threadId);
  f.feed.watch('phone',{subscriptionId,threads:[{threadId,revision:''}]});f.feed.send=()=>{throw Error('合成连接已关闭');};
  f.feed.settled({...snapshot('最终'),status:'idle',activeTurnId:'',turns:[{turnId:'turn',status:'completed'}],latestTurn:{turnId:'turn',status:'completed'}});
  assert.equal(JSON.parse(f.journal.db.prepare('SELECT snapshot FROM conversation_cache WHERE thread_id=?').get(threadId).snapshot).messages[0].text,text+'最终');
  assert.deepEqual([...entry.watchers],['detail-page']);assert.equal(f.feed.activity.has(threadId),false);
});

test('缓存SQLite失败仍即时推送最新内存正文，明确删除取消尚未落盘的副本',t=>{
  const f=fixture(t);f.feed.watch('phone',{subscriptionId,threads:[{threadId,revision:''}]});
  f.feed.cacheStore.db={prepare(){throw Error('合成磁盘不可用');},exec(){throw Error('合成磁盘不可用');}};
  f.feed.save(snapshot('内存'),'fresh');assert.equal(f.sent.at(-1).snapshot.messages[0].text,text+'内存');
  assert.equal(f.feed.cacheStore.flush(),false);assert.ok(f.feed.row(threadId));
  f.feed.cacheStore.db=f.journal.db;f.data.delete(threadId);f.feed.checkMembership();
  assert.equal(f.feed.row(threadId),undefined);assert.equal(f.feed.cacheStore.pending.size,0);
  f.feed.cacheStore.flush();assert.equal(f.journal.db.prepare('SELECT count(*) AS total FROM conversation_cache').get().total,0);
});

test('后台来源批次跨事件循环时归档，不能保存或补发该聊天的迟到正文', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-archive-round-'));
  const sessions = path.join(home, 'sessions');fs.mkdirSync(sessions);
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,archived INTEGER)');
  const ids = ['synthetic-a', 'synthetic-b'];
  for (const id of ids) {
    const file = path.join(sessions, id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0)').run(id, '合成聊天', '/workspace/demo', 1, file);
  }
  const adapter = new EventEmitter(), journal = new Journal(), sent = [];
  adapter.index = new StateReader(home);
  adapter.client = { allowedClients: new Set(['owner']), assertCurrent() {} };
  adapter.conversations = new Map(ids.map(id => [id, { owner: { clientId: 'owner' }, state: { id }, watchers: new Set() }]));
  adapter.snapshot = state => snapshot('', state.id);
  adapter.unwatch = (id, watcher) => adapter.conversations.get(id)?.watchers.delete(watcher);
  const feed = new ThreadCacheFeed({ adapter, db: journal.db, send: event => sent.push(event), blocked: () => false });
  t.after(() => { feed.close();journal.close();db.close();fs.rmSync(home, { recursive: true, force: true }); });
  feed.save(snapshot('', ids[1]));
  feed.watch('phone', { subscriptionId, threads: [{ threadId: ids[1], revision: '' }] });
  const sourceView = adapter.index.historySourceView.bind(adapter.index);
  adapter.index.historySourceView = requested => {
    const view = sourceView(requested);
    setImmediate(() => db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(ids[1]));
    return view;
  };
  await feed.refresh();
  assert.equal(feed.row(ids[1]), undefined);
  assert.ok(sent.some(event => event.threadId === ids[1] && event.removed === true));
  assert.equal(sent.some(event => event.threadId === ids[1] && event.snapshot), false);
});

test('旧中转无人订阅列表时，后台缓存仍能发现桌面新建聊天', async t => {
  const adapter = new EventEmitter(), journal = new Journal();let rows = [{ id: threadId, title: '合成旧聊天' }];
  adapter.conversations = new Map();adapter.close = () => {};
  adapter.index = { list: () => rows, historyCacheSource: id => 'source-' + id, visibleThreadIds: ids => new Set(ids), readHistory: id => snapshot('', id) };
  const agent = new BridgeAgent({ config: {}, adapter, journal, newThreads: {} });t.after(() => agent.close());
  agent.threadListFeed.start();
  assert.equal(agent.threadListFeed.mode, 'legacy');assert.equal(agent.threadListFeed.devices.size, 0);
  const created = 'synthetic-new';rows = [{ id: created, title: '合成新聊天' }, ...rows];
  await agent.threadCache.refresh();
  assert.ok(agent.threadCache.row(created));
});

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
  const feed = new ThreadCacheFeed({ adapter: {index:{visibleThreadIds:ids=>new Set(ids)}}, db: journal.db, send: () => {}, blocked: () => false });
  for (let index = 0; index < CACHE_THREAD_LIMIT; index++) feed.save(snapshot('', 'old-' + index));
  feed.save(snapshot(), 'one');
  assert.equal(journal.db.prepare('SELECT COUNT(*) AS total FROM conversation_cache').get().total, 0);
  assert.equal(feed.cacheStore.records.size, CACHE_THREAD_LIMIT);
  feed.cacheStore.flush();
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
