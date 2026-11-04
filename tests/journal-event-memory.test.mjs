import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Journal} from '../apps/bridge/journal.mjs';
import {TaskQueue} from '../apps/bridge/task-queue.mjs';
import {BridgeError} from '../packages/protocol/contracts.mjs';

/** 临时目录只包含本用例的自有账本，清理前再次检查绝对路径和目录归属范围。 */
function files(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-journal-events-')),file=path.join(directory,'journal.sqlite'),handles=[];
  t.after(()=>{
    for(const handle of handles.reverse())try{handle.close();}catch{}
    const resolved=path.resolve(directory),parent=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('synthetic-journal-events-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return {file,open(){const journal=new Journal(file);handles.push(journal);return journal;},reader(){const db=new DatabaseSync(file,{readOnly:true});handles.push(db);return db;}};
}

test('展示事件游标跨会话单调，重放只返回目标会话，正文修改不污染保留事件',t=>{
  const journal=new Journal();t.after(()=>journal.close());
  const payload={kind:'snapshot',snapshot:{messages:[{text:'合成原始正文'}]}};
  const first=journal.append('one',payload);journal.append('two',{kind:'snapshot',snapshot:{text:'另一合成会话'}});journal.append('one',{kind:'delta',baseSeq:1,update:{text:'合成新增'}});
  payload.snapshot.messages[0].text='调用方后来修改';first.snapshot.messages.push({text:'调用方新增'});
  assert.equal(journal.latestSeq(),3);const replay=journal.replay('one',journal.epoch,0);
  assert.deepEqual(replay.map(row=>row.seq),[1,3]);assert.deepEqual(replay[0].snapshot.messages,[{text:'合成原始正文'}]);
  replay[0].snapshot.messages[0].text='重放结果后来修改';assert.equal(journal.replay('one',journal.epoch,0)[0].snapshot.messages[0].text,'合成原始正文');
  assert.deepEqual(journal.replay('one',journal.epoch,3),[]);
});

test('保留最多2000条，淘汰旧游标但允许从明确保留边界继续',t=>{
  const journal=new Journal();t.after(()=>journal.close());
  for(let index=0;index<2001;index++)journal.append('thread',{kind:'delta',baseSeq:index,update:{text:'合成片段'}});
  assert.equal(journal.latestSeq(),2001);assert.equal(journal.replay('thread',journal.epoch,0),null);
  const retained=journal.replay('thread',journal.epoch,1);assert.equal(retained.length,2000);assert.equal(retained[0].seq,2);assert.equal(retained.at(-1).seq,2001);
});

test('序列化失败不推进游标，正文不能覆盖当前展示流身份',t=>{
  const journal=new Journal();t.after(()=>journal.close());
  const event=journal.append('thread',{v:9,type:'request',epoch:'old',seq:999,threadId:'other',kind:'snapshot',snapshot:{text:'合成正文'}});
  assert.equal(event.v,1);assert.equal(event.type,'event');assert.equal(event.epoch,journal.epoch);assert.equal(event.seq,1);assert.equal(event.threadId,'thread');
  const circular={};circular.self=circular;assert.throws(()=>journal.append('thread',circular),TypeError);
  assert.equal(journal.latestSeq(),1);assert.equal(journal.replay('thread',journal.epoch,0).length,1);
});

test('4MiB硬预算按UTF8事件字节计算，单个超大事件仍推送但不冒充可重放',t=>{
  const journal=new Journal();t.after(()=>journal.close());
  for(let index=0;index<1000;index++)journal.append('thread',{kind:'snapshot',snapshot:{text:'合成'.repeat(2048)}});
  assert.ok(journal.eventBytes<=4*1024*1024);assert.ok(journal.eventRows.length<2000);assert.equal(journal.replay('thread',journal.epoch,0),null);
  const oversized=journal.append('thread',{kind:'snapshot',snapshot:{text:'合'.repeat(1500000)}});
  assert.equal(oversized.seq,1001);assert.equal(journal.eventBytes,0);assert.equal(journal.eventRows.length,0);
  assert.equal(journal.replay('thread',journal.epoch,1000),null);assert.deepEqual(journal.replay('thread',journal.epoch,1001),[]);
  journal.append('thread',{kind:'snapshot',snapshot:{text:'合成恢复窗口'}});assert.equal(journal.replay('thread',journal.epoch,1001)[0].seq,1002);
});

test('非法、未来及旧代次游标拒绝重放，关闭后清空正文并拒绝追加',()=>{
  const journal=new Journal();journal.append('thread',{kind:'snapshot',snapshot:{text:'合成正文'}});
  for(const afterSeq of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,2,'0'])assert.equal(journal.replay('thread',journal.epoch,afterSeq),null);
  assert.equal(journal.replay('thread','different-epoch',0),null);
  journal.close();assert.equal(journal.eventRows.length,0);assert.equal(journal.eventBytes,0);assert.equal(journal.replay('thread',journal.epoch,1),null);
  assert.throws(()=>journal.append('thread',{}),/已关闭/);assert.throws(()=>journal.latestSeq(),/已关闭/);journal.close();
});

test('忘记会话清除其内存事件并抬高缺口水位，不返回不完整增量',t=>{
  const journal=new Journal();t.after(()=>journal.close());
  journal.append('other',{kind:'snapshot',snapshot:{text:'合成其他会话'}});journal.append('forgotten',{kind:'snapshot',snapshot:{text:'合成已删除会话'}});journal.append('other',{kind:'delta',baseSeq:1,update:{text:'合成后续'}});
  journal.forgetThreads(['forgotten']);assert.equal(journal.replay('other',journal.epoch,0),null);assert.equal(journal.replay('forgotten',journal.epoch,0),null);
  assert.deepEqual(journal.replay('other',journal.epoch,2).map(row=>row.seq),[3]);assert.deepEqual(journal.replay('forgotten',journal.epoch,2),[]);assert.ok(journal.eventRows.every(row=>row.threadId!=='forgotten'));
  for(let index=0;index<1999;index++)journal.append('other',{kind:'delta',baseSeq:index+3,update:{text:'合成片段'}});
  assert.equal(journal.replay('other',journal.epoch,1),null,'淘汰更早的其他会话事件不能降低删除时的缺口水位');
});

test('重启更换展示epoch、清理旧events但保留命令及提交任务去重记录',async t=>{
  const f=files(t);let journal=f.open();const oldEpoch=journal.epoch;
  const queue=new TaskQueue({journal,ready:()=>false,execute:async()=>({ok:true})});
  queue.submit('phone',{taskId:'synthetic-task-123456',kind:'command',payload:{method:'turn.send',params:{threadId:'thread',text:'合成消息'}}});await queue.close();
  await journal.execute('phone','completed-command','turn.send',{threadId:'thread'},async()=>({ok:true}));
  await assert.rejects(journal.execute('phone','unknown-command','turn.send',{threadId:'thread'},async()=>{throw new BridgeError('OUTCOME_UNKNOWN','合成未知结果',true);}),error=>error.outcomeUnknown===true);
  journal.append('thread',{kind:'snapshot',snapshot:{text:'合成旧事件'}});journal.db.prepare('INSERT INTO events(thread_id,payload) VALUES (?,?)').run('thread',JSON.stringify({kind:'snapshot',snapshot:{text:'合成兼容旧表'}}));journal.close();
  journal=f.open();assert.notEqual(journal.epoch,oldEpoch);assert.equal(journal.latestSeq(),0);assert.equal(journal.replay('thread',oldEpoch,1),null);assert.equal(journal.db.prepare('SELECT count(*) AS count FROM events').get().count,0);
  assert.equal(journal.db.prepare("SELECT value FROM metadata WHERE key='epoch'").get().value,journal.epoch);assert.equal(journal.status('phone','completed-command').state,'done');assert.equal(journal.status('phone','unknown-command').state,'unknown');
  assert.equal(journal.db.prepare('SELECT state FROM submission_task_keys WHERE device_id=? AND id=?').get('phone','synthetic-task-123456').state,'queued');
  assert.deepEqual(await journal.execute('phone','completed-command','turn.send',{threadId:'thread'},async()=>{throw Error('不应再次执行已完成命令');}),{ok:true});
  await assert.rejects(journal.execute('phone','unknown-command','turn.send',{threadId:'thread'},async()=>{throw Error('不应再次执行未知命令');}),error=>error.code==='OUTCOME_UNKNOWN');
  const restoredQueue=new TaskQueue({journal,ready:()=>false,execute:async()=>({ok:true})});
  assert.equal(restoredQueue.submit('phone',{taskId:'synthetic-task-123456',kind:'command',payload:{method:'turn.send',params:{threadId:'thread',text:'合成消息'}}}).duplicate,true);await restoredQueue.close();
  const next=journal.append('thread',{kind:'snapshot',snapshot:{text:'合成新窗口'}});assert.equal(next.seq,1);assert.equal(next.epoch,journal.epoch);
});

test('每帧展示事件不访问events SQL，命令占位、检查点和完成结果在返回前可被另一连接读取',async t=>{
  const f=files(t),journal=f.open(),reader=f.reader(),prepared=[],prepare=journal.db.prepare.bind(journal.db);
  journal.db.prepare=(sql,...args)=>{prepared.push(sql);return prepare(sql,...args);};
  for(let index=0;index<10;index++)journal.append('thread',{kind:'delta',baseSeq:index,update:{text:'合成片段'}});
  assert.equal(journal.latestSeq(),10);assert.equal(journal.replay('thread',journal.epoch,0).length,10);journal.forgetThreads(['unrelated']);
  assert.equal(prepared.filter(sql=>/\bevents\b/i.test(sql)).length,0);assert.equal(reader.prepare('SELECT count(*) AS count FROM events').get().count,0);
  let invoked=0;const operation=async()=>{invoked++;assert.equal(reader.prepare('SELECT state FROM commands WHERE device_id=? AND command_id=?').get('phone','command').state,'pending');journal.checkpoint('phone','command',{threadId:'thread',created:true});assert.equal(JSON.parse(reader.prepare('SELECT payload FROM commands WHERE device_id=? AND command_id=?').get('phone','command').payload).result.created,true);return{ok:true};};
  await journal.execute('phone','command','turn.send',{threadId:'thread'},operation);assert.equal(reader.prepare('SELECT state FROM commands WHERE device_id=? AND command_id=?').get('phone','command').state,'done');
  await journal.execute('phone','command','turn.send',{threadId:'thread'},operation);assert.equal(invoked,1);
  await assert.rejects(journal.execute('phone','command','turn.send',{threadId:'different'},operation),error=>error.code==='REQUEST_ID_REUSED');
});

test('题组占位仍在外部调用前及时持久，换展示epoch后跨设备防重复且未知结果不释放',async t=>{
  const f=files(t);let journal=f.open();const reader=f.reader(),params={threadId:'thread',questionGroupId:'question'},unknown={threadId:'thread',questionGroupId:'unknown-question'};let count=0;
  await journal.execute('one','question-command','question.reply',params,async()=>{count++;assert.equal(reader.prepare('SELECT count(*) AS count FROM question_submissions WHERE thread_id=? AND group_id=?').get('thread','question').count,1);return{ok:true};});
  await assert.rejects(journal.execute('one','unknown-question-command','question.reply',unknown,async()=>{count++;throw new BridgeError('OUTCOME_UNKNOWN','合成未知结果',true);}),error=>error.outcomeUnknown===true);
  journal.close();journal=f.open();await assert.rejects(journal.execute('two','new-id','question.reply',params,async()=>{count++;}),error=>error.code==='QUESTION_SUBMITTED');await assert.rejects(journal.execute('two','new-unknown-id','question.reply',unknown,async()=>{count++;}),error=>error.code==='QUESTION_SUBMITTED');assert.equal(count,2);
});
