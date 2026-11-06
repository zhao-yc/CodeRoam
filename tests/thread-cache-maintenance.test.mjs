import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate as nextTick } from 'node:timers/promises';
import { Journal } from '../apps/bridge/journal.mjs';
import { ThreadCacheFeed, CACHE_WATCHER } from '../apps/bridge/thread-cache.mjs';

/** 所有正文与所有者均为合成数据，数据库只使用本用例独立的内存账本。 */
const snapshot = (threadId, status = 'inProgress') => ({ threadId, title: '合成维护会话', cwd: '/workspace/example', messages: [{ id: 'message', role: 'assistant', text: '合成展示正文', turnId: 'turn', status }], turns: [{ turnId: 'turn', status }], latestTurn: { turnId: 'turn', status }, status: status === 'inProgress' ? 'active' : 'idle', activeTurnId: status === 'inProgress' ? 'turn' : '' });
const drain = async () => { for (let index = 0; index < 8; index++) await nextTick(); };

/** 虚拟定时器只控制维护调度，历史读取仍执行实际异步与真实缓存代码。 */
function fixture(t, { file = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const journal = new Journal(), rows = new Map(), calls = { list: 0, source: [], activity: [], history: [], watch: [], unwatch: [], snapshots: 0 }, sent = [], watchers = [];
  if (file) t.mock.method(fs, 'watch', (_directory, _options, callback) => {
    const handle = { callback, closed: false, on() { return this; }, close() { this.closed = true; } };
    watchers.push(handle); return handle;
  });
  const adapter = {
    conversations: new Map(),
    index: {
      ...(file ? { filePath: '/synthetic/state.sqlite' } : {}),
      list() { calls.list++; return [...rows.keys()].map(id => ({ id })); },
      containsThread: id => rows.has(id),
      visibleThreadIds: ids => new Set(ids.filter(id => rows.has(id))),
      historyCacheSource(id) { calls.source.push(id); return rows.get(id)?.source ?? ''; },
      historyActivity(id) { calls.activity.push(id); return { status: rows.get(id)?.status ?? 'unknown' }; },
      readHistory(id) { calls.history.push(id); return rows.get(id).snapshot; },
    },
    watch(id, watcher, options) { calls.watch.push({ id, watcher, options }); return Promise.reject(new Error('合成测试没有额外桌面所有者')); },
    unwatch(id, watcher) { calls.unwatch.push({ id, watcher }); adapter.conversations.get(id)?.watchers.delete(watcher); },
    snapshot(state) { calls.snapshots++; return state.snapshot; },
  };
  const feed = new ThreadCacheFeed({ adapter, db: journal.db, send: event => sent.push(event), blocked: () => false });
  t.after(() => { feed.close(); journal.close(); });
  const add = (id, status = 'completed', source = 'source-one') => rows.set(id, { source, status, snapshot: snapshot(id, status === 'active' ? 'inProgress' : status) });
  const live = (id, status = 'active', initialWatchers = []) => {
    const entry = { owner: { clientId: 'synthetic-owner' }, revision: 1, state: { threadRuntimeStatus: { type: status }, snapshot: snapshot(id, status === 'active' ? 'inProgress' : 'completed') }, watchers: new Set(initialWatchers) };
    adapter.conversations.set(id, entry); return entry;
  };
  const changes = () => journal.db.prepare('SELECT total_changes() AS count').get().count;
  return { feed, adapter, rows, calls, sent, watchers, add, live, changes };
}

test('legacy保留原有跟随与历史预热，不依赖活动清单或历史终态', async t => {
  const f = fixture(t); f.add('active-history', 'active'); f.add('unknown-history', 'unknown');
  await f.feed.refresh(); await drain();
  assert.equal(f.feed.mode, 'legacy'); assert.deepEqual(f.calls.watch.map(row => row.id), ['active-history', 'unknown-history']);
  assert.deepEqual(f.calls.history, ['active-history', 'unknown-history']); assert.equal(f.calls.activity.length, 0);
  assert.ok(f.feed.row('active-history')); assert.ok(f.feed.row('unknown-history'));
});

test('online仅内部跟随活动项，不完整清单缺席保留候选，完整清单替换候选', async t => {
  const f = fixture(t); for (const id of ['inventory-active', 'native-active', 'idle']) f.add(id);
  const native = f.live('native-active'), idle = f.live('idle', 'idle', ['detail-page']);
  f.feed.setMode('online'); f.feed.setActivityInventory({ threadIds: ['inventory-active'], complete: true });
  f.feed.setActivityInventory({ threadIds: [], complete: false });
  await f.feed.refresh(); await drain();
  assert.deepEqual(f.calls.watch.map(row => row.id), ['inventory-active']); assert.ok(native.watchers.has(CACHE_WATCHER));
  assert.equal(idle.watchers.has(CACHE_WATCHER), false); assert.ok(idle.watchers.has('detail-page'));
  assert.ok(f.feed.activity.has('inventory-active')); assert.equal(f.calls.unwatch.length, 0);
  f.feed.setActivityInventory({ threadIds: [], complete: true }); assert.equal(f.feed.activity.has('inventory-active'), false);
});

test('light释放CACHE与完整缓存状态，保留真实详情订阅且不再接收流式正文', async t => {
  const f = fixture(t); f.add('active', 'active'); const entry = f.live('active', 'active', ['detail-page']);
  f.feed.setMode('online'); await f.feed.refresh();
  assert.ok(entry.watchers.has(CACHE_WATCHER)); assert.ok(f.feed.liveVersions.has('active'));
  f.feed.saved.set('active', { source: 'source-one', snapshot: snapshot('active') });
  f.feed.setMode('light');
  assert.deepEqual([...entry.watchers], ['detail-page']); assert.equal(f.feed.saved.size, 0); assert.equal(f.feed.reading.size, 0); assert.equal(f.feed.liveVersions.size, 0);
  const before = f.changes(); f.feed.captureLive({ ...snapshot('active'), messages: [{ id: 'new', text: '新的合成正文' }] });
  assert.equal(f.changes(), before); assert.ok(f.adapter.conversations.has('active'));
});

test('light文件通知只登记变化，十五秒前不读取元数据或正文', async t => {
  const f = fixture(t, { file: true }); f.add('active-history', 'active'); f.feed.setMode('light');
  f.watchers.at(-1).callback('change', 'state.sqlite-wal'); f.watchers.at(-1).callback('change', 'session_index.jsonl');
  t.mock.timers.tick(14999); await drain(); assert.equal(f.calls.list, 0); assert.equal(f.calls.history.length, 0);
  t.mock.timers.tick(1); await drain(); assert.equal(f.calls.list, 1); assert.deepEqual(f.calls.activity, ['active-history']); assert.equal(f.calls.history.length, 0);
  f.watchers.at(-1).callback('change', 'state.sqlite'); t.mock.timers.tick(14999); await drain(); assert.equal(f.calls.list, 1);
  t.mock.timers.tick(1); await drain(); assert.equal(f.calls.list, 2); assert.equal(f.calls.history.length, 0);
});

test('活动历史只查生命周期，明确终态只解析一次且静态来源不重复写库', async t => {
  const f = fixture(t); f.add('history', 'active'); f.feed.setMode('light');
  await f.feed.refresh(); await f.feed.refresh(); assert.equal(f.calls.history.length, 0); assert.deepEqual(f.calls.activity, ['history']);
  f.add('history', 'completed', 'source-two'); await f.feed.refresh();
  assert.deepEqual(f.calls.history, ['history']); assert.equal(f.feed.row('history').saved_source, 'source-two');
  const before = f.changes(); await f.feed.refresh(); await f.feed.refresh();
  assert.equal(f.calls.history.length, 1); assert.equal(f.changes(), before); assert.deepEqual(f.calls.activity, ['history', 'history']);
});

test('light不为未知或缺失生命周期的历史解析全文', async t => {
  const f = fixture(t); f.add('unknown', 'unknown'); f.feed.setMode('light'); await f.feed.refresh(); assert.equal(f.calls.history.length, 0);
  delete f.adapter.index.historyActivity; f.rows.get('unknown').source = 'source-two'; await f.feed.refresh(); assert.equal(f.calls.history.length, 0);
});

test('settled先保存真实终态再释放内部跟随，详情与已保存静态内容保持可用', async t => {
  const f = fixture(t); f.add('live', 'active'); const entry = f.live('live', 'active', ['detail-page']);
  f.feed.setMode('online'); f.feed.setActivityInventory({ threadIds: ['live'], complete: true }); await f.feed.refresh();
  const terminal = snapshot('live', 'completed'); entry.state = { threadRuntimeStatus: { type: 'idle' }, snapshot: terminal }; entry.revision++;
  f.feed.settled(terminal);
  assert.equal(JSON.parse(f.feed.row('live').snapshot).latestTurn.status, 'completed'); assert.deepEqual([...entry.watchers], ['detail-page']);
  assert.equal(f.feed.activity.has('live'), false); assert.equal(f.feed.liveVersions.has('live'), false); assert.ok(f.feed.recent.has('live'));
});

test('切换light使旧readSaved失效，迟到正文不能重建内存或写入缓存', async t => {
  const f = fixture(t); f.add('pending', 'completed'); f.feed.setMode('online'); f.feed.remember('pending');
  let finish; f.adapter.index.readHistory = id => { f.calls.history.push(id); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.feed.readSaved('pending'); const rejected = assert.rejects(pending, error => error.code === 'SUBSCRIPTION_CANCELED');
  await Promise.resolve(); assert.equal(typeof finish, 'function'); f.feed.setMode('light'); finish(snapshot('pending', 'completed')); await rejected;
  assert.equal(f.feed.row('pending'), undefined); assert.equal(f.feed.saved.size, 0); assert.equal(f.feed.reading.size, 0);
});

test('模式切换只保留一个索引目录watcher，关闭后全部释放', t => {
  const f = fixture(t, { file: true }); f.feed.start(); f.feed.setMode('online'); f.feed.setMode('grace'); f.feed.setMode('light');
  assert.equal(f.watchers.filter(watcher => !watcher.closed).length, 1); f.feed.close(); assert.ok(f.watchers.every(watcher => watcher.closed));
});

test('light取消尚未完成的内部探测，迟到CACHE订阅不能重新驻留', async t => {
  const f = fixture(t); f.add('probing', 'active'); let finish;
  f.adapter.watch = (id, watcher) => new Promise(resolve => { finish = () => { f.live(id, 'active', [watcher]); resolve(snapshot(id)); }; });
  f.feed.setMode('online'); f.feed.setActivityInventory({ threadIds: ['probing'], complete: true }); await f.feed.refresh();
  assert.equal(typeof finish, 'function'); f.feed.setMode('light'); finish(); await drain();
  assert.equal(f.adapter.conversations.get('probing').watchers.has(CACHE_WATCHER), false); assert.equal(f.feed.liveVersions.size, 0);
});

test('暂停正文后台时保留手机订阅和历史读取，旧结果不会落缓存，恢复后补发新版本',async t=>{
  const f=fixture(t,{file:true});
  f.add('pending','completed');
  f.feed.watch('phone',{subscriptionId:'synthetic-cache',threads:[{threadId:'pending',revision:''}]});
  const read=f.adapter.index.readHistory;
  let finish;
  f.adapter.index.readHistory=id=>{f.calls.history.push(id);return new Promise(resolve=>{finish=resolve;});};
  const running=f.feed.refresh();
  await drain();
  assert.equal(typeof finish,'function');
  f.feed.setBackgroundSyncEnabled(false);
  assert.equal(f.feed.interval,null);
  assert.equal(f.feed.timer,null);
  assert.ok(f.watchers.every(watcher=>watcher.closed));
  const foreground=f.feed.readSaved('pending');
  finish(snapshot('pending','completed'));
  assert.equal((await foreground).threadId,'pending');
  await running;
  assert.equal(f.feed.subscriptions.size,1);
  assert.equal(f.feed.row('pending'),undefined);
  assert.equal(f.sent.length,0);
  f.feed.schedule(0);
  t.mock.timers.tick(30000);
  await drain();
  assert.equal(f.calls.history.length,1);
  f.adapter.index.readHistory=read;
  f.feed.setBackgroundSyncEnabled(true);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(f.calls.history.length,2);
  assert.ok(f.feed.row('pending'));
  assert.ok(f.sent.some(event=>event.deviceId==='phone'&&event.subscriptionId==='synthetic-cache'&&event.revision));
});

test('暂停保留已有正文和真实详情，旧内部探测迟到只清理自己的跟随',async t=>{
  const f=fixture(t);
  f.add('live','active');f.add('probing','active');
  const live=f.live('live','active',['detail']);
  let finish;
  f.adapter.watch=(id,watcher)=>new Promise(resolve=>{finish=()=>{f.live(id,'active',[watcher,'other-detail']);resolve(snapshot(id));};});
  f.feed.start();
  await f.feed.refresh();
  const prior=f.feed.row('live').revision;
  assert.ok(live.watchers.has(CACHE_WATCHER));
  f.feed.setBackgroundSyncEnabled(false);
  assert.deepEqual([...live.watchers],['detail']);
  finish();await drain();
  assert.deepEqual([...f.adapter.conversations.get('probing').watchers],['other-detail']);
  assert.equal(f.feed.row('live').revision,prior);
  f.feed.captureLive({...snapshot('live'),messages:[{id:'changed',text:'暂停后的流式正文'}]});
  assert.equal(f.feed.row('live').revision,prior);
});
