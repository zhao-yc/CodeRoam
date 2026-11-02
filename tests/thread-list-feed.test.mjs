import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ThreadListFeed} from '../apps/bridge/thread-list-feed.mjs';
import {conversationContentRevision} from '../apps/bridge/conversation-prefetch.mjs';

/** 不经过手机详情订阅，列表本身持续跟随状态，正文变化合并到尾帧。 */
test('列表独立订阅推送完成、未读和移除，多设备共享且最后离线释放',async()=>{
  const adapter=new EventEmitter(),events=[],removed=[];
  let rows=[{id:'a',title:'会话',updatedAt:1}];
  const snapshot={threadId:'a',title:'会话',status:'active',activeTurnId:'turn',approvals:[],questionGroups:[],hasUnreadTurn:false};
  adapter.index={list:()=>rows};adapter.conversations=new Map();adapter.snapshot=value=>value;
  adapter.watch=async(id,device)=>{adapter.conversations.set(id,{state:snapshot,watchers:new Set([device])});return snapshot;};
  adapter.unwatch=(id,device)=>{removed.push([id,device]);adapter.conversations.get(id)?.watchers.delete(device);};
  const feed=new ThreadListFeed(adapter,event=>events.push(event));
  const initial=await feed.watch('one');assert.equal(initial.threads[0].status,'active');
  adapter.emit('conversation',{...snapshot,questionGroups:[{kind:'async',state:'pending'}]});
  assert.equal(events.at(-1).threads[0].unansweredQuestionCount,1);assert.equal(events.at(-1).threads[0].pendingQuestionCount,0);assert.equal(events.at(-1).threads[0].status,'active');
  await feed.watch('two');assert.equal(adapter.conversations.get('a').watchers.has('list-status'),true);
  adapter.emit('conversation',{...snapshot,status:'idle',activeTurnId:'',hasUnreadTurn:true});
  assert.equal(events.at(-1).threads[0].hasUnreadTurn,true);assert.equal(events.at(-1).threads[0].status,'idle');
  assert.equal(events.at(-1).threads[0].unansweredQuestionCount,0);
  const count=events.length;adapter.emit('conversation',{...snapshot,status:'idle',activeTurnId:'',hasUnreadTurn:true,messages:[{text:'正文变化'}]});assert.equal(events.length,count);
  feed.unwatch('one');assert.equal(adapter.conversations.get('a').watchers.has('list-status'),true);
  rows=[];await feed.refresh();assert.deepEqual(events.at(-1).threads,[]);
  assert.ok(removed.some(([id])=>id==='a'));feed.unwatch('two');assert.equal(feed.closed,true);feed.close();
});

/** 使用虚拟时间验证真实合并逻辑，避免靠等待时间长短判断是否丢帧。 */
function streamingFixture(t,send) {
  t.mock.timers.enable({apis:['setTimeout']});
  const adapter=new EventEmitter(),events=[];
  const snapshot={threadId:'a',title:'合成会话',cwd:'/workspace/demo',status:'active',activeTurnId:'turn',approvals:[],questionGroups:[],latestTurn:{turnId:'turn',status:'inProgress'},messages:[{id:'message',role:'assistant',kind:'agentMessage',text:'首帧',turnId:'turn',status:'inProgress'}],turns:[{turnId:'turn',status:'inProgress'}]};
  const entry={state:snapshot,watchers:new Set()};
  adapter.index={list:()=>[{id:'a',title:'合成会话',updatedAt:42}]};adapter.conversations=new Map([['a',entry]]);
  adapter.snapshot=value=>value;
  adapter.watch=async()=>snapshot;
  adapter.unwatch=(id,owner)=>adapter.conversations.get(id)?.watchers.delete(owner);
  const feed=new ThreadListFeed(adapter,event=>{events.push(event);send?.(event,feed);});
  t.after(()=>feed.close());
  return {adapter,feed,snapshot,events,entry};
}

test('连续流每秒最多推送一次纯内容版本，持续输入不饿死且停止输入仍送最后一帧',async t=>{
  const {adapter,feed,snapshot,events}=streamingFixture(t);
  await feed.watch('phone');assert.equal(events.length,1);
  for(let index=1;index<=19;index++) {
    snapshot.messages[0].text='合成片段'+index;
    adapter.emit('conversation',structuredClone(snapshot));
    t.mock.timers.tick(100);
  }
  assert.equal(events.length,2);
  assert.equal(events[1].threads[0].contentRevision,conversationContentRevision({...snapshot,messages:[{...snapshot.messages[0],text:'合成片段10'}]}));
  t.mock.timers.tick(99);assert.equal(events.length,2);
  t.mock.timers.tick(1);assert.equal(events.length,3);
  assert.equal(events.at(-1).threads[0].contentRevision,conversationContentRevision(snapshot));
  t.mock.timers.tick(5000);assert.equal(events.length,3);assert.equal(feed.contentTimer,null);
});

