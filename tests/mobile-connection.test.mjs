import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 直接执行项目 UTS 的连接逻辑，用可控计时器复现原生 onError 后没有 onClose 的情况。 */
function mobileFixture(storage=new Map()){
  const timers=new Map(),sockets=[];let timerId=0;
  const uni={getStorageSync:key=>storage.get(key)??'',setStorageSync(key,value){storage.set(key,value);},removeStorageSync(key){storage.delete(key);},onNetworkStatusChange(){},request(options){options.success({statusCode:200,data:{ticket:'t'.repeat(43)}});},connectSocket(){
    const socket={callbacks:{},closeCount:0,close(){this.closeCount++;},onMessage(fn){this.callbacks.message=fn;},onClose(fn){this.callbacks.close=fn;},onError(fn){this.callbacks.error=fn;}};sockets.push(socket);return socket;
  }};
  const context=vm.createContext({uni,Map,Promise,Error,JSON,Math,Date,reactive:value=>value,setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
  let source=fs.readFileSync(new URL('../apps/mobile/services/bridge.uts',import.meta.url),'utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
  source=stripTypeScriptTypes(source,{mode:'transform'});vm.runInContext(source+'\nglobalThis.subject={MobileBridge,connection};',context);
  const {MobileBridge,connection}=context.subject,bridge=new MobileBridge();bridge.config={relayUrl:'wss://relay.example/ws',hostId:'pc',token:'s'.repeat(43)};
  return {bridge,connection,timers,sockets,storage,uni};
}

test('导入默认保存连接，新页面忽略旧操作锁且不重发写操作',()=>{
  const storage=new Map(),first=mobileFixture(storage);first.bridge.foreground=false;
  const config={relayUrl:'wss://relay.example/ws',hostId:'pc',token:'s'.repeat(43),extra:'不应保存'};
  first.bridge.configure(JSON.stringify(config));
  assert.deepEqual(JSON.parse(storage.get('codex-mobile-connection')),{relayUrl:config.relayUrl,token:config.token,hostId:config.hostId,cacheNamespace:first.bridge.config.cacheNamespace});
  storage.set('codex-mobile-pending-pc','unknown-command');
  const reopened=mobileFixture(storage);reopened.bridge.restore();
  assert.equal(reopened.connection.configured,true);assert.equal(reopened.connection.hostId,'pc');assert.equal(reopened.connection.pendingCommandId,'');assert.equal(reopened.storage.has('codex-mobile-pending-pc'),false);
  assert.equal(reopened.bridge.config.token,config.token);assert.equal(reopened.sockets.length,1);assert.equal(reopened.bridge.pending.size,0);
  assert.equal(JSON.parse(storage.get('codex-mobile-connection')).extra,undefined);
});

test('缓存损坏或浏览器禁用存储不阻止启动，导入校验或保存失败不覆盖旧配置',()=>{
  const f=mobileFixture();f.bridge.foreground=false;
  const serialized=JSON.stringify(f.bridge.config);f.bridge.configure(serialized);
  const oldConfig=f.bridge.config,saved=f.storage.get('codex-mobile-connection');
  assert.throws(()=>f.bridge.configure('{损坏'));assert.equal(f.storage.get('codex-mobile-connection'),saved);assert.equal(f.bridge.config,oldConfig);
  f.uni.setStorageSync=()=>{throw new Error('含敏感信息的存储异常');};
  assert.throws(()=>f.bridge.configure(JSON.stringify({...oldConfig,hostId:'next'})),/无法保存连接配置/);assert.equal(f.bridge.config,oldConfig);
  assert.equal(f.storage.get('codex-mobile-connection'),saved);
  const corrupted=mobileFixture(new Map([['codex-mobile-connection','{损坏']]));corrupted.bridge.restore();assert.equal(corrupted.connection.configured,false);assert.equal(corrupted.sockets.length,0);assert.match(corrupted.connection.error,/无法读取/);
  const blocked=mobileFixture();blocked.uni.getStorageSync=()=>{throw new Error('禁止存储');};assert.doesNotThrow(()=>blocked.bridge.restore());assert.match(blocked.connection.error,/无法读取/);
});

test('旧配对自动补齐缓存命名空间，刷新与切换电脑沿用，重新导入隔离旧内容',()=>{
  const f=mobileFixture();f.bridge.foreground=false;
  const raw=JSON.stringify(f.bridge.config);f.bridge.configure(raw,false);
  const namespace=f.connection.cacheNamespace;assert.ok(namespace.length>0);assert.equal(namespace.includes(f.bridge.config.token),false);
  const restored=mobileFixture(f.storage);restored.bridge.foreground=false;restored.bridge.restore();assert.equal(restored.connection.cacheNamespace,namespace);
  restored.connection.computers=[{id:'other',online:true}];restored.bridge.selectComputer('other');assert.equal(restored.connection.cacheNamespace,namespace);
  restored.bridge.configure(raw);assert.notEqual(restored.connection.cacheNamespace,namespace);
  restored.bridge.forgetConfiguration();assert.equal(restored.connection.cacheNamespace,'');
});

test('切换到授权子实例后刷新恢复同一电脑，保留配对字段且不重放写请求',()=>{
  const f=mobileFixture();f.bridge.foreground=false;f.bridge.configure(JSON.stringify(f.bridge.config));
  f.connection.computers=[{id:'pc',online:true},{id:'pc~00000000-0000-4000-8000-000000000002',online:true}];
  f.bridge.resume=()=>{};
  const selected=f.connection.computers[1].id;
  f.bridge.selectComputer(selected);
  assert.equal(f.connection.hostId,selected);assert.equal(f.bridge.config.hostId,selected);
  assert.deepEqual(JSON.parse(f.storage.get('codex-mobile-connection')),{relayUrl:'wss://relay.example/ws',token:'s'.repeat(43),hostId:selected,cacheNamespace:f.bridge.config.cacheNamespace});
  const restored=mobileFixture(f.storage);restored.bridge.restore();
  assert.equal(restored.connection.hostId,selected);assert.equal(restored.bridge.pending.size,0);assert.equal(restored.connection.activeThreadId,'');
});

test('切换所选电脑保存失败或越权时保留原会话，不退订也不改变持久配置',()=>{
  const f=mobileFixture();f.bridge.foreground=false;f.bridge.configure(JSON.stringify(f.bridge.config));
  f.connection.computers=[{id:'pc',online:true},{id:'other',online:true}];f.connection.activeThreadId='current';const snapshot={threadId:'current'};f.connection.snapshot=snapshot;
  const saved=f.storage.get('codex-mobile-connection');f.bridge.request=()=>assert.fail('失败的切换不应发送请求');
  assert.throws(()=>f.bridge.selectComputer('unauthorized'),/不在当前授权/);
  f.uni.setStorageSync=()=>{throw new Error('私有存储错误');};
  assert.throws(()=>f.bridge.selectComputer('other'),/无法保存所选电脑/);
  assert.equal(f.connection.hostId,'pc');assert.equal(f.bridge.config.hostId,'pc');assert.equal(f.connection.activeThreadId,'current');assert.equal(f.connection.snapshot,snapshot);assert.equal(f.storage.get('codex-mobile-connection'),saved);
});

test('清除连接只删除指定配置并断开，不影响其他记录，刷新后不再连接',()=>{
  const f=mobileFixture();f.bridge.foreground=false;f.bridge.configure(JSON.stringify(f.bridge.config));
  f.storage.set('其他站点设置','保留');f.storage.set('codex-mobile-pending-other','待核对');
  f.connection.snapshot={threadId:'thread'};f.connection.activeThreadId='thread';f.connection.connected=true;
  f.bridge.forgetConfiguration();
  assert.equal(f.storage.has('codex-mobile-connection'),false);assert.equal(f.connection.configured,false);assert.equal(f.connection.connected,false);assert.equal(f.connection.snapshot,null);assert.equal(f.connection.hostId,'');assert.equal(f.bridge.config,null);
  assert.equal(f.storage.get('其他站点设置'),'保留');assert.equal(f.storage.get('codex-mobile-pending-other'),'待核对');
  const reopened=mobileFixture(f.storage);reopened.bridge.restore();assert.equal(reopened.connection.configured,false);assert.equal(reopened.sockets.length,0);
});

test('待核对操作或存储删除失败时不清除连接，不丢失原配置',()=>{
  const f=mobileFixture();f.bridge.foreground=false;f.bridge.configure(JSON.stringify(f.bridge.config));
  f.bridge.rememberCommand('pending','pc','thread');assert.throws(()=>f.bridge.forgetConfiguration(),/正在提交/);assert.equal(f.storage.has('codex-mobile-connection'),true);assert.equal(f.connection.configured,true);
  f.bridge.clearCommand('pending');f.uni.removeStorageSync=()=>{throw new Error('删除失败');};
  assert.throws(()=>f.bridge.forgetConfiguration(),/无法清除本地连接/);assert.equal(f.connection.configured,true);assert.notEqual(f.bridge.config,null);
});

test('原生 WebSocket 只触发 onError 时也会释放连接并安排一次重试',()=>{
  const f=mobileFixture();f.bridge.connect();const socket=f.sockets[0];socket.callbacks.error({errMsg:'Expected HTTP 101 response but was 401'});
  assert.equal(f.bridge.connecting,false);assert.equal(f.connection.connected,false);assert.equal(socket.closeCount,1);
  assert.equal([...f.timers.values()].filter(timer=>timer.delay<8000).length,1);assert.match(f.connection.error,/401/);
  socket.callbacks.close({code:1006,reason:''});assert.equal([...f.timers.values()].filter(timer=>timer.delay<8000).length,1);
});

test('未收到 welcome 且没有 close 回调时握手超时仍可恢复，错误详情隐藏凭据',()=>{
  const f=mobileFixture();f.bridge.connect();const timeout=[...f.timers.values()].find(timer=>timer.delay===8000);timeout.fn();assert.equal(f.bridge.connecting,false);assert.equal(f.connection.status,'等待重连');
  const retry=[...f.timers.values()].find(timer=>timer.delay<8000);retry.fn();assert.equal(f.sockets.length,2);
  f.sockets[1].callbacks.error({errMsg:`握手失败 ${'s'.repeat(43)} ticket.${'t'.repeat(43)}`});assert.equal(f.connection.error.includes('s'.repeat(43)),false);assert.equal(f.connection.error.includes('t'.repeat(43)),false);
});

/** 使用可回放响应的 Socket，验证发送边界和切换电脑后的响应归属。 */
function connectedFixture(){
  const f=mobileFixture(),sent=[];
  f.connection.connected=true;f.connection.hostId='pc';f.connection.activeThreadId='thread';
  f.bridge.socket={send(options){sent.push(JSON.parse(options.data));},close(){}};
  return {...f,sent};
}

/** 为实际 UTS 响应处理器提供其使用的 JSON 访问方法。 */
function utsObject(value){
  return {...value,getString(key){return this[key]??null;},getNumber(key){return this[key]??null;},getBoolean(key){return this[key]??null;}};
}

function respond(f,request,result={},error=null){
  f.bridge.receive(utsObject({type:'response',requestId:request.requestId,result:utsObject(result),error:error==null?null:utsObject(error)}));
}

test('图片读取就绪只来自当前聊天订阅回执，旧快照和旧电脑响应不能提前放行',async()=>{
  const f=connectedFixture();f.connection.snapshot={threadId:'thread',messages:[]};
  assert.equal(f.connection.subscribedThreadId,'');f.bridge.watch('thread');assert.equal(f.connection.subscribedThreadId,'');
  respond(f,f.sent[0],{snapshot:{threadId:'thread',messages:[],readOnly:true},epoch:'current',seq:1});await Promise.resolve();
  assert.equal(f.connection.subscribedHostId,'pc');assert.equal(f.connection.subscribedThreadId,'thread');assert.equal(f.connection.subscriptionRevision,1);
  f.bridge.disconnect();assert.equal(f.connection.subscribedHostId,'');assert.equal(f.connection.subscribedThreadId,'');assert.equal(f.connection.snapshot.threadId,'thread','旧快照保留阅读但不代表订阅仍有效');
  f.connection.connected=true;f.bridge.socket={send:options=>f.sent.push(JSON.parse(options.data)),close(){}};f.bridge.watch('thread');assert.equal(f.connection.subscribedThreadId,'');
  respond(f,f.sent.at(-1),{snapshot:{threadId:'thread',messages:[]},epoch:'reconnected',seq:1});await Promise.resolve();assert.equal(f.connection.subscribedThreadId,'thread');
  f.bridge.watch('next');assert.equal(f.connection.subscribedThreadId,'');
  f.bridge.applySnapshot(utsObject({snapshot:{threadId:'next'},epoch:'old',seq:1}),'other-pc','next');assert.equal(f.connection.subscribedThreadId,'');
});

test('快速从A切到B再返回A时，第一轮A的迟到回执不能恢复图片就绪或结束新订阅',async()=>{
  for(const failed of [false,true]){
    const f=connectedFixture();f.connection.activeThreadId='';f.bridge.watch('A');f.bridge.watch('B');f.bridge.watch('A');
    const reads=f.sent.filter(request=>request.method==='thread.watch');assert.equal(reads.length,3);
    respond(f,reads[0],{snapshot:{threadId:'A',title:'旧订阅'},epoch:'old',seq:1},failed?{message:'旧订阅读取失败'}:null);await Promise.resolve();
    assert.equal(f.connection.subscribedThreadId,'');assert.equal(f.bridge.syncingThread,'A');assert.equal(f.connection.conversationError,'');assert.equal(f.connection.snapshot,null);
    respond(f,reads[2],{snapshot:{threadId:'A',title:'新订阅'},epoch:'current',seq:2});await Promise.resolve();
    assert.equal(f.connection.subscribedThreadId,'A');assert.equal(f.connection.snapshot.title,'新订阅');assert.equal(f.bridge.syncingThread,'');
    f.bridge.disconnect();
  }
});

test('主动打开应用快照后发起新读取，旧成功结算不能清除新读取的同步锁',async()=>{
  const f=connectedFixture(),apply=f.bridge.applySnapshot.bind(f.bridge);
  f.bridge.applySnapshot=(...args)=>{apply(...args);f.bridge.syncingThread='';f.bridge.watch('thread');};
  const opening=f.bridge.openThread('thread');respond(f,f.sent[0],{snapshot:{threadId:'thread'},epoch:'current',seq:1,desktopActivated:true});await opening;
  assert.equal(f.bridge.syncingThread,'thread');assert.equal(f.sent.filter(request=>request.method==='thread.watch').length,2);f.bridge.disconnect();
});

test('有效实时事件也能确认图片订阅，取消、电脑离线及实例换代立即撤销',()=>{
  const f=connectedFixture();f.connection.computers=[{id:'pc',online:true,instanceGeneration:'g1'}];
  f.bridge.receive(utsObject({type:'event',hostId:'pc',threadId:'thread',generation:'g1',epoch:'current',seq:1,snapshot:{threadId:'thread',messages:[]}}));
  assert.equal(f.connection.subscribedThreadId,'thread');
  f.bridge.receive(utsObject({type:'hosts',hosts:[{id:'pc',online:false,instanceGeneration:'g1'}]}));assert.equal(f.connection.subscribedThreadId,'');
  f.connection.computers=[{id:'pc',online:true,instanceGeneration:'g1'}];f.bridge.confirmConversationRead();
  f.bridge.receive(utsObject({type:'hosts',hosts:[{id:'pc',online:true,instanceGeneration:'g2'}]}));assert.equal(f.connection.subscribedThreadId,'');
  f.bridge.confirmConversationRead();f.bridge.cancelOpen('thread');assert.equal(f.connection.subscribedThreadId,'');assert.equal(f.connection.subscribedHostId,'');
});

test('永久删除超时、断线和未知回执保留编号，重连恢复后只核对，不允许重复删除',async()=>{
  for(const failure of ['timeout','disconnect','unknown']){
    const f=connectedFixture();const pending=f.bridge.request('thread.delete',{threadId:'thread'},true);const request=f.sent.at(-1);
    if(failure==='timeout')[...f.timers.values()].find(timer=>timer.delay===65000).fn();
    if(failure==='disconnect')f.bridge.rejectPending();
    if(failure==='unknown')respond(f,request,{}, {code:'OUTCOME_UNKNOWN',message:'连接中断',outcomeUnknown:true});
    await assert.rejects(pending,/核对/);
    assert.equal(f.bridge.pendingCommand('pc','thread'),request.requestId);
    assert.ok(f.storage.get('codex-mobile-delete-pending-v1-pc').includes(request.requestId));
    await assert.rejects(f.bridge.request('thread.delete',{threadId:'thread'},true),/正在提交/);
    f.connection.pendingCommands=[];f.bridge.clearLegacyCommands('pc');assert.equal(f.bridge.pendingCommand('pc','thread'),request.requestId);
  }
});

test('永久删除明确失败释放保护，成功由应用完成清理后释放',async()=>{
  for(const failure of [false,true]){
    const f=connectedFixture(),pending=f.bridge.request('thread.delete',{threadId:'thread'},true),request=f.sent.at(-1);
    respond(f,request,{threadId:'thread',deleted:true,deletedThreadIds:['thread']},failure?{code:'DELETE_STOP_FAILED',message:'停止失败',outcomeUnknown:false}:null);
    if(failure)await assert.rejects(pending,/停止失败/);else assert.equal((await pending).deleted,true);
    if(!failure){assert.equal(f.bridge.pendingCommand('pc','thread'),request.requestId);f.bridge.clearCommand(request.requestId,'pc');}
    assert.equal(f.bridge.pendingCommand('pc','thread'),'');f.bridge.clearLegacyCommands('pc');assert.equal(f.bridge.pendingCommand('pc','thread'),'');
  }
});

test('删除状态读取固定原电脑，不改变当前电脑或聊天，越权请求不发送',async()=>{
  const f=connectedFixture();f.connection.computers=[{id:'pc',online:true},{id:'other',online:true}];
  const read=f.bridge.readCommandStatus('other','original-delete-command'),request=f.sent.at(-1);
  assert.equal(request.hostId,'other');assert.equal(request.method,'command.status');assert.equal(f.connection.hostId,'pc');assert.equal(f.connection.activeThreadId,'thread');
  respond(f,request,{state:'pending'});assert.equal((await read).state,'pending');
  await assert.rejects(f.bridge.readCommandStatus('untrusted','original-delete-command'),/离线或已取消授权/);assert.equal(f.sent.length,1);
});

test('删除保护按配对隔离，旧版记录仅在启动恢复时迁移',()=>{
  const f=connectedFixture();f.connection.cacheNamespace='pair-a';f.bridge.rememberCommand('original-delete-command','pc','thread','thread.delete');
  assert.ok(f.storage.get('codex-mobile-delete-pending-v1-pc:pair-a'));
  f.connection.cacheNamespace='pair-b';f.connection.pendingCommands=[];f.bridge.restoreDeletionCommands('pc');assert.equal(f.bridge.pendingCommand('pc','thread'),'');
  f.storage.set('codex-mobile-delete-pending-v1-pc',JSON.stringify([{id:'legacy-delete-command',hostId:'pc',threadId:'thread',method:'thread.delete'}]));
  f.bridge.restoreDeletionCommands('pc');assert.equal(f.bridge.pendingCommand('pc','thread'),'');
  f.bridge.migrateDeleteCommands=true;f.bridge.restoreDeletionCommands('pc');assert.equal(f.bridge.pendingCommand('pc','thread'),'legacy-delete-command');assert.equal(f.storage.has('codex-mobile-delete-pending-v1-pc'),false);
});

test('手机增量接收保留报告阶段与轮次耗时，阶段替换和后续文本追加可组合',()=>{
  const f=connectedFixture();f.connection.activeThreadId='thread';f.connection.epoch='e';f.connection.sequence=1;
  f.connection.snapshot={threadId:'thread',messages:[{id:'a',role:'assistant',phase:'commentary',text:'报告',turnId:'t',status:'inProgress'}]};
  const metadata={threadId:'thread',title:'标题',cwd:'',status:'idle',activeTurnId:'',supportsImages:true,turns:[{turnId:'t',status:'completed',durationMs:1000}],approvals:[],questionGroups:[],updatedAt:0,order:['a']};
  const receive=update=>f.bridge.receive(utsObject({type:'event',hostId:'pc',threadId:'thread',kind:'delta',epoch:'e',baseSeq:f.connection.sequence,seq:f.connection.sequence+1,update:{...metadata,...update}}));
  receive({upserts:[{...f.connection.snapshot.messages[0],phase:'final_answer',status:'completed'}],appends:[]});
  receive({upserts:[],appends:[{id:'a',text:'结束',status:'completed'}]});
  assert.equal(f.connection.snapshot.messages[0].phase,'final_answer');assert.equal(f.connection.snapshot.messages[0].text,'报告结束');assert.deepEqual(f.connection.snapshot.turns,metadata.turns);
  assert.equal(f.connection.snapshot.supportsImages,true);
});

test('历史浏览拒绝所有手机写请求，不保存命令编号，读取与核对仍可使用',async()=>{
  const f=connectedFixture();f.connection.snapshot={threadId:'thread',readOnly:true};
  for(const method of ['turn.send','turn.steer','turn.stop','approval.reply','question.reply'])await assert.rejects(f.bridge.request(method,{threadId:'thread'},true),/仅支持历史浏览/);
  assert.equal(f.sent.length,0);assert.equal(f.connection.pendingCommandId,'');assert.equal(f.bridge.pending.size,0);assert.equal(f.timers.size,0);
  const read=f.bridge.request('thread.watch',{threadId:'thread'});respond(f,f.sent[0],{snapshot:{threadId:'thread',readOnly:true}});await read;
});

test('继续只发加载标记不发送草稿，成功恢复实时状态，失败保留历史',async()=>{
  const f=connectedFixture();f.connection.activeThreadId='thread';f.connection.snapshot={threadId:'thread',readOnly:true,messages:[]};
  const loading=f.bridge.activate('thread');assert.equal(f.sent.length,1);assert.equal(f.sent[0].method,'thread.watch');assert.deepEqual(f.sent[0].params,{threadId:'thread',activate:true});assert.equal(f.connection.pendingCommandId,'');
  respond(f,f.sent[0],{snapshot:{threadId:'thread',readOnly:false,messages:[]},epoch:'e',seq:2});await loading;assert.equal(f.connection.snapshot.readOnly,false);
  f.connection.snapshot={threadId:'thread',readOnly:true};const failed=f.bridge.activate('thread');respond(f,f.sent[1],{},{message:'加载失败'});await assert.rejects(failed,/加载失败/);assert.equal(f.connection.snapshot.readOnly,true);
  f.bridge.rememberCommand('pending');await assert.rejects(f.bridge.activate('thread'),/正在提交/);assert.equal(f.sent.length,2);
});

test('继续期间切换电脑或会话，旧加载响应不会覆盖当前快照',async()=>{
  for(const changeHost of [true,false]){
    const f=connectedFixture();f.connection.activeThreadId='thread';f.connection.snapshot={threadId:'thread',readOnly:true};
    const loading=f.bridge.activate('thread');if(changeHost)f.connection.hostId='other';else f.connection.activeThreadId='other';
    f.connection.snapshot={threadId:'other',readOnly:true};respond(f,f.sent[0],{snapshot:{threadId:'thread',readOnly:false},epoch:'e',seq:1});await loading;assert.equal(f.connection.snapshot.threadId,'other');
  }
});

test('增量快照保留历史只读标记，并允许真实快照解除只读',()=>{
  const f=connectedFixture();f.connection.activeThreadId='thread';f.connection.epoch='e';f.connection.sequence=1;
  f.connection.snapshot={threadId:'thread',messages:[]};
  for(const readOnly of [true,false]) {
    f.bridge.receive(utsObject({type:'event',hostId:'pc',threadId:'thread',kind:'delta',epoch:'e',baseSeq:f.connection.sequence,seq:f.connection.sequence+1,update:{threadId:'thread',title:'标题',cwd:'C:/project',status:'unknown',activeTurnId:'',approvals:[],questionGroups:[],updatedAt:0,order:[],upserts:[],appends:[],readOnly}}));
    assert.equal(f.connection.snapshot.readOnly,readOnly);
  }
});

test('请求尚在提交时，发送、追加、停止和审批均不能连续点击',async()=>{
  const f=connectedFixture();f.bridge.rememberCommand('unknown-command');
  for(const method of ['turn.send','turn.steer','turn.stop','approval.reply']){
    await assert.rejects(f.bridge.request(method,{threadId:'thread'},true),/正在提交/);
    assert.equal(f.connection.pendingCommandId,'unknown-command');
  }
  assert.equal(f.sent.length,0);assert.equal(f.bridge.pending.size,0);assert.equal(f.timers.size,0);
});

test('提交中的会话仍可读取列表，读取完成不会解除在途写请求保护',async()=>{
  const f=connectedFixture(),write=f.bridge.request('turn.send',{threadId:'thread',text:'消息'},true),id=f.connection.pendingCommandId;
  const read=f.bridge.request('threads.list',{});respond(f,f.sent[1],{threads:[{id:'thread'}]});await read;
  assert.equal(f.connection.pendingCommandId,id);respond(f,f.sent[0],{});await write;assert.equal(f.connection.pendingCommandId,'');
});

test('切换电脑后，旧电脑的延迟会话列表不会覆盖当前电脑结果',async()=>{
  const f=connectedFixture();f.bridge.refreshThreads();
  f.connection.hostId='other-pc';f.bridge.refreshThreads();
  assert.equal(f.sent[0].hostId,'pc');assert.equal(f.sent[1].hostId,'other-pc');
  respond(f,f.sent[1],{threads:[{id:'current-thread'}]});await Promise.resolve();
  assert.equal(f.connection.threads[0].id,'current-thread');
  respond(f,f.sent[0],{threads:[{id:'stale-thread'}]});await Promise.resolve();
  assert.equal(f.connection.threads.length,1);assert.equal(f.connection.threads[0].id,'current-thread');
});

test('切换电脑后，旧电脑的延迟列表错误不会污染当前连接提示',async()=>{
  const f=connectedFixture();f.bridge.refreshThreads();
  f.connection.hostId='other-pc';f.connection.error='当前电脑的提示';
  respond(f,f.sent[0],{},{message:'旧电脑读取失败'});await Promise.resolve();
  assert.equal(f.connection.error,'当前电脑的提示');
});

test('切换电脑后同号会话的旧响应不覆盖快照、错误或清除新同步锁',async()=>{
  for(const failed of [false,true]){
    const f=connectedFixture();f.connection.activeThreadId='';f.bridge.watch('same-thread');
    f.connection.hostId='other-pc';f.bridge.syncingThread='';f.bridge.watch('same-thread');
    f.connection.snapshot={threadId:'same-thread',title:'当前电脑缓存'};f.connection.error='当前电脑的提示';
    respond(f,f.sent[0],{snapshot:{threadId:'same-thread',title:'旧电脑内容'},epoch:'old',seq:1},failed?{message:'旧电脑读取失败'}:null);await Promise.resolve();
    assert.equal(f.connection.snapshot.title,'当前电脑缓存');assert.equal(f.connection.error,'当前电脑的提示');assert.equal(f.bridge.syncingThread,'same-thread');
    respond(f,f.sent[1],{snapshot:{threadId:'same-thread',title:'当前电脑内容'},epoch:'current',seq:2});await Promise.resolve();
    assert.equal(f.connection.snapshot.title,'当前电脑内容');assert.equal(f.connection.epoch,'current');assert.equal(f.connection.sequence,2);assert.equal(f.bridge.syncingThread,'');
  }
});

test('超时、断线、发送失败与未知回执均释放提交状态，用户可手动再次发送',async()=>{
  for(const reason of ['timeout','disconnect','send-fail','unknown']){
    const f=connectedFixture();let failSend;
    f.bridge.socket.send=options=>{f.sent.push(JSON.parse(options.data));failSend=options.fail;};
    const first=f.bridge.request('turn.send',{threadId:'thread',text:'消息'},true),rejected=assert.rejects(first,/查看聊天/),old=f.sent[0];
    await assert.rejects(f.bridge.request('turn.send',{threadId:'thread',text:'连续点击'},true),/正在提交/);
    if(reason==='timeout')[...f.timers.values()].find(t=>t.delay===20000).fn();
    if(reason==='disconnect')f.bridge.disconnect();
    if(reason==='send-fail')failSend({});
    if(reason==='unknown')respond(f,old,{}, {message:'内部核对信息',outcomeUnknown:true});
    await rejected;assert.equal(f.connection.pendingCommandId,'');assert.equal(f.bridge.hasPendingCommands(),false);assert.equal(f.bridge.pending.size,0);
    assert.equal(f.sent.length,1);assert.equal(f.storage.size,0);
    f.connection.connected=true;f.bridge.socket={send:options=>f.sent.push(JSON.parse(options.data)),close(){}};
    const retry=f.bridge.request('turn.send',{threadId:'thread',text:'用户主动重发'},true),current=f.sent.at(-1);
    assert.notEqual(current.requestId,old.requestId);assert.equal(current.method,'turn.send');
    respond(f,old,{});assert.equal(f.connection.pendingCommandId,current.requestId);
    respond(f,current,{});await retry;assert.equal(f.connection.pendingCommandId,'');
  }
});

test('重连刷新会话与列表不查询操作账本、不自动重发消息，用户查看后可主动发送',async()=>{
  const f=connectedFixture();f.connection.computers=[{id:'pc',online:true}];
  const first=f.bridge.request('turn.send',{threadId:'thread',text:'消息'},true),rejected=assert.rejects(first);
  f.bridge.disconnect();await rejected;const count=f.sent.length;
  f.bridge.socket={send:options=>f.sent.push(JSON.parse(options.data)),close(){}};
  f.bridge.receive(utsObject({type:'welcome',hosts:[{id:'pc',online:true}]}));f.bridge.refreshThreads();
  const refreshed=f.sent.slice(count);assert.deepEqual(refreshed.map(r=>r.method),['thread.watch','threads.list']);
  respond(f,refreshed[0],{snapshot:{threadId:'thread',messages:[{role:'user',text:'消息'}]},epoch:'new',seq:1});
  respond(f,refreshed[1],{threads:[{id:'thread',title:'消息'}]});await Promise.resolve();
  assert.equal(f.connection.snapshot.messages[0].text,'消息');assert.equal(f.connection.threads[0].id,'thread');assert.equal(f.connection.pendingCommandId,'');
  assert.equal(f.sent.some(r=>r.method==='command.status'),false);assert.equal(f.sent.filter(r=>r.method==='turn.send').length,1);
  const retry=f.bridge.request('turn.send',{threadId:'thread',text:'用户决定再发送'},true);respond(f,f.sent.at(-1),{});await retry;
  assert.equal(f.sent.filter(r=>r.method==='turn.send').length,2);
});

test('A失败只释放A，切换电脑和会话不会解除B正在提交的保护',async()=>{
  for(const reason of ['timeout','send-fail','unknown','success']){
    const f=connectedFixture();f.connection.activeThreadId='A';let failSend;
    f.bridge.socket.send=options=>{f.sent.push(JSON.parse(options.data));failSend=options.fail;};
    const first=f.bridge.request('turn.send',{threadId:'A'},true),settled=reason==='success'?first:assert.rejects(first),old=f.sent[0];
    f.connection.hostId='other';f.connection.activeThreadId='B';f.bridge.rememberCommand('B-command','other','B');
    if(reason==='timeout')[...f.timers.values()].find(t=>t.delay===20000).fn();
    if(reason==='send-fail')failSend({});
    if(reason==='unknown')respond(f,old,{}, {message:'未知',outcomeUnknown:true});
    if(reason==='success')respond(f,old,{});
    await settled;assert.equal(f.bridge.pendingCommand('pc','A'),'');assert.equal(f.connection.pendingCommandId,'B-command');
  }
});

test('断线同时释放所有在途操作，旧格式及损坏记录不再恢复或阻止新操作',async()=>{
  const f=connectedFixture();
  const a=f.bridge.request('turn.send',{threadId:'A'},true),b=f.bridge.request('turn.send',{threadId:'B'},true);
  const rejected=Promise.all([assert.rejects(a),assert.rejects(b)]);f.bridge.disconnect();await rejected;
  assert.equal(f.bridge.hasPendingCommands(),false);assert.equal(f.connection.pendingCommands.length,0);
  for(const saved of ['{损坏',JSON.stringify([{id:'old',hostId:'pc',threadId:'A'}])]){
    const storage=new Map([['codex-mobile-pending-pc','old'],['codex-mobile-pending-v2-pc',saved]]),reopened=mobileFixture(storage);
    reopened.bridge.foreground=false;reopened.bridge.configure(JSON.stringify(reopened.bridge.config));
    assert.equal(reopened.bridge.hasPendingCommands(),false);assert.equal(reopened.connection.configured,true);assert.equal(storage.has('codex-mobile-pending-pc'),false);assert.equal(storage.has('codex-mobile-pending-v2-pc'),false);
    assert.equal(reopened.bridge.pending.size,0);assert.equal(reopened.sockets.length,0);
  }
});

test('旧记录删除失败仍可进入连接，存储不可写不再阻止消息发送',async()=>{
  const f=connectedFixture();f.uni.removeStorageSync=()=>{throw Error('存储不可写');};f.uni.setStorageSync=()=>{throw Error('存储不可写');};
  assert.doesNotThrow(()=>f.bridge.clearLegacyCommands('pc'));
  const sending=f.bridge.request('turn.send',{threadId:'thread',text:'消息'},true);respond(f,f.sent[0],{});await sending;
  assert.equal(f.connection.pendingCommandId,'');
});

/** 执行首页实际使用的派生状态，验证连接、空结果与后台刷新的显示边界。 */
function homeLoading(connection,online=true){
  const source=fs.readFileSync(new URL('../apps/mobile/services/thread-list.uts',import.meta.url),'utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
  const context=vm.createContext({connection,bridge:{},watch:()=>{},liveThreadLists:{updates:[]},reactive:value=>value});
  vm.runInContext(stripTypeScriptTypes(source)+';globalThis.subject={threadList,computerThreadsLoading};',context);
  context.subject.threadList.computers=connection.hostId?[{hostId:connection.hostId,online,threads:connection.threads,loading:connection.threadsLoading,loaded:connection.threadsLoadedHostId===connection.hostId,error:connection.error}]:[];
  return context.subject.computerThreadsLoading(connection.hostId);
}

test('首页恢复连接及首次列表请求期间显示加载，空结果返回后才展示暂无会话',async()=>{
  const f=connectedFixture();f.connection.configured=true;f.connection.connected=false;f.connection.status='正在连接';
  assert.equal(homeLoading(f.connection),true);
  f.connection.connected=true;f.connection.status='已连接';f.bridge.refreshThreads();
  assert.equal(f.connection.threadsLoading,true);assert.equal(homeLoading(f.connection),true);
  respond(f,f.sent[0],{threads:[]});await Promise.resolve();
  assert.equal(f.connection.threadsLoading,false);assert.equal(f.connection.threadsLoadedHostId,'pc');assert.equal(homeLoading(f.connection),false);
  f.bridge.refreshThreads();assert.equal(f.connection.threadsLoading,true);assert.equal(homeLoading(f.connection),false);
  respond(f,f.sent[1],{threads:[]});await Promise.resolve();
});

test('首页加载失败结束旋转，重新读取成功后显示列表，后台刷新保留已有内容',async()=>{
  const f=connectedFixture();f.connection.configured=true;f.bridge.refreshThreads();
  respond(f,f.sent[0],{},{message:'读取超时，请重试'});await Promise.resolve();
  assert.equal(f.connection.threadsLoading,false);assert.equal(f.connection.threadsLoadedHostId,'');assert.equal(homeLoading(f.connection),false);assert.match(f.connection.error,/读取超时/);
  f.connection.error='';f.bridge.refreshThreads();assert.equal(homeLoading(f.connection),true);
  respond(f,f.sent[1],{threads:[{id:'thread'}]});await Promise.resolve();
  assert.equal(homeLoading(f.connection),false);assert.equal(f.connection.threads[0].id,'thread');
  f.bridge.refreshThreads();assert.equal(homeLoading(f.connection),false);assert.equal(f.connection.threads[0].id,'thread');
  respond(f,f.sent[2],{threads:[{id:'thread'}]});await Promise.resolve();
});

test('切换电脑再切回时，旧列表响应不会结束最新请求的加载状态',async()=>{
  const f=connectedFixture();f.bridge.refreshThreads();
  f.connection.hostId='other';f.bridge.refreshThreads();f.connection.hostId='pc';f.bridge.refreshThreads();
  respond(f,f.sent[0],{threads:[{id:'old'}]});respond(f,f.sent[1],{},{message:'其他电脑旧错误'});await Promise.resolve();
  assert.equal(f.connection.threadsLoading,true);assert.equal(f.connection.threads.length,0);assert.equal(f.connection.error,'');
  respond(f,f.sent[2],{threads:[{id:'new'}]});await Promise.resolve();
  assert.equal(f.connection.threadsLoading,false);assert.equal(f.connection.threads[0].id,'new');assert.equal(f.connection.threadsLoadedHostId,'pc');
});

test('断开旧连接后开始新列表请求，旧请求拒绝不会清除新加载或写入错误',async()=>{
  const f=connectedFixture();f.bridge.socket.close=()=>{};f.bridge.refreshThreads();f.bridge.disconnect();
  assert.equal(f.connection.threadsLoading,false);assert.equal(f.bridge.listingHost,'');
  f.connection.connected=true;f.bridge.socket={send(options){f.sent.push(JSON.parse(options.data));}};f.bridge.refreshThreads();await Promise.resolve();
  assert.equal(f.connection.threadsLoading,true);assert.equal(f.connection.error,'');
  respond(f,f.sent[1],{threads:[]});await Promise.resolve();assert.equal(f.connection.threadsLoading,false);
});

test('未配置、离线或连接失败不显示首次加载，重新导入会重置空结果标记',()=>{
  const f=mobileFixture();assert.equal(homeLoading(f.connection),false);
  f.connection.configured=true;f.connection.status='网络不可用';assert.equal(homeLoading(f.connection,false),false);
  f.connection.status='正在连接';f.connection.error='配置已失效';assert.equal(homeLoading(f.connection),false);
  f.bridge.foreground=false;f.connection.threadsLoadedHostId='pc';f.bridge.configure(JSON.stringify(f.bridge.config));assert.equal(f.connection.threadsLoadedHostId,'');
});

test('跨电脑只读列表请求保留执行电脑与待核对编号，并拒绝未授权电脑',async()=>{
  const f=connectedFixture();f.connection.computers=[{id:'pc',online:true},{id:'other',online:true}];f.connection.pendingCommandId='pending';
  const read=f.bridge.readComputerThreads('other');assert.equal(f.sent[0].hostId,'other');assert.equal(f.sent[0].method,'threads.watch');assert.equal(f.connection.hostId,'pc');assert.equal(f.connection.pendingCommandId,'pending');
  respond(f,f.sent[0],{threads:[]});await read;await assert.rejects(f.bridge.readComputerThreads('forbidden'),/授权范围/);assert.equal(f.sent.length,1);
});
