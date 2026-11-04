import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {BridgeAgent} from '../apps/bridge/agent.mjs';
import {Journal} from '../apps/bridge/journal.mjs';
import {ThreadListFeed} from '../apps/bridge/thread-list-feed.mjs';
import {READ_METHODS, WRITE_METHODS, validateRequest, BridgeError} from '../packages/protocol/contracts.mjs';

const params = {threadId:'thread', expectedTurnId:'failed'};
const request = (id='retry-command-0001', p=params) => ({v:1, type:'request', requestId:id, deviceId:'phone', method:'turn.retry', params:p});

/** 通过实际跟随快照入口模拟桌面所有者，所有消息与错误都是独立合成数据。 */
class DesktopFixture extends EventEmitter {
  constructor() {
    super();this.socket={writable:true};this.calls=[];this.snapshotReads=0;this.available=true;
    this.state={id:'thread', title:'合成失败会话', turns:[{turnId:'failed', status:'failed', error:{message:'Selected model is at capacity. Please try a different model.'}, items:[]}], requests:[], threadRuntimeStatus:{type:'idle'}};
  }
  async connect() {}
  async findOwner(_id,hostId) {return this.available&&hostId==='local'?{clientId:'desktop',hostId}:null;}
  broadcast(method,p) {
    if(method!=='thread-stream-following-changed'||!p.following)return;
    this.snapshotReads++;
    queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{conversationId:'thread',hostId:'local',change:{type:'snapshot',revision:this.snapshotReads,conversationState:structuredClone(this.state)}}}));
  }
  async request(method,p,version,options) {
    this.calls.push({method,params:p,version,options});
    if(this.failure)throw this.failure;
    if(this.response)return this.response;
    this.state.turns.push({turnId:'retry',status:'inProgress',items:[]});this.state.threadRuntimeStatus.type='active';
    return {resultType:'success',result:{result:{turnId:'retry'}}};
  }
  close() {}
}

function fixture() {
  const client=new DesktopFixture();
  const adapter=new DesktopAdapter({client,snapshotTimeoutMs:100,index:{list:()=>[{id:'thread',title:'合成失败会话'}]}});
  return {client,adapter};
}

test('重试进入写白名单并严格只接受两个非空编号', () => {
  assert.equal(WRITE_METHODS.has('turn.retry'),true);assert.equal(READ_METHODS.has('turn.retry'),false);
  assert.equal(validateRequest(request()).method,'turn.retry');
  for(const p of [{}, {threadId:'thread'}, {...params,expectedTurnId:''}, {...params,expectedTurnId:1}, {...params,expectedTurnId:'x'.repeat(201)}, ...['text','input','images','attachments','restoreMessage','model','approvalPolicy','turnTrigger','planMode'].map(key=>({...params,[key]:'伪造字段'}))]) {
    assert.throws(()=>validateRequest(request('retry-command-0001',p)),error=>error.code==='BAD_PARAMS');
  }
});

test('所有结构化失败均以空输入继续，继承原设置，成功回执带原失败目标', async () => {
  for(const failed of [{status:'failed',error:{message:'模型容量不足'}}, {status:'failed',error:'Rate limit exceeded.'}, {status:'failed'}, {status:'completed',error:{message:'Internal server error.'}}]) {
    const {adapter,client}=fixture();
    try {
      Object.assign(client.state.turns[0],failed);if(!Object.hasOwn(failed,'error'))delete client.state.turns[0].error;
      const result=await adapter.operate('turn.retry',params,'retry-command-0001','phone');
      assert.equal(result.ok,true);assert.equal(result.expectedTurnId,'failed');assert.equal(result.threadId,'thread');
      assert.deepEqual(client.calls,[{method:'thread-follower-start-turn',version:2,options:{targetClientId:'desktop',timeoutMs:15000},params:{conversationId:'thread',turnStart:{request:{threadId:'thread',input:[],turnTrigger:'capacity_retry_manual'},context:{inheritThreadSettings:true}}}}]);
      assert.equal(client.state.turns.flatMap(turn=>turn.items).length,0);
      assert.equal(client.snapshotReads,1);
    } finally {adapter.close();}
  }
});

test('重试重新获取快照并发布最新状态，旧失败、已完成、已停止和运行状态均不重放', async () => {
  for(const change of [
    state=>state.turns.push({turnId:'new',status:'failed',items:[]}),
    state=>{delete state.turns[0].error;state.turns[0].status='completed';},
    state=>{delete state.turns[0].error;state.turns[0].status='interrupted';},
    state=>state.turns.push({turnId:'new',status:'inProgress',items:[]}),
    state=>{state.threadRuntimeStatus.type='active';}
  ]) {
    const {adapter,client}=fixture(),events=[];
    try {
      await adapter.watch('thread','phone');change(client.state);
      adapter.on('conversation',snapshot=>events.push(snapshot));
      await assert.rejects(adapter.operate('turn.retry',params,'retry-command-0001','phone'),error=>['STALE_TURN','TURN_ACTIVE'].includes(error.code));
      assert.equal(client.calls.length,0);assert.equal(client.snapshotReads,2);assert.equal(events.length,1);
      assert.deepEqual(events[0].latestTurn,adapter.snapshot(adapter.conversations.get('thread').state).latestTurn);
    } finally {adapter.close();}
  }
});

