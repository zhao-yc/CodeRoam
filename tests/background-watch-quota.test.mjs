import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {CACHE_WATCHER} from '../apps/bridge/thread-cache.mjs';

/** 真实适配器配合合成IPC快照，仅验证订阅生命周期，不连接实际桌面或原生服务。 */
function fixture(t) {
  const client=new EventEmitter(),released=[];
  client.socket={writable:true};client.connect=async()=>{};client.close=()=>{};
  client.findOwner=async(_id,hostId)=>hostId==='local'?{clientId:'synthetic-owner',hostId}:null;
  client.broadcast=(method,params)=>{
    if(method!=='thread-stream-following-changed')return;
    if(!params.following){released.push(params.conversationId);return;}
    queueMicrotask(()=>client.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'synthetic-owner',params:{conversationId:params.conversationId,hostId:'local',change:{type:'snapshot',revision:1,conversationState:{id:params.conversationId,title:'合成额度会话',turns:[],requests:[],threadRuntimeStatus:{type:'idle'}}}}}));
  };
  const adapter=new DesktopAdapter({client,snapshotTimeoutMs:100});t.after(()=>adapter.close());
  const watch=(id,owner='phone')=>adapter.watch(id,owner,{history:false});
  const fill=async(count,prefix,owner)=>{for(let index=0;index<count;index++)await watch(prefix+index,owner);};
  return {adapter,watch,fill,released};
}
const quota=error=>error.code==='TOO_MANY_THREADS';

test('五十个纯后台条目不挤占六十四个真实详情额度，总满时只驱逐后台',async t=>{
  const f=fixture(t);await f.fill(50,'background-','list-status');
  await f.fill(64,'detail-','phone');
  assert.equal(f.adapter.conversations.size,84);
  for(let index=0;index<64;index++)assert.ok(f.adapter.conversations.get('detail-'+index)?.watchers.has('phone'));
  assert.equal(f.released.length,30);assert.ok(f.released.every(id=>id.startsWith('background-')));
  await assert.rejects(f.watch('detail-overflow'),quota);
  await f.watch('detail-0','another-phone');
  assert.deepEqual([...f.adapter.conversations.get('detail-0').watchers].sort(),['another-phone','phone']);
});

test('CACHE和列表共享条目均属后台，满六十四真实详情后不能借后台条目绕过额度',async t=>{
  const f=fixture(t);await f.fill(20,'background-',CACHE_WATCHER);
  for(let index=0;index<20;index++)await f.watch('background-'+index,'list-status');
  await f.fill(64,'detail-','phone');
  assert.equal(f.adapter.conversations.size,84);
  assert.ok(f.adapter.conversations.get('background-0').watchers.has(CACHE_WATCHER));
  assert.ok(f.adapter.conversations.get('background-0').watchers.has('list-status'));
  await assert.rejects(f.watch('background-0','phone'),quota);
  assert.equal(f.adapter.conversations.get('background-0').watchers.has('phone'),false);
});

test('纯后台最多五十条，满额每两秒只轮转两个最旧条目',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  const f=fixture(t);await f.fill(50,'background-','list-status');
  await f.watch('replacement-one','list-status');await f.watch('replacement-two',CACHE_WATCHER);
  assert.equal(f.adapter.conversations.size,50);assert.deepEqual(f.released,['background-0','background-1']);
  await assert.rejects(f.watch('replacement-three','list-status'),quota);
  t.mock.timers.tick(1999);await assert.rejects(f.watch('replacement-three',CACHE_WATCHER),quota);
  t.mock.timers.tick(1);await f.watch('replacement-three','list-status');await f.watch('replacement-four',CACHE_WATCHER);
  assert.equal(f.adapter.conversations.size,50);assert.deepEqual(f.released,['background-0','background-1','background-2','background-3']);
  await assert.rejects(f.watch('replacement-five','list-status'),quota);
});

test('共享总额八十四时后台轮转只释放纯内部条目，不驱逐任何真实观看者',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  const f=fixture(t);await f.fill(64,'detail-','phone');await f.fill(20,'background-',CACHE_WATCHER);
  await f.watch('detail-0','list-status');await f.watch('detail-0',CACHE_WATCHER);
  await f.watch('next-background','list-status');await f.watch('another-background',CACHE_WATCHER);
  assert.equal(f.adapter.conversations.size,84);assert.deepEqual(f.released,['background-0','background-1']);
  await assert.rejects(f.watch('blocked-background','list-status'),quota);
  for(let index=0;index<64;index++)assert.ok(f.adapter.conversations.get('detail-'+index)?.watchers.has('phone'));
  assert.ok(f.adapter.conversations.get('detail-0').watchers.has('list-status'));
  assert.ok(f.adapter.conversations.get('detail-0').watchers.has(CACHE_WATCHER));
});
