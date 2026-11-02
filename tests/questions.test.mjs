import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';
import {formatQuestionReply} from '../apps/bridge/questions.mjs';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {Journal} from '../apps/bridge/journal.mjs';
import {BridgeError, validateRequest} from '../packages/protocol/contracts.mjs';
import {conversationUpdate, applyConversationUpdate} from '../apps/bridge/updates.mjs';

function state() {return {id:'thread',cwd:'/',turns:[{turnId:'turn',status:'completed',items:[{id:'call',type:'agentMessage',text:'选择甲或乙',questions:[{title:'第一题',options:['甲','乙']},{title:'第二题',options:null}]}]}],requests:[]};}
function answerParams(snapshot) {const group=snapshot.questionGroups[0];return {threadId:'thread',questionGroupId:group.id,turnId:group.turnId,answers:group.questions.map((q,i)=>({questionId:q.id,text:i?'自定义':'乙'}))};}
class Fixture extends EventEmitter {
  constructor(raw) {super();this.raw=raw;this.socket={writable:true};this.calls=[];}
  async connect() {}
  async findOwner() {return {clientId:'desktop',hostId:'local'};}
  broadcast(method,params) {if(params.following)queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{conversationId:'thread',hostId:'local',change:{type:'snapshot',revision:1,conversationState:this.raw}}}));}
  async request(method,params,version) {this.calls.push({method,params,version});return {resultType:'success',result:{ok:true}};}
  close() {}
}

test('异步问答从结构化字段提取，跨轮已接受的回复转为已回答，普通列表不转按钮',()=>{
  const raw=state(), first=normalizeConversation(raw), group=first.questionGroups[0];
  assert.equal(group.questions[0].id,JSON.stringify(['request_user_input_async','call',0]));
  assert.deepEqual(group.questions[0].options.map(x=>x.label),['甲','乙']);
  const text=formatQuestionReply(group,answerParams(first).answers);
  raw.turns.push({turnId:'next',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text}]}]});
  const next=normalizeConversation(raw);assert.equal(next.questionGroups[0].state,'answered');assert.equal(next.questionGroups[0].questions[1].answer,'自定义');assert.match(next.messages.at(-1).text,/回答：乙/);assert.doesNotMatch(next.messages.at(-1).text,/send_user_message/);
  raw.turns[0].items[0].questions=undefined;assert.equal(normalizeConversation(raw).questionGroups.length,0);
});

test('拒绝的追加回答不算已回答；原生完成结果读取桌面实际数组格式',()=>{
  const raw=state();raw.turns[0].items.push({id:'rejected',type:'steeringUserMessage',status:'rejected',input:[{type:'text',text:formatQuestionReply(normalizeConversation(raw).questionGroups[0],answerParams(normalizeConversation(raw)).answers)}]});
  assert.equal(normalizeConversation(raw).questionGroups[0].state,'pending');
  raw.turns[0].items.push({id:'r',type:'userInputResponse',requestId:9,completed:true,questions:[{id:'q',question:'题目',options:[]}],answers:{q:['回答']}});
  assert.equal(normalizeConversation(raw).questionGroups[1].questions[0].answer,'回答');
});

test('原生已答记录留在原时间位置，兼容两种答案格式并隐藏保密答案',()=>{
  const response={id:'response',type:'userInputResponse',requestId:9,completed:true,questions:[{id:'q',question:'选择方案'},{id:'secret',title:'填写密钥',isSecret:true}],answers:{q:['甲','乙'],secret:{answers:['仅测试保密内容']}}};
  const raw={id:'thread',requests:[],turns:[{turnId:'turn',status:'completed',items:[{id:'before',type:'agentMessage',text:'请确认方案'},response,{id:'after',type:'agentMessage',text:'收到，继续执行'},response]}]};
  const snapshot=normalizeConversation(raw);
  assert.deepEqual(snapshot.messages.map(message=>message.id),['before','response','after']);
  assert.equal(snapshot.messages[1].role,'user');assert.equal(snapshot.messages[1].text,'选择方案\n回答：甲、乙\n\n填写密钥\n回答：已填写');
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/仅测试保密内容/);assert.equal(snapshot.questionGroups[0].state,'answered');
  response.completed=false;
  assert.deepEqual(normalizeConversation(raw).messages.map(message=>message.id),['before','after']);
  assert.equal(normalizeConversation(raw).questionGroups[0].state,'expired');
});

