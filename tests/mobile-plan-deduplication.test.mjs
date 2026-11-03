import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { normalizeConversation } from '../apps/bridge/conversation.mjs';

/** 运行实际 UTS 时间线，使用合成桌面记录验证双方案卡片问题。 */
function timeline(snapshot) {
  const context = vm.createContext({});
  const source = fs.readFileSync('apps/mobile/services/executions.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.render = reportTimeline;', context);
  return Array.from(context.render(snapshot, []));
}

const text = '# 合成方案\n\n保留完整正文，等待用户确认。';
const plan = (id, turnId = 'turn', body = text) => ({ id, role: 'assistant', kind: 'planImplementation', text: body, turnId, status: 'completed' });
const snapshot = messages => ({ messages, turns: [], activeTurnId: '', approvals: [], questionGroups: [] });

test('桌面 plan 与确认项正文相同只展示一张，始终保留可确认编号且不触发兜底', () => {
  for (const reverse of [false, true]) {
    const items = [
      { id: 'body', type: 'plan', text: text + '\n' },
      { id: 'confirm', type: 'planImplementation', planContent: text, isCompleted: false },
    ];
    if (reverse) items.reverse();
    items.push({ id: 'final', type: 'agentMessage', phase: 'final_answer', text });
    const conversation = normalizeConversation({ id: 'thread', turns: [{ turnId: 'turn', status: 'completed', items }] });
    assert.equal(conversation.messages.length, 3, '传输快照仍保留原始记录');
    const entries = timeline(conversation);
    assert.deepEqual(entries.map(entry => entry.id), ['confirm']);
    assert.equal(entries[0].text, text);
    assert.ok(entries.some(entry => entry.id === conversation.pendingPlan.id), '页面按待确认编号检查时无须补一张兜底卡片');
    assert.equal(conversation.pendingPlan.id, 'confirm', '去重不改变确认操作目标');
  }
});

test('历史与缓存没有待确认状态时保留最后一张原文，不改写原数组', () => {
  const messages = [plan('body', 'turn', text + '\n'), plan('confirm')];
  messages.forEach(Object.freeze);
  Object.freeze(messages);
  const conversation = Object.freeze(snapshot(messages));
  assert.deepEqual(timeline(conversation).map(entry => entry.id), ['confirm']);
  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.messages[0].text, text + '\n');
});

test('不同轮次、未知轮次、修订正文和携带图片的记录不能误合并', () => {
  const suffix = '\n' + '相同长尾正文'.repeat(2000);
  const messages = [plan('first'), plan('other-turn', 'other'), plan('unknown-a', ''), plan('unknown-b', ''), plan('revision-a', 'turn', '修订甲' + suffix), plan('revision-b', 'turn', '修订乙' + suffix), { ...plan('image'), imageCount: 1 }];
  assert.deepEqual(timeline(snapshot(messages)).map(entry => entry.id), messages.map(message => message.id));
});

test('方案正文有更新时同时保留两个版本，待确认编号不会隐藏不同内容', () => {
  const conversation = { ...snapshot([plan('old'), plan('confirm', 'turn', text + '\n新增步骤')]), pendingPlan: { id: 'confirm', turnId: 'turn', text: text + '\n新增步骤' } };
  assert.deepEqual(timeline(conversation).map(entry => entry.id), ['old', 'confirm']);
});
