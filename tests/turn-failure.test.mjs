import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {normalizeConversation, applyPatches} from '../apps/bridge/conversation.mjs';
import {TURN_FAILURE_FALLBACK, MAX_TURN_ERROR_CHARACTERS, TURN_METADATA_BUDGET_BYTES, TURN_ERROR_TRUNCATED, turnMetadata} from '../apps/bridge/turn-failure.mjs';
import {historicalSnapshot} from '../apps/bridge/history-reader.mjs';
import {readHistoricalPage} from '../apps/bridge/history-pager.mjs';
import {readProjectedHistory} from '../apps/bridge/projected-history.mjs';
import {conversationUpdate, applyConversationUpdate} from '../apps/bridge/updates.mjs';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {InstanceRuntime} from '../apps/bridge/instance-runtime.mjs';

const capacity = 'Selected model is at capacity. Please try a different model.';
const event = payload => ({type:'event_msg', payload});

test('普通启动和多实例装配均保留审查终止，另一实例同号聊天独立', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-status-'));
  const normal=new DesktopAdapter();
  const runtimes=['one','two'].map(id=>{
    const dataPath=path.join(root,id);fs.mkdirSync(dataPath);
    return new InstanceRuntime({instance:{id,platform:'win32',pid:42,codexHome:root,alive:true,ready:true,verify:async()=>{}},config:{},dataPath,send:()=>{}});
  });
  t.after(async()=>{normal.close();for(const runtime of runtimes)await runtime.close();fs.rmSync(root,{recursive:true,force:true});});
  const state={id:'thread',turns:[{turnId:'turn',status:'interrupted',items:[{id:'warning',type:'autoReviewInterruptionWarning'}]}]};
  for(const adapter of [normal,runtimes[0].adapter]) {
    const snapshot=adapter.snapshot(state);
    assert.equal(snapshot.latestTurn.status,'reviewStopped');
    assert.equal(snapshot.notificationState.latestTurnStatus,'reviewStopped');
    assert.equal(snapshot.turns[0].errorMessage,'本轮操作已被自动审查终止');
  }
  assert.equal(runtimes[1].adapter.snapshot({id:'thread',turns:[{turnId:'turn',status:'completed',items:[]}]}).latestTurn.status,'completed');
});

test('自动审查终止只认专用标记，拒绝记录和工具正文不能冒充终止', () => {
  const review = {id:'review',type:'automaticApprovalReview',status:'denied',rationale:'合成审查原因'};
  const warning = {id:'warning',type:'autoReviewInterruptionWarning'};
  const snapshot = normalizeConversation({id:'thread',turns:[{turnId:'turn',status:'interrupted',items:[review,warning]}]});
  assert.equal(snapshot.latestTurn.status,'reviewStopped');
  assert.equal(snapshot.notificationState.latestTurnStatus,'reviewStopped');
  assert.equal(snapshot.turns[0].errorMessage,'本轮操作已被自动审查终止\n\n合成审查原因');
  assert.equal(snapshot.messages.length,0);
  for (const [status,items,expected] of [['interrupted',[review],'interrupted'],['inProgress',[review],'inProgress'],['completed',[warning],'completed']]) {
    assert.equal(normalizeConversation({id:'thread',turns:[{turnId:'turn',status,items}]}).latestTurn.status,expected);
  }
  const history=historicalSnapshot({id:'thread'},[event({type:'task_started',turn_id:'turn'}),event({type:'item_completed',turn_id:'turn',item:{id:'warning',type:'AutoReviewInterruptionWarning'}}),event({type:'turn_aborted',turn_id:'turn'})]);
  assert.equal(history.turns[0].status,'interrupted');
  assert.equal(history.readOnly,true);
});

