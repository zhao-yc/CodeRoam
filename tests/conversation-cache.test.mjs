import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const message=(id,text=id)=>({id,text,role:'assistant',turnId:'turn',status:'completed',phase:'final_answer'});
const snapshot=(messages=[message('recent')])=>({threadId:'thread',title:'合成标题',cwd:'/synthetic/project',messages,turns:[{turnId:'turn',status:'completed',durationMs:1000}],status:'active',activeTurnId:'turn',approvals:[{id:'private-approval'}],questionGroups:[{id:'private-question'}],updatedAt:1});
const uts=file=>fs.readFileSync('apps/mobile/services/'+file+'.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');

/** 运行真实 UTS 模块，存储与计时器均独立，所有内容使用合成会话。 */
function fixture(storage=new Map()) {
  let now=1000;
  const uni={getStorageSync:key=>storage.get(key)??'',setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key)};
  const c=componentContext({uni,reactive:value=>value,Date:{now:()=>++now},setTimeout:()=>1,clearTimeout:()=>{}});
  vm.runInContext(stripTypeScriptTypes(uts('file-report-cache')+'\n'+uts('conversation-cache'),{mode:'transform'})+';globalThis.subject={readConversationCache,saveConversationCache,cachedConversationSnapshot,clearConversationCache,retainConversationCacheHosts,conversationCacheChanges,flushConversationCacheStorage};',c);
  return {c,uni,storage,...c.subject};
}

test('重启后恢复正文和额外历史，持久化不包含图片数据、审批、问题及协议游标',()=>{
  const f=fixture(),current=snapshot();current.messages[0].images=['private-image'];current.messages[0].token='private-token';
  assert.equal(f.saveConversationCache('pair','pc',current,{messages:[message('older'),message('recent','old')],turns:current.turns,cursor:'private-cursor',hasMore:false}),true);
  const restored=fixture(f.storage).readConversationCache('pair','pc','thread');
  assert.deepEqual(Array.from(restored.messages,m=>m.id),['recent']);assert.deepEqual(Array.from(restored.olderMessages,m=>m.id),['older']);
  const display=f.cachedConversationSnapshot(restored);assert.equal(display.status,'unknown');assert.equal(display.activeTurnId,'');assert.equal(display.readOnly,true);assert.equal(display.approvals.length,0);assert.equal(display.questionGroups.length,0);
  const raw=[...f.storage.values()].join('');for(const secret of ['private-image','private-token','private-approval','private-question','private-cursor'])assert.equal(raw.includes(secret),false);
});

test('相同编号的不同电脑和不同配对相互隔离，旧配对清理不删除新配对',()=>{
  const f=fixture();f.saveConversationCache('pair','pc',snapshot([message('one')]),null);f.saveConversationCache('pair','other',snapshot([message('two')]),null);
  assert.equal(f.readConversationCache('pair','pc','thread').messages[0].id,'one');assert.equal(f.readConversationCache('pair','other','thread').messages[0].id,'two');assert.equal(f.readConversationCache('new','pc','thread'),null);
  f.saveConversationCache('new','pc',snapshot(),null);f.clearConversationCache('pair');assert.ok(f.readConversationCache('new','pc','thread'));
});

test('归档或删除按电脑和会话清理，授权撤回及清除配对删除相应记录',()=>{
  const f=fixture();f.saveConversationCache('pair','pc',snapshot(),null);f.saveConversationCache('pair','other',snapshot(),null);
  f.clearConversationCache('pair','pc',['thread']);assert.equal(f.readConversationCache('pair','pc','thread'),null);assert.ok(f.readConversationCache('pair','other','thread'));
  f.retainConversationCacheHosts('pair',['pc']);assert.equal(f.readConversationCache('pair','other','thread'),null);
  f.saveConversationCache('pair','pc',snapshot(),null);f.clearConversationCache('pair');assert.equal(f.storage.size,0);
});

test('容量限制淘汰最早完整消息与最久未访问会话，不截断当前正文',()=>{
  const f=fixture(),large='合'.repeat(100000),current=snapshot([message('recent',large)]);
  f.saveConversationCache('pair','pc',current,{messages:[message('oldest',large),message('older',large),...current.messages],turns:[],cursor:'',hasMore:true});
  const cached=f.readConversationCache('pair','pc','thread');assert.equal(cached.messages[0].text,large);assert.ok(cached.olderMessages.length<2);assert.equal(current.messages[0].text,large);
  for(let i=0;i<21;i++)f.saveConversationCache('pair','pc',{...snapshot(),threadId:'thread-'+i},null);
  assert.equal(f.readConversationCache('pair','pc','thread-0'),null);assert.ok(f.readConversationCache('pair','pc','thread-20'));
  for(let i=0;i<12;i++)f.saveConversationCache('large','pc',{...current,threadId:'large-'+i},null);
  assert.ok([...f.storage.values()][0].length*2<=3*1024*1024);
});

