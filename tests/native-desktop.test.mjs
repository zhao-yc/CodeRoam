import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {NativeDesktop} from '../apps/bridge/native-desktop.mjs';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {EventEmitter} from 'node:events';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const row=(value,isUnread,hostId='local')=>({id:value,kind:'codex',hostId,isUnread});

test('原生目录区分本机和其他来源，历史未返回的已读状态保持未知',async t=>{
 const calls=[],n=new NativeDesktop({invoke:async(tool,args)=>{calls.push({tool,args});return args.mode==='history'?{threads:[row(other,true)]}:{pinnedThreads:[row(id,false)],threads:[row(other,false,'remote'),{...row(other,false),kind:'chatgpt'}]};}});t.after(()=>n.close());await n.refresh([id,other]);assert.equal(n.unread.get(id),false);assert.equal(n.unread.get(other),true);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.tool==='list_threads'));await n.refresh([id]);assert.equal(n.unread.has(other),false);
});

test('导航及已读确认后直接完成，目录只在后台校准，失败或过期不得清理蓝点',async t=>{
 const calls=[],n=new NativeDesktop({invoke:async(tool,args)=>{calls.push(tool);return tool==='navigate_to_codex_page'?{navigated:true}:tool==='list_threads'?{threads:[row(id,false)]}:{threadId:id,hostId:'local',read:true};}});t.after(()=>n.close());await n.navigate(id);assert.deepEqual(calls,['navigate_to_codex_page','set_thread_read_state']);assert.equal(n.unread.get(id),false);
 calls.length=0;n.invokeOverride=async tool=>{calls.push(tool);return {navigated:false};};await assert.rejects(n.navigate(id),e=>e.code==='DESKTOP_LOAD_FAILED');assert.deepEqual(calls,['navigate_to_codex_page']);
 calls.length=0;let current=true;n.invokeOverride=async tool=>{calls.push(tool);current=false;return {navigated:true};};await assert.rejects(n.navigate(id,()=>current),e=>e.code==='SUBSCRIPTION_CANCELED');assert.deepEqual(calls,['navigate_to_codex_page']);
});

test('桌面保存的蓝点优先于流式默认值，目录缺少标记不能猜为已读',t=>{
 const c=new EventEmitter();c.close=()=>{};const adapter=new DesktopAdapter({client:c});t.after(()=>adapter.close());adapter.native=new NativeDesktop({invoke:async()=>({})});const state={id,hasUnreadTurn:false,turns:[],requests:[],threadRuntimeStatus:{type:'idle'}};adapter.native.unread.set(id,true);assert.equal(adapter.snapshot(state).hasUnreadTurn,true);adapter.native.unread.clear();assert.equal(adapter.snapshot(state).hasUnreadTurn,undefined);
});

test('只监听全局状态文件通知，刷新不写入文件；关闭后不再响应通知',async t=>{
 const root=fs.mkdtempSync(path.join(path.resolve('.cache'),'codex-read-')),file=path.join(root,'.codex-global-state.json');fs.writeFileSync(file,'保持原样');let unread=true,calls=0;const n=new NativeDesktop({stateDirectory:root,invoke:async()=>{calls++;return {threads:[row(id,unread)]};}});t.after(()=>{n.close();assert.ok(root.startsWith(path.resolve('.cache')+path.sep));fs.rmSync(root,{recursive:true,force:true});});await n.refresh([id]);const changed=new Promise(resolve=>n.once('changed',resolve));unread=false;fs.appendFileSync(file,' ');await changed;assert.equal(n.unread.get(id),false);assert.equal(fs.readFileSync(file,'utf8'),'保持原样 ');n.close();const before=calls;fs.appendFileSync(file,' ');await new Promise(resolve=>setTimeout(resolve,350));assert.equal(calls,before);
});

test('原生方法和会话编号固定白名单，未知平台返回脱敏错误',async t=>{
 const n=new NativeDesktop({platform:'linux'});t.after(()=>n.close());await assert.rejects(n.call('arbitrary',{command:'run'},id),e=>e.code==='BAD_NATIVE_REQUEST');await assert.rejects(n.call('list_threads',{},'-'.repeat(36)),e=>e.code==='BAD_NATIVE_REQUEST');await assert.rejects(n.call('list_threads',{},id),e=>e.code==='DESKTOP_NATIVE_UNAVAILABLE'&&!e.message.includes('powershell'));
});

