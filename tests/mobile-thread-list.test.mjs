import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const plain=value=>JSON.parse(JSON.stringify(value));
/** 执行实际列表服务，通过可控异步响应检查并发、缓存和授权归属。 */
function fixture(count=2){
 const requests=[],connection={configurationRevision:1,configured:true,connected:true,error:'',status:'已连接',hostId:'pc0',computers:Array.from({length:count},(_,i)=>({id:'pc'+i,label:'电脑'+i,online:true}))};
 const watchers=[],liveThreadLists={updates:[]};
 const context=vm.createContext({watch:(_source,callback)=>watchers.push(callback),liveThreadLists,connection,reactive:value=>value,bridge:{readComputerThreads(hostId){return new Promise((resolve,reject)=>requests.push({hostId,resolve,reject}));}}});
 const source=fs.readFileSync('apps/mobile/services/thread-list.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
 vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.subject={threadList,syncThreadComputers,refreshComputerThreads,visibleComputerThreads,computerThreadsLoading,disconnectThreadLists,removeDeletedThreads};',context);
 return {...context.subject,connection,requests,liveThreadLists,push:()=>watchers.forEach(callback=>callback())};
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


test('永久删除拦截迟到推送，不影响其他电脑的同号会话',async()=>{
 const f=fixture();f.connection.threads=[];f.refreshComputerThreads();
 f.requests[0].resolve({threads:[row('same','合成主对话',2)]});f.requests[1].resolve({threads:[row('same','另一电脑对话',1)]});await settle();
 f.removeDeletedThreads('pc0',['same']);
 f.liveThreadLists.updates=[{hostId:'pc0',revision:3,threads:[row('same','迟到快照',3)]},{hostId:'pc1',revision:3,threads:[row('same','另一电脑对话',1)]}];f.push();
 assert.deepEqual(plain(f.visibleComputerThreads('','').map(item=>item.key)),['pc1:same']);
});
