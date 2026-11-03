import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {conversationCacheSource,conversationMemoryDatabase} from './helpers/conversation-cache-fixture.mjs';

const source=name=>fs.readFileSync('apps/mobile/services/'+name+'.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
const row=(id,revision='v1',overrides={})=>({id,revision,attention:'running',important:false,terminal:false,...overrides});
const host=(id,threads,generation='g')=>({id,generation,threads});
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

/** 使用真实调度器与可控回执、时钟，检查网络边界而非镜像调度实现。 */
function fixture(){
  let now=10000,epoch=0;
  const requests=[],saved=[],cache=new Map();
  const context=vm.createContext({Date:{now:()=>now},JSON});
  vm.runInContext(stripTypeScriptTypes(source('conversation-prefetch-state'),{mode:'transform'})+';globalThis.Queue=ConversationPrefetchQueue;',context);
  const queue=new context.Queue((hostId,threadId)=>new Promise((resolve,reject)=>requests.push({hostId,threadId,resolve,reject})),(namespace,hostId,threadId)=>cache.get(JSON.stringify([namespace,hostId,threadId]))??null,(job,result)=>{saved.push({hostId:job.hostId,threadId:job.threadId,...result});cache.set(JSON.stringify([job.namespace,job.hostId,job.threadId]),result.contentRevision);return true;},()=>epoch,()=>queue.drain(now));
  const observe=(hosts,activeHost='',activeThread='',scope='pair')=>queue.observe(scope,scope,hosts,activeHost,activeThread);
  return {queue,requests,saved,cache,observe,advance:ms=>{now+=ms;queue.drain(now);},invalidate:()=>epoch++,start:()=>queue.drain(now),resolve:(index,contentRevision='v1')=>requests[index].resolve({snapshot:{},contentRevision})};
}

test('首份列表只预热执行中、未读待办和旧缓存，旧桥接无标记时不读取',async()=>{
  const f=fixture();f.cache.set(JSON.stringify(['pair','one','cached']),'old');
  f.observe([host('one',[row('old'),row('active','v1',{important:true}),row('cached'),row('legacy','')])]);f.start();
  assert.deepEqual(f.requests.map(x=>x.threadId),['active','cached']);f.resolve(0);f.resolve(1);await tick();assert.equal(f.requests.length,2);
  f.observe([host('one',[row('old','v2'),row('active'),row('cached'),row('new')])]);f.start();
  assert.deepEqual(f.requests.slice(2).map(x=>x.threadId),['old','new']);
});

test('跨电脑同号聊天独立，全局仅两路读取，重复列表不会增加请求',async()=>{
  const f=fixture(),hosts=['one','two','three'].map(id=>host(id,[row('same','v1',{important:true})]));f.observe(hosts);f.start();f.observe(hosts);f.start();
  assert.equal(f.requests.length,2);assert.equal(f.queue.activeReads,2);f.resolve(0);await tick();assert.equal(f.requests.length,3);assert.equal(f.requests[2].hostId,'three');
  f.resolve(1);f.resolve(2);await tick();assert.deepEqual(f.saved.map(x=>x.hostId),['one','two','three']);assert.equal(f.queue.activeReads,0);
});

test('首次空列表也建立基线，之后出现的普通新聊天会预加载',()=>{
  const f=fixture();f.observe([host('one',[])]);f.start();assert.equal(f.requests.length,0);
  f.observe([host('one',[row('new')])]);f.start();assert.equal(f.requests.length,1);assert.equal(f.requests[0].threadId,'new');
});

test('在途流式更新合并，旧回执不写入；一秒窗口后补取尾帧，终态优先',async()=>{
  const f=fixture();f.observe([host('one',[row('a','v1',{important:true})])]);f.start();
  for(let i=2;i<=20;i++)f.observe([host('one',[row('a','v'+i,{important:true})])]);
  assert.equal(f.requests.length,1);f.resolve(0,'v1');await tick();assert.equal(f.saved.length,0);assert.equal(f.queue.nextDelay(10000),1000);
  f.advance(999);assert.equal(f.requests.length,1);f.advance(1);assert.equal(f.requests.length,2);f.resolve(1,'v20');await tick();
  f.observe([host('one',[row('a','final',{terminal:true,attention:'completed'})])]);f.start();assert.equal(f.requests.length,3);f.resolve(2,'final');await tick();assert.equal(f.saved.at(-1).contentRevision,'final');
});

test('用户打开后退出也拒绝旧预加载覆盖实时内容，正常打开不等待队列',async()=>{
  const f=fixture(),hosts=[host('one',[row('a','v1',{important:true})])];f.observe(hosts);f.start();
  f.observe(hosts,'one','a');f.observe(hosts);f.resolve(0);await tick();assert.equal(f.saved.length,0);
  f.advance(1000);assert.equal(f.requests.length,2);f.resolve(1);await tick();assert.equal(f.saved.length,1);
});

test('后台断线、配对改变、授权撤回、实例换代和列表移除均拒绝迟到回执',async()=>{
  for(const mode of ['reset','pair','revoke','generation','removed','cache-clear']){
    const f=fixture();f.observe([host('one',[row('a','v1',{important:true})])]);f.start();
    if(mode==='reset')f.queue.reset();
    if(mode==='pair')f.observe([host('one',[row('a')])],'','','other-pair');
    if(mode==='revoke'||mode==='removed')f.observe([]);
    if(mode==='generation')f.observe([host('one',[row('a')],'new-generation')]);
    if(mode==='cache-clear')f.invalidate();
    f.resolve(0);await tick();assert.equal(f.saved.length,0,mode);
  }
});

test('失败静默退避，存储失败不会产生立即重试循环',async()=>{
  const f=fixture();f.observe([host('one',[row('a','v1',{important:true})])]);f.start();f.requests[0].reject(Error('合成超时'));await tick();
  assert.equal(f.queue.nextDelay(10000),5000);f.advance(4999);assert.equal(f.requests.length,1);f.advance(1);assert.equal(f.requests.length,2);
  f.queue.save=()=>false;f.resolve(1);await tick();assert.equal(f.queue.nextDelay(15000),5000);
});

/** 执行真实缓存代码，验证预加载沿用容量边界并保留额外历史。 */
function cacheFixture(){
  const database=conversationMemoryDatabase();const context=vm.createContext({...database.adapter,uni:{getStorageSync:()=>''},Date,reactive:value=>value,setTimeout:()=>1,clearTimeout:()=>{},clearFileReportCache:()=>{}});
  vm.runInContext(stripTypeScriptTypes(conversationCacheSource,{mode:'transform'})+';globalThis.f={saveConversationCache,peekConversationCache,conversationCacheRevision,clearConversationCache,cachedConversationSnapshot,flushConversationCacheStorage};',context);
  return {...context.f,database};
}
const message=(id,text=id)=>({id,text,role:'assistant',turnId:'turn',status:'completed'});
const snapshot=(text='正文')=>({threadId:'a',title:'合成聊天',cwd:'/synthetic/project',messages:[message('recent',text)],turns:[],latestTurn:{turnId:'turn',status:'completed'}});

test('预加载版本向后兼容、保留额外历史且只生成不可操作的展示快照',async()=>{
  const f=cacheFixture();f.saveConversationCache('pair','one',snapshot(),{messages:[message('older')],turns:[]});
  await f.flushConversationCacheStorage();
  const previous=f.peekConversationCache('pair','one','a'),before=f.database.writes.length;assert.equal(previous.contentRevision,undefined);f.peekConversationCache('pair','one','a');assert.equal(f.database.writes.length,before);
  f.saveConversationCache('pair','one',snapshot('新正文'),{messages:previous.olderMessages,turns:previous.olderTurns},'v2');
  const cached=f.peekConversationCache('pair','one','a');assert.equal(cached.contentRevision,'v2');assert.equal(cached.olderMessages[0].id,'older');assert.equal(cached.messages[0].text,'新正文');
  const display=f.cachedConversationSnapshot(cached);assert.equal(display.readOnly,true);assert.equal(display.activeTurnId,'');assert.equal(display.approvals.length,0);
  const epoch=f.conversationCacheRevision();await f.clearConversationCache('pair','one',['not-cached']);assert.ok(f.conversationCacheRevision()>epoch);
});

/** 执行应用服务和缓存，验证真实入口不会碰导航、焦点及当前聊天状态。 */
function serviceFixture(supportsConversationCache=false){
  const database=conversationMemoryDatabase(),watchers=[],timers=new Map(),requests=[],subscriptions=[],unsubscribed=[],removed=[];let timer=0;
  const connection={cacheNamespace:'pair',configurationRevision:1,connected:true,supportsConversationCache,hostId:'current',activeThreadId:'reading',snapshot:{threadId:'reading',messages:[message('reading')]},computers:[{id:'one',online:true,instanceGeneration:'g'}]};
  const threadList={computers:[{hostId:'one',online:true,subscribed:true,instanceGeneration:'g',threads:[{id:'a',contentRevision:'v1',status:'active',activeTurnId:'turn'}]}]};
  const bridge={prefetchConversation:(hostId,threadId)=>new Promise((resolve,reject)=>requests.push({hostId,threadId,resolve,reject})),watchConversationCache:(hostId,id,threads,verify)=>new Promise((resolve,reject)=>subscriptions.push({hostId,id,threads,verify,resolve,reject})),unwatchConversationCache:(hostId,id)=>unsubscribed.push({hostId,id}),invalidateRemovedConversation:(hostId,threadId)=>removed.push({hostId,threadId})};
  const context=vm.createContext({JSON,Date,bridge,connection,threadList,...database.adapter,reactive:value=>value,clearFileReportCache:()=>{},watch:(read,callback,options)=>{watchers.push(callback);if(options?.immediate)callback();},setTimeout:(fn,delay)=>{timers.set(++timer,{fn,delay});return timer;},clearTimeout:id=>timers.delete(id),uni:{getStorageSync:()=>''}});
  const bridgeSource=source('bridge');const messages=bridgeSource.slice(bridgeSource.indexOf('function hasConversationContentRevision'),bridgeSource.indexOf('type ConversationDelta'));
  vm.runInContext(stripTypeScriptTypes(conversationCacheSource+'\n'+messages+'\n'+source('conversation-prefetch-state')+'\n'+source('conversation-prefetch'),{mode:'transform'})+';globalThis.f={startConversationPrefetch,backgroundConversationPrefetch,resumeConversationPrefetch,saveConversationCache,peekConversationCache,clearConversationCache,flushConversationCacheStorage};',context);
  const refresh=()=>watchers.forEach(fn=>fn());
  const resolve=(index,text='新正文')=>{
    const snap={...snapshot(text),readOnly:true};snap.getString=key=>snap[key];snap.getBoolean=key=>snap[key];
    requests[index].resolve({snapshot:snap,getString:key=>key==='contentRevision'?'v1':null});
  };
  const push=(value,index=subscriptions.length-1)=>bridge.cacheEventHandler({hostId:'one',generation:'g',subscriptionId:subscriptions[index].id,threadId:'a',...value,getString(key){return this[key]??null;},getBoolean(key){return this[key]??null;}});
  return {...context.f,connection,threadList,requests,refresh,resolve,timers,subscriptions,unsubscribed,push,database,removed};
}

test('应用级预加载不切换电脑或聊天；缓存可立即展示，后台与归档清理后不回写',async()=>{
  const f=serviceFixture(),original=JSON.stringify(f.connection);f.startConversationPrefetch();f.startConversationPrefetch();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].hostId,'one');assert.equal(f.peekConversationCache('pair','one','a'),null);
  f.resolve(0);await tick();assert.equal(f.peekConversationCache('pair','one','a').messages[0].text,'新正文');assert.equal(JSON.stringify(f.connection),original);
  f.threadList.computers[0].threads[0].contentRevision='v2';f.refresh();assert.ok(f.timers.size>0);
  f.backgroundConversationPrefetch();assert.equal(f.timers.size,0);f.resumeConversationPrefetch();assert.equal(f.requests.length,2);
  f.clearConversationCache('pair','one',['a']);f.resolve(1,'迟到正文');await tick();assert.equal(f.peekConversationCache('pair','one','a'),null);
});

