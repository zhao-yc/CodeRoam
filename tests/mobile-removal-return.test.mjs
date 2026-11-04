import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';import {stripTypeScriptTypes} from 'node:module';

const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8'),json=value=>Object.assign(value,{getBoolean(key){return this[key]??null;},getString(key){return this[key]??null;}}),flush=()=>new Promise(resolve=>setImmediate(resolve));

/** 执行真实入队监听及确认方法，只用合成回执控制入队与执行完成的先后。 */
function fixture(){
  const watches=[],calls=[],events=[],modals=[],loading=[],notices=[],removed=[];let deletion=null,deleted=false;
  const ref=value=>({value}),c={ref,computed:read=>({get value(){return read();}}),watch:(read,callback)=>watches.push({read,callback}),onPaneHide(){},onUnmounted(){},
    submissionTasks:{accepted:{revision:0}},pageHostId:ref('synthetic-host'),pageThreadId:ref('synthetic-thread'),pageVisible:ref(true),busy:ref(false),goalBusy:ref(false),pendingAction:ref(''),canWrite:ref(true),activeTurnId:ref(''),approvalCount:ref(0),operationError:ref(''),historyError:ref(''),historyPage:ref({messages:['合成历史']}),historyRequest:0,
    props:{target:{cacheNamespace:'synthetic-pair'}},connection:{cacheNamespace:'synthetic-pair',hostId:'synthetic-host',activeThreadId:'synthetic-thread',snapshot:{status:'idle'},threads:[{id:'synthetic-thread'},{id:'other-thread'}]},deletionTasks:{revision:0},
    closeActions(){},settleSubmission(){},notify:message=>notices.push(message),emit:(...args)=>events.push(args),queueArchiveSuccessNotice:()=>notices.push('归档成功'),removeArchivedThread:(...args)=>removed.push(args),clearFileReportCache(){},
    uni:{showModal:options=>modals.push(options),hideKeyboard(){},showLoading:options=>loading.push(options.title),hideLoading:()=>loading.push('关闭')},
    deletionTask:()=>deletion,deletedThread:()=>deleted,startDeletion(hostId,threadId){deletion={commandId:'synthetic-delete-command',hostId,threadId};calls.push({method:'thread.delete',...deletion});return true;},
  };
  c.isCurrentPage=()=>c.props.target.cacheNamespace===c.connection.cacheNamespace&&c.connection.hostId===c.pageHostId.value&&c.connection.activeThreadId===c.pageThreadId.value;
  c.bridge={pendingCommand:()=>calls.at(-1)?.commandId??'',clearCommand(){},request(method,params){const call={method,params,commandId:'synthetic-archive-command'};calls.push(call);return new Promise((resolve,reject)=>Object.assign(call,{resolve:result=>resolve(json(result)),reject}));}};
  const accepted=source.slice(source.indexOf('// 入队即释放页面操作锁'),source.indexOf('const goalExpanded'));
  const deletionMethods=source.slice(source.indexOf('// 永久删除必须完成两次独立确认'),source.indexOf('// 归档只在原生回执'));
  const archiveMethods=source.slice(source.indexOf('// 归档只在原生回执'),source.indexOf('// 首次打开沿用自动定位'));
  vm.runInNewContext(stripTypeScriptTypes(accepted+'\n'+deletionMethods+'\n'+archiveMethods,{mode:'transform'})+'\nglobalThis.subject={deleteFromMenu,answerDeleteFinal,archiveFromMenu,removalSubmissionId,removalReturnStarted};',c);
  const acceptedWatch=watches.find(w=>typeof w.read==='function'&&w.read.toString().includes('submissionTasks.accepted')).callback;
  return{c,calls,events,loading,notices,removed,...c.subject,
    begin(method){if(method==='thread.delete'){c.subject.deleteFromMenu();modals.at(-1).success({confirm:true});c.subject.answerDeleteFinal(true);}else{c.subject.archiveFromMenu();modals.at(-1).success({confirm:true});}return calls.at(-1);},
    accept(method,patch={}){c.submissionTasks.accepted={revision:1,method,hostId:c.pageHostId.value,threadId:c.pageThreadId.value,taskId:calls.at(-1)?.commandId??'background-command',...patch};acceptedWatch();},
    completeDelete(){deleted=true;c.deletionTasks.revision++;watches.find(w=>typeof w.read!=='function').callback();},
  };
}

test('删除与归档先等待入队确认，确认后立即返回且不提前移除聊天或报告成功',()=>{
  for(const method of ['thread.delete','thread.archive']){
    const f=fixture();f.begin(method);assert.equal(f.events.length,0);assert.equal(f.removalSubmissionId.value,f.calls[0].commandId);
    f.accept(method);assert.deepEqual(f.events,[['close']]);assert.equal(f.c.busy.value,false);assert.equal(f.c.pendingAction.value,'');assert.equal(f.c.connection.threads.length,2);assert.deepEqual(f.notices,[]);assert.deepEqual(f.removed,[]);
    if(method==='thread.archive')assert.equal(f.loading.at(-1),'关闭');
  }
});

test('确认入队后快速完成也只返回一次，不能以成功回执再次关闭列表',async()=>{
  for(const method of ['thread.delete','thread.archive']){
    const f=fixture(),call=f.begin(method);f.accept(method);f.accept(method);
    if(method==='thread.delete')f.completeDelete();else{call.resolve({archived:true,threadId:'synthetic-thread'});await flush();}
    assert.deepEqual(f.events,[['close']]);assert.deepEqual(f.notices,[]);
  }
});

test('其他任务、电脑、聊天和非删除归档的入队不能触发返回',()=>{
  for(const patch of [{taskId:'other-command'},{hostId:'other-host'},{threadId:'other-thread'},{method:'turn.send'}]){
    const f=fixture();f.begin('thread.archive');f.accept('thread.archive',patch);assert.equal(f.events.length,0);
  }
});

test('用户离开或重新打开聊天后，原操作晚到的入队和完成回执不会带走新页面',async()=>{
  for(const method of ['thread.delete','thread.archive']){
    const f=fixture(),call=f.begin(method);f.c.pageVisible.value=false;f.accept(method);assert.equal(f.events.length,0);
    if(method==='thread.delete')f.completeDelete();else{call.resolve({archived:true,threadId:'synthetic-thread'});await flush();}assert.equal(f.events.length,0);
    const reopened=fixture();reopened.accept(method,{taskId:call.commandId});assert.equal(reopened.events.length,0);
  }
});

test('归档入队确认前失败保留详情，返回后的失败只留在任务状态，不显示成功',async()=>{
  for(const accepted of [false,true]){
    const f=fixture(),call=f.begin('thread.archive');if(accepted){f.accept('thread.archive');f.c.pageVisible.value=false;}
    call.reject(new Error('合成归档失败'));await flush();assert.equal(f.events.length,accepted?1:0);assert.equal(f.c.connection.threads.length,2);assert.equal(f.notices.includes('归档成功'),false);
  }
});

test('切换配对后迟到的归档成功不能清理新连接中的同号聊天',async()=>{
  const f=fixture(),call=f.begin('thread.archive');f.c.connection.cacheNamespace='new-synthetic-pair';call.resolve({archived:true,threadId:'synthetic-thread'});await flush();assert.equal(f.removed.length,0);assert.equal(f.c.connection.threads.length,2);assert.equal(f.events.length,0);
});
