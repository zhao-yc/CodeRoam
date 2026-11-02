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
  let source=fs.readFileSync(new URL('../apps/mobile/services/bridge.uts',import.meta.url),'utf8').replace(/^import .* from 'vue'\r?\n/m,'').replace(/\bexport /g,'');
  source=stripTypeScriptTypes(source,{mode:'transform'});vm.runInContext(source+'\nglobalThis.subject={MobileBridge,connection};',context);
  const {MobileBridge,connection}=context.subject,bridge=new MobileBridge();bridge.config={relayUrl:'wss://relay.example/ws',hostId:'pc',token:'s'.repeat(43)};
  return {bridge,connection,timers,sockets,storage,uni};
}

test('导入默认持久保存必要配置，新页面自动恢复并保留待核对编号，不重发写操作',()=>{
  const storage=new Map(),first=mobileFixture(storage);first.bridge.foreground=false;
  const config={relayUrl:'wss://relay.example/ws',hostId:'pc',token:'s'.repeat(43),extra:'不应保存'};
  first.bridge.configure(JSON.stringify(config));
  assert.deepEqual(JSON.parse(storage.get('codex-mobile-connection')),{relayUrl:config.relayUrl,token:config.token,hostId:config.hostId});
  storage.set('codex-mobile-pending-pc','unknown-command');
  const reopened=mobileFixture(storage);reopened.bridge.restore();
  assert.equal(reopened.connection.configured,true);assert.equal(reopened.connection.hostId,'pc');assert.equal(reopened.connection.pendingCommandId,'');assert.equal(reopened.connection.legacyPendingCommandId,'unknown-command');
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
  f.bridge.rememberCommand('pending','pc','thread');assert.throws(()=>f.bridge.forgetConfiguration(),/核对上次操作结果/);assert.equal(f.storage.has('codex-mobile-connection'),true);assert.equal(f.connection.configured,true);
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
  f.bridge.rememberCommand('pending');await assert.rejects(f.bridge.activate('thread'),/先核对上次操作/);assert.equal(f.sent.length,2);
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

test('存在待核对操作时，发送、追加、停止和审批均不发送且不覆盖操作编号',async()=>{
  const f=connectedFixture();f.bridge.rememberCommand('unknown-command');
  for(const method of ['turn.send','turn.steer','turn.stop','approval.reply']){
    await assert.rejects(f.bridge.request(method,{threadId:'thread'},true),/请先核对结果/);
    assert.equal(f.connection.pendingCommandId,'unknown-command');
  }
  assert.equal(f.sent.length,0);assert.equal(f.bridge.pending.size,0);assert.equal(f.timers.size,0);
});

test('存在待核对操作时仍可读取会话列表和核对未知结果',async()=>{
  const f=connectedFixture();f.bridge.rememberCommand('unknown-command');
  const status=f.bridge.checkPending();
  assert.equal(f.sent[0].method,'command.status');assert.equal(f.sent[0].params.commandId,'unknown-command');
  respond(f,f.sent[0],{state:'unknown'});assert.equal((await status).state,'unknown');
  assert.equal(f.connection.pendingCommandId,'unknown-command');
  const read=f.bridge.request('threads.list',{});assert.equal(f.sent[1].method,'threads.list');
  respond(f,f.sent[1],{threads:[{id:'thread'}]});assert.equal((await read).threads[0].id,'thread');
  assert.equal(f.connection.pendingCommandId,'unknown-command');assert.equal(f.bridge.pending.size,0);
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

test('写请求尚未结束时不核对账本或解锁，超时后仍可正常核对',async()=>{
  const f=connectedFixture();const write=f.bridge.request('turn.send',{threadId:'thread',text:'继续'},true);
  const commandId=f.connection.pendingCommandId;
  await assert.rejects(f.bridge.checkPending(),/操作仍在提交，请稍后核对/);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].method,'turn.send');assert.equal(f.connection.pendingCommandId,commandId);assert.equal(f.bridge.pending.has(commandId),true);
  [...f.timers.values()].find(timer=>timer.delay===20000).fn();await assert.rejects(write,/操作响应超时/);
  assert.equal(f.bridge.pending.has(commandId),false);
  const status=f.bridge.checkPending();assert.equal(f.sent[1].method,'command.status');assert.equal(f.sent[1].params.commandId,commandId);
  respond(f,f.sent[1],{state:'not_found'});await status;assert.equal(f.connection.pendingCommandId,'');
});

test('核对期间待核对编号变化时，旧操作的完成响应不清除新编号',async()=>{
  const f=connectedFixture();f.bridge.rememberCommand('old-command');
  const status=f.bridge.checkPending();f.bridge.clearCommand('old-command');f.bridge.rememberCommand('new-command');
  respond(f,f.sent[0],{state:'done'});await status;
  assert.equal(f.sent[0].params.commandId,'old-command');assert.equal(f.connection.pendingCommandId,'new-command');
});

test('核对期间切换电脑时，即使待核对编号相同也不清除新电脑状态',async()=>{
  const f=connectedFixture();f.bridge.rememberCommand('same-command');
  const status=f.bridge.checkPending();f.connection.hostId='other-pc';f.bridge.rememberCommand('same-command','other-pc','thread');
  respond(f,f.sent[0],{state:'not_found'});await status;
  assert.equal(f.sent[0].hostId,'pc');assert.equal(f.connection.pendingCommandId,'same-command');
});

test('核对电脑和编号均未变化时，完成和未收到响应仍能正常收口',async()=>{
  for(const state of ['done','not_found']){
    const f=connectedFixture();f.bridge.rememberCommand('pending-command');
    const status=f.bridge.checkPending();respond(f,f.sent[0],{state});await status;
    assert.equal(f.connection.pendingCommandId,'');
  }
});

test('A会话未知暂停只锁定A，切到B不显示待核对且B可独立写入',async()=>{
  const f=connectedFixture();f.connection.activeThreadId='A';
  const first=f.bridge.request('thread.goal.update',{threadId:'A',action:'pause',expectedRevision:'v'},true);
  const command=f.sent[0];respond(f,command,{}, {message:'需要核对',outcomeUnknown:true});await assert.rejects(first,/需要核对/);
  assert.equal(f.connection.pendingCommandId,command.requestId);
  f.bridge.watch('B');assert.equal(f.connection.pendingCommandId,'');
  assert.equal(f.bridge.pendingCommand('pc','A'),command.requestId);
  const second=f.bridge.request('turn.send',{threadId:'B',text:'B会话'},true);const b=f.sent.at(-1);
  respond(f,b,{});await second;assert.equal(f.bridge.pendingCommand('pc','A'),command.requestId);
  f.bridge.watch('A');assert.equal(f.connection.pendingCommandId,command.requestId);
  await assert.rejects(f.bridge.request('turn.stop',{threadId:'A'},true),/请先核对结果/);
});

test('切换页面后的超时及断线仍绑定原会话，不能覆盖B的待核对编号',async()=>{
  for(const reason of ['timeout','disconnect','send-fail']) {
    const f=connectedFixture();f.connection.activeThreadId='A';let failSend;
    if(reason==='send-fail')f.bridge.socket.send=options=>{f.sent.push(JSON.parse(options.data));failSend=options.fail;};
    const a=f.bridge.request('turn.send',{threadId:'A'},true),aError=assert.rejects(a);const id=f.sent[0].requestId;
    f.connection.activeThreadId='B';f.bridge.syncPendingCommand();f.bridge.rememberCommand('B-pending-command','pc','B');
    if(reason==='timeout')[...f.timers.values()].find(timer=>timer.delay===20000).fn();
    if(reason==='disconnect')f.bridge.disconnect();
    if(reason==='send-fail')failSend({});
    await aError;assert.equal(f.connection.pendingCommandId,'B-pending-command');assert.equal(f.bridge.pendingCommand('pc','A'),id);
  }
});

test('核对A期间切到B只清除A，迟到成功或明确失败不会改写B',async()=>{
  for(const outcome of ['check','success','failure']) {
    const f=connectedFixture();f.connection.activeThreadId='A';let promise,request;
    if(outcome==='check'){f.bridge.rememberCommand('A-pending-command');promise=f.bridge.checkPending('A');request=f.sent.at(-1);}
    else {promise=f.bridge.request('turn.send',{threadId:'A'},true);request=f.sent.at(-1);}
    const rejected=outcome==='failure'?assert.rejects(promise):promise;
    f.connection.activeThreadId='B';f.bridge.syncPendingCommand();f.bridge.rememberCommand('B-pending-command');
    respond(f,request,outcome==='check'?{state:'done'}:{},outcome==='failure'?{message:'明确失败'}:null);await rejected;
    assert.equal(f.bridge.pendingCommand('pc','A'),'');assert.equal(f.connection.pendingCommandId,'B-pending-command');
  }
});

test('多个会话待核对记录持久保存，恢复与跨电脑同号会话互不污染且不重发',async()=>{
  const f=connectedFixture();f.bridge.rememberCommand('A-command','pc','A');f.bridge.rememberCommand('B-command','pc','B');
  f.connection.computers=[{id:'pc',online:true},{id:'other',online:true}];f.bridge.selectComputer('other');
  f.connection.activeThreadId='A';f.bridge.rememberCommand('other-A-command');assert.equal(f.connection.pendingCommandId,'other-A-command');
  f.bridge.selectComputer('pc');f.bridge.watch('B');assert.equal(f.connection.pendingCommandId,'B-command');
  const reopened=mobileFixture(f.storage);reopened.bridge.foreground=false;reopened.bridge.configure(JSON.stringify(f.bridge.config));
  assert.equal(reopened.connection.pendingCommandId,'');reopened.connection.activeThreadId='A';reopened.bridge.syncPendingCommand();
  assert.equal(reopened.connection.pendingCommandId,'A-command');assert.equal(reopened.bridge.pendingCommand('pc','B'),'B-command');
  reopened.bridge.restoreCommands('other');assert.equal(reopened.bridge.pendingCommand('other','A'),'other-A-command');assert.equal(reopened.bridge.pending.size,0);
  assert.equal(reopened.sockets.length,0);
});

test('旧版未知编号只在设置保留核对入口，不猜测会话归属，核对完成才清除',async()=>{
  const f=connectedFixture();f.storage.set('codex-mobile-pending-pc','old-command');f.bridge.restoreCommands('pc');
  f.bridge.watch('B');assert.equal(f.connection.pendingCommandId,'');assert.equal(f.connection.legacyPendingCommandId,'old-command');
  let check=f.bridge.checkLegacyPending();respond(f,f.sent.at(-1),{state:'unknown'});await check;
  assert.equal(f.storage.get('codex-mobile-pending-pc'),'old-command');
  check=f.bridge.checkLegacyPending();respond(f,f.sent.at(-1),{state:'done'});await check;
  assert.equal(f.storage.has('codex-mobile-pending-pc'),false);assert.equal(f.connection.legacyPendingCommandId,'');
});

test('返回待核对A可只读同步，切到B仍可主动导航，保存失败不发送写请求',async()=>{
  const f=connectedFixture();f.bridge.rememberCommand('A-command','pc','A');
  f.bridge.watch('A');let request=f.sent.at(-1);assert.equal(request.params.activate,undefined);
  respond(f,request,{snapshot:{threadId:'A'},epoch:'e',seq:1});await Promise.resolve();assert.equal(f.connection.pendingCommandId,'A-command');
  f.bridge.watch('B');request=f.sent.at(-1);respond(f,request,{snapshot:{threadId:'B'},epoch:'e',seq:2});await Promise.resolve();
  const opening=f.bridge.activate('B');request=f.sent.at(-1);assert.equal(request.params.activate,true);
  respond(f,request,{snapshot:{threadId:'B',readOnly:false},epoch:'e',seq:3});await opening;assert.equal(f.connection.pendingCommandId,'');
  f.uni.setStorageSync=()=>{throw new Error('不可写');};const count=f.sent.length;
  await assert.rejects(f.bridge.request('turn.send',{threadId:'B'},true),/操作未发送/);assert.equal(f.sent.length,count);
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
