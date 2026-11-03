import {componentContext, componentScope} from './helpers/component-context.mjs';
import {conversationCacheSource, conversationMemoryDatabase} from './helpers/conversation-cache-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const message=(id,text=id)=>({id,text,role:'assistant',turnId:'turn',status:'completed',phase:'final_answer'});
const snapshot=(messages=[message('recent')])=>({threadId:'thread',title:'合成标题',cwd:'/synthetic/project',messages,turns:[{turnId:'turn',status:'completed',durationMs:1000}],status:'active',activeTurnId:'turn',approvals:[{id:'private-approval'}],questionGroups:[{id:'private-question'}],updatedAt:1});
const uts=file=>fs.readFileSync('apps/mobile/services/'+file+'.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
const legacyKey='codex-mobile-conversation-cache-v1';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const pending=()=>Promise.withResolvers();

/** 构造曾由 v1 Storage 写入的旧版离线数据。 */
function legacyEntry(text='旧版正文') {
  return {...snapshot([message('recent',text)]),hostId:'pc',olderMessages:[message('older')],olderTurns:[],savedAt:1,accessedAt:2};
}

const legacyStorage=entry=>new Map([[legacyKey,JSON.stringify({version:1,namespace:'pair',entries:[entry]})]]);

/** 运行真实 UTS 模块，存储与计时器均独立，所有内容使用合成会话。 */
function fixture(storage=new Map(),database=conversationMemoryDatabase()) {
  let now=1000;
  const uni={getStorageSync:key=>storage.get(key)??'',setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key)};
  const c=componentContext({uni,...database.adapter,reactive:value=>value,Date:{now:()=>++now},setTimeout:()=>-1,clearTimeout:()=>{}});
  vm.runInContext(stripTypeScriptTypes(uts('file-report-cache')+'\n'+conversationCacheSource,{mode:'transform'})+';globalThis.subject={primeConversationCache,readConversationCache,peekConversationCache,saveConversationCache,cachedConversationSnapshot,clearConversationCache,retainConversationCacheHosts,conversationCacheChanges,flushConversationCacheStorage};',c);
  return {c,uni,storage,database,...c.subject};
}

test('重启后恢复正文和额外历史，持久化不包含图片数据、审批、问题及协议游标',async()=>{
  const f=fixture(),current=snapshot();current.messages[0].images=['private-image'];current.messages[0].token='private-token';
  assert.equal(f.saveConversationCache('pair','pc',current,{messages:[message('older'),message('recent','old')],turns:current.turns,cursor:'private-cursor',hasMore:false}),true);
  await f.flushConversationCacheStorage();
  const reopened=fixture(f.storage,f.database);await reopened.primeConversationCache('pair');
  const restored=reopened.readConversationCache('pair','pc','thread');
  assert.deepEqual(Array.from(restored.messages,m=>m.id),['recent']);assert.deepEqual(Array.from(restored.olderMessages,m=>m.id),['older']);
  const display=f.cachedConversationSnapshot(restored);assert.equal(display.status,'unknown');assert.equal(display.activeTurnId,'');assert.equal(display.readOnly,true);assert.equal(display.approvals.length,0);assert.equal(display.questionGroups.length,0);
  const raw=JSON.stringify(f.database.dump('pair'));for(const secret of ['private-image','private-token','private-approval','private-question','private-cursor'])assert.equal(raw.includes(secret),false);
});

test('相同编号的不同电脑和不同配对相互隔离，旧配对清理不删除新配对',async()=>{
  const f=fixture();f.saveConversationCache('pair','pc',snapshot([message('one')]),null);f.saveConversationCache('pair','other',snapshot([message('two')]),null);
  assert.equal(f.readConversationCache('pair','pc','thread').messages[0].id,'one');assert.equal(f.readConversationCache('pair','other','thread').messages[0].id,'two');assert.equal(f.readConversationCache('new','pc','thread'),null);
  await f.flushConversationCacheStorage();
  const next=fixture(f.storage,f.database);next.saveConversationCache('new','pc',snapshot(),null);await next.flushConversationCacheStorage();
  await f.clearConversationCache('pair');assert.ok(next.readConversationCache('new','pc','thread'));
  assert.equal(f.database.dump('pair').rows.length,0);assert.equal(f.database.dump('new').rows.length,2);
});

