import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {PredictionConnections} from '../apps/bridge/prediction-connections.mjs';
import {ComposerPredictionReader} from '../apps/bridge/composer-prediction.mjs';

const suggestion={threadId:'thread-1',sourceTurnId:'turn-1',text:'请继续核查这条会话。'};
function adapter(){const entry={owner:{hostId:'local',clientId:'desktop-1'},watchers:new Set(['phone']),state:{turns:[{turnId:'turn-1',status:'completed'}]}};return{entry,conversations:new Map([['thread-1',entry]]),subscribed:()=>entry,snapshot:()=>({status:'idle',activeTurnId:''})};}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const pages=()=>Promise.resolve({ok:true,text:async()=>JSON.stringify([{type:'page',url:'app://-/index.html',id:'PAGE'}])});

test('后台复核未完成时前台立即复用身份，超过硬期限不继续使用旧身份',async t=>{
  let now=1000,calls=0,next;
  const reader=new ComposerPredictionReader({now:()=>now,discover:()=>{calls++;return next?.promise??Promise.resolve([{port:12345,pid:1}]);},fetcher:pages,evaluate:async()=>[suggestion]});
  t.after(()=>reader.close());await reader.start();assert.equal(calls,1);
  now+=16000;next=deferred();
  assert.deepEqual(await reader.read(adapter(),'thread-1','phone'),{prediction:suggestion});assert.equal(calls,2);
  now+=60000;let finished=false;const pending=reader.read(adapter(),'thread-1','phone').then(value=>{finished=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  next.resolve([]);assert.deepEqual(await pending,{prediction:null});
});

test('后台发现失败时已有身份仅在有效期内可用，关闭后不接收迟到发现结果',async t=>{
  let now=1000,fail=false;
  const reader=new ComposerPredictionReader({now:()=>now,discover:async()=>{if(fail)throw Error('模拟发现失败');return[{port:12345,pid:1}];},fetcher:pages,evaluate:async()=>[suggestion]});
  t.after(()=>reader.close());await reader.start();fail=true;now+=16000;
  assert.deepEqual(await reader.read(adapter(),'thread-1','phone'),{prediction:suggestion});
  now+=60000;assert.deepEqual(await reader.read(adapter(),'thread-1','phone'),{prediction:null});
  const next=deferred(),closing=new ComposerPredictionReader({discover:()=>next.promise,evaluate:async()=>[]});
  const start=closing.start();closing.close();next.resolve([{port:12345,pid:1}]);await start;assert.deepEqual(await closing.endpoints(),[]);
});

test('读取中进程身份改变丢弃结果，原文不会跨轮次短缓存',async t=>{
  let pid=1,pause=deferred(),value=suggestion;
  const reader=new ComposerPredictionReader({discover:async()=>[{port:12345,pid}],fetcher:pages,evaluate:async()=>{await pause.promise;return value?[value]:[];}});
  t.after(()=>reader.close());await reader.start();const pending=reader.read(adapter(),'thread-1','phone');
  await new Promise(resolve=>setImmediate(resolve));pid=2;await reader.refresh();pause.resolve();
  assert.deepEqual(await pending,{prediction:null});
  value=null;assert.deepEqual(await reader.read(adapter(),'thread-1','phone'),{prediction:null});
});

test('重复订阅同一所有者不丢弃回执，桌面客户端真正改变时仍丢弃',async t=>{
  const a=adapter();let changed=false;
  const reader=new ComposerPredictionReader({discover:async()=>[{port:12345,pid:1}],fetcher:pages,evaluate:async()=>{a.entry.owner={hostId:'local',clientId:changed?'desktop-2':'desktop-1'};return[suggestion];}});
  t.after(()=>reader.close());assert.deepEqual(await reader.read(a,'thread-1','phone'),{prediction:suggestion});
  changed=true;assert.deepEqual(await reader.read(a,'thread-1','phone'),{prediction:null});
});

test('真实 WebSocket 复用连接、按编号匹配并发响应，并保持固定只读限制',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(resolve=>server.once('listening',resolve));
  let connections=0;const seen=[];
  server.on('connection',socket=>{connections++;socket.on('message',data=>{const message=JSON.parse(data);seen.push(message);setTimeout(()=>socket.send(JSON.stringify({id:message.id,result:{result:{value:message.params.expression}}})),message.params.expression==='first'?25:0);});});
  const pool=new PredictionConnections();t.after(async()=>{pool.close();for(const s of server.clients)s.terminate();await new Promise(resolve=>server.close(resolve));});
  const url=`ws://127.0.0.1:${server.address().port}/devtools/page/PAGE`;
  await pool.open(url,'process-1');assert.deepEqual(await Promise.all([pool.evaluate(url,'first','process-1'),pool.evaluate(url,'second','process-1')]),['first','second']);
  assert.equal(await pool.evaluate(url,'third','process-1'),'third');assert.equal(connections,1);
  for(const message of seen){assert.equal(message.method,'Runtime.evaluate');assert.equal(message.params.throwOnSideEffect,true);assert.equal(message.params.timeout,1500);}
  pool.retain(new Set(['process-2']));assert.equal(await pool.evaluate(url,'new','process-2'),'new');assert.equal(connections,2);
});

test('连接丢失拒绝在途读取并撤销身份，关闭连接池后不再创建连接',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(resolve=>server.once('listening',resolve));
  server.on('connection',socket=>socket.on('message',()=>socket.terminate()));
  const invalidated=[],pool=new PredictionConnections({onDisconnect:id=>invalidated.push(id)});
  t.after(async()=>{pool.close();for(const s of server.clients)s.terminate();await new Promise(resolve=>server.close(resolve));});
  const url=`ws://127.0.0.1:${server.address().port}/devtools/page/PAGE`;
  await assert.rejects(pool.evaluate(url,'fixed','process-1'));assert.deepEqual(invalidated,['process-1']);
  pool.close();await assert.rejects(pool.evaluate(url,'fixed','process-1'));
});


test('单个进程断开仅撤销自身身份，其他进程读取不等待后台重新发现',async t=>{
  const next=deferred();let refreshing=false;
  const reader=new ComposerPredictionReader({discover:()=>refreshing?next.promise:Promise.resolve([{port:12345,pid:1},{port:12346,pid:2}]),fetcher:async()=>({ok:true,text:async()=>'[]'})});
  t.after(()=>reader.close());await reader.start();reader.fetcher=pages;reader.evaluate=async()=>[suggestion];refreshing=true;
  reader.connections.onDisconnect(JSON.stringify([12345,1]));
  assert.deepEqual(await reader.read(adapter(),'thread-1','phone'),{prediction:suggestion});
  assert.deepEqual(reader.ports,[{port:12346,pid:2}]);assert.ok(reader.discovery);
  next.resolve([{port:12346,pid:2}]);await reader.discovery;
});
