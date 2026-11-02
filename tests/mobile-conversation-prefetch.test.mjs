import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

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
  const storage=new Map();const context=vm.createContext({uni:{getStorageSync:key=>storage.get(key)??'',setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key)},Date,clearFileReportCache:()=>{}});
  vm.runInContext(stripTypeScriptTypes(source('conversation-cache'),{mode:'transform'})+';globalThis.f={saveConversationCache,peekConversationCache,conversationCacheRevision,clearConversationCache,cachedConversationSnapshot};',context);
  return {...context.f,storage};
}
const message=(id,text=id)=>({id,text,role:'assistant',turnId:'turn',status:'completed'});
const snapshot=(text='正文')=>({threadId:'a',title:'合成聊天',cwd:'/synthetic/project',messages:[message('recent',text)],turns:[],latestTurn:{turnId:'turn',status:'completed'}});

test('预加载版本向后兼容、保留额外历史且只生成不可操作的展示快照',()=>{
  const f=cacheFixture();f.saveConversationCache('pair','one',snapshot(),{messages:[message('older')],turns:[]});
  const previous=f.peekConversationCache('pair','one','a');const before=[...f.storage.values()][0];assert.equal(previous.contentRevision,undefined);f.peekConversationCache('pair','one','a');assert.equal([...f.storage.values()][0],before);
  f.saveConversationCache('pair','one',snapshot('新正文'),{messages:previous.olderMessages,turns:previous.olderTurns},'v2');
  const cached=f.peekConversationCache('pair','one','a');assert.equal(cached.contentRevision,'v2');assert.equal(cached.olderMessages[0].id,'older');assert.equal(cached.messages[0].text,'新正文');
  const display=f.cachedConversationSnapshot(cached);assert.equal(display.readOnly,true);assert.equal(display.activeTurnId,'');assert.equal(display.approvals.length,0);
  const epoch=f.conversationCacheRevision();f.clearConversationCache('pair','one',['not-cached']);assert.ok(f.conversationCacheRevision()>epoch);
});

/** 执行应用服务和缓存，验证真实入口不会碰导航、焦点及当前聊天状态。 */
function serviceFixture(){
  const storage=new Map(),watchers=[],timers=new Map(),requests=[];let timer=0;
  const connection={cacheNamespace:'pair',configurationRevision:1,connected:true,hostId:'current',activeThreadId:'reading',snapshot:{threadId:'reading',messages:[message('reading')]},computers:[{id:'one',online:true,instanceGeneration:'g'}]};
  const threadList={computers:[{hostId:'one',online:true,subscribed:true,instanceGeneration:'g',threads:[{id:'a',contentRevision:'v1',status:'active',activeTurnId:'turn'}]}]};
  const bridge={prefetchConversation:(hostId,threadId)=>new Promise((resolve,reject)=>requests.push({hostId,threadId,resolve,reject}))};
  const context=vm.createContext({JSON,Date,bridge,connection,threadList,clearFileReportCache:()=>{},watch:(read,callback,options)=>{watchers.push(callback);if(options?.immediate)callback();},setTimeout:(fn,delay)=>{timers.set(++timer,{fn,delay});return timer;},clearTimeout:id=>timers.delete(id),uni:{getStorageSync:key=>storage.get(key)??'',setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key)}});
  vm.runInContext(stripTypeScriptTypes(source('conversation-cache')+'\n'+source('conversation-prefetch-state')+'\n'+source('conversation-prefetch'),{mode:'transform'})+';globalThis.f={startConversationPrefetch,backgroundConversationPrefetch,resumeConversationPrefetch,peekConversationCache,clearConversationCache};',context);
  const refresh=()=>watchers.forEach(fn=>fn());
  const resolve=(index,text='新正文')=>{
    const snap={...snapshot(text),readOnly:true};snap.getString=key=>snap[key];snap.getBoolean=key=>snap[key];
    requests[index].resolve({snapshot:snap,getString:key=>key==='contentRevision'?'v1':null});
  };
  return {...context.f,connection,threadList,requests,refresh,resolve,timers};
}

test('应用级预加载不切换电脑或聊天；缓存可立即展示，后台与归档清理后不回写',async()=>{
  const f=serviceFixture(),original=JSON.stringify(f.connection);f.startConversationPrefetch();f.startConversationPrefetch();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].hostId,'one');assert.equal(f.peekConversationCache('pair','one','a'),null);
  f.resolve(0);await tick();assert.equal(f.peekConversationCache('pair','one','a').messages[0].text,'新正文');assert.equal(JSON.stringify(f.connection),original);
  f.threadList.computers[0].threads[0].contentRevision='v2';f.refresh();assert.ok(f.timers.size>0);
  f.backgroundConversationPrefetch();assert.equal(f.timers.size,0);f.resumeConversationPrefetch();assert.equal(f.requests.length,2);
  f.clearConversationCache('pair','one',['a']);f.resolve(1,'迟到正文');await tick();assert.equal(f.peekConversationCache('pair','one','a'),null);
});
