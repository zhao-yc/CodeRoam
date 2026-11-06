import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { componentContext } from './helpers/component-context.mjs';
import { validateRequest, BridgeError } from '../packages/protocol/contracts.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';

const models = [
  { id: 'model-a', defaultEffort: 'high', efforts: ['low','high'], speeds: [{id:''},{id:'priority'}], supportsImages: true },
  { id: 'model-b', defaultEffort: 'medium', efforts: ['medium'], speeds: [{id:''}], supportsImages: false },
];
/** 使用真实桥接、任务账本和消息队列，只替换原桌面 IPC。 */
class Desktop extends EventEmitter {
  constructor() {
    super(); this.socket={writable:true}; this.calls=[];
    this.state={id:'thread',cwd:'/',turns:[],requests:[],latestModel:'model-a',latestReasoningEffort:'high',latestCollaborationMode:{mode:'default',settings:{model:'model-a',reasoning_effort:'high'}},latestThreadSettings:{model:'model-a',effort:'high',serviceTier:null,permissions:':workspace',approvalPolicy:'on-request',approvalsReviewer:'user'}};
  }
  async connect() {}
  async findOwner(_id,hostId) { return {clientId:'desktop',hostId}; }
  broadcast(_method,params) { if(params.following)this.publish(); }
  publish() { queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{hostId:'local',conversationId:'thread',change:{type:'snapshot',revision:1,conversationState:structuredClone(this.state)}}})); }
  async request(method,params) {
    this.calls.push({method,params});
    if(method==='thread-follower-read-model-settings')return {resultType:'success',result:{settings:{model:this.state.latestModel,reasoningEffort:this.state.latestReasoningEffort,modelProvider:'openai'}}};
    if(method==='thread-follower-update-thread-settings') {
      if(this.unknownPermissions)throw new BridgeError('OUTCOME_UNKNOWN','合成权限结果未知',true);
      if(this.rejectSettings)return {resultType:'success',result:{applied:false}};
      if(this.noApplyPermissions)return {resultType:'success',result:{applied:true}};
      const changes=params.threadSettings;
      Object.assign(this.state.latestThreadSettings,changes);
      if(changes.model!==undefined)this.state.latestModel=changes.model;
      if(changes.effort!==undefined)this.state.latestReasoningEffort=changes.effort;
      if(changes.collaborationMode)this.state.latestCollaborationMode=changes.collaborationMode;
      this.publish();return {resultType:'success',result:{applied:true}};
    }
    if(method==='thread-follower-start-turn'||method==='thread-follower-steer-turn') {
      if(this.rejectSettings)throw new BridgeError('SEND_REJECTED','合成原生发送拒绝');
      const request=params.turnStart?.request??params, next={...this.state.latestThreadSettings};
      for(const key of ['model','effort','serviceTier','permissions','approvalPolicy','approvalsReviewer','collaborationMode'])if(Object.hasOwn(request,key))next[key]=request[key];
      this.sentSettings??=[];this.sentSettings.push(structuredClone(next));
      if(this.unknownSend)throw new BridgeError('OUTCOME_UNKNOWN','合成发送结果未知',true);
    }
    return {resultType:'success',result:{ok:true}};
  }
  running() { this.state.turns=[{turnId:'active',status:'inProgress',items:[]}]; }
  idle() { this.state.turns=[]; }
  close() {}
}
function fixture(t) {
  const client=new Desktop(),journal=new Journal(),adapter=new DesktopAdapter({client,modelCatalog:{read:()=>models},permissionCatalog:{capabilities:async()=>({options:['default','auto-review','read-only','full-access'].map(id=>({id,enabled:true})),reviewer:'auto_review'})}});
  const agent=new BridgeAgent({config:{},adapter,journal});clearInterval(agent.messageQueue.timer);t.after(()=>agent.close());
  const send=(params,id=randomUUID(),method='turn.send')=>agent.handleRequest({v:1,type:'request',requestId:id,deviceId:'phone',method,params:{threadId:'thread',text:'合成消息',...params}});
  return {client,journal,adapter,agent,send};
}

test('消息选项白名单拒绝非法字段、缺少权限版本和未确认完整访问',()=>{
  const request=choices=>({v:1,type:'request',requestId:randomUUID(),method:'turn.send',params:{threadId:'thread',text:'合成',queueAction:'enqueue',choices}});
  for(const value of [null,{},[],{effort:3},{effort:''},{model:'unknown',sandboxPolicy:{}},{permissionMode:'full-access',permissionRevision:'a'.repeat(64)},{permissionMode:'read-only'},{permissionRevision:'a'.repeat(64)},{mode:'other'}])assert.throws(()=>validateRequest(request(value)));
  for(const choices of [{model:'model-a',effort:'high',serviceTier:''},{mode:'plan'},{permissionMode:'full-access',permissionRevision:'a'.repeat(64),confirmedFullAccess:true}])assert.doesNotThrow(()=>validateRequest(request(choices)));
});

