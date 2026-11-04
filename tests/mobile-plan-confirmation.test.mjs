import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
/** 执行真实页面处理方法，确认独立草稿、重复点击和离页回执。 */
function fixture(){const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8'),calls=[],pending=[],watchers=[];const c=componentContext({cacheOnly:false,ref:value=>({value}),computed:read=>({get value(){return read();}}),watch(read,change){watchers.push({read,change});},canWrite:{value:true},busy:{value:false},pendingAction:{value:''},operationError:{value:''},pageHostId:{value:'host'},pageThreadId:{value:'thread'},connection:{hostId:'host',snapshot:{threadId:'thread',pendingPlan:{id:'plan',text:'合成计划'}}},isCurrentPage:()=>true,notify(){},refresh(){},bridge:{request:(method,params)=>{calls.push({method,params});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}}});vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('const hiddenPlanId ='),source.indexOf('// 运行中显示电脑确认值'))+'\n'+source.slice(source.indexOf('// 取消只收起编辑区'),source.indexOf('function copyText(')),{mode:'transform'})+'\nglobalThis.api={replyPlan,hidePlan,hiddenPlanId,planFeedback,planEditing,editPlan,cancelPlanFeedback};',c);return {c,calls,pending,watchers,...c.api};}
test('连续点击只提交一次，计划确认不使用聊天草稿，成功后收起',async()=>{const f=fixture();f.replyPlan('implement');f.replyPlan('implement');assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.planAction,'implement');assert.equal(f.calls[0].params.planId,'plan');f.pending[0].resolve({});await Promise.resolve();assert.equal(f.hiddenPlanId.value,'plan');});
test('失败保留修改意见，离页成功回执不清空新会话反馈',async()=>{const f=fixture();f.planFeedback.value='保留建议';f.replyPlan('feedback');f.pending[0].reject(Error('待核对'));await Promise.resolve();assert.equal(f.planFeedback.value,'保留建议');assert.equal(f.c.operationError.value,'待核对');f.replyPlan('feedback');f.c.pageThreadId.value='other';f.planFeedback.value='新会话';f.pending[1].resolve({});await Promise.resolve();assert.equal(f.planFeedback.value,'新会话');});

test('默认不展开修改区，取消后保留独立意见，空意见和只读状态均不能提交',()=>{
  const f=fixture();assert.equal(f.planEditing.value,false);f.replyPlan('feedback');assert.equal(f.calls.length,0);
  f.editPlan();assert.equal(f.planEditing.value,true);f.planFeedback.value='保留这条意见';f.cancelPlanFeedback();assert.equal(f.planEditing.value,false);f.editPlan();assert.equal(f.planFeedback.value,'保留这条意见');
  f.c.canWrite.value=false;f.replyPlan('implement');f.replyPlan('feedback');assert.equal(f.calls.length,0);
  f.c.canWrite.value=true;f.c.connection.hostId='other-host';f.replyPlan('implement');assert.equal(f.calls.length,0);
});

test('方案切换重置编辑状态，旧方案回执不能清空同一聊天中新方案的修改意见',async()=>{
  const f=fixture();f.editPlan();f.planFeedback.value='旧意见';f.replyPlan('feedback');
  f.c.connection.snapshot.pendingPlan={id:'new-plan',text:'新方案'};f.watchers[0].change();
  assert.equal(f.planEditing.value,false);assert.equal(f.planFeedback.value,'');f.planFeedback.value='新方案意见';
  f.pending[0].resolve({});await Promise.resolve();assert.equal(f.planFeedback.value,'新方案意见');assert.equal(f.hiddenPlanId.value,'');f.editPlan();assert.equal(f.planEditing.value,true);
});