test('损坏缓存、旧版本、非法结构、存储禁用和实际配额不足均可降级',()=>{
  for(const raw of ['{损坏',JSON.stringify({version:2,namespace:'pair',entries:[]}),JSON.stringify({version:1,namespace:'pair',entries:[{}]})]) {
    const f=fixture(new Map([['codex-mobile-conversation-cache-v1',raw]]));assert.equal(f.readConversationCache('pair','pc','thread'),null);assert.doesNotThrow(()=>f.saveConversationCache('pair','pc',snapshot(),null));
  }
  const f=fixture();f.uni.getStorageSync=()=>{throw Error('禁止读取');};assert.equal(f.readConversationCache('pair','pc','thread'),null);
  f.uni.setStorageSync=()=>{throw Error('配额不足');};assert.equal(f.saveConversationCache('pair','pc',snapshot(),null),false);
});

test('应用级清理保留离线电脑内容，welcome 完成后才核对完整授权列表',()=>{
  const f=fixture(),watchers=[],connection={cacheNamespace:'pair',connected:false,computers:[]};
  f.saveConversationCache('pair','pc',snapshot(),null);
  Object.assign(f.c,{connection,watch:(read,callback,options)=>watchers.push({read,callback,options})});
  vm.runInContext(stripTypeScriptTypes(uts('conversation-cache-lifecycle'),{mode:'transform'})+';startConversationCacheLifecycle();',f.c);
  assert.notEqual(watchers[1].options?.flush,'sync');watchers[1].callback();assert.ok(f.readConversationCache('pair','pc','thread'));
  connection.connected=true;connection.computers=[{id:'pc',online:false}];watchers[1].callback();assert.ok(f.readConversationCache('pair','pc','thread'));
  connection.computers=[];watchers[1].callback();assert.equal(f.readConversationCache('pair','pc','thread'),null);
  f.saveConversationCache('pair','pc',snapshot(),null);connection.cacheNamespace='next';watchers[0].callback('next','pair');assert.equal(f.readConversationCache('pair','pc','thread'),null);
});

/** 执行实际详情页，模拟缓存首屏、最新回执和阅读锚点，不把缓存注入实时快照。 */
function pageFixture(finishInitial = true) {
  const f=fixture(),watchers=[],loads=[],hides=[],unloads=[],timers=new Map(),calls=[];let timer=0;
  f.c.deletedThread=()=>false;
  f.c.props={active:true};
  const connection={configured:true,cacheNamespace:'pair',configurationRevision:1,hostId:'pc',activeThreadId:'thread',snapshot:null,connected:true,error:'',conversationError:'',epoch:'',sequence:0,subscriptionRevision:0,subscribedHostId:'pc',subscribedThreadId:'thread',contentRevision:'',pendingCommandId:'',pendingCommands:[],computers:[{id:'pc',online:true}]};
  f.saveConversationCache('pair','pc',snapshot([message('recent','旧正文')]),{messages:[message('older','更早正文')],turns:[],cursor:'old-cursor',hasMore:false});
  Object.assign(f.c,{connection,hideTaskNoticeThread:()=>{},ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(source,callback)=>watchers.push({source,callback}),onLoad:fn=>loads.push(fn),onShow:()=>{},onHide:fn=>hides.push(fn),onUnload:fn=>unloads.push(fn),onResize:()=>{},onBackPress:()=>{},nextTick:fn=>fn(),setTimeout:(fn,delay)=>{timers.set(++timer,{fn,delay});return timer;},clearTimeout:id=>timers.delete(id),readDraft:()=>'',bridge:{watch:()=>calls.push('watch'),cancelOpen:()=>{connection.snapshot=null;},resume:()=>calls.push('resume')},reportTimeline:current=>(current?.messages??[]).map(item=>({...item,executions:[],label:''})),taskNotifications:{focusRevision:0},pendingTaskNotice:()=>null,bindImagePaste:()=>()=>{}});
  const geometry={top:20};
  f.uni.getWindowInfo=()=>({windowWidth:390,windowHeight:800});
  f.uni.getElementById=id=>id==='conversation-timeline'?{getBoundingClientRect:()=>({top:0,bottom:500,height:500})}:id==='message-older'?{getBoundingClientRect:()=>({top:geometry.top,bottom:geometry.top+40})}:null;
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  vm.runInContext(stripTypeScriptTypes(uts('turn-failure')+'\n'+uts('history')+'\n'+uts('conversation-opening')+'\n'+uts('annotations')+'\n'+uts('message-attachments')+'\n'+uts('message-presentations')+'\n'+page,{mode:'transform'})+';globalThis.page={cachedDetail,pageCacheNamespace,liveConversation,showingCachedContent,cacheSyncHint,displayConversation,historyPage,canWrite,scheduleConversationCache,flushConversationCache,following,pageVisible,historyScrollTop,refresh};',f.c);
  vm.runInContext('paneHideCallbacks.forEach(onHide);',f.c);
  const p=f.c.page;loads.forEach(fn=>fn({threadId:'thread',title:'列表标题'}));
  f.flushConversationCacheStorage();
  if(finishInitial)for(const [id,timer] of timers)if(timer.delay===50){timers.delete(id);timer.fn();}
  let previous=p.displayConversation.value;
  return {...f,p,geometry,connection,calls,watchers,timers,hides,unloads,live:()=>{watchers.find(w=>w.source===p.liveConversation).callback();watchers.find(w=>w.source===p.displayConversation).callback(p.displayConversation.value,previous);previous=p.displayConversation.value;}};
}

