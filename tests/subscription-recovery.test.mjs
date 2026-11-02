import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';

/** 模拟桌面探测短暂无响应，验证列表轮询不能破坏手机已有的实时订阅。 */
class Desktop extends EventEmitter {
  socket={writable:true}; available=true; calls=[];
  state={id:'thread',title:'会话',cwd:'C:/project',latestModel:'model',requests:[],turns:[]};
  async connect() {}
  async findOwner(_id,hostId) {return this.available&&hostId==='local'?{clientId:'desktop',hostId}:null;}
  broadcast(method,params) {
    this.calls.push({method,params});
    if(params.following)queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{conversationId:'thread',hostId:'local',change:{type:'snapshot',revision:1,conversationState:this.state}}}));
  }
  async request(method) {assert.equal(method,'thread-follower-read-model-settings');return {resultType:'success',result:{settings:{model:'model',reasoningEffort:'high'}}};}
  close() {}
}

test('列表探测失败只返回未知，不清空手机订阅及模型设置读取能力',async()=>{
  const client=new Desktop();
  const adapter=new DesktopAdapter({client,index:{list:()=>[{id:'thread',title:'会话'}]},modelCatalog:{read:()=>[]}});
  try {
    await adapter.watch('thread','phone');
    const entry=adapter.conversations.get('thread'),state=entry.state,owner=entry.owner;
    client.available=false;
    assert.equal((await adapter.list({}))[0].status,'unknown');
    assert.equal(entry.owner,owner);
    assert.equal(entry.state,state);
    assert.deepEqual([...entry.watchers],['phone']);
    assert.equal((await adapter.readSettings('thread','phone')).settings.model,'model');
    assert.equal(client.calls.filter(call=>call.params.following===false).length,0);
    await assert.rejects(adapter.readSettings('thread','other'),error=>error.code==='SUBSCRIPTION_REQUIRED');
  } finally {adapter.close();}
});

/** 执行真实页面监听：桥接重启后能力字段相同，也要重新读取设置并清除旧错误。 */
test('桥接重启的新快照会重新读取设置，消除抢先读取留下的加载提示',async()=>{
  const source=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8');
  const method=source.slice(source.indexOf('function loadSettings()'),source.indexOf('\nfunction openComposerMenu('));
  const start=source.indexOf('watch((): string => connection.hostId +');
  const watchers=source.slice(start,source.indexOf('\nfunction onDraftLineChange',start));
  const subscriptions=[],pending=[];
  const context=vm.createContext({settingsRequest:0,settingsSnapshotRevision:0,settingsRetryTimer:0,settingsRetryCount:0,setTimeout:()=>1,clearTimeout(){},settings:{value:null},models:{value:[]},settingsLoading:{value:false},settingsBusy:{value:false},settingsError:{value:''},readOnly:{value:false},composerMenu:{value:''},
    connection:{hostId:'pc',activeThreadId:'thread',connected:true,epoch:'persistent-epoch',subscriptionRevision:0,snapshot:{supportsExecutionSettings:true}},pageHostId:{value:'pc'},pageThreadId:{value:'thread'},
    isCurrentPage:()=>true,closeComposerMenu(){},confirmDefaultMode(){},updateMenuHeight(){},
    bridge:{request:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))},watch:(read,changed)=>subscriptions.push({read,changed})});
  const helpers=fs.readFileSync('apps/mobile/services/execution-settings.uts','utf8').replace(/\bexport /g,'');
  vm.runInContext(stripTypeScriptTypes(helpers+'\n'+method+'\n'+watchers,{mode:'transform'}),context);
  const watcher=subscriptions[0],before=watcher.read();watcher.changed();
  pending.shift().reject(new Error('请先加载此会话后再操作'));await new Promise(resolve=>setImmediate(resolve));
  assert.match(context.settingsError.value,/请先加载/);
  context.connection.subscriptionRevision++; // 重启不会更换持久化 epoch，订阅确认必须有独立信号。
  assert.notEqual(watcher.read(),before);
  watcher.changed();
  pending.shift().resolve({settings:{model:'model',mode:'default'},models:[{id:'model'}]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(context.settingsError.value,'');assert.equal(context.settings.value.model,'model');
});

test('只有当前会话的订阅确认推进恢复标记，较旧回执不能覆盖新消息',()=>{
  const source=fs.readFileSync('apps/mobile/services/bridge.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
  const context=vm.createContext({reactive:value=>value});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={MobileBridge,connection};',context);
  const {MobileBridge,connection}=context.subject,bridge=new MobileBridge();
  Object.assign(connection,{hostId:'pc',activeThreadId:'thread',epoch:'persisted',sequence:10,snapshot:{threadId:'thread',title:'较新内容'}});
  const result={getString:()=> 'persisted',getNumber:()=>9,snapshot:{threadId:'thread',title:'较旧内容'}};
  bridge.applySnapshot(result,'other','thread');assert.equal(connection.subscriptionRevision,0);
  bridge.applySnapshot(result,'pc','old-thread');assert.equal(connection.subscriptionRevision,0);
  bridge.applySnapshot(result,'pc','thread');assert.equal(connection.subscriptionRevision,1);assert.equal(connection.snapshot.title,'较新内容');
});
