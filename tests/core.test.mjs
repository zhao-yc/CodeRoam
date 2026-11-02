import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameDecoder, encodeFrame } from '../packages/protocol/ipc-client.mjs';
import { applyPatches, normalizeConversation } from '../apps/bridge/conversation.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { validateRequest } from '../packages/protocol/contracts.mjs';

test('IPC 长度帧兼容逐字节拆包及多消息粘包',()=>{
  const actual=[];const decoder=new FrameDecoder(message=>actual.push(message));const frames=Buffer.concat([encodeFrame({text:'中文消息'}),encodeFrame({id:2})]);
  for(const byte of frames)decoder.push(Buffer.from([byte]));assert.deepEqual(actual,[{text:'中文消息'},{id:2}]);
});
test('IPC 拒绝空帧和超过上限的长度',()=>{const decoder=new FrameDecoder(()=>{},8);assert.throws(()=>decoder.push(Buffer.alloc(4)));const frame=Buffer.alloc(4);frame.writeUInt32LE(9);assert.throws(()=>decoder.push(frame));});
test('补丁支持数组插入移除并阻断原型链污染',()=>{
  const state={messages:[{text:'旧'}]};applyPatches(state,[{op:'add',path:['messages',1],value:{text:'新'}},{op:'replace',path:['messages',0,'text'],value:'已更新'},{op:'remove',path:['messages',1]}]);assert.deepEqual(state,{messages:[{text:'已更新'}]});
  assert.throws(()=>applyPatches(state,[{op:'add',path:['__proto__','polluted'],value:true}]));assert.equal({}.polluted,undefined);
});
test('归一化按规范时间线顺序读取真实类型消息和待审批请求',()=>{
  const state={id:'t',title:'测试',turns:[],threadRuntimeStatus:{type:'active'},turnHistory:{history:{entitiesByKey:{a:{turnId:'turn-a',status:'inProgress',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'用户消息'}]},{id:'a',type:'agentMessage',text:'实时输出'}]}},islands:[{entries:[{value:'a'}]}]}},requests:[{id:7,method:'item/commandExecution/requestApproval',params:{turnId:'turn-a',command:'echo test'}}]};
  const result=normalizeConversation(state);assert.equal(result.messages.length,2);assert.equal(result.messages[1].text,'实时输出');assert.equal(result.activeTurnId,'turn-a');assert.equal(result.approvals[0].id,'7');
});
test('归一化保留命令执行和文件变更的真实显示类型',()=>{
  const state={id:'t',turns:[{turnId:'turn',items:[{id:'command',type:'commandExecution',command:'node --test',aggregatedOutput:'通过'},{id:'file',type:'fileChange',changes:[{kind:{type:'update'},path:'src/app.mjs'}]}]}]};
  const result=normalizeConversation(state);
  assert.deepEqual(result.messages.map(({role,kind,text})=>({role,kind,text})),[{role:'tool',kind:'commandExecution',text:'node --test\n通过'},{role:'tool',kind:'fileChange',text:'update src/app.mjs'}]);
});
test('文件摘要仅来自真实变更路径，支持多文件并限制显示长度',()=>{
  const longPath='src/'+'长目录/'.repeat(80)+'app.mjs';
  const items=[{id:'command',type:'commandExecution',command:'echo src/假路径.mjs'},{id:'single',type:'fileChange',changes:[{path:'E:/git/project/src/app.mjs'}]},{id:'multi',type:'fileChange',changes:[{path:'src/first.mjs'},{path:'src/second.mjs'}]},{id:'long',type:'fileChange',changes:[{path:longPath}]}];
  const result=normalizeConversation({id:'t',turns:[{items}]}).messages;
  assert.equal(result[0].summary,'echo src/假路径.mjs');
  assert.equal(result[1].summary,'E:/git/project/src/app.mjs');
  assert.equal(result[2].summary,'src/first.mjs 等2个文件');
  assert.equal(result[3].summary,longPath.slice(0,240));assert.equal(result[3].summary.length,240);
});
test('命令摘要来自原始命令，长日志截断和缺少命令时不误用输出',()=>{
  const items=[
    {id:'long',type:'commandExecution',command:'node\n  --test\t tests/core.test.mjs',aggregatedOutput:'模拟输出\n'.repeat(3000)},
    {id:'limit',type:'commandExecution',command:'echo '+'很长的参数'.repeat(100)},
    {id:'legacy',type:'commandExecution',aggregatedOutput:'这不是命令'},
    {id:'empty',type:'commandExecution',command:'   ',output:'输出内容'}
  ];
  const result=normalizeConversation({id:'t',turns:[{items}]}).messages;
  assert.equal(result[0].summary,'node --test tests/core.test.mjs');
  assert.equal(result[0].text.length,10000);assert.ok(!result[0].text.includes('node'));
  assert.equal(result[1].summary,items[1].command.slice(0,240));
  assert.equal(Object.hasOwn(result[2],'summary'),false);assert.equal(Object.hasOwn(result[3],'summary'),false);
});
test('协议仅允许固定接口并校验操作目标',()=>{assert.throws(()=>validateRequest({v:1,type:'request',requestId:'a'.repeat(20),method:'shell.exec',params:{}}));assert.throws(()=>validateRequest({v:1,type:'request',requestId:'a'.repeat(20),method:'turn.stop',params:{}}));});
test('写操作相同编号只执行一次，参数改变时拒绝复用',async()=>{
  const journal=new Journal();let count=0;const operation=()=>{count++;return {ok:true};};
  await journal.execute('phone','id','turn.send',{text:'第一次'},operation);await journal.execute('phone','id','turn.send',{text:'第一次'},operation);assert.equal(count,1);
  await assert.rejects(journal.execute('phone','id','turn.send',{text:'修改'},operation),error=>error.code==='REQUEST_ID_REUSED');journal.close();
});
test('进程重启后未完成操作保持未知，禁止自动补发',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-mobile-journal-'));const file=path.join(directory,'test.sqlite');
  const first=new Journal(file);first.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run('p','c','x','pending',null);first.close();
  const next=new Journal(file);assert.equal(next.status('p','c').state,'unknown');next.close();fs.rmSync(directory,{recursive:true});
});
test('事件补发使用 epoch 和游标，超出保留范围需要重取快照',()=>{
  const journal=new Journal();journal.append('t',{kind:'snapshot',snapshot:{text:'a'}});journal.append('t',{kind:'snapshot',snapshot:{text:'b'}});
  assert.equal(journal.replay('t',journal.epoch,1)[0].snapshot.text,'b');assert.equal(journal.replay('t','旧实例',0),null);journal.close();
});
