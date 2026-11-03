import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { conversationMemoryDatabase } from './helpers/conversation-cache-fixture.mjs';

const source = stripTypeScriptTypes(fs.readFileSync(new URL('../apps/mobile/services/thread-list-storage.uts', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, '').replace(/^export /gm, ''));
const scope = '合成配对';
const storageScope = 'thread-list-v1:' + scope;
const row = (id, updatedAt, title = `聊天 ${id}`) => ({id, title, cwd:'/project', updatedAt});
const host = (hostId, threads, instanceGeneration = '甲') => ({hostId, label:`电脑 ${hostId}`, icon:'laptop', instanceGeneration, threads});
const plain = value => JSON.parse(JSON.stringify(value));

/** 每个窗口有自己的运行时和写队列，但共享同一个 CAS 数据库。 */
function windowCache(db) {
  const context = vm.createContext({...db.adapter});
  vm.runInContext(source + ';globalThis.cache={readThreadListCache,replaceThreadListCacheHost,retainThreadListCacheHosts,removeThreadListCacheHost,removeThreadListCacheThreads,clearThreadListCache};', context);
  return context.cache;
}

test('按配对和电脑隔离，同号会话分别恢复且只落盘展示字段', async () => {
  const db = conversationMemoryDatabase(), writer = windowCache(db);
  const live = {...row('共享编号', 10), notificationState:{pending:['审批']}, contentRevision:'实时版本', hasUnreadTurn:true};
  await writer.replaceThreadListCacheHost(scope, {...host('电脑一', [live]), online:true});
  await writer.replaceThreadListCacheHost(scope, host('电脑二', [row('共享编号', 20)]));
  await writer.replaceThreadListCacheHost('另一配对', host('电脑一', [row('另一记录', 30)]));
  const reader = windowCache(db);
  assert.deepEqual(plain(await reader.readThreadListCache(scope)), [host('电脑二',[row('共享编号',20)]),host('电脑一',[row('共享编号',10)])]);
  assert.deepEqual(plain(await reader.readThreadListCache('另一配对')), [host('电脑一',[row('另一记录',30)])]);
  assert.equal(db.dump(scope).rows.length, 0, '正文命名空间不被列表写入');
  assert.equal(db.dump(storageScope).rows.length, 4);
  assert.deepEqual(db.reads.map(read => read.namespace), [storageScope,'thread-list-v1:另一配对',storageScope,'thread-list-v1:另一配对']);
});

test('同内容不提交，新增修改和移出只动对应行，空快照移除该电脑', async () => {
  const db = conversationMemoryDatabase(), cache = windowCache(db);
  const initial = host('主机', [row('修改',1),row('不变',2),row('移出',3)]);
  await cache.replaceThreadListCacheHost(scope, initial);
  await cache.replaceThreadListCacheHost(scope, {...initial,threads:initial.threads.map(thread=>({...thread, status:'running'}))});
  assert.equal(db.writes.length, 1);
  await cache.replaceThreadListCacheHost(scope, host('主机', [row('修改',1,'新标题'),row('不变',2),row('新增',4)]));
  const {changes} = db.writes[1];
  assert.deepEqual(changes.put.map(entry => JSON.parse(entry.value).id).sort(), ['修改','新增'].sort());
  assert.deepEqual(changes.remove, ['thread:["主机","移出"]']);
  await cache.replaceThreadListCacheHost(scope, host('主机', []));
  assert.deepEqual(db.dump(storageScope).rows, []);
  assert.equal(db.reads.length, 1, '同一进程持有已提交基线');
});

test('保留每台最近 50 条、全配对最近 500 条，含 UTF-8 键值最多 1 MiB', async () => {
  const db = conversationMemoryDatabase(), cache = windowCache(db);
  for (let index=0; index<11; index++) {
    const threads = Array.from({length:55}, (_,offset) => row(`聊天${offset}`,index*100+offset));
    await cache.replaceThreadListCacheHost(scope, host(`电脑${index}`,threads));
  }
  const restored = await cache.readThreadListCache(scope);
  assert.equal(restored.length, 10);
  assert.equal(restored.reduce((sum, computer) => sum+computer.threads.length, 0), 500);
  assert.ok(restored.every(computer => computer.threads.length === 50 && computer.threads.at(-1).updatedAt%100 === 5));
  assert.ok(restored.every(computer => computer.hostId !== '电脑0'));

  const bigTitle = '汉字🌱'.repeat(4200);
  await cache.replaceThreadListCacheHost('容量测试', host('主机', Array.from({length:60},(_,offset)=>row(`聊天${offset}`,offset,bigTitle))));
  const stored = db.dump('thread-list-v1:容量测试');
  const bytes = stored.rows.reduce((sum,{key,value})=>sum+Buffer.byteLength(key)+Buffer.byteLength(value),0);
  assert.ok(bytes <= 1024*1024 && bytes > 1024*1024-Buffer.byteLength(bigTitle)*2);
  const [large] = await cache.readThreadListCache('容量测试');
  assert.ok(large.threads.length < 50);
  assert.equal(large.threads[0].updatedAt, 59);
});

test('撤权和移除聊天按归属删除，迟到旧写在版本冲突后不能复活数据', async () => {
  const db = conversationMemoryDatabase(), owner = windowCache(db), stale = windowCache(db);
  await owner.replaceThreadListCacheHost(scope, host('主机一',[row('同号',10),row('继续保留',12)]));
  await owner.replaceThreadListCacheHost(scope, host('主机二',[row('同号',9)]));
  await stale.readThreadListCache(scope);
  await owner.removeThreadListCacheThreads(scope,'主机一',['同号']);
  const writes = db.writes.length;
  await Promise.all([
    stale.replaceThreadListCacheHost(scope, host('主机一',[row('同号',11),row('继续保留',12)])),
    stale.replaceThreadListCacheHost(scope, host('主机一',[row('同号',12),row('继续保留',12)])),
  ]);
  assert.equal(db.writes.at(-1).applied, false);
  assert.equal(db.writes.length, writes+1, '基线冲突使已入队的后续旧写一起失效');
  assert.deepEqual(plain(await stale.readThreadListCache(scope)), [host('主机一',[row('继续保留',12)]),host('主机二',[row('同号',9)])]);
  await owner.retainThreadListCacheHosts(scope, ['主机一']);
  assert.deepEqual(plain(await owner.readThreadListCache(scope)), [host('主机一',[row('继续保留',12)])]);
  await owner.removeThreadListCacheHost(scope, '主机一');
  assert.deepEqual(db.dump(storageScope).rows, []);
});

test('清除配对先废弃迟到恢复，再阻止其他窗口或新进程写入已终止的旧配对', async () => {
  const db = conversationMemoryDatabase(), owner = windowCache(db), stale = windowCache(db);
  await owner.replaceThreadListCacheHost(scope, host('电脑',[row('历史',10)]));
  await stale.readThreadListCache(scope);
  const restoring = windowCache(db);
  let releaseRead;
  const readWait = new Promise(resolve => { releaseRead = resolve; });
  db.beforeRead = () => readWait;
  const pending = restoring.readThreadListCache(scope);
  const removal = restoring.clearThreadListCache(scope);
  releaseRead();
  assert.deepEqual(plain(await pending), []);
  await removal;
  await stale.replaceThreadListCacheHost(scope, host('电脑',[row('迟到',20)]));
  const restarted = windowCache(db);
  await restarted.replaceThreadListCacheHost(scope, host('电脑',[row('旧配对重启',30)]));
  assert.deepEqual(plain(await restarted.readThreadListCache(scope)), []);
  assert.deepEqual(db.dump(storageScope).rows, []);
  assert.match(db.dump(storageScope).revision, /^closed:/);
});

test('清理可在 CAS 冲突后重读重试，存储暂时失败时能继续在线', async () => {
  const db = conversationMemoryDatabase(), current = windowCache(db), stale = windowCache(db);
  db.beforeRead = () => { throw Error('模拟读取受限'); };
  assert.deepEqual(plain(await current.readThreadListCache(scope)), []);
  db.beforeRead = null;
  await current.replaceThreadListCacheHost(scope, host('电脑',[row('内容',10)]));
  await stale.readThreadListCache(scope);
  await current.replaceThreadListCacheHost(scope, host('电脑',[row('内容',20)]));
  await stale.retainThreadListCacheHosts(scope, []);
  assert.deepEqual(db.writes.slice(-2).map(write=>write.applied), [false,true]);
  assert.deepEqual(db.dump(storageScope).rows, []);
});

test('明确撤权在空基线上仍拒绝迟到插入，事务短暂失败后清理会重试', async () => {
  const db = conversationMemoryDatabase(), owner = windowCache(db), stale = windowCache(db);
  await stale.readThreadListCache(scope);
  let failOnce = true;
  db.beforeWrite = () => { if (failOnce) { failOnce = false; throw Error('模拟写入暂不可用'); } };
  await owner.retainThreadListCacheHosts(scope, []);
  assert.deepEqual(db.writes.map(write=>write.applied), [false,true]);
  assert.ok(db.writes[1].changes.put.length === 0 && db.writes[1].changes.remove.length === 0);
  await stale.replaceThreadListCacheHost(scope, host('撤权主机',[row('迟到新行',20)]));
  assert.equal(db.writes.at(-1).applied, false);
  assert.deepEqual(db.dump(storageScope).rows, []);
});