test('仅结构化轮次错误或失败状态提供错误原文，其余正文和工具失败不会误报', () => {
  for (const [error, expected] of [[capacity, capacity], [{message:'Rate limit exceeded.'}, 'Rate limit exceeded.'], [{message:'Internal server error.\nTry again.'}, 'Internal server error.\nTry again.'], [{stack:'内部堆栈'}, TURN_FAILURE_FALLBACK], [{message:'  '}, TURN_FAILURE_FALLBACK], [undefined, TURN_FAILURE_FALLBACK]]) {
    const snapshot = normalizeConversation({id:'thread', turns:[{turnId:'failed', status:'failed', error, items:[]}]});
    assert.deepEqual(snapshot.turns, [{turnId:'failed', status:'failed', errorMessage:expected}]);
    assert.deepEqual(snapshot.latestTurn, {turnId:'failed', status:'failed'});
    assert.equal(snapshot.supportsTurnRetry, true);
    assert.equal(snapshot.messages.length, 0, '失败不能制造空用户消息');
  }
  const structured = normalizeConversation({id:'thread', turns:[{turnId:'failed', status:'completed', error:{message:capacity}, items:[]}]});
  assert.equal(structured.turns[0].status, 'failed');
  for (const status of ['completed', 'interrupted', 'inProgress']) {
    const snapshot = normalizeConversation({id:'thread', turns:[{turnId:'normal', status, items:[{id:'tool', type:'commandExecution', status:'failed', command:'合成命令', output:capacity}]}]});
    assert.equal(snapshot.turns[0].status, status);
    assert.equal(Object.hasOwn(snapshot.turns[0], 'errorMessage'), false);
  }
});

test('消息截断后保留无消息失败与最新轮次，未加载到末端的历史岛不声明最新', () => {
  const turns = [{turnId:'old-failure', status:'failed', items:[]}, {turnId:'latest', status:'completed', items:[]}];
  const snapshot = normalizeConversation({id:'thread', turns}, {maxMessages:0});
  assert.deepEqual(snapshot.turns, [{turnId:'latest',status:'completed'}]);
  assert.deepEqual(snapshot.latestTurn, {turnId:'latest', status:'completed'});
  for (const status of ['available', 'loading', 'exhausted']) {
    const state = {id:'thread', turnHistory:{history:{entitiesByKey:{failure:turns[0]}, islands:[{entries:[{value:'failure'}], newerBoundary:{status}}]}}};
    const partial = normalizeConversation(state);
    assert.equal(partial.latestTurn?.turnId, status === 'exhausted' ? 'old-failure' : undefined);
    assert.equal(partial.notificationState.latestTurnId, status === 'exhausted' ? 'old-failure' : '');
    assert.equal(partial.turns[0]?.errorMessage, status === 'exhausted' ? TURN_FAILURE_FALLBACK : undefined);
  }
  const missingTail = normalizeConversation({id:'thread',turnHistory:{history:{entitiesByKey:{failure:turns[0]},islands:[{entries:[{value:'failure'},{value:'not-loaded'}],newerBoundary:{status:'exhausted'}}]}}});
  assert.equal(missingTail.latestTurn,undefined);
  assert.equal(missingTail.notificationState.latestTurnId,'');
});

test('失败状态补丁和无正文增量完整传递元数据，新轮次开始后保留历史错误', () => {
  const state = {id:'thread', turns:[{turnId:'turn', status:'inProgress', items:[{id:'message', type:'agentMessage', text:'合成正文'.repeat(1000)}]}]};
  const initial = normalizeConversation(state);
  applyPatches(state, [{op:'replace', path:['turns',0,'status'], value:'failed'}, {op:'add', path:['turns',0,'error'], value:{message:capacity}}]);
  const failed = normalizeConversation(state);
  const delta = conversationUpdate({snapshot:initial, seq:1}, failed);
  assert.equal(delta.kind, 'delta');
  const restored = applyConversationUpdate({snapshot:initial, epoch:'test', seq:1}, {...delta, epoch:'test', seq:2});
  assert.deepEqual(restored.snapshot.turns, failed.turns);
  assert.deepEqual(restored.snapshot.latestTurn, failed.latestTurn);
  applyPatches(state, [{op:'add', path:['turns',1], value:{turnId:'retry', status:'inProgress', items:[]}}]);
  const retry = normalizeConversation(state);
  assert.deepEqual(retry.latestTurn, {turnId:'retry', status:'inProgress'});
  assert.equal(retry.activeTurnId, 'retry');
  assert.equal(retry.turns[0].errorMessage, capacity);
});

