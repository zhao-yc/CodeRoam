import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';import {Journal} from '../apps/bridge/journal.mjs';import {BridgeAgent} from '../apps/bridge/agent.mjs';import {validateRequest} from '../packages/protocol/contracts.mjs';import {normalizeConversation} from '../apps/bridge/conversation.mjs';import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';

const models=[{id:'model',efforts:['high'],speeds:[{id:'priority'}]}];
/** 所有模式变更仅写模拟桌面的下一轮设置，正在执行的轮次独立保存启动模式。 */
class Desktop extends EventEmitter {
 constructor(){super();this.socket={writable:true};this.calls=[];this.started=[];this.state={id:'thread',cwd:'C:/project',latestModel:'model',latestReasoningEffort:'high',latestThreadSettings:{model:'model',effort:'high',serviceTier:'priority',collaborationMode:{mode:'plan',settings:{model:'model',reasoning_effort:'high'}}},requests:[],turns:[]};}
 async connect(){} async findOwner(_id,hostId){return hostId==='local'?{clientId:'desktop',hostId}:null;}
 publish(){queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{conversationId:'thread',hostId:'local',change:{type:'snapshot',revision:1,conversationState:structuredClone(this.state)}}}));}
 broadcast(method,params){if(params.following)this.publish();}
 async request(method,params){this.calls.push({method,params});
  if(method==='thread-follower-read-model-settings')return {resultType:'success',result:{settings:{model:'model',reasoningEffort:'high',modelProvider:'openai'}}};
  if(method==='thread-follower-update-thread-settings'){
   if(this.rejectReset&&params.threadSettings.collaborationMode.mode==='default')return {resultType:'success',result:{applied:false}};
   if(this.holdReset&&params.threadSettings.collaborationMode.mode==='default')await new Promise(resolve=>this.releaseReset=resolve);
   this.state.latestThreadSettings=params.threadSettings;this.publish();return {resultType:'success',result:{applied:true}};
  }
  if(['thread-follower-start-turn','thread-follower-steer-turn'].includes(method)){
   if(this.failSend)throw new Error(this.failSend);
   if(method==='thread-follower-start-turn')this.started.push(this.state.latestThreadSettings.collaborationMode.mode);
   return {resultType:'success',result:{ok:true}};
  }
  return {resultType:'success',result:{ok:true}};
 }
 close(){}
}
function fixture(t){const client=new Desktop(),adapter=new DesktopAdapter({client,modelCatalog:{read:()=>models},attachments:{materialize:()=>[]}}),journal=new Journal(),agent=new BridgeAgent({config:{},adapter,journal});t.after(()=>agent.close());return {client,adapter,journal,agent};}
const request=(id,method='turn.send',params={})=>({v:1,type:'request',deviceId:'phone',requestId:'plan-once-request-'+id,method,params:{threadId:'thread',text:'测试消息',resetPlanAfterSend:true,planMode:'plan',...params}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('一次性计划在消息成功后恢复普通模式，下一轮按默认发送，重复请求不重发或重置',async t=>{
 const f=fixture(t),message=request('first'),first=await f.agent.handleRequest(message);assert.equal(first.error,undefined);assert.equal(first.result.planReset,true);assert.equal(first.result.messageAccepted,true);assert.deepEqual(f.client.started,['plan']);assert.equal(f.client.state.latestThreadSettings.collaborationMode.mode,'default');assert.equal(first.result.nextSettings.model,'model');assert.equal(first.result.nextSettings.effort,'high');assert.equal(first.result.nextSettings.serviceTier,'priority');
 const count=f.client.calls.length;assert.deepEqual(await f.agent.handleRequest(message),first);assert.equal(f.client.calls.length,count);
 f.client.state.latestThreadSettings.collaborationMode.mode='plan'; // 模拟迟到快照或电脑重新设置，手机的默认意图仍必须落实。
 const next=await f.agent.handleRequest(request('next','turn.send',{planMode:'default'}));assert.equal(next.result.planReset,true);assert.deepEqual(f.client.started,['plan','default']);
});

test('追加成功也清除下一轮计划，但正在执行的轮次仍保留原模式',async t=>{
 const f=fixture(t);f.client.state.turns=[{turnId:'active',status:'inProgress',params:{mode:'plan'},items:[]}];
 const result=await f.agent.handleRequest(request('steer','turn.steer',{expectedTurnId:'active'}));assert.equal(result.result.planReset,true);assert.equal(f.client.state.turns[0].params.mode,'plan');assert.equal(f.client.state.latestThreadSettings.collaborationMode.mode,'default');assert.equal(f.client.started.length,0);
});

test('发送失败或超时不执行事后恢复，旧手机发送保持兼容',async t=>{
 const f=fixture(t);f.client.failSend='发送超时';const result=await f.agent.handleRequest(request('timeout'));assert.equal(result.error.code,'OUTCOME_UNKNOWN');assert.equal(f.client.calls.some(call=>call.method==='thread-follower-update-thread-settings'),false);
 // 合成桌面确认原发送没有开始后，显式跳过未知任务并恢复实例，绝不自动重发。
 assert.equal(f.client.started.length,0);await f.agent.taskQueue.control('phone',{taskId:request('timeout').requestId,action:'skip',confirmed:true});
 f.client.failSend='';const old=request('old');delete old.params.resetPlanAfterSend;delete old.params.planMode;const response=await f.agent.handleRequest(old);assert.equal(response.result.messageAccepted,undefined);assert.equal(f.client.state.latestThreadSettings.collaborationMode.mode,'plan');
});

test('模式恢复失败仍返回消息已发送，重试只修改设置且不再次发送正文',async t=>{
 const f=fixture(t);f.client.rejectReset=true;const message=request('reset-failed'),result=await f.agent.handleRequest(message);assert.equal(result.error,undefined);assert.equal(result.result.messageAccepted,true);assert.equal(result.result.planReset,false);assert.match(result.result.planResetError,/消息已发送/);assert.equal(f.journal.status('phone',message.requestId).state,'done');assert.deepEqual(await f.agent.handleRequest(message),result);assert.equal(f.client.started.length,1);
 f.client.rejectReset=false;await f.adapter.operate('thread.settings.update',{threadId:'thread',changes:{mode:'default'}},'retry','phone');assert.equal(f.client.started.length,1);assert.equal(f.client.state.latestThreadSettings.collaborationMode.mode,'default');
});

test('发送接收后立即保存独立回执，恢复模式尚未完成时也有可核对依据',async t=>{
 const f=fixture(t);f.client.holdReset=true;const message=request('checkpoint'),operation=f.agent.handleRequest(message);
 for(let attempt=0;attempt<50&&!f.client.releaseReset;attempt++)await tick();
 const pending=f.journal.status('phone',message.requestId);assert.equal(pending.state,'pending');assert.equal(pending.result.messageAccepted,true);assert.equal(pending.result.planReset,false);f.client.releaseReset();await operation;
});

test('协议限制一次性标记和本次模式，快照增量保留能力',()=>{
 const good=request('validation');assert.doesNotThrow(()=>validateRequest(good));for(const params of [{planMode:'other'},{resetPlanAfterSend:'true'},{planMode:null},{resetPlanAfterSend:true,planMode:undefined}])assert.throws(()=>validateRequest({...good,params:{...good.params,...params}}));assert.throws(()=>validateRequest({...good,method:'turn.stop'}));
 const snapshot=normalizeConversation({id:'thread',turns:[]}),first={snapshot:{...snapshot,supportsPlanReset:false},seq:1},update=conversationUpdate(first,snapshot);assert.equal(applyConversationUpdate(first,update,2).snapshot.supportsPlanReset,true);
});

/** 使用原生计划项验证确认内容、模式和重复提交。 */
function planRequest(id,action='implement',text='修改建议'){return {v:1,type:'request',deviceId:'phone',requestId:'plan-confirm-request-'+id,method:'turn.send',params:{threadId:'thread',planId:'plan-item',planAction:action,text}};}
function addPlan(f){f.client.state.turns=[{turnId:'planned',status:'completed',items:[{id:'plan-item',type:'planImplementation',turnId:'planned',planContent:'# 合成计划\n完成测试功能',isCompleted:false}]}];}
test('计划确认发送桌面完整正文并切换普通模式，重复请求不重复执行',async t=>{
 const f=fixture(t);addPlan(f);const message=planRequest('implement');const first=await f.agent.handleRequest(message);assert.equal(first.error,undefined);assert.deepEqual(f.client.started,['default']);
 const send=f.client.calls.find(c=>c.method==='thread-follower-start-turn');assert.equal(send.params.turnStart.request.input[0].text,'PLEASE IMPLEMENT THIS PLAN:\n# 合成计划\n完成测试功能');
 const count=f.client.calls.length;assert.deepEqual(await f.agent.handleRequest(message),first);assert.equal(f.client.calls.length,count);
});
test('修改意见保持计划模式，过期计划不会发送',async t=>{
 const f=fixture(t);addPlan(f);const feedback=await f.agent.handleRequest(planRequest('feedback','feedback'));assert.equal(feedback.error,undefined);assert.deepEqual(f.client.started,['plan']);
 f.client.state.turns[0].items[0].isCompleted=true;const stale=await f.agent.handleRequest(planRequest('stale'));assert.equal(stale.error.code,'STALE_PLAN');assert.equal(f.client.started.length,1);
});
test('计划正文正常展示，执行中及已处理计划不再显示确认',()=>{
 const raw={id:'thread',turns:[{turnId:'planned',status:'completed',items:[{id:'plan',type:'planImplementation',planContent:'合成计划',isCompleted:false}]}]};
 const snapshot=normalizeConversation(raw);assert.equal(snapshot.messages[0].role,'assistant');assert.equal(snapshot.pendingPlan.text,'合成计划');
 raw.turns.push({turnId:'running',status:'inProgress',items:[]});assert.equal(normalizeConversation(raw).pendingPlan,null);raw.turns.pop();raw.turns[0].items[0].isCompleted=true;assert.equal(normalizeConversation(raw).pendingPlan,null);
});
