import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {ThreadListStore} from '../apps/bridge/thread-list-store.mjs';
import {ThreadListFeed} from '../apps/bridge/thread-list-feed.mjs';
import {CACHE_PERSISTENCE_INTERVAL_MS} from '../apps/bridge/cache-persistence.mjs';

async function drain(){for(let i=0;i<25;i++)await Promise.resolve();}
const row=(id='a',title='合成会话',updatedAt=1)=>({id,title,cwd:'/workspace/synthetic',updatedAt});
function storeFixture(t,options={}) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const db=new DatabaseSync(':memory:'),store=new ThreadListStore(db,options);store.load();
  t.after(()=>{store.close();db.close();});
  return {db,store,read:()=>db.prepare('SELECT id,title,cwd,updated_at AS updatedAt FROM thread_list_index ORDER BY position').all()};
}
function feedFixture(t,{live=false,onSettled=()=>{}}={}) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const db=new DatabaseSync(':memory:'),adapter=new EventEmitter(),events=[],visible=new Set(['a']);let rows=[row()];
  const snapshot={threadId:'a',title:'合成会话',status:'active',activeTurnId:'turn',approvals:[],questionGroups:[],messages:[],turns:[]};
  adapter.index={list:()=>rows,visibleThreadIds:ids=>new Set(ids.filter(id=>visible.has(id)))};
  adapter.conversations=new Map(live?[['a',{state:snapshot,watchers:new Set(['detail'])}]]:[]);adapter.snapshot=state=>state;
  adapter.readActivityInventory=async()=>({complete:true,threadIds:[]});
  adapter.watch=async()=>{throw new Error('合成会话尚未加载');};
  adapter.unwatch=(id,owner)=>{const entry=adapter.conversations.get(id);entry?.watchers.delete(owner);if(entry&&!entry.watchers.size)adapter.conversations.delete(id);};
  const feed=new ThreadListFeed(adapter,event=>events.push(event),{db,onSettled});
  t.after(()=>{feed.close();db.close();});
  return {db,adapter,feed,snapshot,events,visible,setRows:value=>{rows=value;},read:()=>db.prepare('SELECT id,title,updated_at AS updatedAt FROM thread_list_index ORDER BY position').all()};
}

test('展示索引使用固定1500ms窗口，连续输入不重置且只保存每个窗口最新值',t=>{
  const f=storeFixture(t);assert.equal(CACHE_PERSISTENCE_INTERVAL_MS,1500);
  f.store.save([row()]);
  for(let i=1;i<=14;i++){f.store.save([row('a','合成片段'+i,i)]);t.mock.timers.tick(100);}
  assert.deepEqual(f.read(),[]);t.mock.timers.tick(100);assert.equal(f.read()[0].title,'合成片段14');
  for(let i=15;i<=29;i++){f.store.save([row('a','合成片段'+i,i)]);t.mock.timers.tick(100);}
  assert.equal(f.read()[0].title,'合成片段29');assert.equal(f.store.pending,null);
});

test('合并窗口保持最新五十行顺序，只落盘展示白名单',t=>{
  const f=storeFixture(t),rows=Array.from({length:55},(_,i)=>({...row('id-'+i,'合成 '+i,i),approvals:[{id:'合成审批'}],permissionSettings:{mode:'synthetic'},notificationState:{latestTurnId:'synthetic'}}));
  f.store.save(rows);f.store.save([...rows].reverse());t.mock.timers.tick(1500);
  const saved=f.read();assert.equal(saved.length,50);assert.equal(saved[0].id,'id-54');assert.equal(saved.at(-1).id,'id-5');
  assert.deepEqual(Object.keys(f.db.prepare('SELECT * FROM thread_list_index LIMIT 1').get()).sort(),['cwd','id','position','title','updated_at']);
});

test('移除成员立即删除磁盘记录并取消其待写，其他成员最新值继续合并',t=>{
  const f=storeFixture(t);f.store.save([row(),row('b')]);f.store.flush();
  f.store.save([row('a','删除前待写'),row('b','保留的新值')]);f.store.forget(['a']);
  assert.deepEqual(f.read().map(value=>value.id),['b']);assert.equal(f.read()[0].title,'合成会话');
  t.mock.timers.tick(1500);assert.equal(f.read()[0].title,'保留的新值');assert.equal(f.read().length,1);
  f.store.save([]);assert.deepEqual(f.read(),[]);t.mock.timers.tick(1500);assert.deepEqual(f.read(),[]);
});