test('旧日志 task_failed 原文连通，没有消息的后续轮次仍为最新且历史保持只读', () => {
  const snapshot = historicalSnapshot({id:'thread'}, [
    event({type:'task_started', turn_id:'failed'}), event({type:'agent_message',message:'合成失败前回复'}), event({type:'task_failed', turn_id:'failed', error:{message:capacity}, duration_ms:120}),
    event({type:'task_started', turn_id:'latest'}), event({type:'task_complete', turn_id:'latest'})
  ], {rawTurns:true});
  assert.deepEqual(snapshot.turns, [{turnId:'failed', status:'failed', durationMs:120, errorMessage:capacity}, {turnId:'latest', status:'completed'}]);
  assert.deepEqual(snapshot.latestTurn, {turnId:'latest', status:'completed'});
  assert.equal(snapshot.sourceTurns.length, 2);
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.activeTurnId, '');
  for (const payload of [{error:capacity}, {message:capacity}, {}]) {
    const result = historicalSnapshot({id:'thread'}, [event({type:'task_failed', turn_id:'failed', ...payload})]);
    assert.equal(result.turns[0].errorMessage, payload.error ?? payload.message ?? TURN_FAILURE_FALLBACK);
  }
});

test('截断块的匿名旧消息保持首次顺序，最新空失败不会被匿名旧组遮住', () => {
  for (const item of [event({type:'agent_message',message:'匿名旧消息'}), event({type:'item_completed',item:{id:'old',type:'AgentMessage',text:'匿名旧消息'}})]) {
    const snapshot=historicalSnapshot({id:'thread'}, [item,event({type:'task_failed',turn_id:'latest',error:capacity})], {rawTurns:true,historyTruncated:true});
    assert.deepEqual(snapshot.sourceTurns.map(turn=>turn.turnId),['','latest']);
    assert.deepEqual(snapshot.messages.map(message=>message.text),['匿名旧消息']);
    assert.deepEqual(snapshot.latestTurn,{turnId:'latest',status:'failed'});
    assert.equal(snapshot.notificationState.latestTurnId,'latest');
  }
});

test('快照只保留窗口跨度内空失败和最新轮次，窗口外旧失败不挤占元数据', () => {
  const turns=[
    {turnId:'outside',status:'failed',error:'旧错误'.repeat(10000),items:[]},
    {turnId:'head',status:'completed',items:[{id:'head',type:'agentMessage',text:'窗口起点'}]},
    {turnId:'inside',status:'failed',error:'跨度内错误',items:[]},
    {turnId:'tail',status:'completed',items:[{id:'tail',type:'agentMessage',text:'窗口终点'}]},
    {turnId:'latest',status:'failed',error:capacity,items:[]}
  ];
  const snapshot=normalizeConversation({id:'thread',turns},{maxMessages:2});
  assert.deepEqual(snapshot.turns.map(turn=>turn.turnId),['head','inside','tail','latest']);
  assert.equal(snapshot.messages.length,2);
  assert.equal(snapshot.turns.find(turn=>turn.turnId==='inside').errorMessage,'跨度内错误');
});

test('240 个超长旧失败只保留最新，单个巨大错误保留前缀并明确截断', () => {
  const turns=Array.from({length:240},(_,index)=>({turnId:'failed-'+index,status:'failed',error:{message:'x'.repeat(10000)},items:[]}));
  const snapshot=normalizeConversation({id:'thread',turns},{maxMessages:0});
  assert.deepEqual(snapshot.turns.map(turn=>turn.turnId),['failed-239']);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<100*1024);
  const original='错误原文：'+('😃内部原因\n'.repeat(100000));
  const message=turnMetadata({turnId:'huge',status:'failed',error:original}).errorMessage;
  assert.ok(message.length<=MAX_TURN_ERROR_CHARACTERS);
  assert.ok(message.endsWith(TURN_ERROR_TRUNCATED));
  assert.ok(original.startsWith(message.slice(0,-TURN_ERROR_TRUNCATED.length)));
  assert.equal(message.isWellFormed(),true);
});

