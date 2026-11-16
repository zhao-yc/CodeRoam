
import {componentContext} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
const read=(start,end)=>page.slice(page.indexOf(start),page.indexOf(end,page.indexOf(start)));
const flush=()=>new Promise(setImmediate);

function fixture() {
  const declarations=[
    read('const activating =','const actionsVisible ='),
    ...page.match(/^const (?:readOnly|canWrite|canBeginLiveAction|subscriptionReady|goalHostOnline|liveConversation) = .+$/gm),
    page.match(/^function isCurrentPage\(\).+$/m)[0],
  ].join('\n');
  const methods=read('// 前台意图只属于','// 只标记用户点击')+
    read('const hasSendableDraft =','function stopFromMenu(')+
    page.match(/^function onComposerFocus\(\).+$/m)[0]+'\n'+
    read('function applyComposerEnter() {','// 追加和取消');
  const ref=value=>({value}), requests=[], loaders=[], calls=[];
  const connection={hostId:'pc',activeThreadId:'thread',subscribedHostId:'pc',subscribedThreadId:'thread',connected:true,pendingCommandId:'',computers:[{id:'pc',online:true,instanceGeneration:'instance'}],snapshot:{threadId:'thread',readOnly:true,messages:[{id:'history'}]}};
  const bridge={
    foreground:true, foregroundRevision:0, generation:1, syncingThread:'',
    watch(id){calls.push('读取:'+id);return Promise.resolve();},
    activate(id){requests.push(id);return new Promise((resolve,reject)=>loaders.push({resolve,reject}));},
    resume(){calls.push('恢复连接');},
  };
  const context=componentContext({
    bridge, connection, ref, computed:get=>({get value(){return get();}}),
    pageAlive:true, pageVisible:ref(true), pageHostId:ref('pc'), pageThreadId:ref('thread'), busy:ref(false), watch(){},
    operationError:ref(''), composerSending:ref(false), inputFocused:ref(false), composerBlurTimer:0,
    clearTimeout(){}, dismissGoal(){}, queueEditing:ref(false), imageBusy:ref(false), filesReady:ref(true),
    activeTurnId:ref(''), retryTurnId:ref(''), canRetryTurn:()=>false, visiblePrediction:ref(''),
    mentionDraftRevision:0, messageChoicesRevision:()=>0, draft:ref('合成草稿'), draftImages:ref([]),
    draftFiles:ref([{id:'synthetic-file'}]), draftPlugins:ref([]), draftMentions:ref([]),
    notify:message=>calls.push(message),
    send(){calls.push('发送');context.busy.value=true;},
  });
  vm.runInContext(stripTypeScriptTypes(declarations+'\n'+methods,{mode:'transform'})+
    '\nglobalThis.subject={canWrite,activating,onComposerFocus,applyComposerEnter,primaryAction,runLiveAction};',context);
  return {connection,context,bridge,ui:context.subject,requests,loaders,calls,
    live(){connection.snapshot.readOnly=false;loaders[0].resolve({});}};
}

test('被动浏览继续显示历史，移除提示和手动打开入口；首次编辑只连接一次',async()=>{
  const t=fixture();
  assert.doesNotMatch(page,/conversationConnectionHint|@click="refreshFromMenu"|重试打开聊天/);
  assert.equal(t.requests.length,0);
  assert.equal(t.ui.canWrite.value,false);
  t.ui.onComposerFocus();t.ui.onComposerFocus();
  assert.deepEqual(t.requests,['thread']);
  assert.equal(t.connection.snapshot.messages[0].id,'history');
  t.live();await flush();
  assert.equal(t.ui.canWrite.value,true);
  assert.deepEqual(t.calls,[]);
});

test('后台读取已有实时状态时不打开电脑页面，操作入口继续执行',async()=>{
  const t=fixture();t.connection.snapshot=null;t.bridge.syncingThread='thread';
  let finish;
  t.bridge.watch=()=>new Promise(resolve=>{finish=resolve;});
  t.ui.runLiveAction(()=>t.calls.push('打开附件菜单'));
  t.ui.runLiveAction(()=>t.calls.push('重复操作'));
  assert.deepEqual(t.requests,[]);
  t.connection.snapshot={threadId:'thread',readOnly:false};
  finish();await flush();
  assert.deepEqual(t.requests,[]);
  assert.deepEqual(t.calls,['打开附件菜单']);
});

test('同步中点击发送和回车合并为一次，保留附件并在实时确认后提交',async()=>{
  const t=fixture();t.ui.onComposerFocus();
  t.ui.primaryAction();t.ui.applyComposerEnter();
  assert.deepEqual(t.requests,['thread']);assert.deepEqual(t.calls,[]);
  t.live();await flush();
  assert.deepEqual(t.calls,['发送']);
  assert.equal(t.context.draftFiles.value[0].id,'synthetic-file');
});

test('同步时编辑草稿或变更附件，成功后仍保留原操作确认',async()=>{
  for(const edit of [t=>{t.context.mentionDraftRevision++;t.context.draft.value='修改后';},t=>{t.context.draftFiles.value=[];}]){
    const t=fixture();t.ui.primaryAction();edit(t);t.live();await flush();
    assert.deepEqual(t.calls,['草稿已更新，请确认后发送']);
    t.ui.primaryAction();assert.equal(t.calls.at(-1),'发送');
  }
});

test('同步失败保留草稿和历史，只在重新发起操作时重试',async()=>{
  const t=fixture();const snapshot=t.connection.snapshot;
  t.ui.primaryAction();t.loaders[0].reject(new Error('电脑加载超时'));await flush();
  assert.equal(t.context.operationError.value,'电脑加载超时');
  assert.equal(t.connection.snapshot,snapshot);
  assert.equal(t.context.draft.value,'合成草稿');
  assert.deepEqual(t.requests,['thread']);
  assert.deepEqual(t.calls,['读取:thread']);
  t.ui.primaryAction();assert.deepEqual(t.requests,['thread','thread']);
  t.connection.snapshot.readOnly=false;t.loaders[1].resolve({});await flush();
  assert.equal(t.calls.at(-1),'发送');
});

test('切换会话、换电脑、退到后台或换代后，迟到回执不会继续提交',async()=>{
  for(const invalidate of [
    t=>{t.connection.activeThreadId='other';},
    t=>{t.connection.hostId='other';},
    t=>{t.bridge.foregroundRevision++;},
    t=>{t.connection.computers[0].instanceGeneration='other';},
    t=>{t.context.pageVisible.value=false;},
  ]){
    const t=fixture();t.ui.primaryAction();invalidate(t);t.live();await flush();
    assert.deepEqual(t.calls,[]);
  }
});

test('离线自动请求恢复连接，待核对时阻止激活或提交',async()=>{
  const t=fixture();t.connection.connected=false;t.ui.primaryAction();await flush();
  assert.deepEqual(t.calls,['恢复连接']);assert.deepEqual(t.requests,[]);
  t.connection.connected=true;t.connection.pendingCommandId='pending';
  t.ui.onComposerFocus();t.ui.primaryAction();
  assert.deepEqual(t.requests,[]);
});
