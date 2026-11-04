import {componentContext} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 执行详情页真实的菜单同步入口，验证导航只来自显式点击。 */
function fixture() {
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const refs=['operationError','activating','activationSource','pageVisible','pageHostId','pageThreadId','liveConversation','goalHostOnline','subscriptionReady'];
  const declarations=page.split(/\r?\n/).filter(line=>refs.some(name=>line.startsWith('const '+name+' ='))||line.startsWith('let activationRequest =')||line.startsWith('let pageAlive =')||line.startsWith('const readOnly =')||line.startsWith('const canWrite =')||line.startsWith('function isCurrentPage()')).join('\n');
  const readMethod=(start,end)=>page.slice(page.indexOf(start),page.indexOf(end,page.indexOf(start)));
  const methods=readMethod('function retryDesktopOpen(', '// 只标记用户点击')+'\n'+readMethod('function refreshFromMenu(', '// 取消只收起编辑区');
  const hint=readMethod('const conversationConnectionHint =','const openingTitle =');
  const requests=[],loaders=[],calls=[];
  const connection={hostId:'pc',activeThreadId:'thread',subscribedHostId:'pc',subscribedThreadId:'thread',epoch:'e',sequence:1,connected:true,pendingCommandId:'',error:'',computers:[{id:'pc',online:true}],snapshot:{threadId:'thread',readOnly:true,messages:[]}};
  const context=componentContext({connection,ref:value=>({value}),computed:get=>({get value(){return get();}}),busy:{value:false},closeActions:()=>calls.push('关闭菜单'),notify:text=>calls.push(text),bridge:{resume:()=>calls.push('恢复连接'),openThread:id=>{requests.push(id);return new Promise((resolve,reject)=>loaders.push({resolve,reject}));}}});
  vm.runInContext(stripTypeScriptTypes(declarations+'\n'+hint+'\n'+methods,{mode:'transform'})+'\nglobalThis.subject={operationError,activating,pageVisible,pageHostId,pageThreadId,canWrite,conversationConnectionHint,refreshFromMenu};',context);
  const f=context.subject;f.pageHostId.value='pc';f.pageThreadId.value='thread';f.pageVisible.value=true;
  return {page,context,connection,f,requests,loaders,calls};
}
const flush=()=>new Promise(setImmediate);

test('历史浏览提示菜单同步，点击才加载一次，成功后开放操作且不发送草稿',async()=>{
  const t=fixture();assert.equal(t.requests.length,0);assert.equal(t.f.canWrite.value,false);
  assert.match(t.f.conversationConnectionHint.value,/右上角菜单重新同步/);
  t.f.refreshFromMenu();t.f.refreshFromMenu();assert.deepEqual(t.requests,['thread']);
  assert.equal(t.f.activating.value,true);assert.equal(t.f.conversationConnectionHint.value,'正在同步聊天…');
  t.connection.snapshot.readOnly=false;t.loaders[0].resolve({});await flush();
  assert.equal(t.f.canWrite.value,true);assert.equal(t.f.activating.value,false);
});

test('已有实时会话也可显式同步，后台状态变化不重放桌面导航',async()=>{
  const t=fixture();t.connection.snapshot.readOnly=false;t.connection.sequence++;
  assert.equal(t.requests.length,0);t.f.refreshFromMenu();assert.equal(t.requests.length,1);
  t.loaders[0].resolve({});await flush();t.connection.snapshot.readOnly=true;t.connection.sequence++;
  assert.equal(t.requests.length,1);assert.equal(t.f.activating.value,false);
});

test('断线、电脑离线、待核对和隐藏页面阻止导航，恢复后仍需重新点击',()=>{
  for(const reason of ['网络','电脑','待核对','隐藏']) {
    const t=fixture();
    if(reason==='网络')t.connection.connected=false;
    if(reason==='电脑')t.connection.computers[0].online=false;
    if(reason==='待核对')t.connection.pendingCommandId='unknown';
    if(reason==='隐藏')t.f.pageVisible.value=false;
    t.f.refreshFromMenu();assert.equal(t.requests.length,0,reason);
    if(reason==='网络')assert.ok(t.calls.includes('恢复连接'));
    t.connection.connected=true;t.connection.computers[0].online=true;t.connection.pendingCommandId='';t.f.pageVisible.value=true;
    assert.equal(t.requests.length,0,reason);t.f.refreshFromMenu();assert.equal(t.requests.length,1,reason);
  }
});

test('同步失败保留原状态和草稿，不自动循环；再次点击可重试',async()=>{
  const t=fixture(),snapshot=t.connection.snapshot;snapshot.draft='合成草稿';
  t.f.refreshFromMenu();t.loaders[0].reject(new Error('电脑加载超时'));await flush();
  assert.equal(t.f.operationError.value,'电脑加载超时');assert.equal(t.connection.error,'');assert.equal(t.connection.snapshot,snapshot);assert.equal(snapshot.draft,'合成草稿');assert.equal(t.f.canWrite.value,false);
  t.connection.sequence++;assert.equal(t.requests.length,1);assert.equal(t.f.activating.value,false);
  t.f.refreshFromMenu();assert.equal(t.requests.length,2);t.connection.snapshot.readOnly=false;t.loaders[1].resolve({});await flush();assert.equal(t.f.canWrite.value,true);
});

test('切换会话、电脑及卸载后，迟到同步回执不改写新页面',async()=>{
  for(const reason of ['会话','电脑','卸载']) {
    const t=fixture();t.f.refreshFromMenu();
    if(reason==='会话')t.connection.activeThreadId='other';
    if(reason==='电脑')t.connection.hostId='other';
    if(reason==='卸载')vm.runInContext('activationRequest++;pageAlive=false;',t.context);
    t.f.operationError.value='新页面的提示';t.loaders[0].reject(new Error('迟到失败'));await flush();
    assert.equal(t.f.operationError.value,'新页面的提示');assert.equal(t.requests.length,1);
  }
});