test('外部清表后flush仍新鲜核对成员，不能迟到回灌已归档或删除的id',t=>{
  const visible=new Set(['a','b']),f=storeFixture(t,{verifyVisible:ids=>new Set(ids.filter(id=>visible.has(id)))});
  f.store.save([row(),row('b')]);f.store.flush();
  f.store.save([row('a','旧待写'),row('b','最新保留')]);visible.delete('a');f.db.prepare('DELETE FROM thread_list_index WHERE id=?').run('a');
  t.mock.timers.tick(1500);assert.deepEqual(f.read().map(value=>value.id),['b']);assert.equal(f.read()[0].title,'最新保留');
});

test('可见性查询失败时不写旧值，恢复后按原pending重试',t=>{
  let available=false;const f=storeFixture(t,{verifyVisible:ids=>{if(!available)throw Error('合成来源暂不可用');return new Set(ids);}});
  f.store.save([row('a','待重试')]);t.mock.timers.tick(1500);assert.deepEqual(f.read(),[]);assert.ok(f.store.pending);
  available=true;t.mock.timers.tick(1499);assert.deepEqual(f.read(),[]);t.mock.timers.tick(1);assert.equal(f.read()[0].title,'待重试');
});

test('删除SQL暂时失败仍立即取消对应待写，恢复后只重试清理而不复活旧值',t=>{
  const f=storeFixture(t);f.store.save([row(),row('b')]);f.store.flush();f.store.save([row('a','禁止复活'),row('b','保留最新')]);
  const prepare=f.db.prepare;let busy=true;
  t.mock.method(f.db,'prepare',function(sql,...args){if(busy&&sql==='DELETE FROM thread_list_index WHERE id=?')throw Error('合成删除暂不可写');return prepare.call(this,sql,...args);});
  assert.equal(f.store.forget(['a']),false);assert.ok(f.store.pending.rows.every(value=>value.id!=='a'));
  busy=false;t.mock.timers.tick(1500);assert.deepEqual(f.read().map(value=>value.id),['b']);assert.equal(f.read()[0].title,'保留最新');
});

test('多行删除部分失败后，后续新鲜恢复的成员不会被旧指纹错误去重',t=>{
  const f=storeFixture(t),rows=[row(),row('b'),row('c')];f.store.save(rows);f.store.flush();
  const prepare=f.db.prepare;let removes=0;
  t.mock.method(f.db,'prepare',function(sql,...args){const statement=prepare.call(this,sql,...args);if(sql!=='DELETE FROM thread_list_index WHERE id=?')return statement;
    return {run(...values){if(++removes===2)throw Error('合成第二行删除失败');return statement.run(...values);}};
  });
  assert.equal(f.store.forget(['a','b']),false);assert.deepEqual(f.read().map(value=>value.id),['b','c']);
  f.store.save(rows);t.mock.timers.tick(1500);assert.deepEqual(f.read().map(value=>value.id),['a','b','c']);
});

test('SQLite写入失败保留最新pending并重试，正常close立即flush且不留关闭后计时器',t=>{
  const f=storeFixture(t),prepare=f.db.prepare;let busy=true;
  t.mock.method(f.db,'prepare',function(sql,...args){if(busy&&sql.startsWith('INSERT INTO thread_list_index'))throw Error('合成SQLite暂不可写');return prepare.call(this,sql,...args);});
  f.store.save([row('a','第一版')]);t.mock.timers.tick(1500);assert.deepEqual(f.read(),[]);assert.ok(f.store.pending);
  f.store.save([row('a','重试前最新')]);busy=false;t.mock.timers.tick(1500);assert.equal(f.read()[0].title,'重试前最新');
  f.store.save([row('a','关闭时最新')]);assert.equal(f.store.close(),true);assert.equal(f.read()[0].title,'关闭时最新');assert.equal(f.store.timer,null);
  f.store.save([row('a','关闭后禁止写')]);t.mock.timers.tick(5000);assert.equal(f.read()[0].title,'关闭时最新');
});

