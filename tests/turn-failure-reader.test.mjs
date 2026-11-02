import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StateReader} from '../apps/bridge/state-reader.mjs';

/** 模拟默认读取块被长内部记录截断，确保空失败页不会被“跳过空页”逻辑吞掉。 */
test('索引读取保留只有失败元数据的中间页，不跳回更早的普通消息', t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'failure-page-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const sessions=path.join(home,'sessions');fs.mkdirSync(sessions);
  const file=path.join(sessions,'synthetic.jsonl');
  fs.writeFileSync(file,[
    {type:'session_meta',payload:{id:'thread'}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'older'}},
    {type:'event_msg',payload:{type:'user_message',turn_id:'older',message:'合成早期消息'}},
    {type:'internal_fixture',payload:'x'.repeat(9*1024*1024)},
    {type:'event_msg',payload:{type:'task_started',turn_id:'failed'}},
    {type:'event_msg',payload:{type:'task_failed',turn_id:'failed',error:{message:'Synthetic failure'}}}
  ].map(record=>JSON.stringify(record)).join('\n')+'\n');
  const db=new DatabaseSync(path.join(home,'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,archived INTEGER)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0)').run('thread','合成会话','/example/project',file,1);
  } finally {db.close();}
  const page=new StateReader(home).readHistory('thread',{page:true});
  assert.equal(page.messages.length,0);
  assert.equal(page.turns[0].turnId,'failed');
  assert.equal(page.turns[0].errorMessage,'Synthetic failure');
  assert.equal(page.hasMore,true);
});
