import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { AttachmentStore } from '../apps/bridge/attachment-store.mjs';
import { createRelay } from '../apps/relay/server.mjs';
import { tokenHash, validTaskSnapshot } from '../packages/protocol/contracts.mjs';

/** 只模拟桌面动作，保留真实 Agent、SQLite、任务租约与协议分派。 */
function fixture(t,{operate,instance,config={}}={}){
  const journal=new Journal(),adapter=new EventEmitter(),calls=[];
  adapter.index={list:()=>[]};adapter.conversations=new Map();adapter.close=()=>{};
  adapter.readActivityInventory=async()=>({complete:true,threadIds:[]});
  if(instance)adapter.client={instance};
  adapter.watch=async(threadId,watcher)=>{const entry=adapter.conversations.get(threadId)??{watchers:new Set()};entry.watchers.add(watcher);adapter.conversations.set(threadId,entry);return {threadId,title:'合成聊天',cwd:'',messages:[],turns:[],approvals:[],questionGroups:[],status:'idle',activeTurnId:'',updatedAt:100};};
  adapter.unwatch=(threadId,watcher)=>{adapter.conversations.get(threadId)?.watchers.delete(watcher);return {ok:true};};
  adapter.operate=async(method,params,commandId,deviceId)=>{
    assert.ok(adapter.taskLeases.get(params.threadId)?.has(deviceId),'后台动作必须保留原设备业务租约');
    calls.push({method,params,commandId,deviceId});
    return operate?operate(method,params,commandId,deviceId):{ok:true,commandId,threadId:params.threadId};
  };
  const nativeDrafts=new EventEmitter();nativeDrafts.commandStatus=async(journal,deviceId,commandId)=>journal.status(deviceId,commandId);nativeDrafts.close=()=>{};
  const agent=new BridgeAgent({config,adapter,journal,nativeDrafts,newThreads:{}});clearInterval(agent.messageQueue.timer);
  t.after(()=>agent.close());
  const request=(method,params={},deviceId='synthetic-phone',extra={})=>agent.handleRequest({v:1,type:'request',requestId:randomUUID(),transportId:randomUUID(),deviceId,method,params,...extra});
  const submit=(method='turn.stop',params={threadId:'synthetic-thread'},taskId=randomUUID(),deviceId='synthetic-phone')=>request('tasks.submit',{taskId,kind:'command',payload:{method,params}},deviceId);
  return {agent,adapter,journal,calls,request,submit};
}

test('旧写接口等待领取时 command.status 返回 pending，执行结果仍保留原编号',async t=>{
  const f=fixture(t);let ready=false;f.agent.taskQueue.ready=()=>ready;
  const commandId=randomUUID(),pending=f.request('turn.stop',{threadId:'synthetic-thread'},'synthetic-phone',{requestId:commandId});
  const status=await f.request('command.status',{commandId});assert.equal(status.result.state,'pending');assert.equal(f.calls.length,0);
  assert.equal(f.journal.status('synthetic-phone',commandId).state,'not_found','等待阶段没有提前伪造桌面命令执行');
  ready=true;await f.agent.taskQueue.pump();const completed=await pending;assert.equal(completed.result.commandId,commandId);
  assert.equal((await f.request('command.status',{commandId})).result.state,'done');assert.equal(f.calls.length,1);
});

test('真实 Agent 任务快照通过中转展示校验，原设备控制隔离且退订不会撤销任务',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=fixture(t,{operate:async()=>{await gate;return {ok:true};}}),events=[];
  f.agent.send=event=>events.push(event);
  assert.equal((await f.request('tasks.watch')).result.supportsTaskQueue,true);
  const first=await f.submit(),second=await f.submit('turn.stop',{threadId:'another-thread'});assert.equal(first.result.accepted,true);assert.equal(second.result.accepted,true);
  await Promise.resolve();
  const denied=await f.request('tasks.control',{taskId:second.result.taskId,action:'cancel'},'other-phone');assert.equal(denied.error.code,'TASK_NOT_FOUND');
  const isolated=await f.request('tasks.list',{view:'active'},'other-phone');assert.deepEqual(isolated.result.tasks,[]);
  await f.request('tasks.unwatch');assert.equal(f.agent.taskQueue.watchers.has('synthetic-phone'),false);
  release();await f.agent.taskQueue.pump();assert.equal(f.calls.length,2);
  const changes=events.filter(event=>event.type==='tasks.changed');assert.ok(changes.length>0);
  for(const event of changes){assert.equal(event.deviceId,'synthetic-phone');assert.equal(validTaskSnapshot(event.snapshot),true);assert.equal(JSON.stringify(event.snapshot).includes('other-phone'),false);}
});

