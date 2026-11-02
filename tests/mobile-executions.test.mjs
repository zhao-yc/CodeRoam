import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 直接执行实际 UTS 模块，不复制分组或状态同步实现。 */
function fixture(){
  const context=vm.createContext({});
  const source=fs.readFileSync('apps/mobile/services/executions.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={executionTimeline,executionGroupLabel,executionTitle,executionGroupExpanded,retainExpandedExecutions,toggleExecutionGroup,reportTimeline,reportTurnIds,reportProcessLabel}',context);
  return context.subject;
}
const plain=value=>JSON.parse(JSON.stringify(value));
const message=(id,kind='commandExecution',turnId='turn')=>({id,role:'tool',kind,text:'记录 '+id,turnId,status:'inProgress'});
const prose=(id,role='assistant',turnId='turn')=>({...message(id,'agentMessage',turnId),role});

test('操作仅在同轮次相邻时合并，正文和用户消息的顺序与原始数据保持一致',()=>{
  const f=fixture();
  const messages=[prose('u','user'),prose('a'),message('c'),message('f','fileChange'),prose('b'),message('c2'),message('c3','commandExecution','next'),prose('u2','user','next'),message('c4','commandExecution','next')];
  messages.forEach(Object.freeze);Object.freeze(messages);
  const entries=f.executionTimeline(messages);
  assert.deepEqual(plain(entries.map(entry=>entry.executions.length?entry.executions.map(item=>item.id):entry.id)),['u','a',['c','f'],'b',['c2'],['c3'],'u2',['c4']]);
  assert.equal(entries[2].label,'编辑了文件运行了命令');assert.equal(entries[2].id,'execution:c');
  assert.equal(entries[0].text,messages[0].text);assert.equal(entries[1].text,messages[1].text);
  assert.deepEqual(plain(f.executionTimeline([])),[]);
});

test('纯命令、纯文件、未知类型和旧快照摘要按实际类型显示',()=>{
  const f=fixture();
  assert.equal(f.executionGroupLabel([message('c')]),'运行了命令');
  assert.equal(f.executionGroupLabel([message('f','fileChange')]),'编辑了文件');
  assert.equal(f.executionGroupLabel([message('x','unknown')]),'执行记录');
  assert.equal(f.executionTitle({...message('c'),summary:'node --test'}),'node --test');
  assert.equal(f.executionTitle({...message('c'),text:'不能当作命令的输出'}),'命令执行');
  assert.equal(f.executionTitle({...message('c'),summary:'  '}),'命令执行');
  assert.equal(f.executionTitle({...message('f','fileChange'),summary:'E:\\git\\项目\\src\\app.uts 等2个文件'}),'app.uts 等2个文件');
  assert.equal(f.executionTitle(message('f','fileChange')),'文件更改');
  assert.equal(f.executionTitle(message('x','unknown')),'执行记录');
});

test('各组默认收起且独立开关，输出更新、快照替换和新增记录保留展开',()=>{
  const f=fixture();
  let messages=[message('c'),message('f','fileChange'),prose('a'),message('d')];
  let entries=f.executionTimeline(messages),expanded=[];
  assert.equal(f.executionGroupExpanded(entries[0],expanded),false);
  expanded=f.toggleExecutionGroup(entries[0],expanded);
  assert.equal(f.executionGroupExpanded(entries[0],expanded),true);assert.equal(f.executionGroupExpanded(entries[2],expanded),false);
  expanded=f.toggleExecutionGroup(entries[2],expanded);
  expanded=f.toggleExecutionGroup(entries[0],expanded);
  assert.deepEqual(plain(expanded),['d']);
  expanded=f.toggleExecutionGroup(entries[0],expanded);
  messages=structuredClone(messages);messages[0].text+='实时新增输出';messages.splice(2,0,message('new'));
  entries=f.executionTimeline(messages);expanded=f.retainExpandedExecutions(entries,expanded);
  assert.deepEqual(plain(expanded),['c','f','new','d']);
  assert.equal(f.executionGroupExpanded(entries[0],expanded),true);
});

