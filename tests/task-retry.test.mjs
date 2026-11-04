import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Journal} from '../apps/bridge/journal.mjs';
import {TaskQueue} from '../apps/bridge/task-queue.mjs';
import {BridgeError} from '../packages/protocol/contracts.mjs';

/** 保留真实数据库、命令去重和步骤检查点，仅替换桌面动作。 */
function fixture(t,execute,options={}){const journal=new Journal(),queue=new TaskQueue({journal,execute:(...args)=>execute(journal,...args),...options});t.after(async()=>{await queue.close();journal.close();});return {journal,queue};}
const command=(method='thread.settings.update')=>({taskId:randomUUID(),kind:'command',payload:{method,params:method==='thread.settings.update'?{threadId:'synthetic-thread',changes:{effort:'high'}}:{threadId:'synthetic-thread'}}});
const retry=(queue,taskId,expectedAttempt=0,device='phone')=>queue.control(device,{taskId,action:'retry',confirmed:true,expectedAttempt});

test('明确失败重试原位置并使用新命令，成功后继续后续任务，重复原提交仍去重',async t=>{
 let fail=true;const calls=[];
 const f=fixture(t,async(journal,task)=>journal.execute(task.deviceId,task.commandId,task.payload.method,task.payload.params,async()=>{calls.push(task.commandId);if(fail){fail=false;throw new BridgeError('SYNTHETIC_FAILURE','合成暂时失败');}return {ok:true};}));
 const first=command(),next=command();f.queue.submit('phone',first);f.queue.submit('phone',next);await f.queue.pump();
 assert.equal(f.queue.list('phone').tasks[0].canRetry,true);assert.equal(calls.length,1);
 await retry(f.queue,first.taskId);await f.queue.pump();
 assert.equal(calls.length,3);assert.equal(calls[0],first.taskId);assert.notEqual(calls[1],first.taskId);assert.equal(calls[2],next.taskId);
 const result=f.queue.list('phone',{taskId:first.taskId}).tasks[0];assert.equal(result.state,'succeeded');assert.equal(result.attempt,1);assert.equal(result.position,1);assert.equal(result.canRetry,false);assert.equal(f.queue.row('phone',first.taskId).payload,null);
 assert.equal(f.journal.status('phone',first.taskId).error.code,'SYNTHETIC_FAILURE');assert.equal(f.queue.submit('phone',first).duplicate,true);await f.queue.pump();assert.equal(calls.length,3);
});

test('再次失败后旧尝试、其他设备、未知结果及其他暂停原因均不能触发重试',async t=>{
 let unknown=false,calls=0;const f=fixture(t,async()=>{calls++;throw new BridgeError(unknown?'OUTCOME_UNKNOWN':'SYNTHETIC_FAILURE','合成失败',unknown);});
 const first=command();f.queue.submit('phone',first);await f.queue.pump();
 await assert.rejects(retry(f.queue,first.taskId,0,'other'),{code:'TASK_NOT_FOUND'});
 await retry(f.queue,first.taskId);await f.queue.pump();assert.equal(calls,2);
 await assert.rejects(retry(f.queue,first.taskId),{code:'TASK_RETRY_STALE'});assert.equal(calls,2);
 unknown=true;await retry(f.queue,first.taskId,1);await f.queue.pump();assert.equal(f.queue.list('phone').tasks[0].canRetry,false);
 await assert.rejects(retry(f.queue,first.taskId,2),{code:'TASK_RETRY_UNAVAILABLE'});
 const older=command();f.queue.submit('phone',older);f.journal.db.prepare("UPDATE submission_tasks SET state='failed',completed_at=? WHERE id=?").run(Date.now(),older.taskId);
 await assert.rejects(retry(f.queue,older.taskId),{code:'TASK_NOT_BLOCKER'});assert.equal(f.queue.list('phone').paused,true);
});

test('组合任务重试保留已成功创建检查点，只重做失败步骤且附件租约持续有效',async t=>{
 let created=0,applied=0,sent=0;const ids=[];
 const f=fixture(t,async(journal,task,context)=>{
  const result=await context.step('创建聊天',async()=>{created++;return {threadId:'synthetic-created'};});
  assert.equal(result.threadId,'synthetic-created');context.retainScope('synthetic-created');
  await context.step('应用设置',id=>journal.execute(task.deviceId,id,'thread.settings.update',{threadId:result.threadId},async()=>{ids.push(id);if(++applied===1)throw new BridgeError('SYNTHETIC_FAILURE','合成设置失败');return {ok:true};}));
  await context.step('发送首条消息',async()=>{sent++;return {ok:true};});return {ok:true,threadId:result.threadId};
 });
 const taskId=randomUUID();f.queue.submit('phone',{taskId,kind:'newConversation',payload:{projectId:'synthetic-project',mode:'desktopIpc',text:'合成消息',images:[],attachments:[],choices:{}}});await f.queue.pump();
 assert.equal(created,1);assert.equal(sent,0);assert.equal(f.queue.holdsScope('synthetic-created','phone'),true);
 await retry(f.queue,taskId);await f.queue.pump();assert.equal(created,1);assert.equal(applied,2);assert.equal(sent,1);assert.notEqual(ids[0],ids[1]);assert.equal(f.queue.holdsScope('synthetic-created','phone'),false);
});

test('旧版已清理的删除任务可恢复原目标，旧正文任务不猜测输入',async t=>{
 const calls=[],f=fixture(t,async(_journal,task)=>{calls.push(task.payload);return {ok:true};},{ready:()=>false});
 const deletion=command('thread.delete'),body=command();
 for(const request of [deletion,body]){f.queue.submit('phone',request);f.journal.db.prepare("UPDATE submission_tasks SET state='failed',payload=NULL,completed_at=? WHERE id=?").run(Date.now(),request.taskId);}
 assert.equal(f.queue.list('phone',{taskId:deletion.taskId}).tasks[0].canRetry,true);assert.equal(f.queue.list('phone',{taskId:body.taskId}).tasks[0].canRetry,false);
 await retry(f.queue,deletion.taskId);f.queue.ready=()=>true;await f.queue.pump();assert.deepEqual(calls,[deletion.payload]);
});

test('失败重试数据关闭即释放，仍暂停的任务三十天后也释放，展示不含原输入',async t=>{
 let now=10000;const f=fixture(t,async()=>{throw new BridgeError('SYNTHETIC_FAILURE','合成失败');},{now:()=>now});
 const task=command();f.queue.submit('phone',task);await f.queue.pump();const row=f.queue.row('phone',task.taskId);
 assert.ok(row.payload);assert.equal('payload' in f.queue.list('phone').tasks[0],false);
 now+=31*86400000;f.queue.cleanup();assert.equal(f.queue.row('phone',task.taskId).payload,null);assert.equal(f.queue.list('phone').tasks[0].canRetry,false);assert.equal(f.queue.list('phone').paused,true);
 const second=fixture(t,async()=>{throw new BridgeError('SYNTHETIC_FAILURE','合成失败');});const request=command();second.queue.submit('phone',request);await second.queue.pump();await second.queue.control('phone',{taskId:request.taskId,action:'dismiss'});assert.equal(second.queue.row('phone',request.taskId).payload,null);
});