test('任务附件上传不依赖聊天订阅，并且只能由上传设备完成',async t=>{
  const f=fixture(t),root=mkdtempSync(path.join(tmpdir(),'synthetic-task-agent-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  f.adapter.attachments=new AttachmentStore({root});
  const taskId=randomUUID(),uploadId=randomUUID(),data=Buffer.from('合成任务附件');
  const begun=await f.request('attachment.begin',{taskId,uploadId,name:'合成.txt',size:data.length});assert.equal(begun.error,undefined);
  const wrong=await f.request('attachment.chunk',{taskId,uploadId,index:0,data:data.toString('base64')},'other-phone');assert.ok(wrong.error);
  assert.equal((await f.request('attachment.chunk',{taskId,uploadId,index:0,data:data.toString('base64')})).error,undefined);
  assert.equal((await f.request('attachment.finish',{taskId,uploadId})).result.complete,true);
  assert.equal(f.adapter.conversations.size,0);assert.equal(f.calls.length,0);
  const mixed=await f.request('attachment.begin',{taskId,threadId:'synthetic-thread',uploadId:randomUUID(),name:'合成.txt',size:1});assert.equal(mixed.error.code,'BAD_PARAMS');
});

test('原实例核验失败时不会向其他代次发送桌面写入',async t=>{
  const instance={alive:true,ready:true,generation:randomUUID(),verify:async()=>{instance.ready=false;}};
  const f=fixture(t,{instance});
  const stale=await f.request('tasks.submit',{taskId:randomUUID(),kind:'command',payload:{method:'turn.stop',params:{threadId:'synthetic-thread'}}},'synthetic-phone',{expectedGeneration:randomUUID()});
  assert.equal(stale.error.code,'INSTANCE_CHANGED');assert.equal(f.agent.taskQueue.list('synthetic-phone').tasks.length,0);
  const submitted=await f.submit();await f.agent.taskQueue.pump();assert.equal(f.calls.length,0);
  const record=f.agent.taskQueue.list('synthetic-phone',{taskId:submitted.result.taskId});assert.equal(record.tasks[0].state,'failed');assert.equal(record.paused,true);
});

/** 回环连接保留消息序列，所有鉴权令牌均为用例随机生成。 */
function inbox(socket){const rows=[],all=[],waiting=[];socket.on('error',()=>{});socket.on('message',data=>{const value=JSON.parse(data);all.push(value);const at=waiting.findIndex(item=>item.match(value));if(at<0)rows.push(value);else{const item=waiting.splice(at,1)[0];clearTimeout(item.timer);item.resolve(value);}});return{socket,all,next(match){const at=rows.findIndex(match);if(at>=0)return Promise.resolve(rows.splice(at,1)[0]);return new Promise((resolve,reject)=>{const item={match,resolve};item.timer=setTimeout(()=>reject(new Error('等待合成任务集成消息超时')),3000);waiting.push(item);});}};}

test('真实 Relay 与 BridgeAgent 确认入队后手机断开，任务仍完成且重连可查历史',async t=>{
  const hostToken=randomBytes(32).toString('base64url'),phoneToken=randomBytes(32).toString('base64url');
  const relay=createRelay({identities:[{id:'synthetic-host',role:'host',hostId:'synthetic-computer',tokenSha256:tokenHash(hostToken)},{id:'synthetic-phone',role:'mobile',hostIds:['synthetic-computer'],tokenSha256:tokenHash(phoneToken)}]});
  const address=await relay.listen();t.after(()=>relay.close());const url=`ws://127.0.0.1:${address.port}/ws`;
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=fixture(t,{config:{relayUrl:url,token:hostToken,hostId:'synthetic-computer'},operate:async()=>{await gate;return {ok:true,threadId:'synthetic-thread'};}});
  const connected=new Promise(resolve=>f.agent.once('connected',resolve));f.agent.start();await connected;
  const connect=async()=>{const phone=inbox(new WebSocket(url,{headers:{Authorization:`Bearer ${phoneToken}`}}));await phone.next(value=>value.type==='welcome');return phone;};
  const call=async(phone,method,params)=>{const requestId=randomUUID();phone.socket.send(JSON.stringify({v:1,type:'request',requestId,hostId:'synthetic-computer',method,params}));return phone.next(value=>value.requestId===requestId);};
  const phone=await connect();assert.equal((await call(phone,'tasks.watch',{})).result.supportsTaskQueue,true);
  const taskId=randomUUID(),submitted=await call(phone,'tasks.submit',{taskId,kind:'command',payload:{method:'turn.stop',params:{threadId:'synthetic-thread'}}});assert.equal(submitted.result.accepted,true);
  phone.socket.close();await new Promise(resolve=>phone.socket.once('close',resolve));release();await f.agent.taskQueue.pump();assert.equal(f.calls.length,1);
  const restored=await connect(),history=await call(restored,'tasks.list',{view:'history',taskId});assert.equal(validTaskSnapshot(history.result),true);assert.equal(history.result.tasks[0].state,'succeeded');
  const original=f.agent.taskQueue.row('synthetic-phone',taskId);assert.equal(original.payload,null);assert.equal(original.device_id,'synthetic-phone');
});