test('大量窗口内空失败受实际 JSON 字节预算约束，最新原因与窗口轮次优先保留', () => {
  const message=(id)=>({turnId:id,status:'completed',items:[{id,type:'agentMessage',text:'合成窗口消息'}]});
  const failures=Array.from({length:1000},(_,index)=>({turnId:'failed-'+index,status:'failed',error:{message:'\u0000中文错误'.repeat(2000)},items:[]}));
  const snapshot=normalizeConversation({id:'thread',turns:[message('head'),...failures,message('tail'),{turnId:'latest',status:'failed',error:'最新原因'.repeat(3000),items:[]}]},{maxMessages:2});
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.turns))<=TURN_METADATA_BUDGET_BYTES);
  assert.ok(snapshot.turns.some(turn=>turn.turnId==='head'));
  assert.ok(snapshot.turns.some(turn=>turn.turnId==='tail'));
  assert.ok(snapshot.turns.some(turn=>turn.status==='failed'&&turn.errorMessage.includes('同步大小限制')));
  const latest=snapshot.turns.at(-1);
  assert.equal(latest.turnId,'latest');
  assert.ok(latest.errorMessage.startsWith('最新原因'));
  assert.ok(latest.errorMessage.endsWith(TURN_ERROR_TRUNCATED));
  assert.equal(snapshot.latestTurn.turnId,'latest');
});

test('旧日志分页携带范围内的无消息失败，早期页不会带入后续失败或最新标记', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-failure-log-'));
  try {
    const file = path.join(root, 'thread.jsonl'), records = [{type:'session_meta', payload:{id:'thread'}}];
    for (let i=0; i<100; i++) {
      records.push(event({type:'item_completed', turn_id:'turn-'+i, item:{id:'message-'+i, type:'AgentMessage', text:'合成消息'+i}}));
      if (i===49) records.push(event({type:'task_failed', turn_id:'empty-failure', error:capacity}));
      if (i===50) records.push(event({type:'task_failed', turn_id:'huge-failure', error:'分页错误'.repeat(10000)}));
    }
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n')+'\n');
    const row = {id:'thread', rollout_path:file};
    const page = readHistoricalPage(row, root, {beforeMessageId:'message-60'});
    assert.equal(page.turns.find(turn => turn.turnId==='empty-failure')?.errorMessage, capacity);
    const huge=page.turns.find(turn=>turn.turnId==='huge-failure').errorMessage;
    assert.ok(huge.length<=MAX_TURN_ERROR_CHARACTERS);assert.ok(huge.startsWith('分页错误'));assert.ok(huge.endsWith(TURN_ERROR_TRUNCATED));
    assert.equal(Object.hasOwn(page, 'latestTurn'), false);
    const earlier = readHistoricalPage(row, root, {beforeMessageId:'message-20'});
    assert.equal(earlier.turns.some(turn => turn.turnId==='empty-failure'), false);
  } finally {fs.rmSync(root, {recursive:true, force:true});}
});

