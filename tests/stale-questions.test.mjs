import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';
import {formatQuestionReply} from '../apps/bridge/questions.mjs';
import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';

const question=(id='question')=>({id,type:'agentMessage',text:'请确认后继续',questions:[{title:'是否允许调整？',options:['允许','暂不调整']}]});
const user=(id,text)=>({id,type:'userMessage',content:[{type:'text',text}]});
const turn=(turnId,items,status='completed')=>({turnId,status,items});
const raw=(turns)=>({id:'thread',turns,requests:[],threadRuntimeStatus:{type:'idle'}});

/** 执行实际手机状态函数，覆盖用户截图中任务已结束却被旧问题占据的情况。 */
function mobileState(snapshot){
  const source=fs.readFileSync('apps/mobile/services/bridge.uts','utf8');
  const methods=source.slice(source.indexOf('export function taskState('),source.indexOf('\ntype TextAppend')).replaceAll('export ','');
  const context=vm.createContext({snapshot});
  vm.runInContext(stripTypeScriptTypes(methods)+';globalThis.result=conversationTaskState(snapshot,true);',context);
  return context.result;
}

test('普通文字回答后继续执行并结束，旧异步题组退出待回答且不伪造选项答案',()=>{
  const input=raw([turn('ask',[question()]),turn('reply',[user('allow','允许'),{id:'done',type:'agentMessage',text:'任务已完成',phase:'final_answer'}])]);
  const snapshot=normalizeConversation(input);
  assert.equal(snapshot.questionGroups[0].state,'expired');assert.equal(snapshot.questionGroups[0].questions[0].answer,'');
  assert.equal(snapshot.questionGroups.filter(group=>group.state==='pending').length,0);assert.equal(mobileState(snapshot),'idle');
  assert.equal(snapshot.messages.find(message=>message.id==='allow').text,'允许');
});

test('没有后续用户输入的真实待答题保留，后续新题也不能被旧回复清除',()=>{
  const snapshot=normalizeConversation(raw([turn('first',[question('old')]),turn('next',[user('next','继续后续工作'),question('new')])]));
  assert.deepEqual(snapshot.questionGroups.map(group=>group.state),['expired','pending']);assert.equal(mobileState(snapshot),'question');
  assert.equal(normalizeConversation(raw([turn('ask',[question()])])).questionGroups[0].state,'pending');
});

test('拒绝或仍排队的追加不关闭问题，已接受追加及图片输入可继续对话',()=>{
  for(const status of ['rejected','pending','accepted']){
    const snapshot=normalizeConversation(raw([turn('ask',[question(),{id:'reply',type:'steeringUserMessage',status,input:[{type:'text',text:'继续'}]}])]));
    assert.equal(snapshot.questionGroups[0].state,status==='accepted'?'expired':'pending');
  }
  const photo=normalizeConversation(raw([turn('ask',[question()]),turn('next',[{id:'photo',type:'userMessage',content:[{type:'localImage',path:'不能泄露的路径'}]}])]));
  assert.equal(photo.questionGroups[0].state,'expired');assert.equal(JSON.stringify(photo).includes('不能泄露的路径'),false);
});

test('结构化回答兼容多文本块和附件，部分回答仍保留未答子题',()=>{
  const input=raw([turn('ask',[{...question(),questions:[{title:'第一题',options:['允许']},{title:'第二题',options:['允许']}]}])]);
  const group=normalizeConversation(input).questionGroups[0];
  const text=formatQuestionReply(group,[{questionId:group.questions[0].id,text:'允许'}]);
  input.turns.push(turn('answer',[{id:'reply',type:'userMessage',content:[{type:'text',text:text.slice(0,text.indexOf('\n'))},{type:'image',url:'图片内容不会参与问答解析'},{type:'text',text:text.slice(text.indexOf('\n')+1)}]}]));
  let snapshot=normalizeConversation(input);assert.equal(snapshot.questionGroups[0].state,'pending');assert.equal(snapshot.questionGroups[0].questions[0].answer,'允许');assert.equal(snapshot.questionGroups[0].questions[1].answer,'');
  input.turns.push(turn('last',[user('plain','先处理其他事情')]));snapshot=normalizeConversation(input);assert.equal(snapshot.questionGroups[0].state,'expired');assert.equal(snapshot.questionGroups[0].questions[0].answer,'允许');
});

test('完成回答不会被同一轮残留原生请求重新打开，新一轮请求仍可显示',()=>{
  const response={id:'answered',type:'userInputResponse',requestId:17,completed:true,questions:[{id:'q',question:'是否继续'}],answers:{q:['继续']}};
  const input=raw([turn('old',[response])]);
  input.requests=[{id:17,method:'item/tool/requestUserInput',params:{turnId:'old',questions:[{id:'q',question:'是否继续'}]}}];
  let snapshot=normalizeConversation(input);assert.equal(snapshot.questionGroups[0].state,'answered');assert.equal(mobileState(snapshot),'idle');
  input.requests[0].params.turnId='new';snapshot=normalizeConversation(input);assert.equal(snapshot.questionGroups[0].state,'pending');assert.equal(mobileState(snapshot),'question');
});

test('旧问题消退随现有增量元数据同步，列表状态计数和页面卡片共用同一状态',()=>{
  const input=raw([turn('ask',[question(),{id:'history',type:'agentMessage',text:'长历史'.repeat(2000)}])]);
  const before=normalizeConversation(input);input.turns.push(turn('next',[user('reply','允许')]));const after=normalizeConversation(input);
  const update=conversationUpdate({snapshot:before,seq:1},after);
  assert.equal(update.kind,'delta');
  const rebuilt=applyConversationUpdate({snapshot:before,seq:1,epoch:'e'},{...update,epoch:'e',seq:2}).snapshot;
  assert.equal(rebuilt.questionGroups[0].state,'expired');assert.equal(mobileState(rebuilt),'idle');
});
