import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 直接执行实际组件脚本，验证选中、同步保留及统一提交，不复制实现逻辑。 */
function fixture(overrides={}) {
  const props={group:{id:'g',turnId:'t',state:'pending',questions:[{id:'a',title:'题一',options:[{label:'甲'},{label:'乙'}],answer:''},{id:'b',title:'题二',options:[],answer:''}]},disabled:false,...overrides};
  const emitted=[],watches=[];
  const context=componentContext({props,defineProps:()=>props,defineEmits:()=> (...args)=>emitted.push(args),ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(_source,callback)=>{watches.push(callback);callback(props.group);}});
  let source=fs.readFileSync(new URL('../apps/mobile/components/question-card/question-card.uvue',import.meta.url),'utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={drafts,complete,locked,choose,chooseOther,submit};',context);
  return {...context.subject,props,emitted,sync:()=>watches.forEach(callback=>callback(props.group))};
}

test('选项默认不代选，多题完成后统一提交；快照替换保留草稿且支持改选和自定义答案',()=>{
  const f=fixture();assert.equal(f.complete.value,false);f.submit();assert.equal(f.emitted.length,0);
  f.choose('a','乙');assert.equal(f.emitted.length,0);f.drafts.value[1].text='自由回答';f.props.group=structuredClone(f.props.group);f.sync();assert.equal(f.drafts.value[0].text,'乙');assert.equal(f.drafts.value[1].text,'自由回答');assert.equal(f.complete.value,true);
  f.chooseOther('a');assert.equal(f.complete.value,false);f.drafts.value[0].text='其他内容';f.submit();assert.deepEqual(JSON.parse(JSON.stringify(f.emitted[0])),['submit','g','t',[{questionId:'a',text:'其他内容'},{questionId:'b',text:'自由回答'}],['a','b']]);
});

test('离线、提交中、结果未知和已提交均阻止修改选择与重复提交，桌面已答子题更新结果',()=>{
  const f=fixture();f.choose('a','甲');f.drafts.value[1].text='回答';
  f.props.disabled=true;f.choose('a','乙');f.chooseOther('a');f.submit();assert.equal(f.drafts.value[0].text,'甲');assert.equal(f.emitted.length,0);f.props.disabled=false;
  f.props.group=structuredClone(f.props.group);f.props.group.questions[0].answer='乙';f.sync();assert.equal(f.drafts.value[0].text,'乙');assert.equal(f.drafts.value[1].text,'回答');
});

test('只读提交保留选中态、自定义长答案和保密草稿，明确失败后可继续编辑',()=>{
  const f=fixture();
  f.props.group.questions.push({id:'secret',title:'保密答案',options:[],answer:'',isSecret:true});f.sync();
  f.choose('a','乙');
  const answer='合成长答案\n'.repeat(200);
  f.drafts.value[1].text=answer;f.drafts.value[2].text='合成保密内容';f.submit();
  assert.equal(f.emitted.length,1);
  // 独立于全局 busy 锁定，成功回执释放 busy 后仍不能改选或重复提交。
  f.props.readOnly=true;
  assert.equal(f.locked.value,true);f.choose('a','甲');f.chooseOther('a');f.submit();
  f.props.group=structuredClone(f.props.group);f.sync();
  assert.equal(f.drafts.value[0].text,'乙');assert.equal(f.drafts.value[0].custom,false);
  assert.equal(f.drafts.value[1].text,answer);assert.equal(f.drafts.value[2].text,'合成保密内容');
  assert.equal(f.emitted.length,1);
  f.props.readOnly=false;assert.equal(f.locked.value,false);f.choose('a','甲');f.submit();
  assert.equal(f.drafts.value[0].text,'甲');assert.equal(f.drafts.value[1].text,answer);assert.equal(f.emitted.length,2);
});

test('问答提交状态位于可见正文之后，只读长答案完整显示且遮蔽保密内容',()=>{
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const questions=page.slice(page.indexOf('<view v-for="group in pendingQuestionGroups"'),page.indexOf('<view id="approvals-anchor"'));
  assert.doesNotMatch(questions,/interaction-underlay|interaction-cover|aria-hidden|showInteractionForm/);
  assert.match(questions,/v-show="expandedQuestionIds.indexOf\(group.id\) >= 0"/);
  assert.match(questions,/:read-only="interactionFor\('question', group.id, group.turnId\) != null"/);
  assert.ok(questions.indexOf('<question-card')<questions.indexOf('<interaction-status'));
  const card=fs.readFileSync('apps/mobile/components/question-card/question-card.uvue','utf8');
  assert.match(card,/<text v-if="item.question.answer.length > 0 \|\| \(readOnly && item.question.isSecret\)" class="answer">\{\{ item.question.isSecret \? '已填写' : item.question.answer \}\}<\/text>/);
  assert.match(card,/<text v-if="readOnly && \(item.custom \|\| item.question.options.length == 0\)" class="custom-answer" selectable>\{\{ item.text \}\}<\/text>/);
  assert.match(card,/group.state == 'pending' && !readOnly/);
  const style=card.match(/\.custom-answer \{([^}]+)\}/)[1];
  assert.match(style,/color: #1a2135/);assert.doesNotMatch(style,/(?:^|;)\s*(?:height|max-height|opacity|overflow):/);
});