test('缓存先于 PC 回执呈现，后台失败保留内容与重试，缓存不能启用发送',()=>{
  const f=pageFixture();assert.deepEqual(f.calls,['watch']);assert.equal(f.connection.snapshot,null);assert.equal(f.p.canWrite.value,false);assert.equal(f.p.showingCachedContent.value,true);
  assert.deepEqual(Array.from(f.p.displayConversation.value.messages,m=>m.text),['更早正文','旧正文']);assert.equal(f.p.historyPage.value.cursor,'');assert.equal(f.p.historyPage.value.hasMore,true);
  f.connection.conversationError='读取超时';assert.equal(f.p.cacheSyncHint.value,'同步失败，当前显示缓存');assert.equal(f.p.displayConversation.value.messages.length,2);f.p.refresh();assert.equal(f.calls.length,2);
});

test('实时订阅确认前接收最新展示正文，迟到的实时快照不能启用发送或覆盖缓存',()=>{
  const f=pageFixture();f.connection.subscribedHostId='';f.connection.subscribedThreadId='';
  const cacheWatch=f.watchers.find(w=>String(w.source).includes('conversationCacheChanges'));
  const newSnapshot=snapshot([message('recent','主动推送的正文')]);
  f.saveConversationCache('pair','pc',newSnapshot,null,'content:new');cacheWatch.callback();
  assert.equal(f.p.displayConversation.value.messages.at(-1).text,'主动推送的正文');
  assert.equal(f.p.displayConversation.value.messages[0].text,'更早正文');
  f.connection.snapshot=snapshot([message('recent','旧实时快照')]);f.live();f.p.flushConversationCache();
  assert.equal(f.p.canWrite.value,false);
  assert.equal(f.p.displayConversation.value.messages.at(-1).text,'主动推送的正文');
  assert.equal(f.readConversationCache('pair','pc','thread').messages[0].text,'主动推送的正文');
  f.connection.snapshot=newSnapshot;f.connection.subscribedHostId='pc';f.connection.subscribedThreadId='thread';
  assert.equal(f.p.canWrite.value,true);
  f.connection.computers[0].online=false;
  assert.equal(f.p.canWrite.value,false);
});

test('缓存首屏定位期间卡片挂载不产生旧位置补偿，完成初始定位后才锁定阅读',()=>{
  const f=pageFixture(false);f.connection.snapshot=snapshot();f.live();assert.equal(f.p.historyScrollTop.value,0);assert.equal(f.p.following.value,false);
  const initial=[...f.timers.values()].find(timer=>timer.delay===50);initial.fn();f.p.following.value=false;
  f.c.nextTick=fn=>{f.geometry.top=70;fn();};f.live();assert.equal(f.p.historyScrollTop.value,50);
});

test('实时快照替换旧尾部、保留额外历史，阅读锚点与跟随选择不被抢占',()=>{
  const f=pageFixture();f.p.following.value=false;f.c.nextTick=fn=>{f.geometry.top=70;fn();};f.connection.snapshot=snapshot([message('new','新正文')]);f.live();
  assert.equal(f.p.historyScrollTop.value,50);
  assert.equal(f.p.showingCachedContent.value,false);assert.deepEqual(Array.from(f.p.displayConversation.value.messages,m=>m.id),['older','new']);assert.equal(f.p.following.value,false);assert.equal(f.p.canWrite.value,true);
  f.p.flushConversationCache();const cached=f.readConversationCache('pair','pc','thread');assert.equal(cached.messages[0].text,'新正文');assert.equal(cached.olderMessages[0].id,'older');assert.equal(cached.messages.some(m=>m.id==='recent'),false);
});

test('流式更新每 500 毫秒合并保存，隐藏或卸载补存，失效配对与迟到页面不能重写缓存',()=>{
  const f=pageFixture();f.connection.snapshot=snapshot();f.live();for(let i=0;i<10;i++){f.connection.snapshot.messages[0].text='分片'+i;f.p.scheduleConversationCache();}
  assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,500);f.hides.forEach(fn=>fn());assert.equal(f.timers.size,0);assert.equal(f.readConversationCache('pair','pc','thread').messages[0].text,'分片9');
  f.connection.snapshot.messages[0].text='卸载前';f.p.scheduleConversationCache();f.unloads.forEach(fn=>fn());assert.equal(f.readConversationCache('pair','pc','thread').messages[0].text,'卸载前');
  f.connection.cacheNamespace='next';f.clearConversationCache('pair');f.p.scheduleConversationCache();f.p.flushConversationCache();assert.equal(f.readConversationCache('pair','pc','thread'),null);
});
