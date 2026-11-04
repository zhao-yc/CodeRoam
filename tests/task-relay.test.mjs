import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelay } from '../apps/relay/server.mjs';
import { tokenHash } from '../packages/protocol/contracts.mjs';

/** 收集回环合成消息，负向断言使用同连接顺序屏障。 */
function inbox(socket){
  const all=[],rows=[],waiting=[];
  socket.on('error',()=>{});socket.on('message',data=>{const message=JSON.parse(data);all.push(message);const at=waiting.findIndex(item=>item.match(message));if(at<0)rows.push(message);else{const item=waiting.splice(at,1)[0];clearTimeout(item.timer);item.resolve(message);}});
  return {socket,all,next(match){const at=rows.findIndex(match);if(at>=0)return Promise.resolve(rows.splice(at,1)[0]);return new Promise((resolve,reject)=>{const item={match,resolve};item.timer=setTimeout(()=>{waiting.splice(waiting.indexOf(item),1);reject(new Error('等待合成任务消息超时'));},2000);waiting.push(item);});},events(){return all.filter(message=>message.type==='tasks.changed');}};
}
const snapshot=()=>({supportsTaskQueue:true,revision:1,paused:false,blockerId:'',tasks:[],now:100});

/** 每个用例使用随机令牌和实例，不接触真实配对、数据库或会话。 */
async function fixture(t,{timeout=500}={}){
  const tokens=Object.fromEntries(['computer','other','phone-a','phone-b'].map(name=>[name,randomBytes(32).toString('base64url')]));
  const identities=Object.keys(tokens).map(name=>({id:name,role:name.startsWith('phone')?'mobile':'host',...(name.startsWith('phone')?{hostIds:['computer']}:{hostId:name}),tokenSha256:tokenHash(tokens[name])}));
  const relay=createRelay({identities,requestTimeoutMs:timeout}),address=await relay.listen();t.after(()=>relay.close());
  const connect=async name=>{const value=inbox(new WebSocket(`ws://127.0.0.1:${address.port}/ws`,{headers:{Authorization:`Bearer ${tokens[name]}`}}));await value.next(message=>message.type==='welcome');return value;};
  const host=await connect('computer'),other=await connect('other'),phone=await connect('phone-a'),second=await connect('phone-b');
  const generations=new Map([['computer',randomUUID()]]);
  const manifest=async()=>{host.socket.send(JSON.stringify({type:'host.instances',instances:[...generations].map(([id,generation])=>({id,generation,label:'合成电脑',online:true}))}));await phone.next(message=>message.type==='hosts'&&message.hosts.some(row=>row.instanceGeneration===generations.get('computer')));};
  await manifest();
  const request=(mobile,method,params={})=>{const requestId=randomUUID();mobile.socket.send(JSON.stringify({v:1,type:'request',requestId,hostId:'computer',method,params}));return requestId;};
  const reply=(transport,result,error)=>host.socket.send(JSON.stringify({v:1,type:'response',transportId:transport.transportId,hostId:'computer',generation:transport.generation,result,error}));
  const watch=async mobile=>{const id=request(mobile,'tasks.watch'),transport=await host.next(message=>message.requestId===id);reply(transport,snapshot());await mobile.next(message=>message.requestId===id);};
  const changed=(extra={},sender=host)=>sender.socket.send(JSON.stringify({v:1,type:'tasks.changed',hostId:'computer',generation:generations.get('computer'),deviceId:'phone-a',snapshot:snapshot(),...extra}));
  const barrier=async()=>{const marker='合成任务屏障-'+randomUUID();host.socket.send(JSON.stringify({type:'host.ready',label:marker}));await phone.next(message=>message.type==='hosts'&&message.hosts.some(row=>row.label===marker));const id=request(phone,'ping');await phone.next(message=>message.requestId===id);};
  return {identities,connect,host,other,phone,second,generations,manifest,request,reply,watch,changed,barrier};
}

