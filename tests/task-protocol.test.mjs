import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { METHODS, WRITE_METHODS, isMutatingRequest, validateRequest, validateAttachmentScope, validTaskSnapshot } from '../packages/protocol/contracts.mjs';

const request = (method,params) => ({v:1,type:'request',requestId:randomUUID(),method,params});
const submit = payload => request('tasks.submit',{taskId:randomUUID(),kind:'command',payload});
const snapshot = () => ({supportsTaskQueue:true,revision:1,paused:false,blockerId:'',now:100,tasks:[{
  id:randomUUID(),position:1,kind:'command',method:'turn.stop',title:'停止生成',threadId:'synthetic-thread',projectId:'',state:'queued',stage:'等待执行',error:'',createdAt:100,startedAt:0,completedAt:0,updatedAt:100,dismissed:false,steps:[],
}]});

test('任务管理属于独立协议集合，提交与控制仍按写入未知结果分类',()=>{
  for(const method of ['tasks.submit','tasks.list','tasks.watch','tasks.unwatch','tasks.control']) {assert.ok(METHODS.has(method));assert.equal(WRITE_METHODS.has(method),false);}
  assert.equal(isMutatingRequest('tasks.submit'),true);assert.equal(isMutatingRequest('tasks.control'),true);assert.equal(isMutatingRequest('tasks.list'),false);
  validateRequest(submit({method:'turn.stop',params:{threadId:'synthetic-thread'}}));
  for(const method of ['tasks.submit','shell.exec','threads.list','attachment.begin']) assert.throws(()=>validateRequest(submit({method,params:{threadId:'synthetic-thread'}})));
  assert.throws(()=>validateRequest(submit({method:'turn.send',params:{threadId:'synthetic-thread',text:'合成内容',cwd:'../escape'}})));
});

test('任务新建消息沿用图片附件权限边界，禁止路径和未确认完整访问',()=>{
  const valid = {taskId:randomUUID(),kind:'newConversation',payload:{projectId:'synthetic-project',mode:'desktopIpc',text:'合成新建消息',images:[],attachments:[],choices:{effort:'high'}}};
  validateRequest(request('tasks.submit',valid));
  validateRequest(request('tasks.submit',{...valid,payload:{...valid.payload,choices:{permissionMode:'desktop-default'}}}));
  for(const change of [{text:''},{images:['https://example.com/private.png']},{attachments:['../escape']},{choices:{permissionMode:'full-access'}},{choices:{mode:'shell'}},{cwd:'../escape'}]) {
    assert.throws(()=>validateRequest(request('tasks.submit',{...valid,payload:{...valid.payload,...change}})));
  }
  validateRequest(request('tasks.submit',{...valid,payload:{...valid.payload,choices:{permissionMode:'full-access',confirmedFullAccess:true}}}));
  assert.throws(()=>validateRequest(request('tasks.submit',{...valid,payload:{...valid.payload,mode:'nativeDraft',pluginIds:['synthetic-plugin']}})));
});

test('首条消息保护不能用于其他任务，也不能夹带未核验执行参数',()=>{
  const firstMessageGuard={permissionRevision:'a'.repeat(64),confirmedFullAccess:false};
  validateRequest(submit({method:'turn.send',params:{threadId:'synthetic-thread',text:'合成消息'},firstMessageGuard}));
  assert.throws(()=>validateRequest(submit({method:'turn.stop',params:{threadId:'synthetic-thread'},firstMessageGuard})));
  assert.throws(()=>validateRequest(submit({method:'turn.send',params:{threadId:'synthetic-thread',text:'合成消息',queueAction:'enqueue'},firstMessageGuard})));
  assert.throws(()=>validateRequest(submit({method:'turn.send',params:{threadId:'synthetic-thread',text:'合成消息'},firstMessageGuard:{...firstMessageGuard,processId:1}})));
});

test('任务查询控制与附件作用域都严格限制输入',()=>{
  const taskId=randomUUID();
  validateRequest(request('tasks.list',{view:'history',before:100,limit:50,state:'waiting_resume'}));
  validateRequest(request('tasks.control',{taskId,action:'skip',confirmed:true}));
  validateRequest(request('tasks.control',{taskId,action:'retry',confirmed:true,expectedAttempt:0}));
  for(const params of [{taskId,action:'retry',confirmed:true},{taskId,action:'retry',confirmed:true,expectedAttempt:-1},{taskId,action:'retry',expectedAttempt:0},{taskId,action:'resume',expectedAttempt:0}]) assert.throws(()=>validateRequest(request('tasks.control',params)));
  for(const params of [{taskId,action:'skip'},{taskId,action:'execute'},{taskId:'../escape',action:'cancel'}]) assert.throws(()=>validateRequest(request('tasks.control',params)));
  assert.throws(()=>validateRequest(request('tasks.list',{limit:10000})));
  assert.throws(()=>validateRequest(request('tasks.watch',{deviceId:'other'})));
  assert.deepEqual(validateAttachmentScope({taskId}),{taskId});
  validateRequest(request('attachment.begin',{taskId,uploadId:randomUUID(),name:'合成.txt',size:1}));
  for(const params of [{taskId,threadId:'synthetic-thread'},{taskId,draftId:randomUUID()},{threadId:'task:'+taskId},{taskId:'../escape'}]) assert.throws(()=>validateAttachmentScope(params));
});

test('任务快照只接受展示字段，拒绝嵌套凭据与步骤执行正文',()=>{
  const value=snapshot();assert.equal(validTaskSnapshot(value),true);
  value.tasks[0].attempt=1;value.tasks[0].canRetry=true;assert.equal(validTaskSnapshot(value),true);
  value.tasks[0].attempt=-1;assert.equal(validTaskSnapshot(value),false);value.tasks[0].attempt=0;
  value.tasks[0].canRetry='yes';assert.equal(validTaskSnapshot(value),false);value.tasks[0].canRetry=false;
  value.tasks[0].historyExpired=true;assert.equal(validTaskSnapshot(value),true);delete value.tasks[0].historyExpired;
  value.tasks[0].result={ok:true,settings:{effort:'high'}};assert.equal(validTaskSnapshot(value),true);
  value.tasks[0].result={deviceId:'other'};assert.equal(validTaskSnapshot(value),false);delete value.tasks[0].result;
  value.tasks[0].payload={text:'不应广播的正文'};assert.equal(validTaskSnapshot(value),false);delete value.tasks[0].payload;
  value.tasks[0].steps=[{name:'发送',state:'running',at:100,payload:{text:'原文'}}];assert.equal(validTaskSnapshot(value),false);
  assert.equal(validTaskSnapshot({...snapshot(),revision:-1}),false);
});