test('close最终保存失败也不留下账本关闭后的重试任务',t=>{
  const f=storeFixture(t,{verifyVisible:()=>{throw Error('合成关闭时来源不可用');}});
  f.store.save([row()]);assert.equal(f.store.close(),false);assert.equal(f.store.timer,null);
  t.mock.timers.tick(5000);assert.equal(f.store.timer,null);assert.deepEqual(f.read(),[]);
});

test('列表内存事件和revision即时推进，不等待1500ms索引落盘',async t=>{
  const f=feedFixture(t);const initial=await f.feed.watch('phone');await drain();assert.equal(initial.threads.length,1);assert.deepEqual(f.read(),[]);
  const revision=f.feed.revision;t.mock.timers.tick(500);f.setRows([row('a','即时新标题',2)]);f.feed.readIndex();
  assert.ok(f.feed.revision>revision);assert.equal(f.events.at(-1).threads[0].title,'即时新标题');assert.deepEqual(f.read(),[]);
  t.mock.timers.tick(999);assert.deepEqual(f.read(),[]);t.mock.timers.tick(1);assert.equal(f.read()[0].title,'即时新标题');
});

test('明确终态立即保存展示并释放内部订阅，写失败仍推送终态及onSettled',async t=>{
  let settled=0;const f=feedFixture(t,{live:true,onSettled:()=>{settled++;}});await f.feed.watch('phone');await drain();
  assert.deepEqual(f.read(),[]);
  const prepare=f.db.prepare;let busy=true;
  t.mock.method(f.db,'prepare',function(sql,...args){if(busy&&sql.startsWith('INSERT INTO thread_list_index'))throw Error('合成终态写入失败');return prepare.call(this,sql,...args);});
  f.adapter.emit('conversation',{...f.snapshot,title:'合成完成标题',status:'idle',activeTurnId:'',latestTurn:{turnId:'turn',status:'completed'}});
  assert.equal(f.events.at(-1).threads[0].status,'idle');assert.equal(settled,1);assert.equal(f.feed.owned.has('a'),false);assert.deepEqual(f.read(),[]);
  busy=false;t.mock.timers.tick(1500);assert.equal(f.read()[0].title,'合成完成标题');
  f.adapter.emit('conversation',{...f.snapshot,title:'再次完成',status:'idle',activeTurnId:'',latestTurn:{turnId:'next',status:'completed'}});
  assert.equal(f.read()[0].title,'再次完成');
});

test('确认删除取消探测与待写，迟到快照不能复活列表、磁盘或内部所有者',async t=>{
  const f=feedFixture(t);let finish;
  f.adapter.readActivityInventory=async()=>({complete:true,threadIds:['a']});
  f.adapter.watch=(id,owner)=>new Promise(resolve=>{finish=()=>{f.adapter.conversations.set(id,{state:f.snapshot,watchers:new Set([owner])});resolve(f.snapshot);};});
  await f.feed.watch('phone');await drain();assert.equal(typeof finish,'function');
  f.visible.delete('a');f.setRows([]);f.feed.forget(['a']);finish();await drain();
  assert.deepEqual(f.feed.list().threads,[]);assert.equal(f.feed.owned.has('a'),false);assert.equal(f.adapter.conversations.has('a'),false);
  t.mock.timers.tick(2000);await drain();assert.deepEqual(f.read(),[]);
});

test('轮次终态即使仍有待回答事项也立即保存，但保留待交互订阅',async t=>{
  let settled=0;const f=feedFixture(t,{live:true,onSettled:()=>{settled++;}});await f.feed.watch('phone');await drain();
  f.adapter.emit('conversation',{...f.snapshot,title:'轮次完成仍待回答',status:'idle',activeTurnId:'',latestTurn:{turnId:'turn',status:'completed'},questionGroups:[{kind:'native',state:'pending'}]});
  assert.equal(f.read()[0].title,'轮次完成仍待回答');assert.equal(f.feed.owned.has('a'),true);assert.equal(settled,0);
});

test('正常关闭保存尚未发出的最新展示标题，不额外推送关闭尾帧',async t=>{
  const f=feedFixture(t,{live:true});await f.feed.watch('phone');await drain();
  f.adapter.emit('conversation',{...f.snapshot,title:'关闭前最新标题'});const events=f.events.length;
  f.feed.close();assert.equal(f.read()[0].title,'关闭前最新标题');assert.equal(f.events.length,events);assert.equal(f.feed.store.timer,null);
});