test('存在审批、原生或异步问答、待确认计划及等待标记时拒绝重试并刷新', async () => {
  for(const change of [
    state=>state.requests.push({id:1,method:'item/commandExecution/requestApproval',params:{turnId:'failed'}}),
    state=>state.requests.push({request:{id:2,method:'item/permissions/requestApproval',params:{turnId:'failed'}}}),
    state=>state.requests.push({id:3,method:'item/tool/requestUserInput',params:{turnId:'failed',questions:[]}}),
    state=>state.turns[0].items.push({id:'question',type:'agentMessage',text:'合成问题',questions:[{title:'选项',options:['一','二']}]}),
    state=>state.turns[0].items.push({id:'plan',type:'planImplementation',isCompleted:false,planContent:'合成计划'}),
    state=>{state.threadRuntimeStatus.activeFlags=['waitingOnApproval'];}
  ]) {
    const {adapter,client}=fixture(),events=[];
    try {
      change(client.state);adapter.on('conversation',snapshot=>events.push(snapshot));
      await assert.rejects(adapter.operate('turn.retry',params,'retry-command-0001','phone'),error=>error.code==='TURN_RETRY_BLOCKED');
      assert.equal(client.calls.length,0);assert.equal(events.length,1);
    } finally {adapter.close();}
  }
});

test('只读或失联会话不能重试，普通 send 仍拒绝空输入，适配器也拒绝伪造字段', async () => {
  const {adapter,client}=fixture();
  try {
    await assert.rejects(adapter.operate('turn.retry',{...params,text:'伪造正文'},'retry-command-0001','phone'),error=>error.code==='BAD_PARAMS');
    assert.equal(client.snapshotReads,0);
    await assert.rejects(adapter.operate('turn.send',{threadId:'thread',text:''},'send-command-0001','phone'),error=>error.code==='BAD_PARAMS');
    client.available=false;
    await assert.rejects(adapter.operate('turn.retry',params,'retry-command-0001','phone'),error=>error.code==='HISTORY_READ_ONLY');
    assert.equal(client.calls.length,0);
  } finally {adapter.close();}
});

test('两个列表路径只发送最新结果摘要，已读仍保留失败，新轮次替换标记', async () => {
  const {adapter,client}=fixture(),events=[];
  const feed=new ThreadListFeed(adapter,event=>events.push(event));
  try {
    const rows=await adapter.list({});
    assert.deepEqual(rows[0].latestTurn,{turnId:'failed',status:'failed'});
    assert.equal(JSON.stringify(rows).includes('capacity'),false);
    // 首帧复用已经核验的实时状态，不为静态列表逐条重新建立正文跟随。
    await adapter.watch('thread','detail',{history:false});
    const initial=await feed.watch('phone');
    assert.deepEqual(initial.threads[0].latestTurn,rows[0].latestTurn);
    const snapshot=adapter.snapshot(adapter.conversations.get('thread').state);
    adapter.emit('conversation',{...snapshot,hasUnreadTurn:false,latestTurn:{...snapshot.latestTurn,errorMessage:'不可带入列表'}});
    assert.deepEqual(events.at(-1).threads[0].latestTurn,{turnId:'failed',status:'failed'});
    assert.equal(JSON.stringify(events).includes('不可带入列表'),false);
    client.state.turns.push({turnId:'retry',status:'inProgress',items:[]});client.state.threadRuntimeStatus.type='active';
    adapter.emit('conversation',adapter.snapshot(client.state));
    assert.deepEqual(events.at(-1).threads[0].latestTurn,{turnId:'retry',status:'inProgress'});
  } finally {feed.close();adapter.close();}
});

/** 使用真实操作账本与 Agent 线程锁验证重复点击，不另造一套去重实现。 */
function agentFixture() {
  const {adapter,client}=fixture(),journal=new Journal();
  const agent=new BridgeAgent({config:{},adapter,journal,newThreads:{}});
  return {agent,client,journal};
}

test('写白名单自动接入账本，同编号并发重试只提交一次', async () => {
  const {agent,client,journal}=agentFixture();
  try {
    const results=await Promise.all([agent.handleRequest(request()),agent.handleRequest(request())]);
    assert.equal(results[0].result.ok,true);assert.deepEqual(results[1].result,results[0].result);
    assert.equal(client.calls.length,1);assert.equal(journal.status('phone','retry-command-0001').state,'done');
  } finally {await agent.close();}
});

test('不同请求编号共用线程锁，第一次启动后第二次重试被最新状态拒绝', async () => {
  const {agent,client}=agentFixture();
  try {
    const results=await Promise.all([agent.handleRequest(request()),agent.handleRequest(request('retry-command-0002'))]);
    assert.equal(results[0].result.ok,true);assert.equal(results[1].error.code,'TURN_ACTIVE');
    assert.equal(client.calls.length,1);
  } finally {await agent.close();}
});

test('IPC 超时保留未知回执，查询及同编号请求均不会自动重试', async () => {
  const {agent,client,journal}=agentFixture();
  try {
    client.failure=new BridgeError('IPC_TIMEOUT','合成超时',true);
    const result=await agent.handleRequest(request());assert.equal(result.error.code,'OUTCOME_UNKNOWN');
    assert.equal(journal.status('phone','retry-command-0001').state,'unknown');
    const duplicate=await agent.handleRequest(request());assert.equal(duplicate.error.code,'OUTCOME_UNKNOWN');
    assert.equal(client.calls.length,1);
  } finally {await agent.close();}
});

test('桌面明确拒绝不会返回成功回执，确定失败的同编号请求也不重复提交', async () => {
  const {agent,client,journal}=agentFixture();
  try {
    client.response={resultType:'error',error:'no-client-found'};
    const result=await agent.handleRequest(request());assert.equal(result.result,undefined);assert.equal(result.error.code,'OWNER_UNAVAILABLE');
    assert.equal(journal.status('phone','retry-command-0001').state,'done');
    const duplicate=await agent.handleRequest(request());assert.equal(duplicate.error.code,'OWNER_UNAVAILABLE');
    assert.equal(client.calls.length,1);
  } finally {await agent.close();}
});
