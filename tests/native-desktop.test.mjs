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

test('导航确认后才调用桌面已读接口并重新回读，导航失败或过期不得清理蓝点',async t=>{
 const calls=[],n=new NativeDesktop({invoke:async(tool,args)=>{calls.push(tool);return tool==='navigate_to_codex_page'?{navigated:true}:tool==='list_threads'?{threads:[row(id,false)]}:{};}});t.after(()=>n.close());await n.navigate(id);assert.deepEqual(calls,['navigate_to_codex_page','set_thread_read_state','list_threads']);assert.equal(n.unread.get(id),false);
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