test('归档或删除按电脑和会话清理，授权撤回及清除配对删除相应记录',async()=>{
  const f=fixture();f.saveConversationCache('pair','pc',snapshot(),null);f.saveConversationCache('pair','other',snapshot(),null);
  await f.flushConversationCacheStorage();await f.flushConversationCacheStorage();
  await f.clearConversationCache('pair','pc',['thread']);assert.equal(f.readConversationCache('pair','pc','thread'),null);assert.ok(f.readConversationCache('pair','other','thread'));
  assert.equal(f.database.dump('pair').rows.length,2);
  f.retainConversationCacheHosts('pair',['pc']);assert.equal(f.readConversationCache('pair','other','thread'),null);
  await f.flushConversationCacheStorage();assert.equal(f.database.dump('pair').rows.length,0);
  f.saveConversationCache('pair','pc',snapshot(),null);await f.clearConversationCache('pair');
  assert.equal(f.database.dump('pair').rows.length,0);assert.equal(f.storage.size,0);
});

test('容量限制淘汰最早完整消息与最久未访问会话，不截断当前正文',async()=>{
  const f=fixture(),large='合'.repeat(100000),current=snapshot([message('recent',large)]);
  f.saveConversationCache('pair','pc',current,{messages:[message('oldest',large),message('older',large),...current.messages],turns:[],cursor:'',hasMore:true});
  const cached=f.readConversationCache('pair','pc','thread');assert.equal(cached.messages[0].text,large);assert.ok(cached.olderMessages.length<2);assert.equal(current.messages[0].text,large);
  for(let i=0;i<21;i++)f.saveConversationCache('pair','pc',{...snapshot(),threadId:'thread-'+i},null);
  assert.equal(f.readConversationCache('pair','pc','thread-0'),null);assert.ok(f.readConversationCache('pair','pc','thread-20'));
  const capacity=fixture();
  for(let i=0;i<20;i++)capacity.saveConversationCache('large','pc',{...current,threadId:'large-'+i},null);
  await capacity.flushConversationCacheStorage();
  const restored=fixture(capacity.storage,capacity.database);await restored.primeConversationCache('large');
  let bytes=0,count=0;
  for(let i=0;i<20;i++){const entry=restored.peekConversationCache('large','pc','large-'+i);if(entry){bytes+=JSON.stringify(entry).length*2;count++;}}
  assert.ok(bytes<=3*1024*1024);assert.ok(count>0&&count<20);
});

test('损坏缓存、旧版本、非法结构、存储禁用和实际配额不足均可降级',async()=>{
  for(const raw of ['{损坏',JSON.stringify({version:2,namespace:'pair',entries:[]}),JSON.stringify({version:1,namespace:'pair',entries:[{}]})]) {
    const f=fixture(new Map([['codex-mobile-conversation-cache-v1',raw]]));assert.equal(f.readConversationCache('pair','pc','thread'),null);assert.doesNotThrow(()=>f.saveConversationCache('pair','pc',snapshot(),null));
  }
  const f=fixture();f.uni.getStorageSync=()=>{throw Error('禁止读取');};assert.equal(f.readConversationCache('pair','pc','thread'),null);
  f.database.beforeWrite=()=>{throw Error('配额不足');};assert.equal(f.saveConversationCache('pair','pc',snapshot(),null),true);
  await f.flushConversationCacheStorage();assert.ok(f.readConversationCache('pair','pc','thread'));assert.equal(f.database.dump('pair').rows.length,0);
});

test('迁移期间可从内存显示旧正文，持久事务成功后才移除 Storage',async()=>{
  const storage=legacyStorage(legacyEntry()),f=fixture(storage),commit=pending();
  f.database.beforeWrite=()=>commit.promise;
  assert.equal(f.peekConversationCache('pair','pc','thread').messages[0].text,'旧版正文');
  await f.primeConversationCache('pair');
  const writing=f.flushConversationCacheStorage();await tick();
  assert.equal(f.database.writes.length,1);assert.equal(f.database.dump('pair').revision,'');assert.ok(storage.has(legacyKey));
  commit.resolve();await writing;
  assert.equal(storage.has(legacyKey),false);
  const restored=fixture(storage,f.database);await restored.primeConversationCache('pair');
  assert.equal(restored.peekConversationCache('pair','pc','thread').messages[0].text,'旧版正文');
  assert.equal(restored.peekConversationCache('pair','pc','thread').olderMessages[0].id,'older');
});

