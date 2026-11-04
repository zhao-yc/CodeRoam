import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BridgeAgent} from '../apps/bridge/agent.mjs';
import {Journal} from '../apps/bridge/journal.mjs';

test('实际Agent用当前实例在线快照协调列表与正文模式，五分钟边界恢复且不执行写操作',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const adapter=new EventEmitter();adapter.conversations=new Map();adapter.index={list:()=>[]};adapter.readActivityInventory=async()=>({complete:true,threadIds:[]});adapter.close=()=>{};adapter.operate=()=>assert.fail('在线数量不能执行写操作');
  const agent=new BridgeAgent({config:{},adapter,journal:new Journal(),newThreads:{}});t.after(()=>agent.close());
  const modes=[];agent.on('maintenance',mode=>modes.push(mode));
  agent.configurePresence({supported:true,hostId:'synthetic-host',generation:'generation-one'});
  const presence=(revision,onlineCount)=>({v:1,type:'clients.presence',hostId:'synthetic-host',generation:'generation-one',revision,onlineCount});
  assert.equal(agent.clientPresence.update(presence(1,1)),true);
  assert.equal(agent.threadListFeed.mode,'online');assert.equal(agent.threadCache.mode,'online');
  agent.clientPresence.update(presence(2,0));t.mock.timers.tick(299999);
  assert.equal(agent.threadListFeed.mode,'grace');assert.equal(agent.threadCache.mode,'grace');
  t.mock.timers.tick(1);assert.equal(agent.threadListFeed.mode,'light');assert.equal(agent.threadCache.mode,'light');
  agent.clientPresence.update(presence(3,1));assert.equal(agent.threadListFeed.mode,'online');
  assert.equal(agent.clientPresence.update({...presence(4,0),generation:'old-generation'}),false);
  agent.configurePresence({supported:false,hostId:'synthetic-host',generation:'generation-one'});
  assert.equal(agent.threadListFeed.mode,'legacy');assert.equal(agent.threadCache.mode,'legacy');
  assert.deepEqual(modes,['online','grace','light','online','legacy']);
});