test('任务进度只发给原设备的当前订阅，伪造来源和私有字段被丢弃',async t=>{
  const f=await fixture(t),sibling=await f.connect('phone-a');await f.watch(f.phone);await f.watch(f.second);
  f.changed();await f.barrier();assert.equal(f.phone.events().length,1);assert.equal(f.second.events().length,0);assert.equal(sibling.events().length,0);
  f.changed({generation:randomUUID()});f.changed({generation:undefined});f.changed({hostId:'other'});f.changed({deviceId:'phone-b'});
  f.changed({snapshot:{...snapshot(),payload:{text:'不应广播'}}});f.changed({},f.other);await f.barrier();assert.equal(f.phone.events().length,1);
  await f.watch(sibling);f.changed();await f.barrier();assert.equal(f.phone.events().length,2);assert.equal(sibling.events().length,1);
});

test('同配对多标签只在最后一个观察者退出时释放守护进程订阅',async t=>{
  const f=await fixture(t),sibling=await f.connect('phone-a');await f.watch(f.phone);await f.watch(sibling);
  const id=f.request(f.phone,'tasks.unwatch');assert.equal((await f.phone.next(message=>message.requestId===id)).result.ok,true);
  assert.equal(f.host.all.filter(message=>message.method==='tasks.unwatch').length,0);
  f.changed();await f.barrier();assert.equal(f.phone.events().length,0);assert.equal(sibling.events().length,1);
  sibling.socket.close();const release=await f.host.next(message=>message.method==='tasks.unwatch');assert.equal(release.deviceId,'phone-a');assert.equal(release.generation,f.generations.get('computer'));
});

test('失败或非法任务快照撤销订阅，换代后必须重新订阅',async t=>{
  const f=await fixture(t);let id=f.request(f.phone,'tasks.watch'),transport=await f.host.next(message=>message.requestId===id);
  f.reply(transport,{...snapshot(),tasks:[{payload:'私有'}]});assert.equal((await f.phone.next(message=>message.requestId===id)).error.code,'BAD_TASK_RESPONSE');
  f.changed();await f.barrier();assert.equal(f.phone.events().length,0);
  await f.watch(f.phone);f.generations.set('computer',randomUUID());await f.manifest();f.changed();await f.barrier();assert.equal(f.phone.events().length,0);
  await f.watch(f.phone);f.changed();await f.barrier();assert.equal(f.phone.events().length,1);
});

test('任务提交超时和断线都标记未知，不自动再次转发提交',async t=>{
  const f=await fixture(t,{timeout:40}),params={taskId:randomUUID(),kind:'command',payload:{method:'turn.stop',params:{threadId:'synthetic-thread'}}};
  const id=f.request(f.phone,'tasks.submit',params);await f.host.next(message=>message.requestId===id);
  const response=await f.phone.next(message=>message.requestId===id);assert.equal(response.error.code,'OUTCOME_UNKNOWN');assert.equal(response.error.outcomeUnknown,true);
  assert.equal(f.host.all.filter(message=>message.method==='tasks.submit').length,1);
  const next=f.request(f.phone,'tasks.submit',{...params,taskId:randomUUID()});await f.host.next(message=>message.requestId===next);f.host.socket.terminate();
  assert.equal((await f.phone.next(message=>message.requestId===next)).error.code,'OUTCOME_UNKNOWN');
});

test('授权撤销阻断状态和在途历史响应',async t=>{
  const f=await fixture(t);await f.watch(f.phone);const id=f.request(f.phone,'tasks.list',{view:'history'}),transport=await f.host.next(message=>message.requestId===id);
  f.identities.find(identity=>identity.id==='phone-a').hostIds=[];f.changed();f.reply(transport,snapshot());
  assert.equal((await f.phone.next(message=>message.requestId===id)).error.code,'HOST_FORBIDDEN');assert.equal(f.phone.events().length,0);
});
