import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {validateRequest} from '../packages/protocol/contracts.mjs';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';

/** 运行真实菜单数据逻辑，控制网络回执以覆盖旧服务、分页及授权撤回。 */
function fixture(){
  const requests=[],watchers=[],props={sort:'project',recentFirst:false,computerId:''},connection={configurationRevision:1,connected:true,computers:[{id:'pc',label:'合成电脑',online:true}]};
  const context=vm.createContext({defineProps:()=>props,defineEmits:()=>()=>{},ref:value=>({value}),computed:fn=>({get value(){return fn();}}),watch:(_read,callback)=>{watchers.push(callback);callback();},onUnmounted:()=>{},uni:{getWindowInfo:()=>({windowWidth:390,windowHeight:844})},connection,bridge:{readComputerMenu(hostId,params){return new Promise((resolve,reject)=>requests.push({hostId,params,resolve,reject}));}}});
  const source=fs.readFileSync('apps/mobile/components/home-menu/home-menu.uvue','utf8').split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\r?\n/gm,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.api={entries,section,showArchives,refreshArchives,loadArchives};',context);
  return {...context.api,requests,props,connection,sync:()=>watchers.forEach(fn=>fn())};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('菜单通过指定电脑查询，旧服务普通列表不得充当归档列表',async()=>{
  const f=fixture();assert.equal(f.requests[0].hostId,'pc');assert.equal(f.requests[0].params.includeUsage,true);
  f.showArchives();f.requests[1].resolve({threads:[{id:'ordinary'}]});await settle();
  assert.equal(f.entries.value[0].threads.length,0);assert.match(f.entries.value[0].archiveError,/更新/);
});
test('归档分页只读、刷新及撤权忽略旧回执，独立额度请求仍可完成',async()=>{
  const f=fixture();f.showArchives();f.refreshArchives();f.requests[1].resolve({archived:true,threads:[{id:'stale'}]});
  f.requests[2].resolve({archived:true,threads:Array.from({length:30},(_,i)=>({id:'t'+i}))});
  f.requests[0].resolve({usage:{available:true,windows:[{label:'本周',remainingPercent:48}]}});await settle();
  assert.equal(f.entries.value[0].threads.length,30);assert.equal(f.entries.value[0].windows[0].remainingPercent,48);
  f.loadArchives(f.entries.value[0]);assert.equal(f.requests[3].params.offset,30);assert.equal(f.requests[3].params.archived,true);
  f.connection.computers=[];f.sync();f.requests[3].resolve({archived:true,threads:[{id:'withdrawn'}]});await settle();assert.equal(f.entries.value.length,0);
});
test('查询参数限制布尔值和分页范围，不能透传任意目录或命令',()=>{
  const request=params=>({v:1,type:'request',requestId:'synthetic-request-123',method:'threads.list',params});
  assert.doesNotThrow(()=>validateRequest(request({archived:true,includeUsage:true,limit:30,offset:30})));
  for(const params of [{archived:'true'},{includeUsage:1},{offset:-1},{limit:101},{cwd:'/synthetic'},{command:'anything'}])assert.throws(()=>validateRequest(request(params)));
});
test('归档只读索引，不订阅或激活任何桌面会话',async()=>{
  let listed=0;
  const adapter={index:{list(params){assert.equal(params.archived,true);listed++;return [{id:'archived'}];}},refreshReadState(){throw Error('归档不能读取运行状态');},watch(){throw Error('归档不能被激活');}};
  assert.deepEqual(await DesktopAdapter.prototype.list.call(adapter,{archived:true}),[{id:'archived'}]);assert.equal(listed,1);
});

// 旧服务与临时失败分别提示，避免把能力缺失当作没有剩余额度。
test('额度响应缺失时提示更新连接服务，接口失败允许稍后重试',async()=>{
  const old=fixture();old.requests[0].resolve({threads:[]});await settle();
  assert.equal(old.entries.value[0].usageNote,'请更新电脑连接服务');
  const failed=fixture();failed.requests[0].reject(Error('合成错误'));await settle();
  assert.equal(failed.entries.value[0].usageLoading,false);
  assert.match(failed.entries.value[0].usageNote,/稍后重试/);
});

test('账号按电脑显示，断线清空身份且丢弃先前的账号回执',async()=>{
  const f=fixture();
  f.requests[0].resolve({usage:{available:false,windows:[],accountLabel:'synthetic@example.com'}});await settle();
  assert.equal(f.entries.value[0].accountLabel,'synthetic@example.com');
  f.sync();const pending=f.requests[1];
  f.connection.connected=false;f.sync();
  assert.equal(f.entries.value[0].accountLabel,'');
  pending.resolve({usage:{available:true,windows:[],accountLabel:'stale@example.com'}});await settle();
  assert.equal(f.entries.value[0].accountLabel,'');
});