test('空闲消息直接在唯一原生发送请求携带模型强度速度模式，不提前修改设置',async t=>{
  const f=fixture(t),id=randomUUID(),result=await f.send({choices:{model:'model-b',effort:'medium',serviceTier:'',mode:'plan'}},id);
  assert.equal(result.error,undefined);assert.equal(f.client.sentSettings.length,1);
  assert.equal(f.client.sentSettings[0].model,'model-b');assert.equal(f.client.sentSettings[0].effort,'medium');assert.equal(f.client.sentSettings[0].collaborationMode.mode,'plan');
  assert.equal(f.client.calls.filter(call=>call.method==='thread-follower-update-thread-settings').length,0);
  assert.equal(f.agent.taskQueue.list('phone',{view:'history'}).tasks.filter(task=>task.method==='thread.settings.update').length,0);
  await f.send({choices:{model:'model-b',effort:'medium',serviceTier:'',mode:'plan'}},id);assert.equal(f.client.sentSettings.length,1);
});

test('原生发送明确失败时不改变 PC 设置，消息任务保留明确失败',async t=>{
  const f=fixture(t);f.client.rejectSettings=true;
  const result=await f.send({choices:{effort:'low'}});
  assert.equal(result.error.code,'SEND_REJECTED');assert.equal(f.client.sentSettings,undefined);assert.equal(f.client.state.latestReasoningEffort,'high');assert.equal(f.client.calls.some(c=>c.method==='thread-follower-update-thread-settings'),false);
});

test('权限冲突在任何设置写入前拒绝，完整访问确认不跨版本复用',async t=>{
  const f=fixture(t),result=await f.send({choices:{effort:'low',permissionMode:'full-access',permissionRevision:'a'.repeat(64),confirmedFullAccess:true}});
  assert.equal(result.error.code,'PERMISSIONS_CHANGED');assert.equal(f.client.calls.some(call=>call.method==='thread-follower-update-thread-settings'),false);assert.equal(f.client.sentSettings,undefined);
});

test('执行设置随正文发送，权限先保存并回读桌面聊天选择',async t=>{
  const f=fixture(t);await f.adapter.watch('thread','phone');const permissions=await f.adapter.readPermissions('thread','phone');
  const result=await f.send({choices:{effort:'low',permissionMode:'read-only',permissionRevision:permissions.revision}});
  assert.equal(result.error,undefined);assert.equal(f.client.sentSettings[0].effort,'low');assert.equal(f.client.sentSettings[0].permissions,':read-only');
  assert.equal(f.client.state.latestThreadSettings.permissions,':read-only');
  assert.equal(f.client.state.latestReasoningEffort,'high');
  assert.equal(f.client.calls.findIndex(call=>call.method==='thread-follower-update-thread-settings') < f.client.calls.findIndex(call=>call.method==='thread-follower-start-turn'),true);
});

test('完整访问发送后保存到聊天，下一次未指定权限的消息沿用所选档位',async t=>{
  const f=fixture(t);await f.adapter.watch('thread','phone');
  const permissions=await f.adapter.readPermissions('thread','phone'), id=randomUUID();
  const params={choices:{permissionMode:'full-access',permissionRevision:permissions.revision,confirmedFullAccess:true}};
  assert.equal((await f.send(params,id)).error,undefined);
  assert.equal((await f.adapter.readPermissions('thread','phone')).mode,'full-access');
  assert.equal(f.client.state.latestThreadSettings.approvalPolicy,'never');
  assert.equal(f.client.state.latestThreadSettings.approvalsReviewer,'user');
  await f.send(params,id);
  assert.equal(f.client.sentSettings.length,1);
  assert.equal((await f.send({})).error,undefined);
  assert.equal(f.client.sentSettings[1].permissions,':danger-full-access');
  assert.equal(f.client.calls.filter(call=>call.method==='thread-follower-update-thread-settings').length,1);
});

for(const failure of ['rejectSettings','unknownPermissions','noApplyPermissions'])test('权限未获桌面确认时不发送正文且不重发权限写入：'+failure,async t=>{
  const f=fixture(t);await f.adapter.watch('thread','phone');
  const permissions=await f.adapter.readPermissions('thread','phone'),id=randomUUID();
  f.client[failure]=true;
  const params={choices:{permissionMode:'full-access',permissionRevision:permissions.revision,confirmedFullAccess:true}};
  const result=await f.send(params,id);
  assert.equal(result.error.code,failure==='rejectSettings'?'PERMISSIONS_REJECTED':'OUTCOME_UNKNOWN');
  assert.equal(f.client.sentSettings,undefined);
  await f.send(params,id);
  assert.equal(f.client.calls.filter(call=>call.method==='thread-follower-update-thread-settings').length,1);
});

