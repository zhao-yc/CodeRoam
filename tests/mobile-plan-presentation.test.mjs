import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { normalizeConversation } from '../apps/bridge/conversation.mjs';

/** 执行实际 UTS 解析与页面选择方法，避免预览裁切影响详情原文。 */
function presentation() {
  const context = componentContext({});
  for (const file of ['markdown', 'plan-presentation', 'executions']) {
    const source = fs.readFileSync('apps/mobile/services/' + file + '.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
    vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }), context);
  }
  vm.runInContext('globalThis.api = { planPresentation, executionTimeline, reportTimeline }', context);
  return context.api;
}

test('预览从真实标题和正文生成，去掉 Markdown 语法且不改写原文', () => {
  const f = presentation(), source = '# **合成方案**\n\n保留 **完整正文**，支持 [示例链接](https://example.com)。\n\n- 第一步\n- 第二步';
  const result = f.planPresentation(source);
  assert.equal(result.title, '合成方案');assert.equal(result.excerpt, '保留 完整正文，支持 示例链接。 第一步 第二步');
  assert.ok(source.includes('**完整正文**'));
  assert.equal(f.planPresentation('没有标题的正文').title, '实施方案');assert.equal(f.planPresentation('').excerpt, '');
});

test('长预览有界，代码和表格仍能预览，时间线保留方案类型和正文', () => {
  const f = presentation(), source = '# 合成方案\n\n' + '正文'.repeat(6000) + '\n结尾标记';
  const preview = f.planPresentation(source);assert.ok(preview.excerpt.length <= 320);
  const entry = f.executionTimeline([{ id:'plan',role:'assistant',kind:'planImplementation',text:source,turnId:'turn' }])[0];
  assert.equal(entry.kind, 'planImplementation');assert.equal(entry.text, source);
  assert.ok(f.planPresentation('```text\n示例代码\n```').excerpt.includes('示例代码'));
  assert.ok(f.planPresentation('| 名称 | 状态 |\n| --- | --- |\n| 示例 | 待确认 |').excerpt.includes('待确认'));
});

test('详情优先使用待确认方案完整原文，打开关闭不改变聊天草稿，切换聊天关闭面板', () => {
  const page = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8'), hooks = [], watches = [];
  const full = '# 完整方案\n' + '正文'.repeat(6000) + '\n结尾标记';
  const context = componentContext({ref:value=>({value}),computed:read=>({get value(){return read();}}),watch:(read,change)=>watches.push(change),onHide:fn=>hooks.push(fn),onUnload:fn=>hooks.push(fn),pendingPlan:{value:{id:'plan',text:full}},timeline:{value:[]},displayConversation:{value:{messages:[{id:'plan',kind:'planImplementation',text:'窗口截取'}]}},pageHostId:{value:'host'},pageThreadId:{value:'thread'},connection:{hostId:'host',activeThreadId:'thread'},closeActions(){},closeComposerMenu(){},dismissGoal(){},uni:{hideKeyboard(){}},pauseFollowing(){},draft:{value:'聊天草稿'}});
  const source = page.slice(page.indexOf('const pendingPlanOutsideTimeline ='),page.indexOf('const expandedQuestionIds ='));
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.api={openPlan,closePlan,selectedPlanId,selectedPlanSource,pendingPlanOutsideTimeline}',context);
  const f=context.api;assert.equal(f.pendingPlanOutsideTimeline.value,true);f.openPlan('plan','窗口截取');assert.equal(f.selectedPlanSource.value,full);assert.equal(context.draft.value,'聊天草稿');context.pendingPlan.value=null;assert.equal(f.selectedPlanSource.value,full);f.closePlan();assert.equal(f.selectedPlanId.value,'');
  f.openPlan('history','历史原文');assert.equal(f.selectedPlanSource.value,'历史原文');watches[0]();assert.equal(f.selectedPlanId.value,'');
  f.openPlan('plan',full);hooks[0]();assert.equal(f.selectedPlanId.value,'');
});

test('真实桌面方案与最终回复去重，历史长方案保留全文，不隐藏其他轮次或不同内容', () => {
  const f = presentation(), text = '# 合成方案\n' + '正文'.repeat(6000) + '\n结尾标记';
  const state={id:'thread',turns:[{turnId:'turn',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text},{id:'plan',type:'planImplementation',planContent:text,isCompleted:false},{id:'other',type:'agentMessage',phase:'final_answer',text:'其他说明'}]},{turnId:'other-turn',status:'completed',items:[{id:'older-final',type:'agentMessage',phase:'final_answer',text}]}]};
  let snapshot=normalizeConversation(state),entries=f.reportTimeline(snapshot,[]);
  assert.equal(entries.filter(entry=>entry.id==='final').length,0);assert.ok(entries.some(entry=>entry.id==='other'));assert.ok(entries.some(entry=>entry.id==='older-final'));
  assert.equal(entries.find(entry=>entry.id==='plan').text,text);
  state.turns[0].items[1].isCompleted=true;snapshot=normalizeConversation(state);
  assert.equal(snapshot.pendingPlan,null);assert.equal(snapshot.messages.find(message=>message.id==='plan').text,text);assert.equal(f.reportTimeline(snapshot,[]).find(entry=>entry.id==='plan').kind,'planImplementation');
  state.turns[0].items[0].text='这是不同的修订说明\n'+text;
  const different=normalizeConversation(state);assert.ok(f.reportTimeline(different,[]).some(entry=>entry.id==='final'),'相同长尾部不能隐藏不同前缀的回复');
});
