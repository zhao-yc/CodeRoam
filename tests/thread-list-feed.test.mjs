import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {ThreadListFeed} from '../apps/bridge/thread-list-feed.mjs';
import {conversationContentRevision} from '../apps/bridge/conversation-prefetch.mjs';

/** 清空异步微任务，不依赖真实墙钟等待。 */
async function drain(){for(let i=0;i<25;i++)await Promise.resolve();}
function snapshot(id='a',status='active') {
  return {threadId:id,title:'合成会话',cwd:'/workspace/demo',status,activeTurnId:status==='active'?'turn':'',approvals:[],questionGroups:[],latestTurn:{turnId:'turn',status:status==='active'?'inProgress':'completed'},messages:[{id:'message',role:'assistant',kind:'agentMessage',text:'首帧',turnId:'turn',status:'inProgress'}],turns:[{turnId:'turn',status:'inProgress'}]};
}
function fixture(t,{live=false,count=1,db,...options}={}) {
  const adapter=new EventEmitter(),events=[],removed=[],probes=[];
  let rows=Array.from({length:count},(_,i)=>({id:i===0?'a':String(i),title:'合成会话',cwd:'/workspace/demo',updatedAt:42})),activity=[];
  adapter.index={list:()=>rows};adapter.conversations=new Map();adapter.snapshot=value=>value;
  adapter.readActivityInventory=async()=>({complete:true,threadIds:activity});
  adapter.watch=async(id,owner,settings)=>{probes.push({id,owner,settings});const value=snapshot(id);adapter.conversations.set(id,{state:value,watchers:new Set([owner])});return value;};
  adapter.unwatch=(id,owner)=>{removed.push([id,owner]);const entry=adapter.conversations.get(id);entry?.watchers.delete(owner);if(entry&&!entry.watchers.size)adapter.conversations.delete(id);};
  const value=snapshot();if(live)adapter.conversations.set('a',{state:value,watchers:new Set(['detail'])});
  const feed=new ThreadListFeed(adapter,event=>events.push(event),{db,...options});t.after(()=>feed.close());
  return {adapter,feed,value,events,removed,probes,setRows:value=>{rows=value;},setActivity:value=>{activity=value;}};
}
async function ready(feed){await feed.watch('phone');await drain();if(feed.running)await feed.running;}

test('五十条索引首帧不等待活动清单、未读或任何正文探测',async t=>{
  const {adapter,feed,probes}=fixture(t,{count:70});let finish;
  adapter.readActivityInventory=()=>new Promise(resolve=>{finish=resolve;});
  adapter.refreshReadState=()=>{throw new Error('首帧不得同步原生未读');};
  const initial=await feed.watch('phone');
  assert.equal(initial.threads.length,50);assert.equal(initial.threads[0].status,'unknown');assert.equal(initial.threads[0].contentRevision,'saved:42');
  assert.equal(initial.syncing,true);assert.equal(initial.catchup,true);assert.equal(probes.length,0);
  finish({complete:true,threadIds:[]});await drain();assert.equal(feed.syncing,false);
});

test('静态索引不会全量watch，完整活动清单缺席仍是unknown，静态转活跃自动发现',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  const {feed,probes,setActivity}=fixture(t,{count:50});await ready(feed);
  assert.equal(probes.length,0);assert.ok(feed.list().threads.every(row=>row.status==='unknown'));
  setActivity(['a']);t.mock.timers.tick(2000);await feed.refresh();assert.equal(probes.length,1);assert.equal(feed.list().threads[0].status,'active');
  const {isCurrent,...settings}=probes[0].settings;
  assert.equal(typeof isCurrent,'function');
  assert.deepEqual(settings,{history:false,snapshotTimeoutMs:1000,ownerTimeoutMs:350});
});

test('旧中转默认仅启动预热索引，首个设备进入后才维护活动，最后设备离开释放',async t=>{
  const {adapter,feed,setActivity,probes}=fixture(t);let inventoryReads=0;setActivity(['a']);
  adapter.readActivityInventory=async()=>{inventoryReads++;return {complete:true,threadIds:['a']};};
  feed.start();await drain();assert.equal(feed.rows.length,1);assert.equal(inventoryReads,0);assert.equal(probes.length,0);
  await ready(feed);assert.equal(inventoryReads,1);assert.equal(probes.length,1);assert.equal(feed.owned.has('a'),true);
  feed.unwatch('phone');assert.equal(feed.owned.size,0);assert.equal(feed.cycleTimer,null);
});

