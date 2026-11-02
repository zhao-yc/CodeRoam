import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelay } from '../apps/relay/server.mjs';
import { tokenHash } from '../packages/protocol/contracts.mjs';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { BridgeAgent } from '../apps/bridge/agent.mjs';

function inbox(socket){const messages=[];const waiting=[];socket.on('message',data=>{const value=JSON.parse(data);const at=waiting.findIndex(entry=>entry.predicate(value));if(at>=0){const entry=waiting.splice(at,1)[0];clearTimeout(entry.timer);entry.resolve(value);}else messages.push(value);});return predicate=>{const at=messages.findIndex(predicate);if(at>=0)return Promise.resolve(messages.splice(at,1)[0]);return new Promise((resolve,reject)=>{const entry={predicate,resolve};entry.timer=setTimeout(()=>{waiting.splice(waiting.indexOf(entry),1);reject(new Error('等待消息超时'));},3000);waiting.push(entry);});};}
async function fixture(t){
  const hostToken=randomBytes(32).toString('base64url'),mobileToken=randomBytes(32).toString('base64url');
  const relay=createRelay({identities:[{id:'host',role:'host',hostId:'pc',tokenSha256:tokenHash(hostToken)},{id:'phone',role:'mobile',hostIds:['pc'],tokenSha256:tokenHash(mobileToken)}],requestTimeoutMs:1000});
  const address=await relay.listen();const url=`ws://127.0.0.1:${address.port}/ws`;t.after(()=>relay.close());
  const open=async token=>{const socket=new WebSocket(url,{headers:{Authorization:`Bearer ${token}`}});const next=inbox(socket);await next(value=>value.type==='welcome');return {socket,next};};
  return {relay,url,hostToken,mobileToken,open};
}
test('真实 WebSocket 中转进行身份验证、设备隔离和请求路由',async t=>{
  const f=await fixture(t);const host=await f.open(f.hostToken),phone=await f.open(f.mobileToken);const requestId=randomUUID();
  phone.socket.send(JSON.stringify({v:1,type:'request',requestId,hostId:'pc',method:'threads.list',params:{}}));
  const request=await host.next(value=>value.type==='request');assert.equal(request.deviceId,'phone');host.socket.send(JSON.stringify({v:1,type:'response',transportId:request.transportId,result:{threads:[{id:'existing'}]}}));
  const response=await phone.next(value=>value.requestId===requestId);assert.equal(response.result.threads[0].id,'existing');
  const badId=randomUUID();phone.socket.send(JSON.stringify({v:1,type:'request',requestId:badId,hostId:'other',method:'threads.list',params:{}}));assert.equal((await phone.next(value=>value.requestId===badId)).error.code,'HOST_FORBIDDEN');
});

test('列表推送只路由给已授权且已订阅手机，断线清理列表订阅',async t=>{
  const f=await fixture(t),host=await f.open(f.hostToken),phone=await f.open(f.mobileToken),other=await f.open(f.mobileToken);
  const requestId=randomUUID();
  phone.socket.send(JSON.stringify({v:1,type:'request',requestId,hostId:'pc',method:'threads.watch',params:{}}));
  const request=await host.next(value=>value.method==='threads.watch');
  host.socket.send(JSON.stringify({v:1,type:'response',transportId:request.transportId,result:{threads:[],revision:1}}));
  await phone.next(value=>value.requestId===requestId);
  const received=[];other.socket.on('message',data=>received.push(JSON.parse(data)));
  host.socket.send(JSON.stringify({v:1,type:'threads.event',hostId:'forged',revision:2,threads:[{id:'a',status:'idle'}]}));
  const update=await phone.next(value=>value.type==='threads.event');assert.equal(update.hostId,'pc');assert.equal(update.threads[0].status,'idle');
  assert.equal(received.some(value=>value.type==='threads.event'),false);
  phone.socket.close();await host.next(value=>value.method==='threads.unwatch');other.socket.close();
});

