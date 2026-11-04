import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeConversation } from '../apps/bridge/conversation.mjs';
import { historicalSnapshot } from '../apps/bridge/history-reader.mjs';
import { StateReader } from '../apps/bridge/state-reader.mjs';

const text = '# 合成实施方案\n\n' + '完整方案正文。'.repeat(1800) + '\n方案结尾';

test('实时方案兼容 plan/text，长正文交给现有卡片且不虚构确认操作', () => {
  const snapshot = normalizeConversation({ id:'thread', turns:[{ turnId:'turn', status:'completed', items:[
    { id:'intro', type:'agentMessage', text:'下面整理实施计划。' },
    { id:'plan', type:'plan', text, isCompleted:false },
    { id:'final', type:'agentMessage', phase:'final_answer', text }
  ] }] });
  assert.deepEqual(snapshot.messages.map(message => message.kind), ['agentMessage','planImplementation','agentMessage']);
  assert.equal(snapshot.messages[1].id, 'plan');
  assert.equal(snapshot.messages[1].role, 'assistant');
  assert.equal(snapshot.messages[1].text, text);
  assert.equal(snapshot.messages[2].text, text, '重复最终回复保留原文以便展示层准确去重');
  assert.equal(snapshot.pendingPlan, null);
  const native = normalizeConversation({ id:'thread', turns:[{ turnId:'turn', status:'completed', items:[
    { id:'confirm', type:'planImplementation', planContent:text, isCompleted:false }
  ] }] });
  assert.equal(native.pendingPlan.id, 'confirm', '桌面明确等待确认的原有入口继续保留');
});

test('大量后续命令不应挤掉方案，空或非法方案不当作正文', () => {
  const snapshot = normalizeConversation({ id:'thread', turns:[{ turnId:'turn', items:[
    { id:'plan', type:'plan', text },
    ...Array.from({ length:100 }, (_,index) => ({ id:'command-'+index, type:'commandExecution', command:'示例命令' })),
    { id:'empty', type:'plan', text:' ' }, { id:'invalid', type:'plan', text:{ hidden:'内部数据' } }
  ] }] });
  assert.ok(snapshot.messages.some(message => message.id === 'plan'));
  assert.ok(snapshot.messages.every(message => !['empty','invalid'].includes(message.id)));
});

test('持久化 Plan 恢复全文和位置，不引入推理或历史操作入口', () => {
  const event = item => ({ type:'event_msg', payload:{ type:'item_completed', turn_id:'turn', item } });
  const result = historicalSnapshot({ id:'thread' }, [
    event({ id:'intro', type:'AgentMessage', text:'下面整理实施计划。' }),
    event({ id:'plan', type:'Plan', text:'未完成版本' }),
    event({ id:'plan', type:'Plan', text }),
    event({ id:'hidden', type:'Plan', text:'推理内容', channel:'analysis' }),
    event({ id:'unknown', type:'UnknownPlan', text:'未知内部数据' })
  ]);
  assert.deepEqual(result.messages.map(message => message.id), ['intro','plan']);
  assert.equal(result.messages[1].text, text);
  assert.equal(result.messages[1].kind, 'planImplementation');
  assert.equal(result.readOnly, true);
  assert.equal(result.pendingPlan, null);
});

test('实际历史读取与投影分页都保留方案，分叉边界排除后续方案', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-sync-'));
  const index = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  const projection = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  try {
    fs.mkdirSync(path.join(home, 'sessions'));
    index.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,archived INTEGER)');
    projection.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,item_json TEXT,item_type TEXT,updated_at_ordinal INTEGER);CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,error_json TEXT,duration_ms INTEGER,rollout_end_ordinal INTEGER)');
    // 索引、日志与投影均使用合成数据，独立验证两种持久化格式。
    for (const id of ['parent','child']) {
      const file = path.join(home, 'sessions', id+'.jsonl');
      const base = id === 'child' ? { history_base:{ thread_id:'parent', end_ordinal_exclusive:10 } } : {};
      fs.writeFileSync(file, JSON.stringify({ type:'session_meta', payload:{ id,...base } })+'\n'+JSON.stringify({ type:'event_msg', payload:{ type:'item_completed', turn_id:'turn', item:{ id:'plan', type:'Plan', text } } })+'\n');
      index.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(id, '合成聊天', '/example/project', file, 1, 0);
    }
    const insert = (id,ordinal,type,value) => projection.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run('parent','turn',id,ordinal,JSON.stringify({ id,type,...value }),type,ordinal);
    insert('intro', 1, 'agentMessage', { text:'方案说明' });
    insert('plan', 2, 'plan', { text });
    insert('native-plan', 3, 'planImplementation', { planContent:'桌面方案', isCompleted:false });
    insert('hidden', 4, 'plan', { text:'推理', phase:'analysis' });
    insert('future-plan', 12, 'plan', { text:'分叉以后的方案' });
    const reader = new StateReader(home);
    const snapshot = reader.readHistory('child');
    assert.equal(snapshot.messages.find(message => message.id === 'plan').text, text);
    assert.equal(snapshot.pendingPlan, null);
    const page = reader.readHistory('child', { page:true });
    assert.deepEqual(page.messages.map(message => message.id), ['native-plan']);
    const earlier = reader.readHistory('child', { page:true, beforeMessageId:'native-plan' });
    assert.deepEqual(earlier.messages.map(message => message.id), ['plan']);
    assert.equal(earlier.messages[0].text,text);assert.equal(earlier.messages[0].kind,'planImplementation');
    const oldest=reader.readHistory('child',{page:true,before:earlier.cursor});
    assert.deepEqual(oldest.messages.map(message=>message.id),['intro']);
  } finally {
    projection.close();index.close();fs.rmSync(home, { recursive:true });
  }
});