test('活动清单从有到无只触发一次终态快照核对，不凭缺席把active改idle',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  const {adapter,feed,setActivity}=fixture(t);setActivity(['a']);await ready(feed);
  assert.equal(feed.rows[0].status,'active');setActivity([]);
  adapter.watch=async()=>{throw new Error('合成核对失败');};t.mock.timers.tick(2000);await feed.refresh();
  assert.equal(feed.rows[0].status,'active');assert.ok(feed.syncError);
});

test('运行标记和计划待交互也保留内部跟随，等待项收口后才释放',async t=>{
  const {adapter,feed,value}=fixture(t,{live:true});value.status='idle';value.activeTurnId='';
  value.activeFlags=['waitingOnApproval'];await ready(feed);assert.equal(feed.owned.has('a'),true);
  adapter.emit('conversation',{...value,activeFlags:[],notificationState:{latestTurnId:'turn',latestTurnStatus:'completed',pending:[{kind:'plan',id:'合成计划'}]}});
  assert.equal(feed.owned.has('a'),true);
  adapter.emit('conversation',{...value,activeFlags:[],notificationState:{latestTurnId:'turn',latestTurnStatus:'completed',pending:[]}});
  assert.equal(feed.owned.has('a'),false);
});

test('列表活动跟随多设备共享，终态先交缓存再只释放列表所有者',async t=>{
  const order=[];
  const {adapter,feed,value,events,probes}=fixture(t,{live:true,onSettled:state=>{assert.ok(adapter.conversations.get(state.threadId));order.push('保存');}});
  const unwatch=adapter.unwatch;adapter.unwatch=(...args)=>{order.push('释放');return unwatch(...args);};
  await ready(feed);await feed.watch('second');assert.equal(probes.length,0);
  assert.equal(adapter.conversations.get('a').watchers.has('list-status'),true);
  adapter.conversations.get('a').watchers.add(Symbol.for('合成缓存'));
  const completed={...value,status:'idle',activeTurnId:'',hasUnreadTurn:true,latestTurn:{turnId:'turn',status:'completed'}};
  adapter.emit('conversation',completed);
  assert.deepEqual(order.slice(-2),['保存','释放']);assert.equal(events.at(-1).threads[0].status,'idle');
  assert.equal(adapter.conversations.get('a').watchers.has('detail'),true);
  assert.equal(adapter.conversations.get('a').watchers.has(Symbol.for('合成缓存')),true);
  assert.equal(adapter.conversations.get('a').watchers.has('list-status'),false);
  feed.unwatch('phone');assert.equal(feed.maintaining(),true);feed.unwatch('second');assert.equal(feed.maintaining(),false);
});

test('活动查询及探测失败保留unknown，失败每条至少十秒退避',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const {adapter,feed,setActivity}=fixture(t);let probes=0;
  adapter.readActivityInventory=async()=>{throw new Error('合成活动查询失败');};
  await ready(feed);assert.equal(feed.list().threads[0].status,'unknown');assert.ok(feed.syncError);
  adapter.readActivityInventory=async()=>({complete:true,threadIds:['a']});setActivity(['a']);
  adapter.watch=async()=>{probes++;throw new Error('合成探测失败');};
  t.mock.timers.tick(2000);await drain();
  await feed.refresh();await feed.refresh();assert.equal(probes,1);assert.equal(feed.list().threads[0].status,'unknown');
  t.mock.timers.tick(9999);await drain();assert.equal(probes,1);
  t.mock.timers.tick(1);await drain();await feed.refresh();assert.equal(probes,2);
});

test('十一条活动候选全部追平，并发不超过二且不受前十条限制',async t=>{
  const {adapter,feed,setActivity}=fixture(t,{count:11});let running=0,max=0,seen=[];
  setActivity(['a',...Array.from({length:10},(_,i)=>String(i+1))]);
  adapter.watch=async(id,owner)=>{running++;max=Math.max(max,running);seen.push(id);await Promise.resolve();const value=snapshot(id);adapter.conversations.set(id,{state:value,watchers:new Set([owner])});running--;return value;};
  const first=await feed.watch('phone');assert.equal(first.threads.length,11);await drain();if(feed.running)await feed.running;
  assert.equal(max,2);assert.equal(seen.length,11);assert.ok(feed.list().threads.every(row=>row.status==='active'));
});

