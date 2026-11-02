import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';import {EventEmitter} from 'node:events';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';import {openDesktopThread} from '../apps/bridge/desktop-launcher.mjs';import {withDesktopUi} from '../apps/bridge/desktop-ui-coordinator.mjs';import {normalizeConversation} from '../apps/bridge/conversation.mjs';import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
const plain=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(resolve=>setImmediate(resolve));
/** 模拟桌面独立维护的未读状态；订阅不标记已读，只有原桌面导航处理改变标记。 */
class Client extends EventEmitter {
 socket={writable:true};states=new Map(ids.map(id=>[id,{id,title:id,hasUnreadTurn:true,turns:[],requests:[],threadRuntimeStatus:{type:'idle',activeFlags:[]}}]));
 async connect(){} async findOwner(_id,host){return host==='local'?{clientId:'desktop',hostId:host}:null;}
 publish(id){queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{conversationId:id,hostId:'local',change:{type:'snapshot',revision:1,conversationState:structuredClone(this.states.get(id))}}}));}
 broadcast(method,params){if(params.following)this.publish(params.conversationId);}
 async request(){throw new Error('不得发送任务或已读写请求');}close(){}
}
function fixture(t,activateThread=async()=>{}){const client=new Client(),adapter=new DesktopAdapter({client,index:{list:()=>ids.map(id=>({id,title:id})),containsThread:id=>ids.includes(id)},activateThread});t.after(()=>adapter.close());return {client,adapter};}

test('保留桌面未读和等待标记，增量由真改假，旧数据缺失字段保持未知',()=>{
 const state={id:'thread',hasUnreadTurn:true,threadRuntimeStatus:{type:'active',activeFlags:['waitingOnUserInput','unsupported']},turns:[],requests:[]},snapshot=normalizeConversation(state);assert.equal(snapshot.hasUnreadTurn,true);assert.deepEqual(snapshot.activeFlags,['waitingOnUserInput']);
 const next=normalizeConversation({...state,hasUnreadTurn:false}),event=conversationUpdate({snapshot,seq:1},next),updated=applyConversationUpdate({snapshot,seq:1},event,2).snapshot;assert.equal(updated.hasUnreadTurn,false);assert.deepEqual(updated.activeFlags,['waitingOnUserInput']);
 const old=normalizeConversation({id:'thread',turns:[]});assert.equal(old.hasUnreadTurn,undefined);assert.equal(old.activeFlags,undefined);
});

test('手机状态优先区分待输入、待审批、运行、未读、离线，不把异步待答误判成阻塞',()=>{
 const source=fs.readFileSync('apps/mobile/services/bridge.uts','utf8'),methods=source.slice(source.indexOf('export function taskState('),source.indexOf('\ntype TextAppend'));const context=vm.createContext({});vm.runInContext(stripTypeScriptTypes(methods.replaceAll('export ',''))+'\nglobalThis.f={taskState,threadIndicator,conversationTaskState}',context);const f=context.f;
 assert.equal(f.taskState('active','turn',0,0,true,['waitingOnUserInput']),'question');assert.equal(f.taskState('active','turn',0,0,true,['waitingOnApproval']),'approval');assert.equal(f.threadIndicator('running',true),'running');assert.equal(f.threadIndicator('question',true),'question');assert.equal(f.threadIndicator('idle',true),'unread');assert.equal(f.threadIndicator('idle',false),'idle');assert.equal(f.threadIndicator('unknown',null),'unknown');assert.equal(f.threadIndicator('offline',true),'offline');
 assert.equal(f.conversationTaskState({status:'active',activeTurnId:'turn',questionGroups:[{kind:'async',state:'pending'}],approvals:[]},true),'running');
});

test('列表轮询和后台订阅不导航或清蓝点，显式点击已加载会话每次都导航',async t=>{
 let opens=0;const f=fixture(t,async id=>{opens++;f.client.states.get(id).hasUnreadTurn=false;});
 const initial=await f.adapter.list({});assert.equal(opens,0);assert.equal(initial[0].hasUnreadTurn,true);await f.adapter.watch(ids[0],'phone');assert.equal(opens,0);
 const opened=await f.adapter.watch(ids[0],'phone',{activate:true});assert.equal(opens,1);assert.equal(opened.hasUnreadTurn,false);await f.adapter.watch(ids[0],'phone',{activate:true});assert.equal(opens,2);
});

test('请求导航成功不等于已读，桌面回读清除蓝点后待输入状态仍保留',async t=>{
 const f=fixture(t);f.client.states.get(ids[0]).threadRuntimeStatus={type:'active',activeFlags:['waitingOnUserInput']};const opened=await f.adapter.watch(ids[0],'phone',{activate:true});assert.equal(opened.hasUnreadTurn,true);assert.deepEqual(opened.activeFlags,['waitingOnUserInput']);
 const received=new Promise(resolve=>f.adapter.once('conversation',resolve));f.client.states.get(ids[0]).hasUnreadTurn=false;f.client.publish(ids[0]);const next=await received;assert.equal(next.hasUnreadTurn,false);assert.deepEqual(next.activeFlags,['waitingOnUserInput']);
});

