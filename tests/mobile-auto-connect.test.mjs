import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 执行页面实际的自动连接入口与监听，不复制调度策略。 */
function fixture(){
  const page=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8');
  const refs=['operationError','activating','autoConnectPending','pageVisible','pageHostId','pageThreadId'];
  const declarations=page.split(/\r?\n/).filter(line=>refs.some(name=>line.startsWith('const '+name+' ='))||line.startsWith('let activationRequest =')||line.startsWith('let pageAlive =')||line.startsWith('const readOnly =')||line.startsWith('const canWrite =')||line.startsWith('function isCurrentPage()')).join('\n');
  const begin=page.indexOf('function continueConversation()');
  const methods=page.slice(begin,page.indexOf('function copyText(',begin));
  const hint=page.slice(page.indexOf('const conversationConnectionHint ='),page.indexOf('const openingTitle ='));
  const watches=[],requests=[],loaders=[];
  const connection={hostId:'pc',activeThreadId:'thread',epoch:'e',sequence:1,connected:true,pendingCommandId:'',error:'',computers:[{id:'pc',online:true}],snapshot:{threadId:'thread',readOnly:true,messages:[]}};
  const context=vm.createContext({connection,ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(source,callback)=>watches.push({source,callback}),busy:{value:false},checking:{value:false},bridge:{syncingThread:'',openThread:id=>{requests.push(id);return new Promise((resolve,reject)=>loaders.push({resolve,reject}));}}});
  vm.runInContext(stripTypeScriptTypes(declarations+'\n'+hint+'\n'+methods,{mode:'transform'})+'\nglobalThis.subject={operationError,activating,autoConnectPending,pageVisible,pageHostId,pageThreadId,canWrite,conversationConnectionHint,tryAutoConnectConversation,continueConversation};',context);
  const f=context.subject;f.pageHostId.value='pc';f.pageThreadId.value='thread';f.pageVisible.value=true;
  return {page,context,connection,f,requests,loaders,tick:()=>watches[0].callback(watches[0].source(),'')};
}
const flush=()=>new Promise(setImmediate);

test('只读页面不自动导航，明确点击后连接一次，成功后开放输入且不发送消息',async()=>{
  const t=fixture();assert.equal(t.f.canWrite.value,false);t.tick();t.tick();assert.equal(t.requests.length,0);t.f.continueConversation();t.f.continueConversation();
  assert.deepEqual(t.requests,['thread']);assert.equal(t.f.activating.value,true);assert.equal(t.f.conversationConnectionHint.value,'正在连接聊天…');
  t.connection.snapshot.readOnly=false;t.loaders[0].resolve({});await flush();
  assert.equal(t.f.canWrite.value,true);assert.equal(t.f.activating.value,false);
  t.connection.snapshot.readOnly=true;t.connection.sequence++;t.tick();assert.equal(t.requests.length,1);
});

test('刷新和缓存状态变化只读订阅，不自动重放导航',()=>{
  const t=fixture();t.connection.snapshot.readOnly=false;t.context.bridge.syncingThread='thread';t.tick();
  assert.equal(t.f.autoConnectPending.value,false);assert.equal(t.requests.length,0);
  t.context.bridge.syncingThread='';t.connection.sequence++;t.connection.snapshot.readOnly=true;t.tick();assert.equal(t.requests.length,0);
  const live=fixture();live.connection.snapshot.readOnly=false;live.tick();assert.equal(live.f.autoConnectPending.value,false);assert.equal(live.requests.length,0);
  live.connection.snapshot.readOnly=true;live.tick();assert.equal(live.requests.length,0);
});

test('断线、电脑离线、待核对和隐藏页面阻止显式导航，恢复后仍需点击',()=>{
  for(const reason of ['网络','电脑','待核对','隐藏']){
    const t=fixture();
    if(reason==='网络')t.connection.connected=false;
    if(reason==='电脑')t.connection.computers[0].online=false;
    if(reason==='待核对')t.connection.pendingCommandId='unknown';
    if(reason==='隐藏')t.f.pageVisible.value=false;
    t.tick();t.f.continueConversation();assert.equal(t.requests.length,0,reason);assert.equal(t.f.autoConnectPending.value,false);
    t.connection.connected=true;t.connection.computers[0].online=true;t.connection.pendingCommandId='';t.f.pageVisible.value=true;
    t.tick();t.tick();assert.equal(t.requests.length,0,reason);t.f.continueConversation();assert.equal(t.requests.length,1,reason);
  }
});

test('加载失败保留历史和草稿，不自动循环；点击重试可恢复',async()=>{
  const t=fixture(),snapshot=t.connection.snapshot;snapshot.draft='原草稿';
  t.f.continueConversation();t.loaders[0].reject(new Error('电脑加载超时'));await flush();
  assert.equal(t.f.operationError.value,'电脑加载超时');assert.equal(t.connection.error,'');assert.equal(t.connection.snapshot,snapshot);assert.equal(snapshot.draft,'原草稿');assert.equal(t.f.canWrite.value,false);
  t.connection.sequence++;t.tick();assert.equal(t.requests.length,1);assert.equal(t.f.autoConnectPending.value,false);assert.equal(t.f.activating.value,false);
  t.f.continueConversation();assert.equal(t.requests.length,2);t.connection.snapshot.readOnly=false;t.loaders[1].resolve({});await flush();assert.equal(t.f.canWrite.value,true);
});

test('切换会话、电脑及卸载后的迟到回执不改写当前错误或重新触发加载',async()=>{
  for(const reason of ['会话','电脑','卸载']){
    const t=fixture();t.f.continueConversation();
    if(reason==='会话')t.connection.activeThreadId='other';
    if(reason==='电脑')t.connection.hostId='other';
    if(reason==='卸载')vm.runInContext('autoConnectPending.value=false;activationRequest++;pageAlive=false;',t.context);
    t.connection.error='新页面的提示';t.loaders[0].reject(new Error('迟到失败'));await flush();
    assert.equal(t.connection.error,'新页面的提示');t.tick();assert.equal(t.requests.length,1);
  }
  const stale=fixture();stale.connection.snapshot.threadId='other';stale.tick();assert.equal(stale.requests.length,0);
});