test('附件准备阶段失败或桌面权限改变时不应用待发权限',async t=>{
  const f=fixture(t);await f.adapter.watch('thread','phone');
  const permissions=await f.adapter.readPermissions('thread','phone');
  f.adapter.attachments.materialize=()=>{throw new BridgeError('ATTACHMENT_NOT_FOUND','合成附件不存在')};
  const params={choices:{permissionMode:'full-access',permissionRevision:permissions.revision,confirmedFullAccess:true}};
  await assert.rejects(f.adapter.operate('turn.send',{threadId:'thread',text:'合成正文',...params},randomUUID(),'phone'),{code:'ATTACHMENT_NOT_FOUND'});
  f.adapter.attachments.materialize=()=>{f.adapter.conversations.get('thread').state.latestThreadSettings.approvalPolicy='never';return []};
  await assert.rejects(f.adapter.operate('turn.send',{threadId:'thread',text:'合成正文',...params},randomUUID(),'phone'),{code:'PERMISSIONS_CHANGED'});
  assert.equal(f.client.calls.some(call=>call.method==='thread-follower-update-thread-settings'),false);
  assert.equal(f.client.sentSettings,undefined);
});

test('临发送权限能力读取期间更换所有者时拒绝写入',async t=>{
  const f=fixture(t);await f.adapter.watch('thread','phone');
  const permissions=await f.adapter.readPermissions('thread','phone');
  const original=f.adapter.permissionCatalog.capabilities;let reads=0;
  f.adapter.permissionCatalog.capabilities=async()=>{
    const result=await original();
    if(++reads===2)f.adapter.subscribed('thread','phone').owner.clientId='another-desktop';
    return result;
  };
  const result=await f.send({choices:{permissionMode:'full-access',permissionRevision:permissions.revision,confirmedFullAccess:true}});
  assert.equal(result.error.code,'OWNER_UNAVAILABLE');
  assert.equal(f.client.calls.some(call=>call.method==='thread-follower-update-thread-settings'),false);
  assert.equal(f.client.sentSettings,undefined);
});

test('原生请求结果未知时只核对原请求，不重发正文或补写设置',async t=>{
  const f=fixture(t),id=randomUUID();f.client.unknownSend=true;
  const params={choices:{effort:'low'}};
  assert.equal((await f.send(params,id)).error.outcomeUnknown,true);
  await f.send(params,id);await f.agent.readTaskCommandStatus('phone',id,'thread');
  assert.equal(f.client.sentSettings.length,1);assert.equal(f.client.calls.filter(call=>call.method==='thread-follower-update-thread-settings').length,0);
});

test('运行中消息选项入队后保持各自快照，撤回编辑完整恢复',async t=>{
  const f=fixture(t);f.client.running();const choices={effort:'low'};
  const first=await f.send({queueAction:'enqueue',choices});choices.effort='high';
  const second=await f.send({queueAction:'enqueue',choices});
  assert.equal(f.client.sentSettings,undefined);
  const rows=f.agent.messageQueue.rows('thread');assert.equal(JSON.parse(rows[0].payload).choices.effort,'low');assert.equal(JSON.parse(rows[1].payload).choices.effort,'high');
  const edited=await f.send({queueAction:'edit',queueId:first.result.queueId});
  // 操作请求不能夹带正文；改用原白名单入口。
  assert.equal(edited.error.code,'BAD_PARAMS');
  const result=await f.agent.handleRequest({v:1,type:'request',requestId:randomUUID(),deviceId:'phone',method:'turn.send',params:{threadId:'thread',queueAction:'edit',queueId:first.result.queueId}});
  assert.equal(result.result.draft.choices.effort,'low');
  assert.ok(second.result.queueId);
});

test('排队实际发送时才应用原选项，运行中即时设置仍可单独提交',async t=>{
  const f=fixture(t);f.client.running();
  await f.send({queueAction:'enqueue',choices:{effort:'low'}});
  const realtime=await f.send({changes:{effort:'high'}},randomUUID(),'thread.settings.update');
  assert.equal(realtime.error,undefined);assert.equal(f.client.sentSettings,undefined);
  f.client.idle();await f.agent.messageQueue.pump();
  assert.equal(f.client.sentSettings[0].effort,'low');
});

