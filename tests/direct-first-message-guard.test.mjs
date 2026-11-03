import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { InstanceRuntime } from '../apps/bridge/instance-runtime.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { permissionState } from '../apps/bridge/permissions.mjs';

const threadId='00000000-0000-4000-8000-000000000001';
const generation='00000000-0000-4000-8000-000000000002';
const phone='example-phone';
const command='example-first-message-command';
const workspace={permissions:':workspace',approvalPolicy:'on-request',approvalsReviewer:'user'};
const full={permissions:':danger-full-access',approvalPolicy:'never',approvalsReviewer:'user'};
const params={threadId,text:'合成正文',pluginIds:['example@example']};

/** 构造真实适配器，只将桌面 IPC 和附件存储替换成可检查的合成接口。 */
function adapterFixture(context,permissions=workspace) {
  const requests=[],watches=[];
  const client=new EventEmitter();
  client.instance={directIpc:true,ready:true,alive:true,generation};
  client.request=async (...args)=>{requests.push(args);return {resultType:'success'};};
  client.close=()=>{};
  const adapter=new DesktopAdapter({client,attachments:{materialize:()=>[]}});
  const state={id:threadId,cwd:'/example/project',turns:[],latestThreadSettings:permissions};
  adapter.conversations.set(threadId,{state,owner:{clientId:'example-desktop',hostId:'local'},watchers:new Set([phone]),waiters:[]});
  adapter.watch=async (id,device,options)=>{watches.push({id,device,options});};
  adapter.selectPlugins=async()=>({plugins:[{id:'example@example',name:'example',displayName:'示例'}],check(){}});
  context.after(()=>adapter.close());
  return {adapter,state,requests,watches,guard:{permissionRevision:permissionState(state).revision,confirmedFullAccess:false}};
}

for(const [name,mutate,code] of [
  ['权限切换',state=>{state.latestThreadSettings=full;},'PERMISSIONS_CHANGED'],
  ['电脑完成首轮',state=>{state.turns=[{turnId:'example-turn',status:'completed',items:[]}];},'FIRST_MESSAGE_CHANGED'],
])test('准备插件时'+name+'会阻止首条 IPC',async context=>{
  const f=adapterFixture(context), select=f.adapter.selectPlugins;
  f.adapter.selectPlugins=async()=>{
    await Promise.resolve();
    mutate(f.state);
    return select();
  };
  await assert.rejects(f.adapter.operate('turn.send',params,command,phone,()=>{},f.guard),{code});
  assert.deepEqual(f.watches,[{id:threadId,device:phone,options:{fresh:true,history:false}}]);
  assert.equal(f.requests.length,0);
});

test('首条 IPC 固定已核验沙箱和审查设置，完整访问须独立确认',async context=>{
  const f=adapterFixture(context);
  await f.adapter.operate('turn.send',params,command,phone,()=>{},f.guard);
  const [method,payload]=f.requests[0];
  assert.equal(method,'thread-follower-start-turn');
  const {permissions,approvalPolicy,approvalsReviewer,input}=payload.turnStart.request;
  assert.deepEqual({permissions,approvalPolicy,approvalsReviewer},workspace);
  assert.ok(input.some(item=>item.type==='mention'&&item.name==='example'));
  f.state.latestThreadSettings=full;
  const fullGuard={permissionRevision:permissionState(f.state).revision,confirmedFullAccess:false};
  await assert.rejects(f.adapter.operate('turn.send',params,command,phone,()=>{},fullGuard),{code:'PERMISSION_CONFIRMATION_REQUIRED'});
  assert.equal(f.requests.length,1);
  await f.adapter.operate('turn.send',params,command,phone,()=>{},{...fullGuard,confirmedFullAccess:true});
  assert.equal(f.requests[1][1].turnStart.request.permissions,full.permissions);
});

test('外层首条保护参与账本去重且只接纳就绪的普通单实例',async context=>{
  const adapter=new EventEmitter(), journal=new Journal();
  adapter.client={instance:{directIpc:true,ready:true,alive:true,generation}};
  adapter.close=()=>{};
  let calls=0;
  const guard={permissionRevision:'a'.repeat(64),confirmedFullAccess:false};
  adapter.operate=async (_method,body,_id,_phone,_checkpoint,actualGuard)=>{
    assert.deepEqual(body,params);
    assert.deepEqual(actualGuard,guard);
    calls++;
    return {ok:true};
  };
  const agent=new BridgeAgent({config:{},adapter,journal});
  context.after(()=>agent.close());
  const request={v:1,type:'request',requestId:command,deviceId:phone,method:'turn.send',params,firstMessageGuard:guard,expectedGeneration:generation};
  assert.deepEqual((await agent.handleRequest(request)).result,{ok:true});
  assert.equal((await agent.handleRequest({...request,firstMessageGuard:{...guard,confirmedFullAccess:true}})).error.code,'REQUEST_ID_REUSED');
  assert.equal((await agent.handleRequest({...request,firstMessageGuard:{...guard,unknown:true}})).error.code,'BAD_PARAMS');
  adapter.client.instance.directIpc=false;
  assert.equal((await agent.handleRequest(request)).error.code,'INSTANCE_CHANGED');
  assert.equal(calls,1);
});

test('转发标记是新代次时仍拒绝手机预期旧代次的请求',async()=>{
  const runtime={instance:{generation,alive:true},client:{assertCurrent:()=>assert.fail('代次错误不得尝试路由')}};
  await assert.rejects(InstanceRuntime.prototype.request.call(runtime,{
    generation,expectedGeneration:'00000000-0000-4000-8000-000000000003',method:'thread.create',
  }),{code:'INSTANCE_CHANGED'});
});
