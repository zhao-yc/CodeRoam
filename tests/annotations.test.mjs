import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

// 执行手机实际使用的解析器，覆盖历史消息和流式消息，不维护第二套实现。
const source=fs.readFileSync('apps/mobile/services/annotations.uts','utf8').replace(/^import type .*\r?\n/gm,'');
const js=stripTypeScriptTypes(source,{mode:'strip'});
const {parseUserAnnotations:user,parseAnnotationReferences:refs,presentAnnotatedMessages:present}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const selections=[{text:'这是用于验证注释解析的合成选文。',annotation:'更新一下',source:{messageId:'sample-message',startOffset:0,endOffset:20}}];
const wrapper=(items=selections,request='')=>`# Response annotations:\nEach item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2. Include :codex-annotation{index="1"}.\n<response-annotations>\n${JSON.stringify(items)}\n</response-annotations>\n\n## My request:\n${request}`;
const marker=index=>`:codex-annotation{index="${index}"}`;
const message=(id,role,text,turnId='turn',status='completed')=>({id,role,text,turnId,status});

test('合法的完整注释包装只显示折叠入口，保留索引与评论',()=>{
  const raw=wrapper(),parsed=user(raw);
  assert.equal(parsed.text,'');
  assert.deepEqual(parsed.annotations,[{index:1,text:selections[0].text,comment:'更新一下',available:true}]);
  assert.equal(raw.includes('# Response annotations:'),true);
});
test('多条注释保留原编号、额外请求与包装前的附件说明，兼容 CRLF',()=>{
  const raw='截图附件\n\n'+wrapper([...selections,{text:'第二处选文',annotation:''}],'请一起处理\n保留这行换行');
  const parsed=user(raw.replaceAll('\n','\r\n'));
  assert.equal(parsed.text,'截图附件\n\n请一起处理\r\n保留这行换行');
  assert.deepEqual(parsed.annotations.map(a=>a.index),[1,2]);assert.equal(parsed.annotations[1].comment,'');
});
test('不完整包装、损坏 JSON 和不合法数组项整体保留，避免静默丢失',()=>{
  const bad=[wrapper().replace('</response-annotations>',''),wrapper().replace('## My request:','普通段落'),wrapper().replace('"text":','"text":broken'),wrapper({text:'不是数组'}),wrapper([null]),wrapper([{text:4}]),wrapper([{text:'  '}]),wrapper([{text:'选文',annotation:5}]),wrapper([{text:'选文'},null])];
  for(const raw of bad){assert.equal(user(raw).text,raw);assert.deepEqual(user(raw).annotations,[]);}
});
test('普通文本、代码围栏和行内代码中的注释包装不被转换',()=>{
  for(const raw of ['普通消息\n<response-annotations>示例</response-annotations>','```text\n'+wrapper()+'\n```','`\n'+wrapper()+'\n`'])assert.equal(user(raw).text,raw);
});
test('回复移除协议标记、去重并按编号排列，其他 Markdown 和图片保留',()=>{
  const parsed=refs(`**已更新**。${marker(2)}\n\n[入口](https://example.com) ${marker(1)} ${marker(2)}\n![图](https://example.com/a.png)`);
  assert.deepEqual(parsed.indices,[1,2]);assert.doesNotMatch(parsed.text,/:codex-annotation/);
  assert.match(parsed.text,/\*\*已更新\*\*/);assert.match(parsed.text,/!\[图\]/);
});
test('行内代码、不同长度反引号、围栏、缩进代码与转义示例原样保留',()=>{
  const code=[`\`${marker(1)}\``,`\`\`${marker(2)}\`\``,`\`a\n${marker(3)}\nend\``,`\`\`\`ts\n${marker(4)}\n\`\`\``,`~~~text\n${marker(5)}\n~~~`,`    ${marker(6)}`,`\t${marker(7)}`,`\\${marker(8)}`,`> \`\`\`\n${marker(9)}\n> \`\`\``,`- \`\`\`text\n  ${marker(11)}\n  \`\`\``].join('\n\n');
  assert.deepEqual(refs(code),{text:code,indices:[]});
  assert.deepEqual(refs(code+'\n正文'+marker(10)).indices,[10]);
});
test('流式尾部协议暂缓，闭合后出现注释入口，未完成结束后保留原文',()=>{
  const complete=marker(12);
  for(let end=7;end<complete.length;end++) {
    const partial=complete.slice(0,end);
    assert.equal(refs('回复 '+partial,true).text,'回复',partial);
    assert.equal(refs('回复 '+partial,false).text,'回复 '+partial);
  }
  assert.deepEqual(refs('回复 '+complete,true),{text:'回复',indices:[12]});
  assert.equal(refs('说明 :codex-nothing',true).text,'说明 :codex-nothing');
});
test('非法编号或格式保持原文，不产生空注释入口',()=>{
  for(const value of [0,-1,'01','1.5','abc','9007199254740992'])assert.deepEqual(refs(marker(value)),{text:marker(value),indices:[]});
});
test('普通正文和代码示例末尾的空格、换行保持原样',()=>{
  for(const raw of ['普通段落  \n\n','```js\nconst value = 1;  \n',`\`${marker(1)}\`  \n`])assert.equal(refs(raw).text,raw);
});
test('同轮次使用最近携带注释的用户消息，其他轮次同编号互不串用',()=>{
  const messages=[message('u1','user',wrapper()),message('a1','assistant','已更新'+marker(1)),message('u2','user',wrapper([{text:'另一次选文',annotation:'第二条评论'}])),message('a2','assistant','再次回复'+marker(1)),message('a3','assistant','另一轮'+marker(1),'other')];
  const original=JSON.stringify(messages),result=present(messages);
  assert.equal(result[1].annotations[0].comment,'更新一下');assert.equal(result[3].annotations[0].text,'另一次选文');
  assert.equal(result[4].annotations[0].available,false);assert.equal(JSON.stringify(messages),original);
});
test('向上加载历史后补齐来源；没有轮次、未知编号与晚于回复的来源不猜测关联',()=>{
  const a=message('a','assistant','回复'+marker(1));
  assert.equal(present([a])[0].annotations[0].available,false);
  assert.equal(present([message('u','user',wrapper()),a])[1].annotations[0].available,true);
  assert.equal(present([a,message('u','user',wrapper())])[0].annotations[0].available,false);
  assert.equal(present([message('u','user',wrapper(),''),message('a','assistant',marker(1),'')])[1].annotations[0].available,false);
  assert.equal(present([message('u','user',wrapper()),message('a','assistant',marker(2))])[1].annotations[0].available,false);
});
test('流式展示隐藏未闭合尾部，但完成的损坏片段可读，图片消息不改变',()=>{
  const partial='已处理 :codex-ann';
  assert.equal(present([message('a','assistant',partial,'t','inProgress')])[0].text,'已处理');
  assert.equal(present([message('a','assistant',partial)])[0].text,partial);
  assert.equal(present([{...message('u','user',''),imageCount:2}])[0].text,'');
});
