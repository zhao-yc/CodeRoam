import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 执行真实展示链路；合成协议不包含真实任务、会话、设备或指令。 */
function fixture(){
  const context=componentContext({});
  for(const module of ['annotations','message-attachments','message-presentations','history']){
    const source=fs.readFileSync('apps/mobile/services/'+module+'.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
    vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'}),context);
  }
  vm.runInContext('globalThis.api={heartbeatMessageText,presentConversationMessages,mergeHistoryMessages}',context);
  return {context,...context.api};
}
const output=(body='示例检查完成，获得 512 MB 流量。',decision='NOTIFY')=>`<heartbeat>\n  <automation_id>synthetic-check</automation_id>\n  <decision>${decision}</decision>\n  <message>${body}</message>\n</heartbeat>`;
const input=body=>`<heartbeat>\n  <automation_id>synthetic-check</automation_id>\n  <current_time_iso>2026-01-01T00:00:00.000Z</current_time_iso>\n  <instructions>\n${body}\n  </instructions>\n</heartbeat>`;
const message=(id,role,text,status='completed')=>({id,role,text,status,turnId:'synthetic-turn',kind:role==='assistant'?'agentMessage':'userMessage'});

test('自动任务回复只展示通知正文，支持换行与Markdown，不泄露协议元数据',()=>{
  const f=fixture(),body='示例检查已完成。\n\n- 结果：**成功**\n- 下一次继续检查。';
  for(const newline of ['\n','\r\n']){
    const source=output(body).replaceAll('\n',newline),expected=body.replaceAll('\n',newline);
    assert.equal(f.heartbeatMessageText(source,'assistant'),expected);
    const presented=f.presentConversationMessages([message('answer','assistant',source)])[0];
    assert.equal(presented.text,expected);assert.doesNotMatch(presented.text,/<heartbeat>|automation_id|<decision>|<message>/);
  }
});

test('任务触发只保留实际指令，展示解析不改变原始消息或历史合并正文',()=>{
  const f=fixture(),instructions='每天检查示例项目。\n\n检查失败时报告原因，不重复提交。',source=input(instructions);
  const messages=[Object.freeze(message('prompt','user',source)),Object.freeze(message('answer','assistant',output()))];Object.freeze(messages);
  assert.equal(f.presentConversationMessages(messages)[0].text,instructions);
  assert.equal(messages[0].text,source);assert.equal(messages[1].text,output());
  const merged=f.mergeHistoryMessages([],messages);assert.equal(merged[0].text,source);assert.equal(merged[1].text,output());
});

test('普通XML、围栏、行内与缩进代码、引用及包含前后正文的示例保持原文',()=>{
  const f=fixture(),wrapped=output();
  for(const source of ['```xml\n'+wrapped+'\n```','`'+wrapped+'`','    '+wrapped.replaceAll('\n','\n    '),'> '+wrapped.replaceAll('\n','\n> '),'示例：\n'+wrapped,wrapped+'\n这是后续说明','<message>普通XML</message>']){
    assert.equal(f.heartbeatMessageText(source,'assistant'),source);assert.equal(f.heartbeatMessageText(source,'user'),source);
  }
  assert.equal(f.heartbeatMessageText(wrapped,'tool'),wrapped);
});

test('缺失字段、未知决策与损坏的已完成包装保留原文，不误吞真实内容',()=>{
  const f=fixture();
  for(const source of [output().replace('</heartbeat>',''),output().replace('<automation_id>synthetic-check</automation_id>',''),output('', 'NOTIFY'),output('原文','UNKNOWN'),output().replace('</message>',''),input('指令').replace('</instructions>','')]){
    const role=source.includes('<instructions>')?'user':'assistant';assert.equal(f.heartbeatMessageText(source,role),source);
  }
});

test('流式包装先等待完整通知，不闪现协议；结束后仍损坏则恢复原文',()=>{
  const f=fixture(),full=output('正在完成合成检查'),prefix=full.slice(0,full.indexOf('</message>'));
  assert.equal(f.heartbeatMessageText(prefix,'assistant',true),'');assert.equal(f.heartbeatMessageText(prefix,'assistant',false),prefix);
  assert.equal(f.presentConversationMessages([message('stream','assistant',prefix,'inProgress')])[0].text,'');
  assert.equal(f.presentConversationMessages([message('stream','assistant',full)])[0].text,'正在完成合成检查');
  assert.equal(f.heartbeatMessageText(output('','SKIP'),'assistant'),'');
});

test('复制最新回复与屏幕使用同一份展示正文，任务包装和注释标记均不进入剪贴板',()=>{
  const f=fixture(),copied=[],messages=[message('prompt','user',input('合成指令')),message('answer','assistant',output('只复制这句通知。'))];
  Object.assign(f.context,{closeActions(){},displayConversation:{value:{messages}},messagePresentations:{value:f.presentConversationMessages(messages)},copyText:value=>copied.push(value),notify(){}});
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8'),method=page.match(/function copyLatestReply\(\) \{[^\n]+/)[0];
  vm.runInContext(stripTypeScriptTypes(method,{mode:'transform'})+'\ncopyLatestReply();',f.context);
  assert.deepEqual(copied,['只复制这句通知。']);assert.equal(messages[1].text,output('只复制这句通知。'));
});