test('旧配对自动上报系统电脑名，断线重连后手机仍收到正确名称，自定义别名继续生效',async t=>{
  const f=await fixture(t),phone=await f.open(f.mobileToken);
  const adapter=new EventEmitter();adapter.close=()=>{};
  const agent=new BridgeAgent({config:{relayUrl:f.url,token:f.hostToken,hostId:'pc',label:'我的 Windows 电脑'},adapter,journal:{close(){}}});
  t.after(()=>agent.close());agent.start();
  const isNamedHost=(message,label)=>message.type==='hosts'&&message.hosts.some(host=>host.id==='pc'&&host.online&&host.label===label);
  assert.equal((await phone.next(message=>isNamedHost(message,hostname()))).hosts[0].label,hostname());
  agent.socket.terminate();
  await phone.next(message=>message.type==='hosts'&&message.hosts.some(host=>host.id==='pc'&&!host.online));
  assert.equal((await phone.next(message=>isNamedHost(message,hostname()))).hosts[0].label,hostname());
  agent.config.label='办公室电脑';agent.socket.terminate();
  assert.equal((await phone.next(message=>isNamedHost(message,'办公室电脑'))).hosts[0].label,'办公室电脑');
});
test('主机断开后的写请求被标记结果未知，服务不会自动重试',async t=>{
  const f=await fixture(t);const host=await f.open(f.hostToken),phone=await f.open(f.mobileToken),requestId=randomUUID();
  phone.socket.send(JSON.stringify({v:1,type:'request',requestId,hostId:'pc',method:'turn.send',params:{threadId:'t',text:'测试'}}));await host.next(value=>value.type==='request');host.socket.terminate();
  const response=await phone.next(value=>value.requestId===requestId);assert.equal(response.error.code,'OUTCOME_UNKNOWN');assert.equal(response.error.outcomeUnknown,true);
});
test('未鉴权连接被拒绝，网页票据只能消费一次且凭据不出现在 URL',async t=>{
  const f=await fixture(t);const ticketResponse=await fetch(f.url.replace('ws:','http:').replace('/ws','/session'),{method:'POST',headers:{Authorization:`Bearer ${f.mobileToken}`}});const {ticket}=await ticketResponse.json();assert.equal(ticketResponse.status,200);
  const socket=new WebSocket(f.url,['codex-mobile-v1',`ticket.${ticket}`]);await inbox(socket)(value=>value.type==='welcome');
  const rejected=new WebSocket(f.url,['codex-mobile-v1',`ticket.${ticket}`]);const status=await new Promise(resolve=>{rejected.on('unexpected-response',(_request,response)=>{response.resume();rejected.terminate();resolve(response.statusCode);});rejected.on('error',()=>{});});assert.equal(status,401);
});

test('手机断开会释放订阅，同一设备的其他观看连接仍然保留',async t=>{
  const f=await fixture(t),host=await f.open(f.hostToken),phone=await f.open(f.mobileToken),second=await f.open(f.mobileToken);
  for(const mobile of [phone,second]){
    const requestId=randomUUID();mobile.socket.send(JSON.stringify({v:1,type:'request',requestId,hostId:'pc',method:'thread.watch',params:{threadId:'t'}}));
    const request=await host.next(value=>value.type==='request');host.socket.send(JSON.stringify({type:'response',transportId:request.transportId,result:{ok:true}}));await mobile.next(value=>value.requestId===requestId);
  }
  phone.socket.terminate();await new Promise(resolve=>phone.socket.once('close',resolve));
  second.socket.terminate();const release=await host.next(value=>value.type==='request'&&value.method==='thread.unwatch');assert.equal(release.params.threadId,'t');assert.equal(release.deviceId,'phone');
});

test('Android 默认 localhost 来源持有效一次性票据时可以握手，票据仍只能使用一次',async t=>{
  const f=await fixture(t),response=await fetch(f.url.replace('ws:','http:').replace('/ws','/session'),{method:'POST',headers:{Authorization:`Bearer ${f.mobileToken}`}}),{ticket}=await response.json();
  const socket=new WebSocket(f.url,['codex-mobile-v1',`ticket.${ticket}`],{headers:{Origin:'http://localhost'}});
  assert.equal((await inbox(socket)(value=>value.type==='welcome')).role,'mobile');
  const reused=new WebSocket(f.url,['codex-mobile-v1',`ticket.${ticket}`],{headers:{Origin:'http://localhost'}});
  const status=await new Promise(resolve=>{reused.on('unexpected-response',(_request,res)=>{res.resume();reused.terminate();resolve(res.statusCode);});reused.on('error',()=>{});});assert.equal(status,401);
});

test('原生来源兼容不会放开其他来源、缺失凭据或电脑身份，也不放开 HTTP 票据接口',async t=>{
  const f=await fixture(t),endpoint=f.url.replace('ws:','http:').replace('/ws','/session');
  const httpResponse=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${f.mobileToken}`,Origin:'http://localhost'}});assert.equal(httpResponse.status,403);
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${f.mobileToken}`}}),{ticket}=await response.json();
  for(const options of [{origin:'https://untrusted.example',ticket},{origin:'http://localhost'},{origin:'http://localhost',authorization:`Bearer ${f.hostToken}`}]){
    const socket=new WebSocket(f.url,options.ticket?['codex-mobile-v1',`ticket.${options.ticket}`]:[],{headers:{Origin:options.origin,...(options.authorization?{Authorization:options.authorization}:{})}});
    const status=await new Promise(resolve=>{socket.on('unexpected-response',(_request,res)=>{res.resume();socket.terminate();resolve(res.statusCode);});socket.on('error',()=>{});});assert.equal(status,401);
  }
});
