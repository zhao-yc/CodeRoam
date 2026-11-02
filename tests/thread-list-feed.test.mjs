import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ThreadListFeed} from '../apps/bridge/thread-list-feed.mjs';

/** 不经过手机详情订阅，列表本身持续跟随状态，正文变化不会重复推送。 */
test('列表独立订阅推送完成、未读和移除，多设备共享且最后离线释放',async()=>{
  const adapter=new EventEmitter(),events=[],removed=[];
  let rows=[{id:'a',title:'会话',updatedAt:1}];
  const snapshot={threadId:'a',title:'会话',status:'active',activeTurnId:'turn',approvals:[],questionGroups:[],hasUnreadTurn:false};
  adapter.index={list:()=>rows};adapter.conversations=new Map();adapter.snapshot=value=>value;
  adapter.watch=async(id,device)=>{adapter.conversations.set(id,{state:snapshot,watchers:new Set([device])});return snapshot;};
  adapter.unwatch=(id,device)=>{removed.push([id,device]);adapter.conversations.get(id)?.watchers.delete(device);};
  const feed=new ThreadListFeed(adapter,event=>events.push(event));
  const initial=await feed.watch('one');assert.equal(initial.threads[0].status,'active');
  await feed.watch('two');assert.equal(adapter.conversations.get('a').watchers.has('list-status'),true);
  adapter.emit('conversation',{...snapshot,status:'idle',activeTurnId:'',hasUnreadTurn:true});
  assert.equal(events.at(-1).threads[0].hasUnreadTurn,true);assert.equal(events.at(-1).threads[0].status,'idle');
  const count=events.length;adapter.emit('conversation',{...snapshot,status:'idle',activeTurnId:'',hasUnreadTurn:true,messages:[{text:'正文变化'}]});assert.equal(events.length,count);
  feed.unwatch('one');assert.equal(adapter.conversations.get('a').watchers.has('list-status'),true);
  rows=[];await feed.refresh();assert.deepEqual(events.at(-1).threads,[]);
  assert.ok(removed.some(([id])=>id==='a'));feed.unwatch('two');assert.equal(feed.closed,true);feed.close();
});

test('订阅在首屏读取中被取消后，迟到快照不会重新建立列表订阅',async()=>{
  const adapter=new EventEmitter(),events=[];let resolve;
  adapter.index={list:()=>[{id:'a'}]};adapter.conversations=new Map();
  adapter.watch=()=>new Promise(done=>resolve=done);adapter.unwatch=()=>{};
  const feed=new ThreadListFeed(adapter,event=>events.push(event));
  const pending=feed.watch('phone');feed.unwatch('phone');
  resolve({approvals:[],questionGroups:[]});await pending;assert.equal(events.length,0);feed.close();
});