test('迁移失败保留旧缓存和内存，重试后也不覆盖并发提交的相同会话',async()=>{
  const storage=legacyStorage(legacyEntry()),f=fixture(storage);
  f.database.beforeWrite=()=>{throw Error('暂时不能写入');};
  await f.primeConversationCache('pair');await f.flushConversationCacheStorage();
  assert.ok(storage.has(legacyKey));assert.equal(f.peekConversationCache('pair','pc','thread').messages[0].text,'旧版正文');
  f.database.beforeWrite=null;
  const concurrent=fixture(storage,f.database);await concurrent.primeConversationCache('pair');
  concurrent.saveConversationCache('pair','pc',snapshot([message('recent','并发新正文')]),null,'new');
  await concurrent.flushConversationCacheStorage();await f.flushConversationCacheStorage();
  assert.equal(storage.has(legacyKey),false);
  assert.equal(f.peekConversationCache('pair','pc','thread').messages[0].text,'并发新正文');
  assert.equal(f.database.writes.filter(write=>write.applied).length,1);
});

test('流式正文变更只提交一条消息与会话头，读取缓存只更新访问时间',async()=>{
  const f=fixture(),history={messages:[message('older')],turns:[]};
  f.saveConversationCache('pair','pc',snapshot([message('unchanged'),message('recent','初始正文')]),history,'v1');
  f.saveConversationCache('pair','pc',{...snapshot(),threadId:'unrelated'},null);
  await f.flushConversationCacheStorage();
  f.database.writes.length=0;
  f.saveConversationCache('pair','pc',snapshot([message('unchanged'),message('recent','追加后的正文')]),history,'v2',true);
  await f.flushConversationCacheStorage();
  assert.equal(f.database.writes.length,1);
  const {put,remove,clear}=f.database.writes[0].changes;
  assert.deepEqual(remove,[]);assert.equal(clear,false);assert.equal(put.length,2);
  const changed=put.find(row=>row.key.startsWith('m:'));
  assert.equal(JSON.parse(changed.value).id,'recent');assert.equal(JSON.parse(changed.value).text,'追加后的正文');
  assert.equal(JSON.parse(put.find(row=>row.key.startsWith('h:')).value).contentRevision,'v2');
  f.database.writes.length=0;
  assert.ok(f.peekConversationCache('pair','pc','thread'));await f.flushConversationCacheStorage();assert.equal(f.database.writes.length,0);
  assert.ok(f.readConversationCache('pair','pc','thread'));await f.flushConversationCacheStorage();
  assert.deepEqual(f.database.writes[0].changes.put.map(row=>row.key),['h:["pc","thread"]']);
});

test('加载期间已归档的聊天不恢复，新的推送内容保留并落盘',async()=>{
  const seeded=fixture();seeded.saveConversationCache('pair','pc',snapshot([message('recent','历史正文')]),null,'old');
  await seeded.flushConversationCacheStorage();
  const f=fixture(new Map(),seeded.database),load=pending();f.database.beforeRead=()=>load.promise;
  const reading=f.primeConversationCache('pair');
  const clearing=f.clearConversationCache('pair','pc',['thread']);
  f.saveConversationCache('pair','pc',{...snapshot([message('recent','实时推送')]),threadId:'other'},null,'new');
  assert.equal(f.peekConversationCache('pair','pc','thread'),null);
  assert.equal(f.peekConversationCache('pair','pc','other').messages[0].text,'实时推送');
  load.resolve();await reading;await clearing;await f.flushConversationCacheStorage();
  const restored=fixture(new Map(),f.database);await restored.primeConversationCache('pair');
  assert.equal(restored.peekConversationCache('pair','pc','thread'),null);
  assert.equal(restored.peekConversationCache('pair','pc','other').messages[0].text,'实时推送');
});

test('流式写入在途时明确清理，完成后重启不会恢复已移除的聊天',async()=>{
  const f=fixture();f.saveConversationCache('pair','pc',snapshot(),null,'base');
  f.saveConversationCache('pair','other',snapshot(),null,'other');
  await f.flushConversationCacheStorage();
  const olderWrite=pending();f.database.beforeWrite=()=>olderWrite.promise;
  f.saveConversationCache('pair','pc',snapshot([message('recent','在途正文')]),null,'in-flight');
  await tick();assert.equal(f.database.writes.at(-1).applied,false);
  const clearing=f.clearConversationCache('pair','pc',['thread']);
  assert.equal(f.peekConversationCache('pair','pc','thread'),null);
  olderWrite.resolve();await clearing;
  const restored=fixture(new Map(),f.database);await restored.primeConversationCache('pair');
  assert.equal(restored.peekConversationCache('pair','pc','thread'),null);
  assert.ok(restored.peekConversationCache('pair','other','thread'));
});

