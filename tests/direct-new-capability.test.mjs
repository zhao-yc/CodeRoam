import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BridgeAgent } from '../apps/bridge/agent.mjs';

const projects=[{id:'example-project',label:'示例项目'}];

/** 只经过项目列表请求，监测页面探测次数，不创建或发送任何聊天。 */
function setup(context, instance, supportsNativeNewDraft=false) {
  const adapter=new EventEmitter();
  adapter.client={instance};
  adapter.close=()=>{};
  const agent=new BridgeAgent({
    config:{},
    adapter,
    journal:{close(){}},
    newThreads:{projects:()=>({projects,supportsThreadCreation:true})},
  });
  let probes=0;
  agent.nativeDrafts.controller.capabilities=async()=>{probes++;return supportsNativeNewDraft;};
  context.after(()=>agent.close());
  return {
    get probes(){return probes;},
    async read(){
      const response=await agent.handleRequest({
        v:1,type:'request',requestId:'example-projects-request',method:'projects.list',deviceId:'example-phone',params:{},
      });
      assert.equal(response.error,undefined);
      return response.result;
    },
  };
}

test('仅独占 IPC 单实例在存活且就绪时声明直接新聊天',async context=>{
  const instance={directIpc:true,alive:true,ready:true};
  const client=setup(context,instance,true);
  const expected={projects,supportsThreadCreation:true,supportsNativeNewDraft:false,nativeNewDraftNeedsDesktopPage:true};
  assert.deepEqual(await client.read(),{...expected,newConversationMode:'desktopIpc'});
  instance.ready=false;
  assert.deepEqual(await client.read(),expected);
  instance.ready=true;
  instance.alive=false;
  assert.deepEqual(await client.read(),expected);
  assert.equal(client.probes,0);
});

test('多个已绑定实例按各自页面能力声明，不使用独占 IPC 模式',async context=>{
  const withPage=setup(context,{directIpc:false,alive:true,ready:true},true);
  const withoutPage=setup(context,{directIpc:false,alive:true,ready:true});
  assert.deepEqual(await withPage.read(),{projects,supportsThreadCreation:true,supportsNativeNewDraft:true,newConversationMode:'nativeDraft'});
  assert.deepEqual(await withoutPage.read(),{projects,supportsThreadCreation:true,supportsNativeNewDraft:false});
  assert.equal(withPage.probes,1);
  assert.equal(withoutPage.probes,1);
});

test('缺少实例绑定的旧单实例配置不声明独占 IPC 模式',async context=>{
  const client=setup(context,undefined);
  assert.deepEqual(await client.read(),{projects,supportsThreadCreation:true,supportsNativeNewDraft:false});
});