/** 独立投影库只放合成记录，验证错误 JSON、空轮次和分叉边界，不读取桌面会话。 */
function projectionFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-failure-projection-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  const index = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  index.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)');
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,item_json TEXT,item_type TEXT,updated_at_ordinal INTEGER); CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,error_json TEXT,duration_ms INTEGER,rollout_end_ordinal INTEGER,rollout_ordinal INTEGER)');
  function session(id, metadata={}) {
    const file=path.join(home, 'sessions', id+'.jsonl');
    fs.writeFileSync(file, JSON.stringify({type:'session_meta',payload:{id,...metadata}})+'\n');
    index.prepare('INSERT INTO threads VALUES(?,?)').run(id,file);
    return {id,rollout_path:file};
  }
  function turn(threadId,id,status,error,ordinal,start=ordinal-1) {db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?)').run(threadId,id,status,error,10,ordinal,start);}
  function item(threadId,turnId,id,ordinal) {db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(threadId,turnId,id,ordinal,JSON.stringify({id,type:'agentMessage',text:'合成消息'}),'agentMessage',ordinal);}
  return {home,session,turn,item,close(){db.close();index.close();fs.rmSync(home,{recursive:true,force:true});}};
}

test('投影 error_json 提取原文与空值兼容，保留无消息失败及最新轮次', () => {
  const f = projectionFixture();
  try {
    const row=f.session('thread');
    f.turn('thread','object-error','completed',JSON.stringify({message:capacity}),2);f.item('thread','object-error','message',1);
    f.turn('thread','string-error','failed',JSON.stringify('Rate limit exceeded.'),3);
    f.turn('thread','no-reason','failed',null,4);
    f.turn('thread','null-error','completed','null',5);f.item('thread','null-error','last-message',5);
    f.turn('thread','huge-error','failed',JSON.stringify({message:'投影错误'.repeat(10000)}),6);
    f.turn('thread','latest','completed',null,7);
    const page=readProjectedHistory(row,f.home);
    assert.equal(page.turns.find(turn=>turn.turnId==='object-error')?.errorMessage,capacity);
    assert.equal(page.turns.find(turn=>turn.turnId==='string-error')?.errorMessage,'Rate limit exceeded.');
    assert.equal(page.turns.find(turn=>turn.turnId==='no-reason')?.errorMessage,TURN_FAILURE_FALLBACK);
    assert.equal(page.turns.find(turn=>turn.turnId==='null-error')?.status,'completed');
    assert.equal(page.turns.find(turn=>turn.turnId==='latest')?.status,'completed');
    assert.deepEqual(page.turns.map(turn=>turn.turnId),['object-error','string-error','no-reason','null-error','huge-error','latest']);
    const huge=page.turns.find(turn=>turn.turnId==='huge-error').errorMessage;
    assert.ok(huge.length<=MAX_TURN_ERROR_CHARACTERS);assert.ok(huge.startsWith('投影错误'));assert.ok(huge.endsWith(TURN_ERROR_TRUNCATED));
    assert.equal(page.messages.length,2);
    const earlier=readProjectedHistory(row,f.home,{beforeMessageId:'message'});
    assert.equal(earlier.turns.some(turn=>turn.turnId==='string-error'||turn.turnId==='latest'),false);
    assert.equal(Object.hasOwn(earlier,'latestTurn'),false);
  } finally {f.close();}
});

test('投影只有无消息失败也可读，分叉后的错误不能污染继承轮次', () => {
  const f=projectionFixture();
  try {
    const row=f.session('empty');f.turn('empty','failed','failed',JSON.stringify(capacity),10);
    assert.equal(readProjectedHistory(row,f.home).turns[0].errorMessage,capacity);
    f.turn('empty','running','inProgress',null,null,11);
    assert.equal(readProjectedHistory(row,f.home).turns.at(-1).turnId,'running');
    const running=f.session('running-only');f.turn('running-only','only','inProgress',null,null,1);
    assert.equal(readProjectedHistory(running,f.home).turns[0].turnId,'only');
    f.session('parent');const child=f.session('child',{history_base:{thread_id:'parent',end_ordinal_exclusive:20}});
    f.item('parent','fork-turn','inherited',10);f.turn('parent','fork-turn','failed',JSON.stringify(capacity),30);
    const inherited=readProjectedHistory(child,f.home);
    assert.equal(inherited.turns[0].status,'');
    assert.equal(inherited.turns[0].errorMessage,undefined);
  } finally {f.close();}
});