test('原生导航队列执行前检查最新意图，快速切换不执行旧目标',async t=>{
 let release;const blocked=withDesktopUi(()=>new Promise(resolve=>release=resolve));await tick();const calls=[];
 const nativeApi={navigate:async id=>calls.push(id)};
 const f=fixture(t,(id,options)=>openDesktopThread(id,{...options,platform:'win32',nativeApi}));const first=f.adapter.watch(ids[0],'phone',{activate:true});const rejected=assert.rejects(first,error=>error.code==='SUBSCRIPTION_CANCELED');await tick();const second=f.adapter.watch(ids[1],'phone',{activate:true});await tick();release();await blocked;await rejected;await second;assert.deepEqual(calls,[ids[1]]);
});

test('导航失败不修改未读或伪装已读，也不执行桌面任务',async t=>{
 const f=fixture(t,async()=>{throw new Error('模拟导航失败');});await assert.rejects(f.adapter.watch(ids[0],'phone',{activate:true}),/模拟导航失败/);assert.equal(f.client.states.get(ids[0]).hasUnreadTurn,true);assert.equal((await f.adapter.watch(ids[0],'phone')).hasUnreadTurn,true);
});

function mobile(){const sent=[],context=vm.createContext({reactive:value=>value,uni:{getStorageSync:()=>'',setStorageSync(){},removeStorageSync(){}},setTimeout,clearTimeout});let source=fs.readFileSync('apps/mobile/services/bridge.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.f={MobileBridge,connection}',context);const {MobileBridge,connection}=context.f,bridge=new MobileBridge();Object.assign(connection,{connected:true,configured:true,hostId:'pc',computers:[{id:'pc',online:true}]});bridge.request=(method,params)=>{if(method==='thread.unwatch'){sent.push({method,params});return Promise.resolve({});}return new Promise((resolve,reject)=>sent.push({method,params,resolve,reject}));};return {bridge,connection,sent};}
const result=(id,unread=true)=>({desktopActivated:true,epoch:'epoch',seq:1,snapshot:{threadId:id,hasUnreadTurn:unread,activeFlags:['waitingOnUserInput'],status:'active',activeTurnId:'turn'},getString(key){return this[key]??null;},getNumber(key){return this[key]??null;}});

test('手机明确打开只发一次导航，页面订阅不重复；回执保留真实蓝点和等待标记',async()=>{
 const f=mobile(),promise=f.bridge.openThread(ids[0]);f.bridge.watch(ids[0]);assert.equal(f.sent.length,1);assert.equal(f.sent[0].params.activate,true);f.sent[0].resolve(result(ids[0]));await promise;assert.equal(f.connection.snapshot.hasUnreadTurn,true);assert.deepEqual(plain(f.connection.snapshot.activeFlags),['waitingOnUserInput']);
 f.bridge.watch(ids[0]);assert.equal(f.sent[1].params.activate,undefined);f.sent[1].resolve(result(ids[0],false));await tick();assert.equal(f.connection.snapshot.hasUnreadTurn,false);
});

test('快速切换忽略旧响应，离页取消后刷新只读，电脑切换不会驱动手机跳页',async()=>{
 const f=mobile(),first=f.bridge.openThread(ids[0]),old=assert.rejects(first,/忽略旧/);const second=f.bridge.openThread(ids[1]);const reads=f.sent.filter(item=>item.method==='thread.watch');reads[0].resolve(result(ids[0]));reads[1].resolve(result(ids[1]));await old;await second;assert.equal(f.connection.snapshot.threadId,ids[1]);
 f.bridge.cancelOpen(ids[1]);assert.equal(f.connection.snapshot,null);assert.equal(f.connection.activeThreadId,'');f.bridge.watch(ids[1]);assert.equal(f.sent.at(-1).params.activate,undefined);f.sent.at(-1).resolve(result(ids[1]));await tick();assert.equal(f.connection.activeThreadId,ids[1]);
});

test('手机导航失败继续读取原内容并保留重试入口，旧桥接不能伪装切换成功',async()=>{
 const f=mobile();const open=f.bridge.openThread(ids[0]),rejected=assert.rejects(open,/更新电脑连接服务/);f.sent[0].resolve({...result(ids[0]),desktopActivated:undefined});await rejected;assert.match(f.connection.desktopNavigationError,/更新/);assert.equal(f.sent[1].params.activate,undefined);f.sent[1].resolve(result(ids[0]));await tick();assert.equal(f.connection.snapshot.hasUnreadTurn,true);assert.match(f.connection.desktopNavigationError,/更新/);
});

test('会话同步错误只归当前会话，退出清除且忽略迟到错误', async () => {
 const f=mobile();f.connection.error='连接错误';f.bridge.watch('thread');
 f.sent.at(-1).reject(new Error('会话读取失败'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.connection.conversationError,'会话读取失败');assert.equal(f.connection.error,'连接错误');
 f.bridge.watch('thread');const pending=f.sent.at(-1);f.bridge.cancelOpen('thread');
 pending.reject(new Error('迟到失败'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.connection.conversationError,'');assert.equal(f.connection.error,'连接错误');
});