const version=letter=>'content:'+letter.repeat(64);

test('前台正文推送在回执前入内存，增量缺口仅补当前聊天，后台停止同步',async()=>{
  const f=serviceFixture(true);f.threadList.computers[0].threads.push({id:'other',updatedAt:1});f.startConversationPrefetch();
  assert.equal(f.requests.length,0);assert.equal(f.subscriptions.length,1);
  f.push({revision:version('a'),snapshot:snapshot('最新')});
  f.push({threadId:'other',revision:version('b'),snapshot:{...snapshot('另一条'),threadId:'other'}});
  f.push({revision:version('c'),baseRevision:version('a'),update:{...snapshot(),messages:undefined,order:['recent'],upserts:[],appends:[{id:'recent',text:'正文',status:'completed'}]}});
  assert.equal(f.peekConversationCache('pair','one','a').messages[0].text,'最新正文');
  f.push({revision:version('d'),baseRevision:version('b'),update:{...snapshot(),messages:undefined,order:['recent'],upserts:[],appends:[]}});
  assert.equal(f.subscriptions.length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.subscriptions[1].threads)),[{threadId:'a',revision:''},{threadId:'other',revision:version('b')}]);
  f.push({revision:version('e'),snapshot:snapshot('迟到正文')},0);
  f.push({revision:version('e'),snapshot:snapshot('旧实例正文'),generation:'old'});
  assert.equal(f.peekConversationCache('pair','one','a').messages[0].text,'最新正文');
  f.push({revision:version('e'),snapshot:snapshot('已追平正文')});
  f.backgroundConversationPrefetch();assert.equal(f.unsubscribed.at(-1).id,f.subscriptions[1].id);
  f.push({revision:version('f'),snapshot:snapshot('后台迟到正文')});
  assert.equal(f.peekConversationCache('pair','one','a').messages[0].text,'已追平正文');
  await f.flushConversationCacheStorage();assert.ok(f.database.dump('pair').rows.some(row=>row.value.includes('已追平正文')));
});