test('五秒追平预算停止转圈并推进revision，后台继续完成剩余候选',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const {adapter,feed,setActivity,events}=fixture(t,{count:11});setActivity(['a',...Array.from({length:10},(_,i)=>String(i+1))]);
  adapter.watch=(id,owner)=>new Promise(resolve=>{setTimeout(()=>{const value=snapshot(id);adapter.conversations.set(id,{state:value,watchers:new Set([owner])});resolve(value);},1000);});
  const first=await feed.watch('phone');await drain();assert.equal(first.syncing,true);const revision=feed.revision;
  for(let i=0;i<5;i++){t.mock.timers.tick(1000);await drain();}
  assert.equal(feed.syncing,false);assert.ok(feed.syncError);assert.ok(feed.revision>revision);
  assert.ok(events.some(event=>event.catchup&&event.syncError&&!event.syncing));
  t.mock.timers.tick(1000);await drain();assert.ok(feed.list().threads.every(row=>row.status==='active'));
});

test('已确认静态终态不会因候选仍在清单而反复探测，索引变化后才重查',async t=>{
  const {adapter,feed,setActivity,setRows}=fixture(t);setActivity(['a']);let probes=0;
  adapter.watch=async()=>{probes++;return snapshot('a','idle');};
  await ready(feed);assert.equal(probes,1);await feed.refresh();await feed.refresh();assert.equal(probes,1);
  setRows([{id:'a',title:'合成会话',cwd:'/workspace/demo',updatedAt:43}]);feed.nextProbe.clear();await feed.refresh();assert.equal(probes,2);
});

test('轻量模式只做十五秒元数据核对，不持正文watch，在线及宽限恢复两秒周期',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const {adapter,feed,setActivity,probes}=fixture(t);let inventoryReads=0;setActivity(['a']);
  adapter.readActivityInventory=async()=>{inventoryReads++;return {complete:true,threadIds:['a']};};
  feed.setMode('light');await drain();const initial=inventoryReads;
  feed.schedule();feed.schedule();t.mock.timers.tick(14999);await drain();assert.equal(inventoryReads,initial);assert.equal(probes.length,0);
  t.mock.timers.tick(1);await drain();assert.equal(inventoryReads,initial+1);assert.equal(probes.length,0);
  feed.setMode('online');await drain();assert.equal(probes.length,1);assert.equal(feed.owned.has('a'),true);
  feed.setMode('grace');await drain();assert.equal(feed.owned.has('a'),true);
  feed.setMode('light');await drain();assert.equal(feed.owned.size,0);
});

test('文件通知固定三百毫秒合并，不被持续通知饿死',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const {adapter,feed,setRows}=fixture(t);await ready(feed);adapter.watch=async()=>{throw new Error('合成未加载会话');};
  setRows([{id:'a',title:'新索引名称',updatedAt:43}]);feed.schedule();t.mock.timers.tick(150);feed.schedule();t.mock.timers.tick(150);await drain();
  assert.equal(feed.list().threads[0].title,'新索引名称');
});

test('三百毫秒索引通知立即维护变化单聊，整批活动和原生未读最多每两秒一次',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const {adapter,feed,setRows,probes}=fixture(t);let activities=0,unread=0,indexReads=0;
  const list=adapter.index.list;adapter.index.list=(...args)=>{indexReads++;return list(...args);};
  adapter.readActivityInventory=async({rows})=>{activities++;assert.equal(rows.length,1);return {complete:true,threadIds:[]};};
  adapter.refreshReadState=async()=>{unread++;};
  await ready(feed);const initialIndex=indexReads;assert.equal(activities,1);assert.equal(unread,1);
  for(let i=0;i<5;i++) {
    setRows([{id:'a',title:'合成会话',cwd:'/workspace/demo',updatedAt:43+i}]);feed.schedule();
    t.mock.timers.tick(300);await drain();
  }
  assert.ok(indexReads>=initialIndex+5);assert.equal(activities,1);assert.equal(unread,1);
  assert.equal(probes.length,1);assert.equal(feed.list().threads[0].status,'active');
  t.mock.timers.tick(499);await drain();assert.equal(activities,1);
  t.mock.timers.tick(1);await drain();assert.equal(activities,2);assert.equal(unread,2);
});

