import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {stripTypeScriptTypes} from 'node:module';
import {recentConversationPage,CONVERSATION_PAGE_SIZE,CONVERSATION_PAGE_BYTES,RECENT_CONVERSATION_OPTIONS} from '../apps/bridge/conversation-page.mjs';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';
import {BridgeAgent} from '../apps/bridge/agent.mjs';
import {Journal} from '../apps/bridge/journal.mjs';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {NativeDesktop} from '../apps/bridge/native-desktop.mjs';
import {READ_METHODS,WRITE_METHODS,validateRequest} from '../packages/protocol/contracts.mjs';

const id='00000000-0000-4000-8000-000000000001';
const message=(index,text='合成消息')=>({id:'message-'+index,role:'assistant',text,turnId:'turn',status:'completed'});
const snapshot=messages=>({threadId:id,title:'合成分页聊天',cwd:'/synthetic/page',messages,turns:[{turnId:'turn',status:'completed'}],latestTurn:{turnId:'turn',status:'completed'},approvals:[],questionGroups:[],status:'idle',activeTurnId:'',updatedAt:1});

test('首屏按条数和实际 UTF-8 字节取连续后缀，单条超长正文不丢失',()=>{
  const source=snapshot(Array.from({length:90},(_,i)=>message(i)));
  assert.deepEqual(recentConversationPage(source).messages.map(m=>m.id),source.messages.slice(-20).map(m=>m.id));
  const large=snapshot(Array.from({length:30},(_,i)=>message(i,'中文'.repeat(2000))));
  const page=recentConversationPage(large);
  assert.ok(page.messages.length<20);assert.ok(Buffer.byteLength(JSON.stringify(page.messages))<=CONVERSATION_PAGE_BYTES);
  assert.deepEqual(page.messages.map(m=>m.id),large.messages.slice(-page.messages.length).map(m=>m.id));
  const giant=message(1,'正文'.repeat(20000));assert.deepEqual(recentConversationPage(snapshot([message(0),giant])).messages,[giant]);
  assert.equal(source.messages.length,90);
});

test('最近窗口从原始连续尾部取消息，不因保留早期对话产生分页缺口',()=>{
  const state={id,turns:[{turnId:'turn',status:'completed',items:Array.from({length:100},(_,i)=>({id:'item-'+i,type:i%10===0?'userMessage':'commandExecution',content:'合成提问',command:'合成校验',output:'合成结果'}))}]};
  const page=normalizeConversation(state,RECENT_CONVERSATION_OPTIONS);
  assert.deepEqual(page.messages.map(m=>m.id),Array.from({length:20},(_,i)=>'item-'+(80+i)));
});

test('首帧、订阅回执和后续推送都保持一页，不自动补回全部正文',async t=>{
  const adapter=new EventEmitter();adapter.index={list:()=>[],containsThread:()=>true};adapter.conversations=new Map();adapter.threadMentions={available:async()=>false,close(){}};
  const journal=new Journal(),agent=new BridgeAgent({adapter,journal,config:{}}),sent=[];agent.send=value=>{sent.push(value);return true;};
  t.after(()=>{agent.threadCache.close();agent.threadListFeed.close();agent.predictions.close();agent.nativeDrafts.close();journal.close();});
  const source=snapshot(Array.from({length:100},(_,i)=>message(i)));
  let finish;adapter.watch=()=>new Promise(resolve=>{finish=resolve;});
  agent.threadCache.preview=async()=>({snapshot:{...source,readOnly:true},contentRevision:'content:'+'a'.repeat(64)});
  const pending=agent.handleRequest({v:1,type:'request',requestId:'synthetic-paged-request',transportId:'synthetic-paged-transport',deviceId:'phone',method:'thread.watch',params:{threadId:id,previewId:'synthetic-preview-page'}});
  await new Promise(setImmediate);assert.equal(sent[0].snapshot.messages.length,20);finish(source);
  const response=await pending;assert.equal(response.error,undefined);assert.ok(!response.result.snapshot.messages||response.result.snapshot.messages.length<=20);assert.equal(agent.published.get(id).snapshot.messages.length,20);
  agent.publish(snapshot([...source.messages,message(100)]));assert.equal(agent.published.get(id).snapshot.messages.length,20);assert.equal(agent.published.get(id).snapshot.messages[0].id,'message-81');
});