test('完成、失败、待交互与未读状态立即带上最新内容版本，并清理原合并计时器',async t=>{
  const {adapter,feed,snapshot,events}=streamingFixture(t);
  await feed.watch('phone');
  snapshot.messages[0].text='待发送尾帧';adapter.emit('conversation',structuredClone(snapshot));
  assert.equal(events.length,1);
  snapshot.latestTurn.status='completed';snapshot.status='idle';snapshot.activeTurnId='';
  adapter.emit('conversation',structuredClone(snapshot));assert.equal(events.length,2);
  assert.equal(events.at(-1).threads[0].contentRevision,conversationContentRevision(snapshot));
  assert.equal(feed.contentTimer,null);t.mock.timers.tick(1000);assert.equal(events.length,2);
  snapshot.messages[0].text='失败尾帧';adapter.emit('conversation',structuredClone(snapshot));
  snapshot.latestTurn.status='failed';adapter.emit('conversation',structuredClone(snapshot));assert.equal(events.length,3);
  snapshot.approvals=[{id:'approval'}];adapter.emit('conversation',structuredClone(snapshot));assert.equal(events.length,4);
  snapshot.questionGroups=[{kind:'native',state:'pending'}];adapter.emit('conversation',structuredClone(snapshot));assert.equal(events.length,5);
  snapshot.messages[0].text='未读前尾帧';adapter.emit('conversation',structuredClone(snapshot));
  adapter.emit('readState',{threadId:'a',hasUnreadTurn:true});assert.equal(events.length,6);
  assert.equal(events.at(-1).threads[0].contentRevision,conversationContentRevision(snapshot));
  assert.equal(events.at(-1).threads[0].hasUnreadTurn,true);
  assert.equal(events.at(-1).threads[0].pendingQuestionCount,1);
});

test('运行时和实时时间不改变内容版本，列表不发送无变化事件',async t=>{
  const {adapter,feed,snapshot,events}=streamingFixture(t);
  await feed.watch('phone');const revision=events[0].threads[0].contentRevision;
  adapter.emit('conversation',{...snapshot,updatedAt:999,activity:'合成运行摘要',executionSettings:{model:'synthetic-model'}});
  t.mock.timers.tick(2000);assert.equal(events.length,1);
  adapter.emit('readState',{threadId:'a',hasUnreadTurn:true});assert.equal(events.length,2);
  assert.equal(events.at(-1).threads[0].contentRevision,revision);
});

test('已取得的实时快照不因临时 entry 释放而误用保存版本，未知历史才采用 saved',async t=>{
  const {adapter,feed,snapshot}=streamingFixture(t);
  adapter.conversations.clear();
  const row={id:'a',updatedAt:42,status:'active'};
  assert.equal(feed.contentSummary(row,snapshot).contentRevision,conversationContentRevision(snapshot));
  assert.equal(feed.contentSummary(row).contentRevision,undefined);
  assert.equal(feed.contentSummary({...row,status:'unknown'}).contentRevision,'saved:42');
});

test('关闭取消待发尾帧，重新订阅不会遗留计时器或发布旧内容',async t=>{
  const {adapter,feed,snapshot,events}=streamingFixture(t);
  await feed.watch('phone');
  snapshot.messages[0].text='关闭前尾帧';adapter.emit('conversation',structuredClone(snapshot));
  feed.unwatch('phone');assert.equal(feed.contentTimer,null);assert.equal(feed.pendingRows,null);
  t.mock.timers.tick(2000);assert.equal(events.length,1);
  await feed.watch('phone');t.mock.timers.tick(1000);
  assert.equal(events.at(-1).threads[0].contentRevision,conversationContentRevision(snapshot));
  snapshot.messages[0].text='最终关闭尾帧';adapter.emit('conversation',structuredClone(snapshot));
  const count=events.length;feed.close();t.mock.timers.tick(2000);assert.equal(events.length,count);
});

test('推送回调重入的新内容保留独立尾帧，不被上一帧清理覆盖',async t=>{
  let again;
  const {adapter,feed,snapshot,events}=streamingFixture(t,()=>{if(again){const emit=again;again=null;emit();}});
  await feed.watch('phone');
  snapshot.messages[0].text='第一段';adapter.emit('conversation',structuredClone(snapshot));
  again=()=>{snapshot.messages[0].text='重入尾帧';adapter.emit('conversation',structuredClone(snapshot));};
  t.mock.timers.tick(1000);assert.equal(events.length,2);
  assert.ok(feed.contentTimer);t.mock.timers.tick(1000);assert.equal(events.length,3);
  assert.equal(events.at(-1).threads[0].contentRevision,conversationContentRevision(snapshot));
});

test('实时探测失败时提供保存版本，重新进入首屏不会注册迟到订阅',async t=>{
  const {adapter,feed,events}=streamingFixture(t);
  adapter.conversations.clear();adapter.watch=async()=>{throw new Error('合成探测失败');};
  const initial=await feed.watch('phone');assert.equal(initial.threads[0].contentRevision,'saved:42');
  assert.equal(initial.threads[0].status,'unknown');
  feed.unwatch('phone');let finish;
  adapter.watch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=feed.watch('phone');feed.unwatch('phone');
  const reentered=feed.watch('new-phone');
  adapter.watch=async()=>({threadId:'a',title:'重入',approvals:[],questionGroups:[]});
  finish({threadId:'a',title:'迟到',approvals:[],questionGroups:[]});
  await Promise.all([pending,reentered]);
  assert.equal(events.at(-1).threads[0].title,'重入');assert.equal(feed.running,null);
});

test('订阅在首屏读取中被取消后，迟到快照不会重新建立列表订阅',async()=>{
  const adapter=new EventEmitter(),events=[];let resolve;
  adapter.index={list:()=>[{id:'a'}]};adapter.conversations=new Map();
  adapter.watch=()=>new Promise(done=>resolve=done);adapter.unwatch=()=>{};
  const feed=new ThreadListFeed(adapter,event=>events.push(event));
  const pending=feed.watch('phone');feed.unwatch('phone');
  resolve({approvals:[],questionGroups:[]});await pending;assert.equal(events.length,0);feed.close();
});