test('运行中追加只直接携带速度，其他待发设置保留给排队新一轮',async t=>{
  const f=fixture(t);f.client.running();
  const result=await f.send({expectedTurnId:'active',choices:{serviceTier:'priority'}},randomUUID(),'turn.steer');
  assert.equal(result.error,undefined);assert.equal(f.client.sentSettings[0].serviceTier,'priority');
  await assert.rejects(f.adapter.operate('turn.steer',{threadId:'thread',text:'合成消息',expectedTurnId:'active',choices:{effort:'low'}},randomUUID(),'phone'),{code:'CHOICES_REQUIRE_QUEUE'});
  const blocked=await f.send({expectedTurnId:'active',choices:{mode:'plan'}},randomUUID(),'turn.steer');
  assert.equal(blocked.error.code,'BAD_SETTINGS');assert.equal(f.client.sentSettings.length,1);
});

test('手机选择隔离、模型兼容、桌面更新及提交版本保护使用真实草稿实现',()=>{
  const c=componentContext({});
  const current={model:'model-a',effort:'high',serviceTier:'priority',mode:'default'};
  assert.equal(c.chooseMessageSetting('pc','thread','model','model-b',current,models),true);
  assert.equal(c.readMessageChoices('other','thread').model,undefined);
  const selected=c.settingsWithMessageChoices({...current,effort:'low'},c.readMessageChoices('pc','thread'));
  assert.equal(selected.model,'model-b');assert.equal(selected.effort,'medium');assert.equal(selected.serviceTier,'');
  const revision=c.messageChoicesRevision('pc','thread');c.saveMessageChoices('pc','thread',{effort:'low'});
  c.settleMessageChoices('pc','thread',revision);assert.equal(c.readMessageChoices('pc','thread').effort,'low');
});

test('含选项的消息失败保留正文和选择，成功仅消费原提交版本',()=>{
  const c=componentContext({reactive:value=>value});
  const source=fs.readFileSync('apps/mobile/services/composer.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={saveDraft,readDraft,rememberSubmission,settleSubmission,submissionHasMessageChoices};',c);
  const s=c.subject;s.saveDraft('pc','thread','合成正文');c.saveMessageChoices('pc','thread',{effort:'low'});s.rememberSubmission('pc','thread','failed','合成正文');
  assert.equal(s.submissionHasMessageChoices('pc','failed'),true);s.settleSubmission('pc','failed',false);assert.equal(s.readDraft('pc','thread'),'合成正文');assert.equal(c.readMessageChoices('pc','thread').effort,'low');
  s.rememberSubmission('pc','thread','success','合成正文');c.saveMessageChoices('pc','thread',{effort:'high'});s.settleSubmission('pc','success',true);assert.equal(c.readMessageChoices('pc','thread').effort,'high');
});

test('UTS 未选择字段为 null 时，发送参数只保留明确选择及 false 确认值',()=>{
 const c=componentContext({});
 const choices={model:'model-a',effort:'low',serviceTier:null,mode:null,permissionMode:null,permissionRevision:null,confirmedFullAccess:null};
 assert.deepEqual(JSON.parse(JSON.stringify(c.messageChoicesParams(choices))),{model:'model-a',effort:'low'});
 assert.deepEqual(JSON.parse(JSON.stringify(c.messageChoicesParams({permissionMode:'read-only',permissionRevision:'a'.repeat(64),confirmedFullAccess:false}))),{permissionMode:'read-only',permissionRevision:'a'.repeat(64),confirmedFullAccess:false});
});

test('手机增量重建保留汇总设置能力，显式撤销能力也会生效',()=>{
 const source=fs.readFileSync('apps/mobile/services/bridge.uts','utf8');
 const assignment=source.split(/\r?\n/).find(line=>line.includes('connection.snapshot = { threadId: update.threadId'));
 for(const supported of [true,false]){
  const c=vm.createContext({connection:{},update:{threadId:'thread',supportsMessageChoices:supported,supportsDirectMessageChoices:supported},ordered:[]});
  vm.runInContext(stripTypeScriptTypes(assignment,{mode:'transform'}),c);
  assert.equal(c.connection.snapshot.supportsMessageChoices,supported);assert.equal(c.connection.snapshot.supportsDirectMessageChoices,supported);
 }
});

test('附件准备期间桌面并发修改设置，发送前拒绝且没有设置写入',async t=>{
  const f=fixture(t);f.adapter.attachments.materialize=()=>{f.adapter.subscribed('thread','phone').state.latestCollaborationMode.settings.reasoning_effort='low';return []};
  const result=await f.send({choices:{effort:'low'}});assert.equal(result.error.code,'SETTINGS_CHANGED');assert.equal(f.client.sentSettings,undefined);assert.equal(f.client.calls.some(c=>c.method==='thread-follower-update-thread-settings'),false);
});