test('在途目录再慢也不阻塞已确认的聊天打开，旧目录不能恢复已清除的蓝点',async t=>{
 let finish;let lists=0;
 const n=new NativeDesktop({invoke:async tool=>{
  if(tool==='list_threads'){lists++;return new Promise(resolve=>{finish=resolve;});}
  return tool==='navigate_to_codex_page'?{navigated:true}:{threadId:id,hostId:'local',read:true};
 }});t.after(()=>n.close());
 n.unread.set(id,true);
 const old=n.refresh([id]);
 await n.navigate(id);
 assert.equal(lists,1);assert.equal(n.unread.get(id),false);
 finish({threads:[row(id,true)]});await old;
 assert.equal(n.unread.get(id),false);
});

test('导航后台目录失败不撤销成功结果，已读回执必须匹配当前本机聊天',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];
 const n=new NativeDesktop({invoke:async tool=>{
  calls.push(tool);
  if(tool==='list_threads')throw Error('合成目录超时');
  return tool==='navigate_to_codex_page'?{navigated:true}:{threadId:id,hostId:'local',read:true};
 }});t.after(()=>n.close());
 await n.navigate(id);assert.equal(n.unread.get(id),false);
 t.mock.timers.tick(250);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.filter(tool=>tool==='list_threads').length,1);
 assert.equal(n.unread.get(id),false);assert.equal(n.reading,null);
 for(const result of [{threadId:other,hostId:'local',read:true},{threadId:id,hostId:'remote',read:true},{threadId:id,hostId:'local',read:false},{}]){
  n.unread.set(id,true);n.invokeOverride=async tool=>tool==='navigate_to_codex_page'?{navigated:true}:result;
  await assert.rejects(n.navigate(id),{code:'BAD_NATIVE_RESPONSE'});assert.equal(n.unread.get(id),true);
 }
});

test('导航已读回执过期或目录回执晚于关闭时不发布旧状态',async t=>{
 let finishRead,finishList,current=true,events=0;
 const n=new NativeDesktop({invoke:async tool=>tool==='navigate_to_codex_page'?{navigated:true}:tool==='set_thread_read_state'?new Promise(resolve=>{finishRead=resolve;}):new Promise(resolve=>{finishList=resolve;})});t.after(()=>n.close());
 n.unread.set(id,true);n.on('changed',()=>events++);
 const navigation=n.navigate(id,()=>current);await new Promise(resolve=>setImmediate(resolve));current=false;
 finishRead({threadId:id,hostId:'local',read:true});await assert.rejects(navigation,{code:'SUBSCRIPTION_CANCELED'});
 assert.equal(n.unread.get(id),true);assert.equal(events,0);
 const refresh=n.refresh([id]);n.close();finishList({threads:[row(id,false)]});await refresh;
 assert.equal(n.unread.get(id),true);assert.equal(events,0);
});

test('真正原生调用超时按阶段给出错误码并释放等待记录',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const n=new NativeDesktop();n.connect=async()=>{};n.socket={write(){},destroy(){}};t.after(()=>n.close());
 for(const [tool,stage] of [['navigate_to_codex_page','聊天切换确认'],['set_thread_read_state','已读状态确认'],['list_threads','聊天目录刷新']]){
  const call=n.call(tool,{},id);await Promise.resolve();assert.equal(n.pending.size,1);
  const rejected=assert.rejects(call,{code:'DESKTOP_NATIVE_TIMEOUT',message:new RegExp(stage+'超时')});
  t.mock.timers.tick(7000);await rejected;assert.equal(n.pending.size,0);
 }
});

test('导航期间合并到旧目录的后台刷新即使旧请求失败也补刷一次',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let fail;let lists=0;
 const n=new NativeDesktop({invoke:async tool=>{
  if(tool==='list_threads'){lists++;if(lists===1)return new Promise((_,reject)=>{fail=reject;});return {threads:[row(id,false)]};}
  return tool==='navigate_to_codex_page'?{navigated:true}:{threadId:id,hostId:'local',read:true};
 }});t.after(()=>n.close());
 const old=n.refresh([id]);const rejected=assert.rejects(old,/合成旧目录失败/);
 await n.navigate(id);t.mock.timers.tick(250);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(lists,1);fail(Error('合成旧目录失败'));await rejected;
 t.mock.timers.tick(250);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(lists,2);assert.equal(n.unread.get(id),false);
 t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));assert.equal(lists,2);
});