test('并发冲突不覆盖同一会话的新版本，保留独立会话的变更',async()=>{
  const first=fixture();first.saveConversationCache('pair','pc',snapshot(),null,'base');await first.flushConversationCacheStorage();
  const second=fixture(new Map(),first.database);await second.primeConversationCache('pair');
  first.saveConversationCache('pair','pc',snapshot([message('recent','其他窗口的新正文')]),null,'new');
  await first.flushConversationCacheStorage();
  second.saveConversationCache('pair','pc',snapshot([message('recent','过期窗口的正文')]),null,'stale',true);
  second.saveConversationCache('pair','other',snapshot([message('recent','独立会话')]),null,'different',true);
  await second.flushConversationCacheStorage();
  assert.ok(first.database.writes.some(write=>!write.applied));
  const restored=fixture(new Map(),first.database);await restored.primeConversationCache('pair');
  assert.equal(restored.peekConversationCache('pair','pc','thread').contentRevision,'new');
  assert.equal(restored.peekConversationCache('pair','other','thread').contentRevision,'different');
});

test('切换配对后迟到的旧加载不会覆盖新配对或恢复被清理的旧缓存',async()=>{
  const old=fixture();old.saveConversationCache('pair','pc',snapshot(),null);await old.flushConversationCacheStorage();
  const f=fixture(new Map(),old.database),delayed=pending();let calls=0;
  f.database.beforeRead=namespace=>{if(namespace==='pair'&&++calls===1)return delayed.promise;};
  const reading=f.primeConversationCache('pair');
  const clearing=f.clearConversationCache('pair');
  f.saveConversationCache('new','pc',snapshot([message('recent','新配对')]),null);await f.flushConversationCacheStorage();
  delayed.resolve();await reading;await clearing;
  assert.equal(f.peekConversationCache('pair','pc','thread'),null);
  assert.equal(f.peekConversationCache('new','pc','thread').messages[0].text,'新配对');
  assert.equal(f.database.dump('pair').rows.length,0);
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
async function pageFixture(finishInitial = true) {
  const f=fixture(),watchers=[],loads=[],hides=[],unloads=[],timers=new Map(),calls=[];let timer=0;
  f.c.deletedThread=()=>false;
  f.c.props={active:true};
  const connection={configured:true,cacheNamespace:'pair',configurationRevision:1,hostId:'pc',activeThreadId:'thread',snapshot:null,connected:true,error:'',conversationError:'',epoch:'',sequence:0,subscriptionRevision:0,subscribedHostId:'pc',subscribedThreadId:'thread',contentRevision:'',pendingCommandId:'',pendingCommands:[],computers:[{id:'pc',online:true}]};
  f.saveConversationCache('pair','pc',snapshot([message('recent','旧正文')]),{messages:[message('older','更早正文')],turns:[],cursor:'old-cursor',hasMore:false});
  await f.flushConversationCacheStorage();
  Object.assign(f.c,{connection,hideTaskNoticeThread:()=>{},ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(source,callback)=>watchers.push({source,callback}),onLoad:fn=>loads.push(fn),onShow:()=>{},onHide:fn=>hides.push(fn),onUnload:fn=>unloads.push(fn),onResize:()=>{},onBackPress:()=>{},nextTick:fn=>fn(),setTimeout:(fn,delay)=>{timers.set(++timer,{fn,delay});return timer;},clearTimeout:id=>timers.delete(id),readDraft:()=>'',bridge:{watch:()=>calls.push('watch'),cancelOpen:()=>{connection.snapshot=null;},resume:()=>calls.push('resume')},reportTimeline:current=>(current?.messages??[]).map(item=>({...item,executions:[],label:''})),taskNotifications:{focusRevision:0},pendingTaskNotice:()=>null,bindImagePaste:()=>()=>{}});
  const geometry={top:20};
  f.uni.getWindowInfo=()=>({windowWidth:390,windowHeight:800});
  f.uni.getElementById=id=>id==='conversation-timeline'?{getBoundingClientRect:()=>({top:0,bottom:500,height:500})}:id==='message-older'?{getBoundingClientRect:()=>({top:geometry.top,bottom:geometry.top+40})}:null;
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  vm.runInContext(stripTypeScriptTypes(uts('turn-failure')+'\n'+uts('history')+'\n'+uts('conversation-opening')+'\n'+uts('annotations')+'\n'+uts('message-attachments')+'\n'+uts('message-presentations')+'\n'+page,{mode:'transform'})+';globalThis.page={cachedDetail,pageCacheNamespace,liveConversation,showingCachedContent,cacheSyncHint,displayConversation,historyPage,canWrite,scheduleConversationCache,flushConversationCache,following,pageVisible,historyScrollTop,refresh};',f.c);
  vm.runInContext('paneHideCallbacks.forEach(onHide);',f.c);
  const p=f.c.page;loads.forEach(fn=>fn({threadId:'thread',title:'列表标题'}));
  await f.flushConversationCacheStorage();
  if(finishInitial)for(const [id,timer] of timers)if(timer.delay===50){timers.delete(id);timer.fn();}
  let previous=p.displayConversation.value;
  return {...f,p,geometry,connection,calls,watchers,timers,hides,unloads,live:()=>{watchers.find(w=>w.source===p.liveConversation).callback();watchers.find(w=>w.source===p.displayConversation).callback(p.displayConversation.value,previous);previous=p.displayConversation.value;}};
}

test('缓存先于 PC 回执呈现，后台失败保留内容与重试，缓存不能启用发送',async()=>{
  const f=await pageFixture();assert.deepEqual(f.calls,['watch']);assert.equal(f.connection.snapshot,null);assert.equal(f.p.canWrite.value,false);assert.equal(f.p.showingCachedContent.value,true);
  assert.deepEqual(Array.from(f.p.displayConversation.value.messages,m=>m.text),['更早正文','旧正文']);assert.equal(f.p.historyPage.value.cursor,'');assert.equal(f.p.historyPage.value.hasMore,true);
  f.connection.conversationError='读取超时';assert.equal(f.p.cacheSyncHint.value,'同步失败，当前显示缓存');assert.equal(f.p.displayConversation.value.messages.length,2);f.p.refresh();assert.equal(f.calls.length,2);
});

test('实时订阅确认前接收最新展示正文，迟到的实时快照不能启用发送或覆盖缓存',async()=>{
  const f=await pageFixture();f.connection.subscribedHostId='';f.connection.subscribedThreadId='';
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

test('缓存首屏定位期间卡片挂载不产生旧位置补偿，完成初始定位后才锁定阅读',async()=>{
  const f=await pageFixture(false);f.connection.snapshot=snapshot();f.live();assert.equal(f.p.historyScrollTop.value,0);assert.equal(f.p.following.value,false);
  const initial=[...f.timers.values()].find(timer=>timer.delay===50);initial.fn();f.p.following.value=false;
  f.c.nextTick=fn=>{f.geometry.top=70;fn();};f.live();assert.equal(f.p.historyScrollTop.value,50);
});

test('实时快照替换旧尾部、保留额外历史，阅读锚点与跟随选择不被抢占',async()=>{
  const f=await pageFixture();f.p.following.value=false;f.c.nextTick=fn=>{f.geometry.top=70;fn();};f.connection.snapshot=snapshot([message('new','新正文')]);f.live();
  assert.equal(f.p.historyScrollTop.value,50);
  assert.equal(f.p.showingCachedContent.value,false);assert.deepEqual(Array.from(f.p.displayConversation.value.messages,m=>m.id),['older','new']);assert.equal(f.p.following.value,false);assert.equal(f.p.canWrite.value,true);
  f.p.flushConversationCache();const cached=f.readConversationCache('pair','pc','thread');assert.equal(cached.messages[0].text,'新正文');assert.equal(cached.olderMessages[0].id,'older');assert.equal(cached.messages.some(m=>m.id==='recent'),false);
});

test('流式更新每 500 毫秒合并保存，隐藏或卸载补存，失效配对与迟到页面不能重写缓存',async()=>{
  const f=await pageFixture();f.connection.snapshot=snapshot();f.live();for(let i=0;i<10;i++){f.connection.snapshot.messages[0].text='分片'+i;f.p.scheduleConversationCache();}
  assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,500);f.hides.forEach(fn=>fn());assert.equal(f.timers.size,0);assert.equal(f.readConversationCache('pair','pc','thread').messages[0].text,'分片9');
  f.connection.snapshot.messages[0].text='卸载前';f.p.scheduleConversationCache();f.unloads.forEach(fn=>fn());assert.equal(f.readConversationCache('pair','pc','thread').messages[0].text,'卸载前');
  f.connection.cacheNamespace='next';f.clearConversationCache('pair');f.p.scheduleConversationCache();f.p.flushConversationCache();assert.equal(f.readConversationCache('pair','pc','thread'),null);
});
