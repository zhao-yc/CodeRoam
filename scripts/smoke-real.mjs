import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

/** 经真实中转和真实桌面会话只读联调，不向其他会话发送测试指令。 */
const config=JSON.parse(fs.readFileSync('.local/mobile.json','utf8'));
const socket=new WebSocket(config.relayUrl,{headers:{Authorization:`Bearer ${config.token}`}});
const start=performance.now(), pending=new Map();let ready;
const initialized=new Promise((resolve,reject)=>{ready={resolve,reject};});
function request(method,params){const requestId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`请求超时：${method}`));},15000);pending.set(requestId,{resolve,reject,timer});socket.send(JSON.stringify({v:1,type:'request',requestId,hostId:config.hostId,method,params}));});}
socket.on('message',data=>{const message=JSON.parse(data);if(message.type==='welcome')ready.resolve();if(message.type==='response'){const entry=pending.get(message.requestId);if(!entry)return;clearTimeout(entry.timer);pending.delete(message.requestId);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result);}});
socket.on('error',error=>ready.reject(error));
try {
  await initialized;const connectedMs=Math.round(performance.now()-start);
  const {threads}=await request('threads.list',{limit:100});const id=process.env.CODEX_THREAD_ID;
  if(!threads.some(thread=>thread.id===id))throw new Error('真实会话列表未包含当前任务');
  const result=await request('thread.watch',{threadId:id});
  if(!result.snapshot.messages.length)throw new Error('真实会话消息为空');
  await request('thread.unwatch',{threadId:id});
  console.log(JSON.stringify({status:'真实只读联调通过',connectedMs,threadCount:threads.length,messageCount:result.snapshot.messages.length,conversationStatus:result.snapshot.status,totalMs:Math.round(performance.now()-start)}));
}catch(error){console.error(error.message);process.exitCode=1;}finally{for(const entry of pending.values())clearTimeout(entry.timer);socket.close();}
