import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 执行实际 UTS 分组逻辑，使用合成电脑与会话覆盖排序、同名路径和最近访问。 */
function subject(){
  const bridge=fs.readFileSync('apps/mobile/services/bridge.uts','utf8');
  const states=bridge.slice(bridge.indexOf('export function taskState'),bridge.indexOf('type TextAppend'));
  const source=fs.readFileSync('apps/mobile/services/thread-presentation.uts','utf8').replace(/^import .*\r?\n/gm,'');
  const context=vm.createContext({});
  vm.runInContext(stripTypeScriptTypes((states+'\n'+source).replace(/\bexport /g,''),{mode:'transform'})+';globalThis.api={groupThreads,limitThreadGroups,normalizeListPreferences,rememberRecentThread};',context);
  return context.api;
}
const plain=value=>JSON.parse(JSON.stringify(value));
const row=(id,cwd,updatedAt,extra={})=>({key:'pc:'+id,hostId:'pc',hostLabel:'合成电脑',id,cwd,title:id,online:true,updatedAt,...extra});

test('首次默认按项目排列，合法偏好保留，非法偏好回退',()=>{
  const s=subject();assert.deepEqual(plain(s.normalizeListPreferences(null)),{sort:'project',recentFirst:false});
  assert.equal(s.normalizeListPreferences({sort:'invalid'}).sort,'project');
  assert.deepEqual(plain(s.normalizeListPreferences({sort:'time',recentFirst:true})),{sort:'time',recentFirst:true});
});
test('按完整路径和电脑归属分组，组内倒序，同名项目不会误合并',()=>{
  const rows=[row('old','/work/app',2),row('new','/work/app',5),row('other','/else/app',4),row('pc2','/work/app',3,{key:'pc2:pc2',hostId:'pc2',hostLabel:'合成电脑乙'})];
  const groups=subject().groupThreads(rows,'project',false,[],0);
  assert.equal(groups.length,3);assert.deepEqual(plain(groups[0].threads.map(t=>t.id)),['new','old']);assert.ok(groups.every(g=>g.title.includes('app')));
  assert.equal(rows[0].id,'old');
});
test('优先级按待处理、执行中、未读和其他排列，离线运行不冒充在线任务',()=>{
  const rows=[row('offline','',99,{online:false,status:'active'}),row('idle','',9,{status:'idle'}),row('running','',1,{status:'active'}),row('question','',2,{unansweredQuestionCount:1}),row('unread','',8,{status:'idle',hasUnreadTurn:true}),row('approval','',3,{approvalCount:1})];
  const groups=subject().groupThreads(rows,'priority',false,[],0);
  assert.deepEqual(plain(groups.map(g=>g.title)),['待处理','执行中','未读','其他聊天']);assert.deepEqual(plain(groups[0].threads.map(t=>t.id)),['approval','question']);
});
test('最近访问去重置顶、限定当前结果且不影响原排序；时间分组保留',()=>{
  const s=subject(),rows=[row('new','/work',100),row('old','/work',1)];
  const recent=s.rememberRecentThread([{key:'pc:old',viewedAt:1},{key:'withdrawn',viewedAt:2}],'pc:old',3);
  assert.equal(recent.length,2);assert.equal(recent[0].viewedAt,3);
  const groups=s.groupThreads(rows,'time',true,recent,50);
  assert.deepEqual(plain(groups.map(g=>g.title)),['最近','今天']);assert.deepEqual(plain(groups.flatMap(g=>g.threads.map(t=>t.id))),['old','new']);
  assert.equal(s.groupThreads(rows,'time',false,recent,50)[0].title,'今天');
});

test('大列表首批跨组保留原顺序与键，补齐时保持完整分组',()=>{
  const s=subject();
  const rows=Array.from({length:150},(_,index)=>row(`t${index}`,`/work/project${Math.floor(index/20)}`,150-index));
  const groups=s.groupThreads(rows,'project',false,[],0), first=s.limitThreadGroups(groups,28);
  assert.deepEqual(plain(first.map(group=>[group.key,group.threads.length])),[[groups[0].key,20],[groups[1].key,8]]);
  assert.equal(first[0],groups[0]);assert.equal(groups[1].threads.length,20);
  assert.equal(s.limitThreadGroups(groups,-1),groups);assert.equal(groups.flatMap(group=>group.threads).length,150);
});
