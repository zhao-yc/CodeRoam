import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 执行实际首页和列表状态，覆盖跨电脑汇总及实时快照带来的状态变化。 */
function fixture() {
  const connection = {configured:true, connected:true, configurationRevision:1, hostId:'pc-a', snapshot:null, computers:[{id:'pc-a',label:'合成电脑甲',online:true},{id:'pc-b',label:'合成电脑乙',online:true}]};
  const context = componentContext({connection, liveThreadLists:{updates:[]}, bridge:{}, reactive:value=>value, ref:value=>({value}), computed:fn=>({get value(){return fn();}}), watch:()=>{}, nextTick:fn=>fn(), onShow:()=>{}, onHide:()=>{}, onUnload:()=>{}, onUnmounted:()=>{}, onBackPress:()=>{}, uni:{getStorageSync:()=>''}});
  const bridge = fs.readFileSync('apps/mobile/services/bridge.uts','utf8');
  const states = bridge.slice(bridge.indexOf('export function taskState'),bridge.indexOf('type TextAppend'));
  const list = fs.readFileSync('apps/mobile/services/thread-list.uts','utf8');
  const home = fs.readFileSync('apps/mobile/components/chat-list/chat-list.uvue','utf8').split('<script setup lang="uts">')[1].split('</script>')[0];
  const source = (states+'\n'+list+'\n'+home).replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.api={syncThreadComputers,threadList,computerIndicator,selectedComputerId,search};',context);
  context.api.syncThreadComputers();
  return {...context.api,connection};
}
const row = (id, extra={}) => ({id,title:'合成会话',cwd:'/synthetic/project',updatedAt:1,status:'idle',...extra});

test('电脑标签按各自列表显示未读或执行中，运行结束、已读和空列表即时隐藏',()=>{
  const f=fixture(), a=f.threadList.computers[0], b=f.threadList.computers[1];
  assert.equal(f.computerIndicator('pc-a'),'idle');
  a.threads=[row('unread',{hasUnreadTurn:true})];
  b.threads=[row('running',{status:'active',activeTurnId:'turn'})];
  assert.equal(f.computerIndicator('pc-a'),'unread');assert.equal(f.computerIndicator('pc-b'),'running');
  a.threads.push(row('another-running',{status:'active'}));assert.equal(f.computerIndicator('pc-a'),'running');
  a.threads.pop();assert.equal(f.computerIndicator('pc-a'),'unread');
  a.threads[0].hasUnreadTurn=false;assert.equal(f.computerIndicator('pc-a'),'idle');
  b.threads=[];assert.equal(f.computerIndicator('pc-b'),'idle');
});

test('电脑筛选和搜索不改变其他电脑汇总，等待和离线缓存不冒充运行或未读',()=>{
  const f=fixture(), a=f.threadList.computers[0], b=f.threadList.computers[1];
  a.threads=[row('waiting',{status:'active',activeFlags:['waitingOnUserInput'],hasUnreadTurn:true})];
  b.threads=[row('unread',{hasUnreadTurn:true})];
  f.selectedComputerId.value='pc-a';f.search.value='不存在的合成文字';
  assert.equal(f.computerIndicator('pc-a'),'idle');assert.equal(f.computerIndicator('pc-b'),'unread');
  f.connection.computers[1].online=false;f.syncThreadComputers();assert.equal(f.computerIndicator('pc-b'),'idle');
  a.threads=[row('running',{status:'active'})];f.connection.connected=false;
  assert.equal(f.computerIndicator('pc-a'),'idle');
});

test('当前订阅的实时快照优先于旧列表，且不会污染另一台电脑的同号会话',()=>{
  const f=fixture();
  f.threadList.computers[0].threads=[row('same',{status:'active'})];
  f.threadList.computers[1].threads=[row('same',{hasUnreadTurn:true})];
  f.connection.snapshot={threadId:'same',status:'idle',activeTurnId:'',approvals:[],questionGroups:[],hasUnreadTurn:false};
  assert.equal(f.computerIndicator('pc-a'),'idle');assert.equal(f.computerIndicator('pc-b'),'unread');
  f.connection.snapshot.status='active';f.connection.snapshot.activeTurnId='turn';assert.equal(f.computerIndicator('pc-a'),'running');
  f.connection.snapshot.status='idle';f.connection.snapshot.activeTurnId='';f.connection.snapshot.hasUnreadTurn=true;assert.equal(f.computerIndicator('pc-a'),'unread');
});