test('旧电脑拒绝正文订阅时只对该电脑恢复前台预加载',async()=>{
  const f=serviceFixture(true);f.startConversationPrefetch();
  f.subscriptions[0].reject(Error('接口不可用'));await tick();
  assert.equal(f.subscriptions.length,1);assert.equal(f.requests.length,1);
  f.resolve(0);await tick();assert.equal(f.peekConversationCache('pair','one','a').messages[0].text,'新正文');
});

test('当前详情和滑出列表的缓存继续核对，仅接收明确移除事件',()=>{
  const f=serviceFixture(true);
  Object.assign(f.connection,{hostId:'one',activeThreadId:'a',subscribedHostId:'one',subscribedThreadId:'a'});
  f.saveConversationCache('pair','one',snapshot('正在读'),null,version('a'));
  f.saveConversationCache('pair','one',{...snapshot('列表之外'),threadId:'outside'},null,version('b'));
  f.startConversationPrefetch();
  assert.deepEqual(Array.from(f.subscriptions[0].threads),[]);
  assert.deepEqual(Array.from(f.subscriptions[0].verify),['a','outside']);
  f.push({revision:version('c'),snapshot:snapshot('忽略核对正文')});
  assert.equal(f.peekConversationCache('pair','one','a').messages[0].text,'正在读');
  f.push({removed:true,revision:''});
  f.push({threadId:'outside',removed:true,revision:''});
  assert.deepEqual(f.removed,[{hostId:'one',threadId:'a'},{hostId:'one',threadId:'outside'}]);
  assert.equal(f.peekConversationCache('pair','one','a'),null);
  assert.equal(f.peekConversationCache('pair','one','outside'),null);
});
