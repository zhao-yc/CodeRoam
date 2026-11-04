import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { supportsDesktopIpcNewConversation } from '../apps/bridge/windows-ipc-mode.mjs';

const projects=[{id:'example-project',label:'示例项目'}];
const generation='00000000-0000-4000-8000-000000000002';

/** 只经过项目列表请求，监测页面探测次数，不创建或发送任何聊天。 */
function setup(context, instance, supportsNativeNewDraft=false, bindings={}) {
  const adapter=new EventEmitter();
  adapter.client={instance,assertCurrent(){},...bindings};
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

test('独占 IPC 单实例在存活且就绪时声明直接新聊天',async context=>{
  const instance={directIpc:true,alive:true,ready:true,generation};
  const client=setup(context,instance);
  const expected={projects,supportsThreadCreation:true,supportsNativeNewDraft:false};
  assert.deepEqual(await client.read(),{...expected,newConversationMode:'desktopIpc'});
  instance.ready=false;
  assert.deepEqual(await client.read(),{...expected,newConversationUnavailableReason:'电脑实例连接尚未就绪，请重新连接后读取项目'});
  instance.ready=true;
  instance.alive=false;
  assert.deepEqual(await client.read(),{...expected,newConversationUnavailableReason:'电脑实例连接尚未就绪，请重新连接后读取项目'});
  assert.equal(client.probes,0);
});

test('多个已绑定实例优先原生页面，草稿页面失效时使用原 IPC 创建',async context=>{
  const instance={platform:'win32',directIpc:false,alive:true,ready:true,generation,port:9222};
  const bindings={allowedClients:new Set(['example-desktop'])};
  const withPage=setup(context,{...instance},true,bindings);
  const withoutPage=setup(context,{...instance},false,bindings);
  assert.deepEqual(await withPage.read(),{projects,supportsThreadCreation:true,supportsNativeNewDraft:true,newConversationMode:'nativeDraft'});
  assert.deepEqual(await withoutPage.read(),{projects,supportsThreadCreation:true,supportsNativeNewDraft:false,newConversationMode:'desktopIpc'});
  assert.equal(withPage.probes,1);
  assert.equal(withoutPage.probes,1);
});

test('IPC 新聊天能力需要真实当前绑定，拒绝空客户端集合与缺失代次',()=>{
  const instance={platform:'win32',alive:true,ready:true,generation,port:9222};
  const bound=()=>({client:{instance:{...instance},assertCurrent(){},allowedClients:new Set(['example-desktop'])}});
  assert.equal(supportsDesktopIpcNewConversation(bound()),true);
  const router=bound(); router.client.instance.routerManaged=true; delete router.client.instance.port;
  assert.equal(supportsDesktopIpcNewConversation(router),true);
  const direct=bound(); direct.client.instance.directIpc=true; direct.client.allowedClients.clear(); delete direct.client.instance.platform;
  assert.equal(supportsDesktopIpcNewConversation(direct),true);
  for(const mutate of [
    row=>{row.client.instance.platform='darwin';},
    row=>{row.client.instance.ready=false;},
    row=>{row.client.instance.alive=false;},
    row=>{delete row.client.instance.generation;},
    row=>{row.client.instance.generation='';},
    row=>{row.client.instance.generation=1;},
    row=>{row.client.allowedClients.clear();},
    row=>{row.client.allowedClients=['example-desktop'];},
    row=>{delete row.client.assertCurrent;},
    row=>{row.client.assertCurrent=()=>{throw Error('旧绑定');};},
    row=>{delete row.client.instance.port;},
    row=>{delete row.client.instance;},
    row=>{row.stopped=true;},
  ]){const row=bound();mutate(row);assert.equal(supportsDesktopIpcNewConversation(row),false);}
  const refreshed=bound(); refreshed.client.assertCurrent=()=>refreshed.client.allowedClients.clear();
  assert.equal(supportsDesktopIpcNewConversation(refreshed),false);
});

test('缺少实例绑定的旧单实例配置不声明独占 IPC 模式',async context=>{
  const client=setup(context,undefined);
  assert.deepEqual(await client.read(),{projects,supportsThreadCreation:true,supportsNativeNewDraft:false,newConversationUnavailableReason:'电脑实例连接尚未就绪，请重新连接后读取项目'});
});
