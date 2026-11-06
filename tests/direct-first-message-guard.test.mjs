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
  client.assertCurrent=()=>{};
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

for (const mode of ['default','full-access']) test('首轮权限即使与快照相同也应用并回读，原提交保护保持原值：'+mode,async context=>{
  const f=adapterFixture(context), request=f.adapter.client.request;
  f.state.latestThreadSettings={...workspace};
  f.adapter.permissionCatalog={capabilities:async()=>({options:[{id:mode,enabled:true}],reviewer:'auto_review'})};
  f.adapter.client.request=async(...args)=>{
    if(args[0]==='thread-follower-update-thread-settings'){
      f.requests.push(args);
      Object.assign(f.state.latestThreadSettings,args[1].threadSettings);
      return {resultType:'success',result:{applied:true}};
    }
    return request(...args);
  };
  const originalRevision=f.guard.permissionRevision;
  await f.adapter.operate('turn.send',{...params,choices:{permissionMode:mode,permissionRevision:originalRevision,confirmedFullAccess:mode==='full-access'}},command,phone,()=>{},f.guard);
  assert.equal(f.guard.permissionRevision,originalRevision);
  assert.deepEqual(f.requests.map(call=>call[0]),['thread-follower-update-thread-settings','thread-follower-start-turn']);
  assert.equal(f.requests[1][1].turnStart.request.permissions,mode==='full-access'?full.permissions:workspace.permissions);
});

test('普通启动与多实例的空聊天首轮均保留手机显示的极高，原空值不覆盖所选档位',async context=>{
  for(const directIpc of [true,false]) {
    const f=adapterFixture(context),client=f.adapter.client;
    client.instance={platform:'win32',directIpc,routerManaged:!directIpc,ready:true,alive:true,generation};
    client.allowedClients=new Set(['example-desktop']);
    Object.assign(f.state,{latestModel:'model-a',latestReasoningEffort:null,
      latestCollaborationMode:{mode:'default',settings:{model:'model-a',reasoning_effort:null}}});
    f.adapter.modelCatalog={read:()=>[{id:'model-a',defaultEffort:'low',efforts:['low','xhigh'],speeds:[{id:''}]}]};
    const request=client.request;
    client.request=async(...args)=>args[0]==='thread-follower-read-model-settings'
      ? {resultType:'success',result:{settings:{model:'model-a',reasoningEffort:null}}}
      : request(...args);
    await f.adapter.operate('turn.send',{...params,choices:{model:'model-a',effort:'xhigh',serviceTier:'',mode:'default'}},command,phone,()=>{},f.guard);
    const [method,payload,,routing]=f.requests[0];
    assert.equal(method,'thread-follower-start-turn');
    assert.equal(payload.turnStart.request.effort,'xhigh');
    assert.equal(payload.turnStart.request.collaborationMode.settings.reasoning_effort,'xhigh');
    assert.equal(routing.targetClientId,'example-desktop');
    assert.equal(f.state.latestReasoningEffort,null);
    assert.equal(f.requests.length,1);
  }
});

test('外层首条保护参与账本去重且只接纳就绪的普通单实例',async context=>{
  const adapter=new EventEmitter(), journal=new Journal();
  adapter.client={instance:{directIpc:true,ready:true,alive:true,generation},assertCurrent(){}};
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

test('有页面且完成绑定的多实例可走首条 IPC，绑定丢失立即停止',async context=>{
  const f=adapterFixture(context), client=f.adapter.client;
  client.instance={platform:'win32',directIpc:false,port:9222,ready:true,alive:true,generation};
  client.allowedClients=new Set(['example-desktop']);
  await f.adapter.operate('turn.send',params,command,phone,()=>{},f.guard);
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0][3].targetClientId,'example-desktop');
  client.allowedClients.clear();
  await assert.rejects(f.adapter.operate('turn.send',params,command,phone,()=>{},f.guard),{code:'INSTANCE_CHANGED'});
  assert.equal(f.requests.length,1);
});

test('原生草稿不兼容时首条 guard 仍只接受当前多实例绑定和原代次',async context=>{
  const adapter=new EventEmitter(), journal=new Journal();
  adapter.client={instance:{platform:'win32',port:9222,ready:true,alive:true,generation},allowedClients:new Set(['example-desktop']),assertCurrent(){}};
  adapter.close=()=>{};
  let calls=0;
  adapter.operate=async()=>{calls++;return {ok:true};};
  const agent=new BridgeAgent({config:{},adapter,journal});
  context.after(()=>agent.close());
  const request={v:1,type:'request',requestId:command,deviceId:phone,method:'turn.send',params,expectedGeneration:generation,firstMessageGuard:{permissionRevision:'a'.repeat(64),confirmedFullAccess:false}};
  assert.deepEqual((await agent.handleRequest(request)).result,{ok:true});
  adapter.client.allowedClients.clear();
  assert.equal((await agent.handleRequest({...request,requestId:command+'-new'})).error.code,'INSTANCE_CHANGED');
  assert.equal(calls,1);
});

test('普通首条消息保留引用链接，历史正文通过独立的不可信上下文交给原桌面', async context => {
  const f=adapterFixture(context);
  const id='00000000-0000-4000-8000-000000000099';
  const content={reference:{kind:'untrusted',value:'合成历史正文'}};
  f.adapter.threadMentions={async select(ids, destination, device, options){
    assert.deepEqual([ids,destination,device,options],[[id],threadId,phone,{savedContext:true}]);
    return {mentions:[{id,title:'示例引用'}],references:[{threadId:id,hostId:'local'}],contextText:'',additionalContext:content,check(){}};
  }};
  await f.adapter.operate('turn.send',{...params,threadMentionIds:[id]},command,phone,()=>{},f.guard);
  const {request,context:restore}=f.requests[0][1].turnStart;
  assert.deepEqual(request.additionalContext,content);
  assert.ok(request.input[0].text.includes('thread://'+id));
  assert.equal(JSON.stringify([request.input,restore]).includes('合成历史正文'),false);
});
