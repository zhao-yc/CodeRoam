import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const page=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8');
// 直接运行页面面板入口，核对草稿、阅读位置、返回优先级和生命周期清理。
function fixture() {
  const lifecycle={hide:[],unload:[],watches:[]},calls=[];
  const context=vm.createContext({messagePresentations:{value:[{messageId:'user',annotations:[{index:1}]}]},selectedAnnotationId:{value:''},closeActions:()=>calls.push('menu'),closeComposerMenu:()=>calls.push('composer'),dismissGoal:()=>calls.push('goal'),uni:{hideKeyboard:()=>calls.push('keyboard'),navigateBack:()=>calls.push('back')},getCurrentPages:()=>[{},{}],composerMenu:{value:''},selectedExecutionId:{value:''},following:{value:true},scrollTarget:{value:'timeline-bottom'},draft:{value:'未发送草稿'},historyScrollTop:{value:240},touchingTimeline:false,historyGesture:0,onHide:fn=>lifecycle.hide.push(fn),onUnload:fn=>lifecycle.unload.push(fn),watch:(source,callback)=>lifecycle.watches.push({source,callback}),connection:{hostId:'pc',activeThreadId:'thread'}});
  const methods=page.slice(page.indexOf('function pauseFollowing()'),page.indexOf('function beginTimelineTouch()'));
  const back=page.match(/function goBack\(\) \{[^\n]+/)[0];
  vm.runInContext(stripTypeScriptTypes(methods+'\n'+back,{mode:'transform'})+'\nglobalThis.subject={openAnnotations,closeAnnotations,goBack};',context);
  return {context,calls,lifecycle,f:context.subject};
}
test('打开和关闭面板保留草稿与阅读位置，面板开启期间暂停自动跟随',()=>{
  const {context:c,calls,f}=fixture();
  f.openAnnotations('missing');assert.deepEqual(calls,[]);
  f.openAnnotations('user');assert.equal(c.selectedAnnotationId.value,'user');assert.equal(c.following.value,false);assert.equal(c.touchingTimeline,true);assert.equal(c.scrollTarget.value,'');
  f.closeAnnotations();assert.equal(c.selectedAnnotationId.value,'');assert.equal(c.touchingTimeline,false);
  assert.equal(c.draft.value,'未发送草稿');assert.equal(c.historyScrollTop.value,240);assert.deepEqual(calls,['menu','composer','goal','keyboard']);
});
test('返回优先关闭注释，隐藏、卸载和切换会话均清理面板',()=>{
  const {context:c,calls,lifecycle,f}=fixture();
  f.openAnnotations('user');f.goBack();assert.equal(c.selectedAnnotationId.value,'');assert.ok(!calls.includes('back'));
  for(const hook of [...lifecycle.hide,...lifecycle.unload,...lifecycle.watches.map(entry=>entry.callback)]){f.openAnnotations('user');hook(true);assert.equal(c.selectedAnnotationId.value,'');}
  f.goBack();assert.equal(calls.at(-1),'back');
});
test('复制回复通过展示解析器清理标记，引用与评论按纯文本渲染',()=>{
  const method=page.match(/function copyLatestReply\(\) \{[^\n]+/)[0],copied=[];
  const context=vm.createContext({closeActions(){},connection:{snapshot:{messages:[{role:'assistant',text:'完成 :codex-annotation{index="1"}'}]}},parseAnnotationReferences:value=>({text:value.replace(/ :codex-annotation\{index="1"\}/,'')}),copyText:value=>copied.push(value),notify(){}});
  vm.runInContext(stripTypeScriptTypes(method,{mode:'transform'})+'\ncopyLatestReply();',context);assert.deepEqual(copied,['完成']);
  const sheet=fs.readFileSync('apps/mobile/components/annotation-sheet/annotation-sheet.uvue','utf8');
  assert.match(sheet,/class="annotation-text" selectable>\{\{ item.text \}\}/);assert.match(sheet,/annotation-comment" selectable>\{\{ item.comment \}\}/);assert.doesNotMatch(sheet,/v-html|rich-text|markdown-body/);
});
