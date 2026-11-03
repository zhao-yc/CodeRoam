import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BridgeAgent} from '../apps/bridge/agent.mjs';
import {hostname} from 'node:os';
import {computerName} from '../apps/bridge/computer-name.mjs';

test('电脑名称兼容缺失、空白和旧默认配置，明确设置的别名继续保留',()=>{
  for(const label of [undefined,null,'','  ','我的 Windows 电脑',' 我的 Windows 电脑 '])assert.equal(computerName(label),hostname());
  assert.equal(computerName('办公室电脑'),'办公室电脑');
});

test('电脑发送积压时主动断开以恢复快照，不静默丢弃最后输出',()=>{
  const adapter=new EventEmitter(),agent=new BridgeAgent({config:{},adapter,journal:{}});let terminated=false;
  agent.socket={readyState:1,bufferedAmount:9*1024*1024,terminate(){terminated=true;},send(){throw new Error('背压过高时不能继续发送');}};
  assert.equal(agent.send({type:'event'}),false);assert.equal(terminated,true);
});

test('普通启动仍提供项目列表，并说明原生新聊天需要桌面页面连接',async t=>{
  const adapter=new EventEmitter();
  adapter.client={instance:{directIpc:true}};
  adapter.close=()=>{};
  const projects=[{id:'synthetic-project',label:'示例项目'}];
  const agent=new BridgeAgent({config:{},adapter,journal:{close(){}},newThreads:{projects:()=>({projects})}});
  t.after(()=>agent.close());
  agent.nativeDrafts.controller.capabilities=()=>assert.fail('普通启动不再探测原生页面');
  const reply=await agent.handleRequest({v:1,type:'request',requestId:'synthetic-projects-request',method:'projects.list',deviceId:'phone',params:{}});
  assert.deepEqual(reply.result,{projects,supportsNativeNewDraft:false,nativeNewDraftNeedsDesktopPage:true});
});