/** 从真实 UTS 导出分页合并方法，不复制手机端算法。 */
function historyApi(){const c=vm.createContext({});const source=fs.readFileSync('apps/mobile/services/history.uts','utf8').replace(/^import .*\r?\n/gm,'').replaceAll('export ','');vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.api={retainHistoryWindow,conversationWithHistory};',c);return c.api;}
test('已加载历史与滚动实时窗口衔接，不漏边界消息，不复活中间移除的消息',()=>{
  const api=historyApi(),previous=snapshot([message(1),message(2),message(3)]),current=snapshot([message(2),message(3),message(4)]);
  const retained=api.retainHistoryWindow(null,previous,current);assert.deepEqual(Array.from(api.conversationWithHistory(current,retained).messages,m=>m.id),['message-1','message-2','message-3','message-4']);
  const removed=api.retainHistoryWindow(null,previous,snapshot([message(1),message(3)]));assert.equal(removed,null);
  const older={messages:[message(0)],turns:[],cursor:'older-page',hasMore:true};const next=api.retainHistoryWindow(older,previous,current);assert.equal(next.cursor,'older-page');assert.deepEqual(Array.from(next.messages,m=>m.id),['message-0','message-1']);
});

test('已读确认独立于导航、执行队列与实时所有者，历史浏览也可清除未读',async t=>{
  const calls=[],native=new NativeDesktop({platform:'win32',invoke:async(tool,args)=>{calls.push(tool);return {threadId:args.threadId,hostId:'local',read:true};}}),client=new EventEmitter();client.close=()=>{};
  const adapter=new DesktopAdapter({client,native});adapter.conversations.set(id,{watchers:new Set(['phone']),owner:null,state:null,waiters:[]});t.after(()=>adapter.close());
  assert.equal(READ_METHODS.has('thread.read'),true);assert.equal(WRITE_METHODS.has('thread.read'),false);
  assert.doesNotThrow(()=>validateRequest({v:1,type:'request',requestId:'synthetic-read-request',method:'thread.read',params:{threadId:id}}));
  assert.throws(()=>validateRequest({v:1,type:'request',requestId:'synthetic-read-request',method:'thread.read',params:{threadId:id,activate:true}}));
  await assert.rejects(adapter.markRead(id,'other'),{code:'SUBSCRIPTION_REQUIRED'});assert.equal(calls.length,0);
  native.unread.set(id,true);assert.deepEqual(await adapter.markRead(id,'phone'),{threadId:id,read:true});assert.deepEqual(calls,['set_thread_read_state']);assert.equal(native.unread.get(id),false);
});

test('独立已读失败或确认期间切换会话时，不提前清除未读',async t=>{
  const n=new NativeDesktop({platform:'win32',invoke:async()=>({threadId:id,hostId:'local',read:false})});t.after(()=>n.close());n.unread.set(id,true);
  await assert.rejects(n.markRead(id),{code:'BAD_NATIVE_RESPONSE'});assert.equal(n.unread.get(id),true);
  let current=true;n.invokeOverride=async()=>{current=false;return {threadId:id,hostId:'local',read:true};};await assert.rejects(n.markRead(id,()=>current),{code:'SUBSCRIPTION_CANCELED'});assert.equal(n.unread.get(id),true);
});

/** 执行真实详情确认方法，控制下一帧及异步回执，检查页面可见性边界。 */
function visibleReadFixture(){
  const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8'),start=source.indexOf('let readRequestKey ='),end=source.indexOf('watch((): string => [pageVisible.value',start);
  const snapshot={...globalThis.structuredClone({threadId:id,hasUnreadTurn:true,supportsReadState:true,readOnly:true}),latestTurn:{turnId:'turn'}},requests=[],ticks=[];
  const c=vm.createContext({current:true,pageVisible:{value:true},pageHostId:{value:'host'},pageThreadId:{value:id},subscriptionReady:{value:true},liveConversation:{value:snapshot},displayConversation:{value:snapshot},operationError:{value:''},connection:{subscriptionRevision:1,snapshot},isCurrentPage:()=>c.current,nextTick:fn=>ticks.push(fn),bridge:{request:(method,params)=>new Promise((resolve,reject)=>requests.push({method,params,resolve,reject}))}});
  vm.runInContext(stripTypeScriptTypes(source.slice(start,end),{mode:'transform'})+';globalThis.confirm=confirmVisibleRead;',c);
  return {c,snapshot,requests,confirm:c.confirm,flush:()=>ticks.splice(0).forEach(fn=>fn()),result:{getString:key=>key==='threadId'?id:'',getBoolean:()=>true}};
}
test('手机只在正文可见且订阅确认后标记已读，后台页面与旧回执不会改写新目标',async()=>{
  const f=visibleReadFixture();f.c.pageVisible.value=false;f.confirm();f.flush();assert.equal(f.requests.length,0);
  f.c.pageVisible.value=true;f.c.subscriptionReady.value=false;f.confirm();f.flush();assert.equal(f.requests.length,0);
  f.c.subscriptionReady.value=true;f.confirm();f.confirm();assert.equal(f.requests.length,0);f.flush();assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'thread.read');
  f.c.current=false;f.requests[0].resolve(f.result);await new Promise(setImmediate);assert.equal(f.snapshot.hasUnreadTurn,true);
});
test('已读后出现新的未读结果可再次确认；首屏挂载前切到后台则取消本次请求',async()=>{
  const f=visibleReadFixture();f.confirm();f.c.pageVisible.value=false;f.confirm();f.flush();assert.equal(f.requests.length,0);
  f.c.pageVisible.value=true;f.confirm();f.flush();assert.equal(f.requests.length,1);f.requests[0].resolve(f.result);await new Promise(setImmediate);assert.equal(f.snapshot.hasUnreadTurn,false);
  f.confirm();f.snapshot.hasUnreadTurn=true;f.confirm();f.flush();assert.equal(f.requests.length,2);
});
