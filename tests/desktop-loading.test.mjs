import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { openDesktopThread } from '../apps/bridge/desktop-launcher.mjs';
import { validateRequest } from '../packages/protocol/contracts.mjs';

/** 未加载会话只有已保存历史，不提供可执行的实时状态。 */
class ColdDesktop extends EventEmitter {
  socket={writable:true}; loaded=false; calls=[];
  async connect() {}
  async findOwner(_id,hostId) {return this.loaded&&hostId==='local'?{clientId:'desktop',hostId}:null;}
  broadcast(method,params) {
    this.calls.push(method);
    if(params.following)queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{conversationId:params.conversationId,hostId:'local',change:{type:'snapshot',revision:1,conversationState:{id:params.conversationId,turns:[],requests:[],threadRuntimeStatus:{type:'idle'}}}}}));
  }
  async request(){throw new Error('不应执行桌面写请求');}
  close() {}
}
const saved={threadId:'thread',readOnly:true,status:'unknown',activeTurnId:'',messages:[{id:'history',role:'user',text:'已有消息'}],approvals:[],questionGroups:[]};

test('只有明确继续才请求电脑加载，完成后获得可操作的原所有者快照',async()=>{
  const client=new ColdDesktop();let opened=0;
  const adapter=new DesktopAdapter({client,index:{readHistory:()=>saved,containsThread:()=>true},activateThread:async()=>{opened++;client.loaded=true;}});
  try {
    assert.equal((await adapter.watch('thread','phone')).readOnly,true);assert.equal(opened,0);
    const result=await adapter.watch('thread','phone',{activate:true});assert.equal(opened,1);assert.notEqual(result.readOnly,true);assert.equal(result.status,'idle');assert.ok(client.calls.every(method=>method==='thread-stream-following-changed'));
    await adapter.watch('thread','phone',{activate:true});assert.equal(opened,2);
  } finally {adapter.close();}
});

test('并发继续共用一次加载，失效会话和加载超时都不会发送任务指令',async()=>{
  const client=new ColdDesktop();let opened=0,release;
  const ready=new Promise(resolve=>{release=resolve;});
  const adapter=new DesktopAdapter({client,index:{containsThread:()=>false},loadTimeoutMs:1,activateThread:async()=>{opened++;await ready;client.loaded=true;}});
  try {
    await assert.rejects(adapter.watch('thread','phone',{activate:true}),error=>error.code==='THREAD_NOT_FOUND');assert.equal(opened,0);
    adapter.index.containsThread=()=>true;
    const first=adapter.watch('thread','p1',{activate:true}),second=adapter.watch('thread','p2',{activate:true});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(opened,1);release();await Promise.all([first,second]);assert.equal(adapter.loadingThreads.size,0);
    client.loaded=false;adapter.activateThread=async()=>{opened++;};
    await assert.rejects(adapter.watch('other','phone',{activate:true}),error=>error.code==='DESKTOP_LOAD_TIMEOUT');assert.equal(adapter.conversations.has('other'),false);
    assert.ok(client.calls.every(method=>method==='thread-stream-following-changed'));
  } finally {adapter.close();}
});

test('加载请求仅调用固定原生会话接口，加载标记必须明确为布尔值',async()=>{
  const id='00000000-0000-4000-8000-000000000001',calls=[];
  const nativeApi={navigate:async value=>calls.push(value)};
  await openDesktopThread(id,{platform:'win32',nativeApi});assert.deepEqual(calls,[id]);
  await assert.rejects(openDesktopThread('bad?prompt=run',{platform:'win32',nativeApi}),error=>error.code==='BAD_THREAD_ID');assert.equal(calls.length,1);
  const request={v:1,type:'request',requestId:'a'.repeat(20),method:'thread.watch',params:{threadId:id,activate:true}};
  assert.doesNotThrow(()=>validateRequest(request));for(const activate of ['true',1,null])assert.throws(()=>validateRequest({...request,params:{threadId:id,activate}}));
});

test('未加载会话只读后台历史，不调用桌面导航或创建跟随订阅',async()=>{
  const client=new ColdDesktop(),reads=[];
  const adapter=new DesktopAdapter({client,index:{readHistory:id=>{reads.push(id);return saved;}}});
  try {assert.deepEqual(await adapter.watch('thread','phone'),{...saved,supportsFileReports:adapter.supportsFileReports});assert.deepEqual(reads,['thread']);assert.deepEqual(client.calls,[]);assert.equal(adapter.conversations.get('thread').owner,null);adapter.unwatch('thread','phone');assert.equal(adapter.conversations.size,0);}
  finally {adapter.close();}
});

test('首页轮询不读取逐条历史，也不打开桌面会话',async()=>{
  let reads=0;const client=new ColdDesktop();
  const adapter=new DesktopAdapter({client,index:{list:()=>[{id:'thread'}],readHistory:()=>{reads++;return saved;}}});
  try {assert.equal((await adapter.list({}))[0].status,'unknown');assert.equal(reads,0);assert.deepEqual(client.calls,[]);assert.equal(adapter.conversations.size,0);}
  finally {adapter.close();}
});

test('local 超时仍查询 durable，已有所有者继续实时跟随',async()=>{
  const client=new ColdDesktop();let reads=0;
  client.findOwner=async(_id,host)=>{if(host==='local')throw Object.assign(new Error('超时'),{code:'IPC_TIMEOUT'});return{clientId:'desktop',hostId:host};};
  const adapter=new DesktopAdapter({client,index:{readHistory:()=>{reads++;return saved;}}});
  try {assert.equal((await adapter.discoverOwner('thread',500)).hostId,'durable');assert.equal(reads,0);}
  finally {adapter.close();}
});

test('历史会话在后端拒绝所有写操作；桌面自然加载后恢复实时模式',async()=>{
  const client=new ColdDesktop(),adapter=new DesktopAdapter({client,index:{readHistory:()=>saved}});
  try {
    await adapter.watch('thread','phone');
    for(const method of ['turn.send','turn.steer','turn.stop','approval.reply','question.reply'])await assert.rejects(adapter.operate(method,{threadId:'thread',text:'消息'},'command','phone'),error=>error.code==='HISTORY_READ_ONLY');
    assert.deepEqual(client.calls,[]);client.loaded=true;
    const realtime=await adapter.watch('thread','phone');assert.notEqual(realtime.readOnly,true);assert.equal(realtime.status,'idle');
  } finally {adapter.close();}
});

test('读取失败和离开会话后的迟到历史不遗留订阅',async()=>{
  const client=new ColdDesktop();let release;
  const adapter=new DesktopAdapter({client,index:{readHistory:()=>{throw new Error('读取失败');}}});
  try {
    await assert.rejects(adapter.watch('thread','phone'),/读取失败/);assert.equal(adapter.conversations.size,0);
    const reading=new Promise(resolve=>{release=resolve;});adapter.index.readHistory=()=>reading;
    const watching=adapter.watch('thread','phone');await new Promise(resolve=>setImmediate(resolve));adapter.unwatch('thread','phone');release(saved);
    await assert.rejects(watching,error=>error.code==='SUBSCRIPTION_CANCELED');assert.equal(adapter.conversations.size,0);assert.deepEqual(client.calls,[]);
  } finally {adapter.close();}
});
