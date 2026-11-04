import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readHistoricalActivity} from '../apps/bridge/history-activity.mjs';
import {StateReader} from '../apps/bridge/state-reader.mjs';

/** 隔离合成历史和索引，文件清理始终限于当前测试创建的临时目录。 */
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-history-activity-')),sessions=path.join(directory,'sessions'),id=randomUUID();
  fs.mkdirSync(sessions);const file=path.join(sessions,'synthetic.jsonl');
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const write=(records=[],tail='')=>fs.writeFileSync(file,[{type:'session_meta',payload:{id}},...records].map(row=>JSON.stringify(row)+'\n').join('')+tail);
  const row={id,rollout_path:file};
  return {directory,sessions,id,file,row,write,read:()=>readHistoricalActivity(row,sessions)};
}
const event=(type,turnId='turn-one',extra={})=>({type:'event_msg',payload:{type,turn_id:turnId,...extra}});
const unavailable=error=>error.code==='HISTORY_UNAVAILABLE';

test('较长官方元数据头按需有界补读，超出头部上限仍保持未知',t=>{
  const f=fixture(t);
  const write=length=>fs.writeFileSync(f.file,JSON.stringify({type:'session_meta',payload:{id:f.id,notes:'合成说明'.repeat(length)}})+'\n'+JSON.stringify(event('task_complete','large-header-turn'))+'\n');
  write(3000);assert.deepEqual(f.read(),{status:'completed',turnId:'large-header-turn'});
  write(40000);assert.deepEqual(f.read(),{status:'unknown'});
});

test('历史尾部仅按明确任务事件返回启动、完成、中断和失败，以最后事件为准',t=>{
  const f=fixture(t);
  for(const [type,status] of [['task_started','active'],['task_complete','completed'],['turn_aborted','interrupted'],['task_failed','failed']]) {
    f.write([event('task_started','old-turn'),event(type,'current-turn',{thread_id:f.id})]);
    assert.deepEqual(f.read(),{status,turnId:'current-turn'});
  }
  f.write([event('task_complete','old-turn'),event('task_started','new-turn')]);
  assert.deepEqual(f.read(),{status:'active',turnId:'new-turn'});
});

test('最终回复、普通文本和错误会话事件不能猜终态，不完整尾帧保持未知',t=>{
  const f=fixture(t),agentMessage={type:'event_msg',payload:{type:'agent_message',message:'合成最终回复'}};
  f.write([agentMessage]);assert.deepEqual(f.read(),{status:'unknown'});
  f.write([event('task_started'),agentMessage,{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'task_complete'}]}}]);
  assert.deepEqual(f.read(),{status:'active',turnId:'turn-one'});
  f.write([event('task_complete','wrong-turn',{thread_id:randomUUID()}),event('task_failed',undefined,{turn_id:null})]);
  assert.deepEqual(f.read(),{status:'unknown'});
  f.write([],JSON.stringify(event('task_complete')));assert.deepEqual(f.read(),{status:'unknown'});
  f.write([], '{"type":"event_msg","payload":{"type":"task_complete"');assert.deepEqual(f.read(),{status:'unknown'});
});

test('历史身份不匹配、目录外路径及非jsonl文件均拒绝',t=>{
  const f=fixture(t);f.write([event('task_complete')]);
  assert.throws(()=>readHistoricalActivity({...f.row,id:randomUUID()},f.sessions),unavailable);
  const outside=path.join(f.directory,'outside.jsonl');fs.copyFileSync(f.file,outside);
  assert.throws(()=>readHistoricalActivity({...f.row,rollout_path:outside},f.sessions),unavailable);
  const wrongExtension=path.join(f.sessions,'synthetic.txt');fs.copyFileSync(f.file,wrongExtension);
  assert.throws(()=>readHistoricalActivity({...f.row,rollout_path:wrongExtension},f.sessions),unavailable);
  assert.throws(()=>readHistoricalActivity({...f.row,rollout_path:path.join(f.sessions,'missing.jsonl')},f.sessions),unavailable);
});

test('大文件仅只读头部4KiB和尾部64KiB，不投影或全量扫描正文',t=>{
  const f=fixture(t);f.write([event('task_started'),{type:'response_item',payload:{type:'message',text:'合成正文'.repeat(100000)}},event('task_complete','tail-turn')]);
  const originalRead=fs.readSync,originalOpen=fs.openSync,reads=[],flags=[];
  t.mock.method(fs,'readSync',(...args)=>{reads.push({length:args[3],position:args[4]});return originalRead(...args);});
  t.mock.method(fs,'openSync',(...args)=>{flags.push(args[1]);return originalOpen(...args);});
  assert.deepEqual(f.read(),{status:'completed',turnId:'tail-turn'});
  assert.deepEqual(flags,['r']);assert.equal(reads.length,2);
  assert.ok(reads[0].length<=4096);assert.equal(reads[0].position,0);
  assert.ok(reads[1].length<=65536);assert.ok(reads[1].position>0);
  assert.ok(reads.reduce((sum,row)=>sum+row.length,0)<=4096+65536);
});

test('StateReader从未归档索引读取指定会话，不修改索引或历史文件',t=>{
  const f=fixture(t);f.write([event('task_complete','saved-turn')]);
  const db=new DatabaseSync(path.join(f.directory,'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,archived INTEGER)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(f.id,'合成标题','/synthetic',f.file,1,0);
    const archived=randomUUID();db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(archived,'合成归档','/synthetic',f.file,1,1);
    const before=db.prepare('SELECT * FROM threads ORDER BY id').all(),history=fs.readFileSync(f.file,'utf8'),reader=new StateReader(f.directory);
    assert.deepEqual(reader.historyActivity(f.id),{status:'completed',turnId:'saved-turn'});
    assert.throws(()=>reader.historyActivity(archived),error=>error.code==='THREAD_NOT_FOUND');
    assert.throws(()=>reader.historyActivity(randomUUID()),error=>error.code==='THREAD_NOT_FOUND');
    assert.deepEqual(db.prepare('SELECT * FROM threads ORDER BY id').all(),before);assert.equal(fs.readFileSync(f.file,'utf8'),history);
  } finally {db.close();}
});
