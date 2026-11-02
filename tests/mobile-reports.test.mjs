import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';

/** 运行实际 UTS 分组与页面脚本，防止验收逻辑复制实现。 */
function fixture(){
  const context=vm.createContext({});
  const source=fs.readFileSync('apps/mobile/services/executions.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={reportTimeline,reportTurnIds,reportProcessLabel,executionTimeline,executionTitle,executionGroupExpanded,retainExpandedExecutions,toggleExecutionGroup};',context);
  return context.subject;
}
const plain=value=>JSON.parse(JSON.stringify(value));
const user=(id)=>({id,type:'userMessage',content:'用户提问'});
const agent=(id,phase='commentary')=>({id,type:'agentMessage',text:id,phase});
function snapshot(status='completed'){
  return normalizeConversation({id:'thread',turns:[{turnId:'turn',status,durationMs:170000,items:[user('u'),agent('progress'),{id:'c',type:'commandExecution',command:'node --test'},agent('more'),{id:'answer',type:'steeringUserMessage',content:'追加要求'},agent('final','final_answer')]}],requests:[]});
}

test('明确完成轮次默认仅保留提问、过程入口和最终报告，展开恢复原顺序和中途追加',()=>{
  const f=fixture(),state=snapshot();
  Object.freeze(state.messages);Object.freeze(state);
  const collapsed=f.reportTimeline(state,[]);
  assert.deepEqual(plain(collapsed.map(entry=>entry.id)),['u','process:turn','final']);
  assert.equal(collapsed[1].label,'用时 2分钟50秒 · 查看执行过程');
  assert.deepEqual(plain(f.reportTimeline(state,['turn']).map(entry=>entry.id)),['u','process:turn','progress','execution:c','more','answer','final']);
  assert.match(f.reportTimeline(state,['turn'])[1].label,/收起执行过程/);
});

test('运行、失败、停止、待操作、无报告和旧阶段数据均保持展开，不用末条回复猜报告',()=>{
  const f=fixture();
  const cases=['inProgress','failed','interrupted','unknown'].map(status=>snapshot(status));
  const approval=snapshot();approval.approvals=[{id:'approval',turnId:'turn'}];cases.push(approval);
  const question=snapshot();question.questionGroups=[{id:'q',turnId:'turn',state:'pending'}];cases.push(question);
  const unknownApproval=snapshot();unknownApproval.approvals=[{id:'approval',turnId:''}];cases.push(unknownApproval);
  const noFinal=snapshot();noFinal.messages.at(-1).phase='commentary';cases.push(noFinal);
  const old=snapshot();delete old.turns;cases.push(old);
  const noPhase=snapshot();delete noPhase.messages[1].phase;cases.push(noPhase);
  const active=snapshot();active.activeTurnId='turn';cases.push(active);
  for(const state of cases){
    assert.equal(f.reportTimeline(state,[]).some(entry=>entry.role==='process'),false);
    assert.deepEqual(plain(f.reportTimeline(state,[]).map(entry=>entry.id)),['u','progress','execution:c','more','answer','final']);
  }
  const error=normalizeConversation({id:'thread',turns:[{turnId:'turn',status:'completed',error:{message:'失败'},items:[agent('p'),agent('f','final_answer')]}]});
  assert.deepEqual(plain(f.reportTurnIds(error)),[]);
});

test('纯报告不生成空过程入口，多轮独立且不吞并后续报告或当前任务',()=>{
  const f=fixture(),first=snapshot(),second=snapshot();
  second.messages.forEach(message=>{message.id='next-'+message.id;message.turnId='next';});second.turns[0].turnId='next';
  first.messages.push(...second.messages);first.turns.push(...second.turns);
  let entries=f.reportTimeline(first,['turn']);
  assert.equal(entries.filter(entry=>entry.role==='process').length,2);
  assert.ok(entries.some(entry=>entry.id==='progress'));assert.equal(entries.some(entry=>entry.id==='next-progress'),false);
  first.turns[1].status='inProgress';first.activeTurnId='next';
  entries=f.reportTimeline(first,[]);assert.ok(entries.some(entry=>entry.id==='next-progress'));assert.equal(entries.some(entry=>entry.id==='progress'),false);
  const pure=normalizeConversation({id:'thread',turns:[{turnId:'pure',status:'completed',items:[user('u'),agent('f','final_answer')]}]});
  assert.deepEqual(plain(f.reportTimeline(pure,[]).map(entry=>entry.id)),['u','f']);
  assert.deepEqual(plain(f.reportTimeline(null,[])),[]);
});

