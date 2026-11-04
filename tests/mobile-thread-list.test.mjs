import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const plain=value=>JSON.parse(JSON.stringify(value));
/** 执行实际列表服务，通过可控异步响应检查并发、缓存和授权归属。 */
function fixture(count=2){
 const requests=[],connection={configurationRevision:1,configured:true,connected:true,error:'',status:'已连接',hostId:'pc0',computers:Array.from({length:count},(_,i)=>({id:'pc'+i,label:'电脑'+i,online:true}))};
 const watchers=[],liveThreadLists={updates:[]},restores=[],writes=[];
 const context=vm.createContext({watch:(source,callback,options)=>{let previous=source();if(options?.immediate)callback(previous);watchers.push(()=>{const next=source();if(next!==previous){previous=next;callback(next);}});},liveThreadLists,connection,reactive:value=>value,bridge:{readComputerThreads(hostId){return new Promise((resolve,reject)=>requests.push({hostId,resolve,reject}));}},
  readThreadListCache:namespace=>new Promise((resolve,reject)=>restores.push({namespace,resolve,reject})),
  replaceThreadListCacheHost:(namespace,host)=>writes.push({action:'replace',namespace,host}),
  removeThreadListCacheHost:(namespace,hostId)=>writes.push({action:'removeHost',namespace,hostId}),
  removeThreadListCacheThreads:(namespace,hostId,ids)=>writes.push({action:'removeRows',namespace,hostId,ids}),
  retainThreadListCacheHosts:(namespace,hostIds)=>writes.push({action:'retain',namespace,hostIds}),
  clearThreadListCache:namespace=>writes.push({action:'clear',namespace})});
 const source=fs.readFileSync('apps/mobile/services/thread-list.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
 vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.subject={threadList,syncThreadComputers,refreshComputerThreads,visibleComputerThreads,computerThreadsLoading,disconnectThreadLists,removeDeletedThreads,removeArchivedThread,startThreadListCache,listDisplayComputers};',context);
 return {...context.subject,connection,requests,liveThreadLists,restores,writes,push:()=>watchers.forEach(callback=>callback())};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const row=(id,title,updatedAt)=>({id,title,cwd:'E:/git/项目',updatedAt,status:'idle'});

test('全部列表最多同时读取四台电脑，同一电脑在途请求不重复，切换筛选不改变执行电脑',async()=>{
 const f=fixture(6);f.refreshComputerThreads();assert.equal(f.requests.length,4);f.refreshComputerThreads();assert.equal(f.requests.length,4);
 f.requests[0].resolve({threads:[row('a','甲',10)]});await settle();assert.equal(f.requests.length,5);
 f.requests[1].resolve({threads:[]});await settle();assert.equal(f.requests.length,6);
 for(const request of f.requests.slice(2))request.resolve({threads:[]});await settle();
 assert.equal(f.visibleComputerThreads('','').length,1);assert.equal(f.connection.hostId,'pc0');assert.equal(f.threadList.computers.every(item=>item.loaded&&!item.loading),true);
});

test('不同电脑的同号会话分别保留，按更新时间混排，搜索跟随电脑筛选',async()=>{
 const f=fixture();f.refreshComputerThreads();f.requests[0].resolve({threads:[row('same','首页优化',10)]});f.requests[1].resolve({threads:[row('same','数据库优化',20)]});await settle();
 assert.deepEqual(plain(f.visibleComputerThreads('','').map(item=>item.key)),['pc1:same','pc0:same']);
 assert.deepEqual(plain(f.visibleComputerThreads('pc0','优化').map(item=>item.title)),['首页优化']);assert.equal(f.visibleComputerThreads('pc0','数据库').length,0);
});

test('慢电脑和失败电脑不阻塞已有结果，确认空结果后后台刷新不显示首次加载',async()=>{
 const f=fixture();f.refreshComputerThreads();assert.equal(f.computerThreadsLoading(''),true);
 f.requests[0].resolve({threads:[row('a','已返回',1)]});await settle();assert.equal(f.computerThreadsLoading(''),false);
 f.requests[1].reject(new Error('模拟失败'));await settle();assert.equal(f.threadList.computers[1].loaded,false);assert.equal(f.computerThreadsLoading('pc1'),false);
 f.refreshComputerThreads('pc1');assert.equal(f.computerThreadsLoading('pc1'),true);f.requests[2].resolve({threads:[]});await settle();
 f.refreshComputerThreads('pc1');assert.equal(f.computerThreadsLoading('pc1'),false);assert.equal(f.requests.length,3);
});

test('离线保留缓存但状态不冒充在线，授权撤回和重新配对清除旧记录并忽略迟到响应',async()=>{
 const f=fixture();f.refreshComputerThreads();f.requests[0].resolve({threads:[row('a','缓存',1)]});await settle();
 f.connection.computers[0].online=false;f.syncThreadComputers();assert.equal(f.visibleComputerThreads('pc0','')[0].online,false);
 f.connection.computers=f.connection.computers.slice(0,1);f.syncThreadComputers();f.requests[1].resolve({threads:[row('secret','撤权后的旧结果',3)]});await settle();assert.equal(f.visibleComputerThreads('','').length,1);
 f.connection.configurationRevision++;f.syncThreadComputers();assert.equal(f.visibleComputerThreads('','').length,0);
 f.connection.configured=false;f.syncThreadComputers();assert.equal(f.threadList.computers.length,0);
});

test('断线使当前读取失效，重连后可重新请求，不把旧响应写入新缓存',async()=>{
 const f=fixture(1);f.refreshComputerThreads();f.connection.connected=false;f.disconnectThreadLists();
 f.requests[0].resolve({threads:[row('old','旧响应',1)]});await settle();assert.equal(f.visibleComputerThreads('','').length,0);
 f.connection.connected=true;f.refreshComputerThreads();f.requests[1].resolve({threads:[row('new','新响应',2)]});await settle();assert.equal(f.visibleComputerThreads('','')[0].id,'new');
});

test('推送在列表隐藏时更新缓存，返回及筛选不重复订阅，迟到首屏响应不覆盖新推送',async()=>{
 const f=fixture(1);f.refreshComputerThreads();
 f.liveThreadLists.updates=[{hostId:'pc0',revision:2,threads:[row('new','最新状态',2)]}];f.push();
 f.requests[0].resolve({threads:[row('old','旧快照',1)],revision:1});await settle();
 assert.equal(f.visibleComputerThreads('','')[0].id,'new');
 f.refreshComputerThreads();f.refreshComputerThreads('pc0');assert.equal(f.requests.length,1);
 f.liveThreadLists.updates[0]={hostId:'pc0',revision:3,threads:[]};f.push();assert.equal(f.visibleComputerThreads('','').length,0);
});

test('完整首帧立即可用，独立追平跨电脑隔离，较早回执不覆盖完成或超时状态',async()=>{
 const f=fixture();f.refreshComputerThreads();
 f.liveThreadLists.updates=[{hostId:'pc0',revision:2,threads:[row('same','快首帧',2)],syncing:true,catchup:true}];f.push();
 const first=f.threadList.computers[0];assert.equal(first.loaded,true);assert.equal(first.subscribed,true);assert.equal(first.syncing,true);assert.equal(first.loading,true);
 assert.equal(f.computerThreadsLoading(''),false);assert.equal(f.threadList.computers[1].loaded,false);
 f.liveThreadLists.updates[0]={hostId:'pc0',revision:3,threads:[row('same','已追平',3)],syncing:false,catchup:true};f.push();
 f.requests[0].resolve({threads:[row('same','迟到首帧',1)],revision:1,syncing:true});await settle();
 assert.equal(first.syncing,false);assert.equal(first.loading,false);assert.equal(first.threads[0].title,'已追平');
 f.requests[1].resolve({threads:[row('same','另一电脑首帧',1)],revision:1,syncing:true});await settle();
 const second=f.threadList.computers[1];
 f.liveThreadLists.updates.push({hostId:'pc1',revision:2,threads:[row('same','另一电脑首帧',1)],syncing:false,syncError:'聊天状态同步超时',catchup:true});f.push();
 assert.equal(second.syncing,false);assert.equal(second.syncError,'聊天状态同步超时');assert.equal(second.loaded,true);assert.equal(second.error,'');
 assert.deepEqual(plain(f.visibleComputerThreads('','').map(item=>item.key)),['pc0:same','pc1:same']);
 assert.equal(first.syncError,'');
});

test('追平状态不落盘，实时索引与新代次优先于旧推送和迟到磁盘',async()=>{
 const f=fixture(1);f.connection.cacheNamespace='pair-a';f.connection.computers[0].instanceGeneration='g1';f.startThreadListCache();f.refreshComputerThreads();
 f.liveThreadLists.updates=[{hostId:'pc0',generation:'g1',revision:1,threads:[row('now','完整索引',2)],syncing:true,catchup:true}];f.push();
 f.restores[0].resolve([cachedHost('pc0',[row('old','迟到磁盘',1)],'g1')]);await settle();
 assert.deepEqual(plain(f.visibleComputerThreads('','').map(item=>item.id)),['now']);
 const saved=f.writes.findLast(item=>item.action==='replace').host;assert.deepEqual(Object.keys(saved.threads[0]).sort(),['cwd','id','title','updatedAt']);
 f.connection.computers[0].instanceGeneration='g2';f.syncThreadComputers();
 assert.equal(f.threadList.computers[0].syncing,false);assert.equal(f.threadList.computers[0].syncError,'');
 f.liveThreadLists.updates[0]={hostId:'pc0',generation:'g1',revision:9,threads:[row('old','旧代次',9)],syncing:true};f.push();
 f.requests[0].resolve({threads:[row('old','旧代次回执',1)],syncing:true});await settle();assert.equal(f.visibleComputerThreads('','').length,0);
 f.liveThreadLists.updates[0]={hostId:'pc0',generation:'g2',revision:1,threads:[row('fresh','新代次',10)],syncing:true};f.push();
 assert.equal(f.threadList.computers[0].syncing,true);f.disconnectThreadLists();assert.equal(f.threadList.computers[0].syncing,false);
});

test('基线标记只属于当前快照，晚到请求失败不撤销已接管的实时首帧',async()=>{
 const f=fixture(1);f.refreshComputerThreads();
 const baseline={latestTurnId:'old-turn',latestTurnStatus:'inProgress',pending:[]};
 f.liveThreadLists.updates=[{hostId:'pc0',revision:1,threads:[{...row('a','基线',1),notificationBaselineState:baseline}],syncing:true,catchup:true}];f.push();
 assert.equal(f.threadList.computers[0].threads[0].notificationBaseline,true);
 assert.deepEqual(plain(f.threadList.computers[0].threads[0].notificationState),baseline);
 f.requests[0].reject(new Error('旧请求超时'));await settle();assert.equal(f.threadList.computers[0].error,'');assert.equal(f.threadList.computers[0].subscribed,true);
 f.liveThreadLists.updates[0]={hostId:'pc0',revision:2,threads:[row('a','实时',2)],syncing:false};f.push();
 assert.equal(f.threadList.computers[0].threads[0].notificationBaseline,false);
});

test('真实列表基线映射保留首个实时终态通知，追平历史终态及重复帧不会补发',()=>{
 const source=fs.readFileSync('apps/mobile/services/task-notification-state.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
 const context=vm.createContext({});vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.Center=TaskNotificationCenter;',context);
 const center=new context.Center(),f=fixture(1);f.refreshComputerThreads();
 const running={latestTurnId:'turn',latestTurnStatus:'inProgress',pending:[]};
 const push=(revision,threads,catchup=false)=>{f.liveThreadLists.updates=[{hostId:'pc0',revision,threads,catchup,syncing:catchup}];f.push();return center.observe('pc0','',f.threadList.computers[0].threads,revision);};
 push(1,[{...row('a','正在运行',1),notificationBaselineState:running}],true);
 const completed={...running,latestTurnStatus:'completed'};
 assert.equal(push(2,[{...row('a','实时完成',2),notificationState:completed}])[0].kind,'completed');
 center.dismiss(3);assert.equal(push(3,[{...row('a','重复完成',2),notificationState:completed}]).length,0);
 assert.equal(push(4,[{...row('a','追平历史终态',4),notificationBaselineState:{...completed,latestTurnId:'history'}}],true).length,0);
 assert.equal(push(5,[{...row('a','仍待交互',5),notificationBaselineState:{...completed,pending:[{kind:'approval',id:'a',turnId:'turn'}]}}],true)[0].kind,'approval');
});

test('电脑图标独立显示首次加载、后台追平及五秒超时警告，已有列表仍可用',()=>{
 const source=fs.readFileSync('apps/mobile/components/chat-list/chat-list.uvue','utf8');
 const methods=source.slice(source.indexOf('function computerSyncState('),source.indexOf('// 默认按项目展示'));
 const connection={connected:true,error:'',status:'已连接',computers:[{id:'pc0',online:true}]};
 const entry={hostId:'pc0',loading:true,loaded:false,error:'',syncing:false,syncError:''},threadList={computers:[entry]};
 const context=vm.createContext({connection,threadList,displayComputers:{value:connection.computers}});
 vm.runInContext(stripTypeScriptTypes(methods,{mode:'transform'})+';globalThis.subject={computerSyncState,computerSyncLabel};',context);
 const {computerSyncState:state,computerSyncLabel:label}=context.subject;
 assert.equal(state('pc0'),'loading');entry.loaded=true;assert.equal(state('pc0'),'');entry.syncing=true;assert.equal(state('pc0'),'loading');
 entry.syncing=false;entry.syncError='聊天状态同步超时';assert.equal(state('pc0'),'error');assert.equal(label('pc0'),'聊天状态同步超时');assert.equal(entry.loaded,true);
 entry.syncError='';assert.equal(state('pc0'),'');connection.computers[0].online=false;assert.equal(state('pc0'),'offline');
});


test('永久删除拦截迟到推送，不影响其他电脑的同号会话',async()=>{
 const f=fixture();f.connection.threads=[];f.refreshComputerThreads();
 f.requests[0].resolve({threads:[row('same','合成主对话',2)]});f.requests[1].resolve({threads:[row('same','另一电脑对话',1)]});await settle();
 f.removeDeletedThreads('pc0',['same']);
 f.liveThreadLists.updates=[{hostId:'pc0',revision:3,threads:[row('same','迟到快照',3)]},{hostId:'pc1',revision:3,threads:[row('same','另一电脑对话',1)]}];f.push();
 assert.deepEqual(plain(f.visibleComputerThreads('','').map(item=>item.key)),['pc1:same']);
});

const cachedHost=(hostId,threads,instanceGeneration='')=>({hostId,label:`缓存${hostId}`,icon:'desktop',instanceGeneration,threads});

test('完全断网先恢复可筛选的离线列表，不把副本放入实时授权、通知和订阅数据',async()=>{
 const f=fixture(0);f.connection.cacheNamespace='pair-a';f.connection.connected=false;f.startThreadListCache();
 assert.equal(f.computerThreadsLoading(''),true);
 f.restores[0].resolve([cachedHost('pc0',[row('same','缓存甲',10)]),cachedHost('pc1',[row('same','缓存乙',20)])]);await settle();
 assert.equal(f.threadList.cachedReady,true);assert.equal(f.computerThreadsLoading(''),false);
 assert.deepEqual(plain(f.listDisplayComputers().map(item=>[item.id,item.online])),[['pc0',false],['pc1',false]]);
 assert.deepEqual(plain(f.visibleComputerThreads('pc0','缓存').map(item=>[item.key,item.online,item.cached,item.status??null])),[['pc0:same',false,true,null]]);
 assert.equal(f.connection.computers.length,0);assert.equal(f.threadList.computers.length,0);assert.equal(f.requests.length,0);
});

test('实时空列表、实例换代与撤权优先于迟到的磁盘数据',async()=>{
 const f=fixture(3);f.connection.cacheNamespace='pair-a';f.startThreadListCache();
 f.connection.computers[1].instanceGeneration='new';f.connection.computers.pop();f.refreshComputerThreads();
 f.requests[0].resolve({threads:[]});await settle();
 f.restores[0].resolve([cachedHost('pc0',[row('old','旧窗口',1)]),cachedHost('pc1',[row('old','旧实例',2)],'old'),cachedHost('pc2',[row('old','已撤权',3)])]);await settle();
 assert.deepEqual(plain(f.visibleComputerThreads('','')),[]);
 assert.deepEqual(plain(f.writes.filter(item=>item.action==='removeHost').map(item=>item.hostId)),['pc1','pc2']);
 f.requests[1].resolve({threads:[row('new','新实例',4)]});await settle();
 assert.equal(f.visibleComputerThreads('','')[0].title,'新实例');
 f.connection.cacheNamespace='pair-b';f.push();assert.ok(f.writes.some(item=>item.action==='clear'&&item.namespace==='pair-a'));
});

test('归档旧推送不会恢复条目，确认移出后可接收取消归档，窗口裁剪按实时列表展示',async()=>{
 const f=fixture(1);f.connection.cacheNamespace='pair-a';f.startThreadListCache();f.refreshComputerThreads();
 f.requests[0].resolve({threads:[row('a','归档聊天',1)]});await settle();f.removeArchivedThread('pc0','a');
 assert.ok(f.writes.some(item=>item.action==='removeRows'&&item.ids[0]==='a'));
 const push=(revision,threads)=>{f.liveThreadLists.updates=[{hostId:'pc0',revision,threads}];f.push();};
 push(1,[row('a','迟到推送',1)]);assert.equal(f.visibleComputerThreads('','').length,0);
 push(2,[]);push(3,[row('a','取消归档',2)]);assert.equal(f.visibleComputerThreads('','').length,1);
 push(4,[]);assert.equal(f.visibleComputerThreads('','').length,0);
});