test('活动读取超过本轮预算仍共享原在途读取，不每轮超时后并行重开整批查询',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const {adapter,feed}=fixture(t);let activities=0,finish;
  adapter.readActivityInventory=()=>{activities++;return new Promise(resolve=>{finish=resolve;});};
  await feed.watch('phone');await drain();assert.equal(activities,1);
  t.mock.timers.tick(1800);await drain();assert.equal(feed.syncing,false);assert.ok(feed.syncError);
  t.mock.timers.tick(200);await drain();assert.equal(activities,1);
  t.mock.timers.tick(1800);await drain();assert.equal(activities,1);
  finish({complete:true,threadIds:[]});await drain();
  adapter.readActivityInventory=async()=>{activities++;return {complete:true,threadIds:[]};};
  t.mock.timers.tick(200);await drain();assert.equal(activities,2);
});

test('新watch和追平有完整通知基线，旧通知仅保留pending，真实终态转换正常发送',async t=>{
  const {adapter,feed,value,events}=fixture(t,{live:true});
  value.notificationState={latestTurnId:'turn',latestTurnStatus:'inProgress',pending:[{id:'合成请求'}]};
  const first=await feed.watch('phone');await drain();
  assert.deepEqual(first.threads[0].notificationBaselineState,value.notificationState);
  assert.deepEqual(first.threads[0].notificationState,{latestTurnId:'',latestTurnStatus:'',pending:[{id:'合成请求'}]});
  const end={...value,status:'idle',activeTurnId:'',notificationState:{latestTurnId:'turn',latestTurnStatus:'completed',pending:[]},latestTurn:{turnId:'turn',status:'completed'}};
  adapter.emit('conversation',end);assert.equal(events.at(-1).catchup,undefined);
  assert.equal(events.at(-1).threads[0].notificationState.latestTurnStatus,'completed');
  const second=await feed.watch('second');assert.equal(second.threads[0].notificationState.latestTurnStatus,'');
  assert.equal(second.threads[0].notificationBaselineState.latestTurnStatus,'completed');
});

test('连续正文每秒尾帧合并，终态和待交互立即送最新版本，未知未读事件不丢尾帧',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const {adapter,feed,value,events}=fixture(t,{live:true});await ready(feed);events.length=0;
  for(let i=1;i<=19;i++){value.messages[0].text='合成片段'+i;adapter.emit('conversation',structuredClone(value));t.mock.timers.tick(100);await drain();}
  assert.equal(events.length,1);assert.equal(events[0].threads[0].contentRevision,conversationContentRevision({...value,messages:[{...value.messages[0],text:'合成片段10'}]}));
  adapter.emit('readState',{threadId:'不存在',hasUnreadTurn:true});t.mock.timers.tick(100);await drain();assert.equal(events.length,2);
  assert.equal(events.at(-1).threads[0].contentRevision,conversationContentRevision(value));
  value.messages[0].text='终态尾帧';adapter.emit('conversation',structuredClone(value));
  adapter.emit('conversation',{...value,status:'idle',activeTurnId:'',latestTurn:{turnId:'turn',status:'completed'}});
  assert.equal(events.length,3);assert.equal(events.at(-1).threads[0].latestTurn.status,'completed');assert.equal(feed.contentTimer,null);
  adapter.emit('conversation',{...value,approvals:[{id:'合成审批'}]});assert.equal(events.length,4);
});

test('同步状态无行变化也推进revision，稳定周期不产生无变化推送',async t=>{
  const {feed,events}=fixture(t);await ready(feed);events.length=0;const revision=feed.revision;
  feed.setSync(true);assert.equal(feed.revision,revision+1);feed.setSync(false);assert.equal(feed.revision,revision+2);
  await feed.refresh();assert.equal(events.length,2);
});