test('耗时未知不估算，缺失轮次编号及非连续轮次不折叠，历史裁剪仍可显示报告',()=>{
  const f=fixture(),state=snapshot();
  assert.equal(f.reportProcessLabel(null,false),'查看执行过程');
  for(const ms of [-1,NaN,Infinity])assert.equal(f.reportProcessLabel(ms,false),'查看执行过程');
  assert.equal(f.reportProcessLabel(1,false),'用时 不足1秒 · 查看执行过程');
  assert.equal(f.reportProcessLabel(3661000,true),'用时 1小时1分钟1秒 · 收起执行过程');
  state.messages.shift();assert.equal(f.reportTimeline(state,[])[0].role,'process');
  state.messages.splice(2,0,{id:'other',role:'user',text:'另一轮',turnId:'other',status:''});
  assert.deepEqual(plain(f.reportTurnIds(state)),[]);
  const missing=snapshot();missing.turns[0].turnId='';assert.deepEqual(plain(f.reportTurnIds(missing)),[]);
});

test('页面完成后收起一次，手动展开与命令选择跨同步保留，切换会话清空且不抢滚动',()=>{
  const f=fixture(),watches=[],calls=[];
  const connection={snapshot:snapshot('inProgress'),computers:[],activeThreadId:'thread'};
  const context=vm.createContext({...f,conversationWithHistory:snapshot=>snapshot,executionRecordTitle:f.executionTitle,connection,bridge:{},ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(source,callback)=>watches.push({source,callback}),onLoad:()=>{},onUnload:()=>{},onShow:()=>{},onHide:()=>{},onBackPress:()=>{},onResize:()=>{},readDraft:()=>'',nextTick:callback=>callback(),uni:{getElementById:()=>null,getWindowInfo:()=>({windowWidth:393}),hideKeyboard:()=>{},setClipboardData:options=>calls.push(options.data)}});
  const source=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  // 页面展示依赖真实注释解析器，避免新展示字段影响过程折叠回归。
  vm.runInContext(stripTypeScriptTypes(fs.readFileSync('apps/mobile/services/annotations.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,''),{mode:'transform'}),context);
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={timeline,expandedTurnIds,expandedExecutionIds,following,scrollTarget,toggleProcess,toggleExecutions,copyLatestReply};',context);
  const page=context.subject,sync=watches.find(watch=>watch.source===page.timeline).callback;
  page.toggleExecutions(page.timeline.value.find(entry=>entry.role==='execution'));
  assert.equal(page.following.value,false);assert.deepEqual(plain(page.expandedExecutionIds.value),['c']);
  connection.snapshot=snapshot();sync(page.timeline.value);
  assert.deepEqual(plain(page.timeline.value.map(entry=>entry.id)),['u','process:turn','final']);
  assert.equal(page.scrollTarget.value,'');assert.equal(page.following.value,false);
  page.toggleProcess(page.timeline.value[1]);sync(page.timeline.value);
  assert.ok(page.timeline.value.some(entry=>entry.id==='progress'));assert.deepEqual(plain(page.expandedExecutionIds.value),['c']);
  connection.snapshot=structuredClone(connection.snapshot);sync(page.timeline.value);
  assert.ok(page.timeline.value.some(entry=>entry.id==='progress'));assert.deepEqual(plain(page.expandedTurnIds.value),['turn']);
  page.copyLatestReply();assert.equal(calls[0],'final');
  page.toggleProcess(page.timeline.value[1]);sync(page.timeline.value);assert.deepEqual(plain(page.expandedExecutionIds.value),['c']);
  const switchThread=watches.find(watch=>typeof watch.source==='function'&&watch.source()===connection.activeThreadId).callback;
  switchThread('other','thread');assert.deepEqual(plain(page.expandedTurnIds.value),[]);assert.deepEqual(plain(page.expandedExecutionIds.value),[]);
});