test('异步问答空闲时开始下一轮，运行中追加，保留题目身份与原会话设置',async()=>{
  for(const active of [false,true]) {const raw=state();if(active)raw.turns[0].status='inProgress';const client=new Fixture(raw),adapter=new DesktopAdapter({client});
    try {await adapter.operate('question.reply',answerParams(normalizeConversation(raw)),'cmd','phone');const call=client.calls[0];assert.equal(call.method,active?'thread-follower-steer-turn':'thread-follower-start-turn');const input=active?call.params.input:call.params.turnStart.request.input;assert.match(input[0].text,/questionItemId/);assert.match(input[0].text,/自定义/);assert.equal(call.params.turnStart?.request.sandboxPolicy,undefined);}
    finally {adapter.close();}
  }
});

test('原生问答保留数字请求编号；不完整、伪造选项和过期题组均不调用桌面',async()=>{
  const raw={...state(),turns:[],requests:[{id:17,method:'item/tool/requestUserInput',params:{turnId:'turn',questions:[{id:'q',question:'题目',isOther:false,options:[{label:'甲',description:'说明'},{label:'乙'}]}]}}]};
  const client=new Fixture(raw),adapter=new DesktopAdapter({client});const params={threadId:'thread',questionGroupId:'native:17',turnId:'turn',answers:[{questionId:'q',text:'乙'}]};
  try {
    await assert.rejects(adapter.operate('question.reply',{...params,answers:[]},'c','p'),e=>e.code==='BAD_ANSWERS');
    await assert.rejects(adapter.operate('question.reply',{...params,answers:[{questionId:'q',text:'伪造'}]},'c','p'),e=>e.code==='BAD_ANSWERS');
    await adapter.operate('question.reply',params,'c','p');assert.equal(client.calls[0].method,'thread-follower-submit-user-input');assert.equal(client.calls[0].params.requestId,17);assert.deepEqual(client.calls[0].params.response,{answers:{q:{answers:['乙']}}});
    raw.requests=[];await assert.rejects(adapter.operate('question.reply',params,'c','p'),e=>e.code==='STALE_QUESTION');assert.equal(client.calls.length,1);
  } finally {adapter.close();}
});

test('回答状态通过增量同步，游标不一致要求重取；协议要求会话和题组目标',()=>{
  const before=normalizeConversation(state());before.messages[0].text='长消息'.repeat(4000);const next=structuredClone(before);next.questionGroups[0].state='answered';next.questionGroups[0].questions[0].answer='乙';
  const event={...conversationUpdate({snapshot:before,seq:1},next),epoch:'epoch',seq:2};assert.equal(event.kind,'delta');assert.equal(applyConversationUpdate({snapshot:before,epoch:'epoch',seq:1},event).snapshot.questionGroups[0].state,'answered');assert.equal(applyConversationUpdate({snapshot:before,epoch:'old',seq:1},event),null);
  assert.throws(()=>validateRequest({v:1,type:'request',requestId:'a'.repeat(20),method:'question.reply',params:{threadId:'t'}}));
});

test('题组占位跨设备和进程防重复，确定失败可修正后再答，未知结果禁止补发',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-questions-')),file=path.join(dir,'journal.sqlite');let journal=new Journal(file),count=0;const params={threadId:'t',questionGroupId:'g'};
  try {
    await journal.execute('p','c','question.reply',params,()=>{count++;return {ok:true};});
    await journal.execute('p','c','question.reply',params,()=>{count++;});
    await assert.rejects(journal.execute('other','c2','question.reply',params,()=>{count++;}),e=>e.code==='QUESTION_SUBMITTED');
    journal.close();journal=new Journal(file);
    await assert.rejects(journal.execute('p','c3','question.reply',params,()=>{count++;}),e=>e.code==='QUESTION_SUBMITTED');assert.equal(count,1);
    const invalid={threadId:'t',questionGroupId:'invalid'};
    await assert.rejects(journal.execute('p','c4','question.reply',invalid,()=>{throw new BridgeError('BAD_ANSWERS','错误答案');}));
    await journal.execute('p','c5','question.reply',invalid,()=>({ok:true}));
    const unknown={threadId:'t',questionGroupId:'unknown'};
    await assert.rejects(journal.execute('p','c6','question.reply',unknown,()=>{throw new Error('IPC 请求超时');}),e=>e.outcomeUnknown);
    await assert.rejects(journal.execute('p','c7','question.reply',unknown,()=>{count++;}),e=>e.code==='QUESTION_SUBMITTED');assert.equal(count,1);
  } finally {journal.close();fs.rmSync(dir,{recursive:true});}
});
