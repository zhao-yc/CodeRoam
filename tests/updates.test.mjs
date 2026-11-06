import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';

test('回复阶段变化必须替换消息，轮次完成与耗时在无新增正文时仍同步',()=>{
  for(const phase of ['commentary',undefined]){
    const before={threadId:'t',turns:[{turnId:'turn',status:'inProgress'}],messages:[{id:'history',text:'历史'.repeat(5000),role:'user'},{id:'agent',text:'报告',role:'assistant',kind:'agentMessage',turnId:'turn',status:'inProgress',...(phase?{phase}:{})}]};
    const after=structuredClone(before);after.messages[1].phase='final_answer';after.messages[1].status='completed';after.turns[0]={turnId:'turn',status:'completed',durationMs:1500};
    const update={...conversationUpdate({snapshot:before,seq:1},after),epoch:'e',seq:2};
    assert.equal(update.kind,'delta');assert.equal(update.update.upserts.length,1);assert.equal(update.update.appends.length,0);
    assert.deepEqual(applyConversationUpdate({snapshot:before,seq:1,epoch:'e'},update).snapshot,after);
    const timed=structuredClone(after);timed.messages[1].workedMs=1200;
    const next={...conversationUpdate({snapshot:after,seq:2},timed),epoch:'e',seq:3};
    assert.equal(next.update.upserts[0].workedMs,1200);
    assert.deepEqual(applyConversationUpdate({snapshot:after,seq:2,epoch:'e'},next).snapshot,timed);
  }
});

test('流式输出只发送增长文本，重建时间线与完整快照一致',()=>{
  const before={threadId:'t',title:'测试',cwd:'C:/test',status:'active',activeTurnId:'turn',approvals:[],updatedAt:1,messages:Array.from({length:40},(_,i)=>({id:String(i),role:'assistant',turnId:'turn',status:'inProgress',text:'历史内容'.repeat(300)}))};
  const after=structuredClone(before);after.messages.at(-1).text+='新增输出';after.updatedAt=2;
  const payload=conversationUpdate({snapshot:before,seq:9},after);assert.equal(payload.kind,'delta');assert.equal(payload.update.appends[0].text,'新增输出');assert.ok(JSON.stringify(payload).length<JSON.stringify(after).length/10);
  const event={...payload,epoch:'epoch',seq:10};assert.deepEqual(applyConversationUpdate({snapshot:before,epoch:'epoch',seq:9},event).snapshot,after);
  assert.equal(applyConversationUpdate({snapshot:before,epoch:'epoch',seq:8},event),null);
  assert.equal(applyConversationUpdate({snapshot:before,epoch:'old',seq:9},event),null);
});

test('滑动窗口删除旧消息、替换文本并新增审批时不会残留历史',()=>{
  const before={threadId:'t',messages:[{id:'old',text:'旧',role:'user'},{id:'edit',text:'x'.repeat(5000),role:'assistant'}],approvals:[]};
  const after={threadId:'t',messages:[{id:'edit',text:'更正',role:'assistant'},{id:'new',text:'新消息',role:'user'}],approvals:[{id:'approval'}]};
  const event={...conversationUpdate({snapshot:before,seq:4},after),epoch:'e',seq:5};
  assert.deepEqual(applyConversationUpdate({snapshot:before,seq:4,epoch:'e'},event).snapshot,after);
});

test('显示类型变化和旧快照补充类型时替换整条消息，重建后不丢类型',()=>{
  for(const [oldKind,newKind] of [[undefined,'commandExecution'],['commandExecution','fileChange'],['fileChange',undefined]]){
    const message={id:'tool',role:'tool',turnId:'turn',status:'inProgress',text:'执行记录',...(oldKind===undefined?{}:{kind:oldKind})};
    const before={threadId:'t',messages:[{id:'history',role:'assistant',text:'历史内容'.repeat(1000)},message]};
    const after=structuredClone(before);after.messages[1].text+='新增输出';
    if(newKind===undefined)delete after.messages[1].kind;else after.messages[1].kind=newKind;
    const payload=conversationUpdate({snapshot:before,seq:4},after);
    assert.equal(payload.kind,'delta');assert.equal(payload.update.upserts.length,1);assert.equal(payload.update.appends.length,0);assert.equal(payload.update.upserts[0].kind,newKind);
    const event={...payload,epoch:'e',seq:5};
    assert.deepEqual(applyConversationUpdate({snapshot:before,epoch:'e',seq:4},event).snapshot,after);
  }
});

test('文件摘要变化和旧快照补充摘要时替换整条消息，重建后不丢摘要',()=>{
  for(const [oldSummary,newSummary] of [[undefined,'src/app.mjs'],['src/old.mjs','src/new.mjs'],['src/app.mjs',undefined]]){
    const message={id:'file',role:'tool',kind:'fileChange',turnId:'turn',status:'inProgress',text:'文件变更',...(oldSummary===undefined?{}:{summary:oldSummary})};
    const before={threadId:'t',messages:[{id:'history',role:'assistant',text:'历史内容'.repeat(1000)},message]};
    const after=structuredClone(before);after.messages[1].text+='新增记录';
    if(newSummary===undefined)delete after.messages[1].summary;else after.messages[1].summary=newSummary;
    const payload=conversationUpdate({snapshot:before,seq:4},after);
    assert.equal(payload.kind,'delta');assert.equal(payload.update.upserts.length,1);assert.equal(payload.update.appends.length,0);assert.equal(payload.update.upserts[0].summary,newSummary);
    const event={...payload,epoch:'e',seq:5};
    assert.deepEqual(applyConversationUpdate({snapshot:before,epoch:'e',seq:4},event).snapshot,after);
  }
});

test('旧命令补充摘要走整条替换，后续日志增量保留真实命令摘要',()=>{
  const before={threadId:'t',messages:[{id:'history',role:'assistant',text:'历史内容'.repeat(1000)},{id:'command',role:'tool',kind:'commandExecution',turnId:'turn',status:'inProgress',text:'node --test\n开始'}]};
  const after=structuredClone(before);after.messages[1].summary='node --test';after.messages[1].text+='新增输出';
  const first={...conversationUpdate({snapshot:before,seq:1},after),epoch:'e',seq:2};
  assert.equal(first.kind,'delta');assert.equal(first.update.upserts.length,1);assert.equal(first.update.appends.length,0);
  const current=applyConversationUpdate({snapshot:before,seq:1,epoch:'e'},first);
  assert.deepEqual(current.snapshot,after);
  const next=structuredClone(after);next.messages[1].text+='继续输出';
  const second={...conversationUpdate(current,next),epoch:'e',seq:3};
  assert.equal(second.update.upserts.length,0);assert.equal(second.update.appends.length,1);
  assert.deepEqual(applyConversationUpdate(current,second).snapshot,next);
});