test('历史窗口裁剪组首仍保持展开，整组移除和新会话清空选择',()=>{
  const f=fixture();
  let entries=f.executionTimeline([message('c'),message('f','fileChange'),message('d')]);
  let expanded=f.toggleExecutionGroup(entries[0],[]);
  entries=f.executionTimeline([message('f','fileChange'),message('d'),message('new')]);
  expanded=f.retainExpandedExecutions(entries,expanded);
  assert.equal(entries[0].id,'execution:f');assert.deepEqual(plain(expanded),['f','d','new']);
  assert.equal(f.executionGroupExpanded(entries[0],expanded),true);
  assert.deepEqual(plain(f.retainExpandedExecutions(f.executionTimeline([prose('a')]),expanded)),[]);
  assert.deepEqual(plain(f.retainExpandedExecutions(f.executionTimeline([message('other')]),[])),[]);
});

/** 运行页面实际脚本，验证列表、详情、跟随和切换会话之间的联动。 */
test('页面打开列表暂停跟随，详情关闭不收起列表，同步裁剪和切换会话清理选择',()=>{
  const f=fixture(),watches=[],calls=[];
  let bottom=400;
  const connection={snapshot:{messages:[message('c'),message('f','fileChange')],approvals:[],questionGroups:[],cwd:'',activeTurnId:''},computers:[],activeThreadId:'thread'};
  const context=vm.createContext({...f,conversationWithHistory:snapshot=>snapshot,executionRecordTitle:f.executionTitle,connection,bridge:{},ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(source,callback)=>watches.push({source,callback}),onLoad:()=>{},onUnload:()=>{},onShow:()=>{},onHide:()=>{},onBackPress:()=>{},readDraft:()=>'',nextTick:callback=>callback(),uni:{getElementById:id=>({getBoundingClientRect:()=>id==='conversation-timeline'?{height:600,bottom:700}:{bottom}}),getWindowInfo:()=>({windowWidth:393}),hideKeyboard:()=>calls.push('收起键盘')}});
  const source=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  // 注释展示与执行记录共用时间线，回归时一并加载真实展示解析器。
  vm.runInContext(stripTypeScriptTypes(fs.readFileSync('apps/mobile/services/annotations.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,''),{mode:'transform'}),context);
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={atTimelineBottom,updateTimelinePosition,beginTimelineTouch,endTimelineTouch,timeline,following,scrollTarget,expandedExecutionIds,selectedExecutionId,selectedExecution,toggleExecutions,toggleExecution,closeExecution,beginExecutionTouch,endExecutionTouch}',context);
  const page=context.subject;
  // 短内容及触摸后仍在底部时隐藏按钮，离开底部才显示。
  page.updateTimelinePosition();assert.equal(page.atTimelineBottom.value,true);
  page.beginTimelineTouch();page.endTimelineTouch();assert.equal(page.atTimelineBottom.value,true);assert.equal(page.following.value,true);
  bottom=900;page.updateTimelinePosition();assert.equal(page.atTimelineBottom.value,false);
  bottom=720;page.updateTimelinePosition();assert.equal(page.atTimelineBottom.value,true);
  page.toggleExecutions(page.timeline.value[0]);
  assert.equal(page.following.value,false);assert.equal(page.scrollTarget.value,'');assert.equal(calls.length,1);
  page.toggleExecution('c');assert.equal(page.selectedExecution.value.id,'c');
  page.closeExecution();assert.equal(page.selectedExecution.value,null);assert.deepEqual(plain(page.expandedExecutionIds.value),['c','f']);
  const sync=watches.find(item=>item.source===page.timeline).callback;
  connection.snapshot.messages.push(message('new'));sync(page.timeline.value);
  assert.deepEqual(plain(page.expandedExecutionIds.value),['c','f','new']);
  page.toggleExecution('c');connection.snapshot.messages.shift();sync(page.timeline.value);
  assert.equal(page.selectedExecutionId.value,'');assert.deepEqual(plain(page.expandedExecutionIds.value),['f','new']);
  page.following.value=true;page.beginExecutionTouch();page.endExecutionTouch();assert.equal(page.following.value,false);
  const switchThread=watches.find(item=>typeof item.source==='function'&&item.source()===connection.activeThreadId).callback;
  switchThread('other','thread');assert.deepEqual(plain(page.expandedExecutionIds.value),[]);assert.equal(page.selectedExecutionId.value,'');
});
