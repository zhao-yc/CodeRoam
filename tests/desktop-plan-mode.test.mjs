import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
import {executionSettings} from '../apps/bridge/model-settings.mjs';import {normalizeConversation} from '../apps/bridge/conversation.mjs';import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve)),setting=mode=>({model:'model',effort:'high',serviceTier:'',mode});
const mode=value=>({mode:value,settings:{model:'model',reasoning_effort:'high'}});

test('模式与桌面输入框一致，实时协作模式优先于旧保存值，缺失时回退旧版本',()=>{
 const state={id:'thread',turns:[],latestCollaborationMode:mode('plan'),latestThreadSettings:{collaborationMode:mode('default')}};
 assert.equal(executionSettings(state).mode,'plan');assert.equal(executionSettings({...state,latestCollaborationMode:undefined}).mode,'default');
 const before=normalizeConversation(state),next=normalizeConversation({...state,latestCollaborationMode:mode('default')});const event=conversationUpdate({snapshot:before,seq:1},next),result=applyConversationUpdate({snapshot:before,epoch:'e',seq:1},{...event,epoch:'e',seq:2});assert.equal(result.snapshot.executionSettings.mode,'default');
});

/** 执行真实页面的模式派生、读写方法和快照监听，不模拟计划状态机。 */
function page(){
 const source=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8'),pending=[],calls=[],settled=[],watchers=[];
 const context=vm.createContext({operationError:{value:''},computed:read=>({get value(){return read();}}),settingsRequest:0,settingsSnapshotRevision:0,checking:{value:false},settings:{value:setting('plan')},models:{value:[]},settingsLoading:{value:false},settingsBusy:{value:false},settingsError:{value:''},busy:{value:false},pendingAction:{value:''},composerMenu:{value:''},readOnly:{value:false},draft:{value:'正文'},draftImages:{value:[]},draftFiles:{value:[]},canWrite:{value:true},imageBusy:{value:false},filesReady:{value:true},modelSupportsImages:{value:true},activeTurnId:{value:''},pageHostId:{value:'pc'},pageThreadId:{value:'thread'},connection:{hostId:'pc',activeThreadId:'thread',snapshot:{threadId:'thread',supportsExecutionSettings:true,supportsPlanReset:false},connected:true,pendingCommandId:'command',error:''},uni:{showToast(){},getStorageSync(){throw Error('不应读取旧计划缓存');},setStorageSync(){throw Error('不应写入计划缓存');}},watch:(read,changed)=>watchers.push({read,changed}),closeComposerMenu(){},updateMenuHeight(){},refresh(){},resumeFollowing(){},notify(){},rememberSubmission(){},settleSubmission:(...args)=>settled.push(args)});
 context.isCurrentPage=()=>context.connection.hostId===context.pageHostId.value&&context.connection.activeThreadId===context.pageThreadId.value;
 context.bridge={pendingCommand:()=>context.connection.pendingCommandId,request:(method,params,write)=>{calls.push({method,params,write});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};
 const derived=source.split(/\r?\n/).find(line=>line.startsWith('const planEnabled ='));
 const read=source.slice(source.indexOf('function loadSettings()'),source.indexOf('\nfunction openComposerMenu('));
 const write=source.slice(source.indexOf('function selectSetting('),source.indexOf('// 附件变更始终写回'));
 const send=source.slice(source.indexOf('function send() {'),source.indexOf('\nfunction stop() {'));
 const watchStart=source.indexOf('watch((): string => JSON.stringify(connection.snapshot?.executionSettings');
 const watch=source.slice(watchStart,source.indexOf('\nfunction onDraftLineChange',watchStart));
 vm.runInContext(stripTypeScriptTypes([derived,read,write,send,watch].join('\n'),{mode:'transform'})+'\nglobalThis.f={planEnabled,loadSettings,selectSetting,send};',context);
 return {context,pending,calls,settled,...context.f,desktop(value){context.connection.snapshot={...context.connection.snapshot,executionSettings:setting(value)};watchers[0].changed();}};
}

test('旧消费缓存不参与显示，发送及追加不修改模式，任务完成后仍以桌面为准',async()=>{
 const f=page();assert.equal(f.planEnabled.value,true);
 for(const turn of ['', 'active']){f.context.activeTurnId.value=turn;f.send();const call=f.calls.at(-1);assert.equal(call.method,turn?'turn.steer':'turn.send');assert.equal(call.params.planMode,undefined);assert.equal(call.params.resetPlanAfterSend,undefined);assert.equal(f.planEnabled.value,true);f.pending.shift().resolve({});await tick();assert.equal(f.planEnabled.value,true);}
 f.context.connection.snapshot.status='idle';assert.equal(f.planEnabled.value,true);f.desktop('default');assert.equal(f.planEnabled.value,false);f.desktop('plan');assert.equal(f.planEnabled.value,true);
 assert.equal(f.settled.length,2);assert.equal(f.calls.some(c=>c.method==='thread.settings.update'),false);
});

test('发送明确失败或未知不改变模式和草稿，不主动恢复普通模式',async()=>{
 const f=page();f.send();f.pending.shift().reject(Error('结果待确认'));await tick();assert.equal(f.planEnabled.value,true);assert.equal(f.context.draft.value,'正文');assert.equal(f.settled.length,0);assert.equal(f.calls.length,1);
});

test('桌面变化后旧读取不能覆盖新模式，即使模式已经往返变化',async()=>{
 const f=page();f.loadSettings();f.desktop('default');f.desktop('plan');f.pending.shift().resolve({settings:setting('default'),models:[{id:'model'}]});await tick();assert.equal(f.planEnabled.value,true);assert.equal(f.context.settingsLoading.value,false);assert.equal(f.context.models.value.length,1);
});

test('手机切换等待桌面确认；较旧写回执也不能覆盖后来桌面模式',async()=>{
 const f=page();f.selectSetting('mode','default');assert.equal(f.planEnabled.value,true);assert.equal(f.calls[0].params.changes.mode,'default');assert.equal(f.calls[0].params.activeTurnId,undefined);f.pending.shift().resolve({settings:setting('default'),models:[]});await tick();assert.equal(f.planEnabled.value,false);
 f.selectSetting('mode','plan');f.desktop('plan');f.desktop('default');f.pending.shift().resolve({settings:setting('plan'),models:[]});await tick();assert.equal(f.planEnabled.value,false);
 f.selectSetting('mode','plan');f.pending.shift().reject(Error('设置未确认'));await tick();assert.equal(f.planEnabled.value,false);assert.equal(f.context.settingsError.value,'设置未确认');
});

test('旧桥接没有实时设置时使用读取结果，换会话后的迟到读取不污染其他会话',async()=>{
 const f=page();f.loadSettings();f.pending.shift().resolve({settings:setting('default'),models:[]});await tick();assert.equal(f.planEnabled.value,false);
 f.loadSettings();f.context.connection.hostId='other';f.pending.shift().resolve({settings:setting('plan'),models:[]});await tick();assert.equal(f.planEnabled.value,false);
});