test('正文尾帧不能覆盖后到的未读与已读事件，无关会话更新也保留最新标记',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {adapter,feed,value,events}=fixture(t,{live:true,count:2});await ready(feed);
 for(const [before,after] of [[false,true],[true,false]]){
  const base={...value,status:'idle',activeTurnId:'',hasUnreadTurn:before,latestTurn:{turnId:'turn',status:'completed'}};
  adapter.emit('conversation',base);events.length=0;
  const tail={...base,messages:[{...base.messages[0],text:'合成尾帧'+after}]};adapter.emit('conversation',tail);
  assert.ok(feed.pendingSnapshots.has('a'));
  adapter.emit('readState',{threadId:'a',hasUnreadTurn:after});
  assert.equal(feed.rows.find(row=>row.id==='a').hasUnreadTurn,after);
  assert.equal(events.at(-1).threads.find(row=>row.id==='a').contentRevision,conversationContentRevision(tail));
  adapter.emit('conversation',{...tail,messages:[{...tail.messages[0],text:'另一份尾帧'}],hasUnreadTurn:after});
  adapter.emit('readState',{threadId:'1',hasUnreadTurn:true});t.mock.timers.tick(1000);await drain();
  assert.equal(events.at(-1).threads.find(row=>row.id==='a').hasUnreadTurn,after);
 }
});

test('关闭取消待发正文，迟到候选快照不能重建订阅或覆盖重入会话',async t=>{
  const {adapter,feed,setActivity,events}=fixture(t);setActivity(['a']);let finish;
  adapter.watch=()=>new Promise(resolve=>{finish=resolve;});
  await feed.watch('phone');await drain();assert.equal(typeof finish,'function');const count=events.length;
  feed.unwatch('phone');finish(snapshot());await drain();assert.equal(events.length,count);assert.equal(feed.owned.size,0);
  feed.close();adapter.emit('conversation',snapshot());assert.equal(events.length,count);
});

test('列表SQLite只落盘四个展示字段，重启不会恢复运行、权限、审批和通知状态',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const {feed,value}=fixture(t,{db,live:true});value.executionSettings={model:'合成模型'};value.approvals=[{id:'合成审批'}];value.notificationState={latestTurnId:'turn',latestTurnStatus:'completed',pending:[]};
  await ready(feed);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM thread_list_index').get().count,0);
  assert.equal(feed.store.flush(),true);
  const row=db.prepare('SELECT * FROM thread_list_index').get();
  assert.deepEqual(Object.keys(row).sort(),['cwd','id','position','title','updated_at']);
  const adapter=new EventEmitter();adapter.index={list:()=>{throw new Error('合成索引暂不可用');}};adapter.conversations=new Map();adapter.unwatch=()=>{};
  const restored=new ThreadListFeed(adapter,()=>{},{db});t.after(()=>restored.close());restored.start();
  assert.equal(restored.list().threads[0].status,'unknown');assert.equal(restored.list().threads[0].approvalCount,0);assert.equal(restored.list().threads[0].notificationBaselineState,undefined);
});

test('保存版本与实时正文版本边界一致，临时entry释放后不误用保存版本',t=>{
  const {feed,value}=fixture(t);const row={id:'a',updatedAt:42,status:'active'};
  assert.equal(feed.contentSummary(row,value).contentRevision,conversationContentRevision(value));
  assert.equal(feed.contentSummary(row).contentRevision,undefined);assert.equal(feed.contentSummary({...row,status:'unknown'}).contentRevision,'saved:42');
});

test('探测超时后迟到创建的内部订阅会被清理，切换轻维护也不会重新挂回正文',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);let finish;
  f.setActivity(['a']);
  f.adapter.watch=(id,owner)=>new Promise(resolve=>{finish=()=>{const value=snapshot(id);f.adapter.conversations.set(id,{state:value,watchers:new Set([owner])});resolve(value);};});
  await f.feed.watch('phone');await drain();
  t.mock.timers.tick(1800);await drain();
  assert.equal(f.feed.syncing,false);assert.equal(f.adapter.conversations.size,0);
  f.feed.setMode('light');finish();await drain();
  assert.equal(f.adapter.conversations.size,0);assert.equal(f.feed.probeLeases.size,0);
});

test('持续输出导致的索引时间更新只发普通增量，不反复转圈或重置通知基线',async t=>{
  const f=fixture(t);f.setActivity(['a']);await ready(f.feed);const count=f.events.length;
  f.setRows([{id:'a',title:'合成会话',cwd:'/workspace/demo',updatedAt:43}]);await f.feed.refresh();
  const updates=f.events.slice(count);assert.ok(updates.length>0);
  assert.ok(updates.every(event=>event.syncing!==true&&event.catchup!==true));
  assert.equal(f.feed.syncing,false);
});
