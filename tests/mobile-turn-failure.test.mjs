import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const uts = name => fs.readFileSync(`apps/mobile/services/${name}.uts`, 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
const plain = value => JSON.parse(JSON.stringify(value));
const state = () => ({threadId:'thread', status:'idle', activeTurnId:'', latestTurn:{turnId:'failed', status:'failed'}, supportsTurnRetry:true, turns:[{turnId:'failed', status:'failed', errorMessage:'Selected model is at capacity. Please try a different model.'}], messages:[], approvals:[], questionGroups:[]});

test('继续入口只使用最新实时审查终止，历史、运行和待交互状态均不可发送',()=>{
  const c=componentContext({});
  vm.runInContext(stripTypeScriptTypes(uts('turn-failure'))+';globalThis.f={reviewContinueTarget,latestReviewStoppedTurnId,failureTimeline}',c);
  const stopped={...state(),latestTurn:{turnId:'review',status:'reviewStopped'},turns:[{turnId:'review',status:'reviewStopped'}]};
  assert.equal(c.f.reviewContinueTarget(stopped),'review');
  assert.equal(c.f.failureTimeline(stopped,[])[0].kind,'reviewStopped');
  for(const change of [{readOnly:true},{status:'active'},{activeTurnId:'next'},{approvals:[{id:'a'}]},{questionGroups:[{state:'pending'}]},{pendingPlan:{id:'p'}},{activeFlags:['waitingOnApproval']},{latestTurn:{turnId:'next',status:'completed'}},{latestTurn:{turnId:'review',status:'interrupted'}}]) assert.equal(c.f.reviewContinueTarget({...stopped,...change}),'');
});

function continueFixture() {
  const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const start=source.indexOf('function reviewContinueSubmitted('),end=source.indexOf('// 两个重试入口共享轮次占位',start);
  let resolve,reject;const calls=[];
  const c=componentContext({submittedReviewContinueKey:{value:''},pageHostId:{value:'pc'},pageThreadId:{value:'thread'},reviewContinueTurnId:{value:'review'},canWrite:{value:true},operationError:{value:''},busy:{value:false},pendingAction:{value:''},draft:{value:'保留草稿'},draftImages:{value:['合成附件']},isCurrentPage:()=>true,resumeFollowing(){},refresh(){},bridge:{request:(method,params,write)=>{calls.push({method,params,write});return new Promise((ok,bad)=>{resolve=ok;reject=bad;});},pendingCommand:()=>''}});
  vm.runInContext(stripTypeScriptTypes(source.slice(start,end))+';globalThis.f={continueReviewTurn,canContinueReviewTurn}',c);
  return {c,calls,...c.f,resolve:()=>resolve({ok:true}),reject:(name='Error')=>{const error=new Error('合成失败');error.name=name;reject(error);}};
}

test('继续按钮发送当前聊天一次，成功前后保留占位及草稿附件',async()=>{
  const f=continueFixture();f.continueReviewTurn('review');f.continueReviewTurn('review');
  assert.deepEqual(plain(f.calls),[{method:'turn.send',params:{threadId:'thread',text:'继续完成当前聊天中尚未完成的任务。'},write:true}]);
  f.resolve();await new Promise(setImmediate);f.continueReviewTurn('review');assert.equal(f.calls.length,1);
  assert.equal(f.c.draft.value,'保留草稿');assert.deepEqual(plain(f.c.draftImages.value),['合成附件']);
  f.c.pageHostId.value='another-instance';assert.equal(f.canContinueReviewTurn('review'),true);
  f.c.reviewContinueTurnId.value='next';assert.equal(f.canContinueReviewTurn('review'),false);
});

test('继续失败可重试，未知结果保持锁定，旧聊天回执不改新聊天错误',async()=>{
  const failed=continueFixture();failed.continueReviewTurn('review');failed.reject();await new Promise(setImmediate);assert.equal(failed.canContinueReviewTurn('review'),true);
  const unknown=continueFixture();unknown.c.bridge.pendingCommand=()=> 'original-command';unknown.continueReviewTurn('review');unknown.reject();await new Promise(setImmediate);assert.equal(unknown.canContinueReviewTurn('review'),false);
  const queuedUnknown=continueFixture();queuedUnknown.continueReviewTurn('review');queuedUnknown.reject('OUTCOME_UNKNOWN');await new Promise(setImmediate);assert.equal(queuedUnknown.canContinueReviewTurn('review'),false);
  const switched=continueFixture();switched.continueReviewTurn('review');switched.c.pageThreadId.value='other';switched.c.operationError.value='新聊天提示';switched.reject();await new Promise(setImmediate);assert.equal(switched.c.operationError.value,'新聊天提示');
});

/** 使用真实 UTS 组装时间线，覆盖空轮次、历史顺序和不可重试边界。 */
test('失败和中断提示插在对应轮次末尾，无消息轮次仍显示', () => {
  const c = componentContext({});
  vm.runInContext(stripTypeScriptTypes(uts('turn-failure')) + ';globalThis.f={failureTimeline,retryTarget,latestFailureTurnId}', c);
  const s=state(); s.turns.unshift({turnId:'older',status:'failed',errorMessage:'Earlier failure'}); s.turns.push({turnId:'next',status:'inProgress'});
  const messages=[{id:'old',role:'assistant',turnId:'older',text:'已有记录'},{id:'new',role:'user',turnId:'next',text:'新要求'}];
  const entries=c.f.failureTimeline(s,messages);
  assert.deepEqual(plain(entries.map(e=>e.id)), ['old','failure:older','failure:failed','new']);
  assert.equal(entries[2].text,s.turns[1].errorMessage); assert.equal(messages.length,2);
  delete s.turns[1].errorMessage;
  assert.match(c.f.failureTimeline(s,[])[1].text,/未提供具体原因/);
  s.turns=[{turnId:'stopped',status:'interrupted'}];assert.equal(c.f.failureTimeline(s,[])[0].text,'本轮操作已中断');
  s.turns=[{turnId:'review',status:'reviewStopped',errorMessage:'本轮操作已被自动审查终止'}];
  assert.equal(c.f.failureTimeline(s,[])[0].role,'interruption');
  assert.equal(c.f.failureTimeline(s,[])[0].label,'自动审查终止');
  assert.equal(c.f.retryTarget({...s,latestTurn:{turnId:'review',status:'reviewStopped'}}),'');
  assert.equal(c.f.retryTarget(state()),'failed');
  for(const change of [{readOnly:true},{status:'active'},{activeTurnId:'running'},{approvals:[{id:'a'}]},{questionGroups:[{state:'pending'}]},{pendingPlan:{id:'plan'}},{activeFlags:['waitingOnApproval']},{latestTurn:{turnId:'next',status:'completed'}}]) assert.equal(c.f.retryTarget({...state(),...change}),'');
});

/** 执行详情页真实入口，验证空发送与重试共享占位且绝不消费草稿。 */
function pageFixture() {
  const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const start=source.indexOf('function retrySubmitting('), end=source.indexOf('// 仅在明确收到成功响应后清空草稿',start);
  let resolve,reject;const calls=[];
  const c=componentContext({cacheOnly:false,submittedRetryKey:{value:''},pageHostId:{value:'pc'},pageThreadId:{value:'thread'},retryTurnId:{value:'failed'},canWrite:{value:true},goalHostOnline:{value:true},liveConversation:{value:state()},operationError:{value:''},busy:{value:false},pendingAction:{value:''},pendingRetryCommand:{value:''},connection:{connected:true},isCurrentPage:()=>true,resumeFollowing(){},refresh(){},bridge:{request:(method,params)=>{calls.push({method,params});return new Promise((ok,bad)=>{resolve=ok;reject=bad;});},pendingCommand:()=>'',watch(){}}});
  vm.runInContext(stripTypeScriptTypes(source.slice(start,end))+';globalThis.f={retryTurn,canRetryTurn}',c);
  return {c,calls,...c.f,resolve:()=>resolve({ok:true}),reject:()=>reject(new Error('已拒绝'))};
}

test('重试只提交目标轮次，回执前后禁止重复，明确拒绝后才解除占位', async () => {
  const f=pageFixture();f.retryTurn('failed');f.retryTurn('failed');
  assert.deepEqual(plain(f.calls),[{method:'turn.retry',params:{threadId:'thread',expectedTurnId:'failed'}}]);
  f.resolve();await new Promise(setImmediate);f.retryTurn('failed');assert.equal(f.calls.length,1);
  const rejected=pageFixture();rejected.retryTurn('failed');rejected.reject();await new Promise(setImmediate);assert.equal(rejected.canRetryTurn('failed'),true);
});

test('失败原因及最新轮次经过历史合并，守护进程只读预览不能启用重试', () => {
  const c=componentContext({});
  vm.runInContext(stripTypeScriptTypes(uts('history')+'\n'+uts('turn-failure'))+';globalThis.f={conversationWithHistory,retryTarget}',c);
  const s={...state(),title:'合成会话',cwd:'/example/project',updatedAt:1};
  const preview={...s,readOnly:true};
  assert.equal(c.f.retryTarget(preview),'');
  const merged=c.f.conversationWithHistory(s,{messages:[],turns:[{turnId:'older',status:'failed',errorMessage:'Earlier failure'}]});
  assert.equal(merged.supportsTurnRetry,true);assert.equal(merged.turns[0].errorMessage,'Earlier failure');assert.equal(merged.latestTurn.turnId,'failed');
});

/** 直接运行连接服务，验证超时和重连只核对原编号，错误回执不能释放操作保护。 */
function bridgeFixture(storage=new Map()) {
  const timers=new Map(),sent=[];let timer=0;
  const c=componentContext({reactive:v=>v,uni:{getStorageSync:k=>storage.get(k)??'',setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k)},setTimeout:(fn,delay)=>{timers.set(++timer,{fn,delay});return timer;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(stripTypeScriptTypes(uts('bridge'),{mode:'transform'})+';globalThis.f={MobileBridge,connection}',c);
  const {MobileBridge,connection}=c.f,bridge=new MobileBridge();
  Object.assign(connection,{connected:true,hostId:'pc',activeThreadId:'thread',snapshot:state(),computers:[{id:'pc',online:true}]});
  bridge.socket={send:options=>sent.push(JSON.parse(options.data))};
  return {bridge,connection,timers,sent,storage};
}
const object = fields => ({...fields,getString(key){return this[key]??null;},getBoolean(key){return this[key]??null;}});

test('重试超时、断线、未知结果保留原编号，重启可恢复且不会重放', async () => {
  for(const event of ['timeout','disconnect','unknown']) {
    const f=bridgeFixture();const request=f.bridge.request('turn.retry',{threadId:'thread',expectedTurnId:'failed'},true);
    const rejected=assert.rejects(request,/核对/),id=f.sent[0].requestId;
    if(event==='timeout')f.timers.values().next().value.fn();
    if(event==='disconnect')f.bridge.rejectPending();
    if(event==='unknown')f.bridge.receive(object({type:'response',requestId:id,error:object({outcomeUnknown:true,message:'未确认'})}));
    await rejected;assert.equal(f.bridge.pendingCommand('pc','thread'),id);
    const reopened=bridgeFixture(f.storage);reopened.bridge.clearLegacyCommands('pc');
    assert.equal(reopened.bridge.pendingCommand('pc','thread'),id);assert.equal(reopened.sent.length,0);
    await assert.rejects(reopened.bridge.request('turn.retry',{threadId:'thread',expectedTurnId:'failed'},true),/正在提交/);
    reopened.bridge.clearCommand(id,'pc');assert.equal(reopened.bridge.pendingCommand('pc','thread'),'');
  }
});

test('错误会话回执保留保护，明确成功或失败回执才结算', async () => {
  for(const result of [{}, {ok:true,threadId:'other'}, {ok:true,threadId:'thread'}]) {
    const f=bridgeFixture(),request=f.bridge.request('turn.retry',{threadId:'thread',expectedTurnId:'failed'},true),id=f.sent[0].requestId;
    const accepted=result.threadId==='thread',settled=accepted?request:assert.rejects(request,/核对/);
    f.bridge.receive(object({type:'response',requestId:id,result:object(result)}));await settled;
    assert.equal(f.bridge.pendingCommand('pc','thread').length>0,!accepted);
  }
});