test('卡片重新挂载从原提交恢复选项和长答案，其他实例不接收展示副本',()=>{
  const answer='切回后保留的合成长答案\n'.repeat(80);
  const submittedDrafts=[{questionId:'a',text:'乙',custom:false},{questionId:'b',text:answer,custom:true}];
  const restored=fixture({readOnly:true,submittedDrafts});
  assert.equal(restored.drafts.value[0].text,'乙');assert.equal(restored.drafts.value[0].custom,false);
  assert.equal(restored.drafts.value[1].text,answer);restored.choose('a','甲');restored.submit();
  assert.equal(restored.drafts.value[0].text,'乙');assert.equal(restored.emitted.length,0);
  const other=fixture();assert.equal(other.drafts.value[0].text,'');assert.equal(other.drafts.value[1].text,'');
  const custom=fixture({readOnly:true,submittedDrafts:[{questionId:'a',text:'乙',custom:true}]});
  assert.equal(custom.drafts.value[0].custom,true);
  restored.props.readOnly=false;restored.props.submittedDrafts=undefined;restored.sync();
  assert.equal(restored.drafts.value[1].text,answer);restored.choose('a','甲');assert.equal(restored.drafts.value[0].text,'甲');
});

/** 执行页面实际计算与监听，供问题提醒及状态清理回归共用。 */
function pageFixture() {
  const watches=[],connection={hostId:'pc',snapshot:{threadId:'thread',messages:[],approvals:[],questionGroups:[{id:'answered',state:'answered'},{id:'pending',state:'pending'},{id:'expired',state:'expired'},{id:'other',state:'pending'}],cwd:'',activeTurnId:''},computers:[],activeThreadId:'thread'};
  const context=componentContext({setTimeout:()=>0,connection,bridge:{},ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(source,callback)=>watches.push({source,callback}),onLoad:()=>{},onUnload:()=>{},onShow:()=>{},onHide:()=>{},onBackPress:()=>{},onResize:()=>{},readDraft:()=>'',executionTimeline:()=>[],nextTick:callback=>callback(),uni:{getElementById:()=>null,getWindowInfo:()=>({windowWidth:393}),hideKeyboard:()=>{}}});
  const pageSource=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const source=pageSource.match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={pendingQuestionGroups,pendingQuestionCount,expandedQuestionIds,showQuestions,scrollTarget,following,pageVisible,pageHostId,pageThreadId};',context);
  context.subject.pageHostId.value='pc';context.subject.pageThreadId.value='thread';connection.hostId='pc';
  return {pageSource,page:context.subject,connection,watches,plain:value=>JSON.parse(JSON.stringify(value))};
}

test('页面末尾只显示待答题组，回答或失效后移除且保留其他题组状态',()=>{
  const {pageSource,page,connection,watches,plain}=pageFixture();
  assert.match(pageSource.split('<script')[0],/v-for="group in pendingQuestionGroups"/);
  assert.deepEqual(plain(page.pendingQuestionGroups.value.map(group=>group.id)),['pending','other']);assert.equal(page.pendingQuestionCount.value,2);
  page.showQuestions();assert.deepEqual(plain(page.expandedQuestionIds.value),['pending']);assert.equal(page.scrollTarget.value,'questions-anchor');
  page.expandedQuestionIds.value.push('other');
  connection.snapshot.questionGroups[1].state='answered';watches.find(watch=>watch.source===page.pendingQuestionGroups).callback(page.pendingQuestionGroups.value);
  assert.deepEqual(plain(page.pendingQuestionGroups.value.map(group=>group.id)),['other']);assert.deepEqual(plain(page.expandedQuestionIds.value),['other']);
  connection.snapshot.questionGroups[3].state='expired';watches.find(watch=>watch.source===page.pendingQuestionGroups).callback(page.pendingQuestionGroups.value);
  assert.equal(page.pendingQuestionCount.value,0);assert.deepEqual(plain(page.expandedQuestionIds.value),[]);
  page.showQuestions();assert.deepEqual(plain(page.expandedQuestionIds.value),[]);
  connection.snapshot=null;assert.equal(page.pendingQuestionCount.value,0);
});

test('移除顶部重复提示后，新问题仍自动展开，重复同步保留收起且不打断历史阅读',()=>{
  const {pageSource,page,connection,watches,plain}=pageFixture();
  const template=pageSource.split('<script')[0];
  assert.doesNotMatch(template,/question-notice|查看待回答问题/);
  const update=watches.find(watch=>watch.source===page.pendingQuestionGroups).callback;
  page.pageVisible.value=true;update(page.pendingQuestionGroups.value,[]);
  assert.deepEqual(plain(page.expandedQuestionIds.value),['pending','other']);assert.equal(page.scrollTarget.value,'timeline-bottom');
  page.expandedQuestionIds.value=[];const previous=page.pendingQuestionGroups.value;
  update(page.pendingQuestionGroups.value,previous);assert.equal(page.expandedQuestionIds.value.length,0);
  page.following.value=false;page.scrollTarget.value='history';
  connection.snapshot.questionGroups.push({id:'new',state:'pending'});update(page.pendingQuestionGroups.value,previous);
  assert.deepEqual(plain(page.expandedQuestionIds.value),['new']);assert.equal(page.scrollTarget.value,'history');
  page.showQuestions();assert.equal(page.scrollTarget.value,'questions-anchor');
});
