import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { historicalSnapshot,readHistoricalSnapshot } from '../apps/bridge/history-reader.mjs';
import { StateReader } from '../apps/bridge/state-reader.mjs';

const row={id:'thread',title:'历史会话',cwd:'C:/project',updatedAt:123};
const item=(type,id,content)=>({type:'event_msg',payload:{type:'item_completed',thread_id:'thread',turn_id:'turn',item:{type,id,content}}});

test('历史保留消息阶段，按轮次合并并只从明确完成事件恢复完成状态和耗时',()=>{
  const progress=item('AgentMessage','p',[{text:'执行中'}]);progress.payload.item.phase='commentary';
  const final=item('AgentMessage','f',[{text:'最终报告'}]);final.payload.item.phase='final_answer';
  const event=(type,turn_id,extra={})=>({type:'event_msg',payload:{type,turn_id,...extra}});
  const records=[event('task_started','turn'),item('UserMessage','u',[{text:'问题'}]),progress,final,event('task_complete','turn',{duration_ms:170000}),event('task_started','next')];
  const next=item('AgentMessage','next-final',[{text:'未确认结束的报告'}]);next.payload.turn_id='next';next.payload.item.phase='final_answer';records.push(next);
  const result=historicalSnapshot(row,records);
  assert.deepEqual(result.turns,[{turnId:'turn',status:'completed',durationMs:170000},{turnId:'next',status:'inProgress'}]);
  assert.deepEqual(result.messages.map(message=>message.phase),[undefined,'commentary','final_answer','final_answer']);
  assert.equal(result.status,'unknown');assert.equal(result.activeTurnId,'');assert.equal(result.readOnly,true);
  const old=historicalSnapshot(row,[final]);assert.equal(old.turns[0].status,'');
  const interrupted=historicalSnapshot(row,[progress,final,event('task_complete','turn'),event('turn_aborted','turn')]);assert.equal(interrupted.turns[0].status,'interrupted');
});

test('已完成过程内的原生问答在历史原位置保留，密文回答仍隐藏',()=>{
  const answer=item('UserInputResponse','answer',[]);
  Object.assign(answer.payload.item,{request_id:1,completed:true,questions:[{id:'q',question:'是否继续'},{id:'secret',question:'密文',is_secret:true}],answers:{q:['继续'],secret:{answers:['不能展示的秘密']}}});
  const result=historicalSnapshot(row,[item('UserMessage','u',[{text:'开始'}]),answer,item('AgentMessage','f',[{text:'报告'}])]);
  assert.deepEqual(result.messages.map(message=>message.id),['u','answer','f']);assert.match(result.messages[1].text,/回答：继续/);assert.match(result.messages[1].text,/已填写/);assert.equal(JSON.stringify(result).includes('不能展示的秘密'),false);
});

test('后台历史只展示可见完成项，去重且不暴露提示词或推理，不冒充当前状态',()=>{
  const hidden=item('AgentMessage','hidden',[{text:'隐藏推理'}]);hidden.payload.item.phase='analysis';
  const records=[{type:'response_item',payload:{type:'message',role:'developer',content:[{text:'内部提示'}]}},item('UserMessage','u',[{text:'用户消息'}]),item('AgentMessage','a',[{text:'旧回复'}]),item('Reasoning','r',[{text:'内部推理'}]),hidden,item('AgentMessage','a',[{text:'最新回复'}]),{type:'event_msg',payload:{type:'user_message',message:'重复旧事件'}},{type:'event_msg',payload:{type:'task_started',turn_id:'running'}},{type:'event_msg',payload:{type:'item_completed',thread_id:'other',item:{type:'UserMessage',id:'foreign',content:[{text:'其他会话'}]}}}];
  const result=historicalSnapshot(row,records);assert.deepEqual(result.messages.map(m=>m.text),['用户消息','最新回复']);assert.equal(result.readOnly,true);assert.equal(result.status,'unknown');assert.equal(result.activeTurnId,'');assert.deepEqual(result.approvals,[]);assert.deepEqual(result.questionGroups,[]);assert.equal(result.updatedAt,123);
});

test('兼容旧消息事件并限制手机历史大小',()=>{
  const records=Array.from({length:100},(_,ordinal)=>({type:'event_msg',ordinal,payload:{type:ordinal%2?'agent_message':'user_message',message:'消息'+ordinal}}));
  const result=historicalSnapshot(row,records);assert.equal(result.messages.length,80);assert.equal(result.messages[0].text,'消息20');assert.equal(result.messages.at(-1).text,'消息99');
});

test('真实持久化格式的文件字典和命令输出可在历史详情展示',()=>{
  const change=item('FileChange','file',[]);change.payload.item.changes={'src/app.mjs':{type:'update',unified_diff:'差异'}};
  const command=item('CommandExecution','command',[]);Object.assign(command.payload.item,{command:['node','--test'],aggregated_output:'检查通过'});
  const result=historicalSnapshot(row,[change,command]);assert.equal(result.messages[0].summary,'src/app.mjs');assert.match(result.messages[0].text,/update src\/app.mjs/);assert.equal(result.messages[1].text,'node --test\n检查通过');
});

/** 用隔离索引和日志验证只读路径边界及会话身份，不修改真实 Codex 文件。 */
test('只读索引定位历史，拒绝归档、跨目录、会话身份错误并忽略损坏末行',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-background-history-')),sessions=path.join(directory,'sessions');fs.mkdirSync(sessions);
  const file=path.join(sessions,'thread.jsonl'),db=new DatabaseSync(path.join(directory,'state_5.sqlite'));
  const content=[{type:'session_meta',payload:{id:'thread'}},item('UserMessage','u',[{text:'历史消息'}])].map(JSON.stringify).join('\n')+'\n{"unfinished';
  try {
    fs.writeFileSync(file,content);db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER)');
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run('thread','标题','C:/project',file,1,0);
    const reader=new StateReader(directory),result=reader.readHistory('thread');assert.equal(result.messages[0].text,'历史消息');assert.equal(fs.readFileSync(file,'utf8'),content);assert.equal(reader.containsThread('thread'),true);assert.equal(reader.containsThread("' OR 1=1 --"),false);
    assert.throws(()=>reader.readHistory("' OR 1=1 --"),error=>error.code==='THREAD_NOT_FOUND');
    assert.throws(()=>readHistoricalSnapshot({...row,id:'other',rollout_path:file},sessions),error=>error.code==='HISTORY_ID_MISMATCH');
    const outside=path.join(directory,'outside.jsonl');fs.writeFileSync(outside,content);
    assert.throws(()=>readHistoricalSnapshot({...row,rollout_path:outside},sessions),error=>error.code==='HISTORY_UNAVAILABLE');
    db.prepare('UPDATE threads SET archived=1').run();assert.throws(()=>reader.readHistory('thread'),error=>error.code==='THREAD_NOT_FOUND');assert.equal(reader.containsThread('thread'),false);
  } finally {db.close();fs.rmSync(directory,{recursive:true});}
});
