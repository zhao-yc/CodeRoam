import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTick } from 'node:timers/promises';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { ThreadCacheFeed } from '../apps/bridge/thread-cache.mjs';
import { conversationProjection, conversationContentRevision } from '../apps/bridge/conversation-prefetch.mjs';
import { validConversationPreviewEvent } from '../packages/protocol/contracts.mjs';

/** 只使用独立合成问答；题组目标和保密答案不得落入展示缓存。 */
function snapshot() {
  return { threadId: 'synthetic-question-chat', title: '合成聊天', cwd: '', messages: [], turns: [],
    questionGroups: [{ id: 'native:synthetic-request-target', kind: 'native', turnId: 'synthetic-turn-target', state: 'pending',
      questions: [{ id: 'synthetic-question-target', title: '合成问题', header: '合成标题', options: [{ label: '选项甲', description: '合成说明', command: '不可缓存操作' }], isOther: true, isSecret: true, answer: '不可缓存答案' }], requestId: '不可缓存请求' }] };
}

test('问题投影只保留展示字段，重复投影稳定，问题变化进入版本而答案和权限不进入', () => {
  const source = snapshot(), projected = conversationProjection(source);
  assert.equal(projected.questionGroups, undefined);
  const group = projected.questionPreviews[0];
  assert.match(group.id, /^preview:[a-f0-9]{32}$/);
  assert.equal(group.questions[0].id, group.id + ':0');
  assert.equal(group.questions[0].title, '合成问题');
  assert.deepEqual(group.questions[0].options, [{ label: '选项甲', description: '合成说明' }]);
  assert.equal(group.questions[0].isSecret, true);
  for (const denied of ['synthetic-request-target', 'synthetic-turn-target', 'synthetic-question-target', '不可缓存']) assert.equal(JSON.stringify(projected).includes(denied), false);
  assert.deepEqual(conversationProjection(projected), projected);
  const revision = conversationContentRevision(source);
  source.questionGroups[0].questions[0].answer = '另一份不可缓存答案';
  source.questionGroups[0].requestId = '另一个不可缓存请求';
  assert.equal(conversationContentRevision(source), revision);
  source.questionGroups[0].questions[0].title += '变化';
  assert.notEqual(conversationContentRevision(source), revision);
  source.questionGroups[0].state = 'answered';
  assert.equal(conversationProjection(source).questionPreviews, undefined);
  assert.notEqual(conversationContentRevision(source), revision);
});

test('守护进程重启后可直接从SQLite返回问题展示，终态移除、旧格式及删除安全降级', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-question-cache-'));
  const file = path.join(directory, 'journal.sqlite'), first = new Journal(file);
  const source = snapshot(); let reads = 0, removed = false;
  const adapter = { conversations: new Map(), index: { visibleThreadIds: ids => new Set(removed ? [] : ids), historyCacheSource: () => 'unchanged', readHistory: () => { reads++; return source; } } };
  const makeFeed = journal => new ThreadCacheFeed({ adapter, db: journal.db, send: () => {}, blocked: () => removed });
  const oldFeed = makeFeed(first); oldFeed.save(source, 'unchanged'); oldFeed.close(); first.close();
  const journal = new Journal(file), feed = makeFeed(journal);
  t.after(() => { feed.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let preview = await feed.preview(source.threadId);
  assert.equal(reads, 0);
  assert.equal(preview.snapshot.questionPreviews[0].questions[0].title, '合成问题');
  assert.deepEqual(preview.snapshot.questionGroups, []);
  assert.deepEqual(preview.snapshot.approvals, []);
  assert.equal(preview.snapshot.readOnly, true);
  const revision = preview.contentRevision;
  source.questionGroups[0].state = 'expired'; feed.save(source, 'unchanged');
  preview = await feed.preview(source.threadId);
  assert.equal(preview.snapshot.questionPreviews, undefined);
  assert.notEqual(preview.contentRevision, revision);
  // 无问题字段的旧缓存仍可读取，不伪造可回答状态。
  assert.deepEqual(preview.snapshot.questionGroups, []);
  removed = true;
  assert.equal(await feed.preview(source.threadId), undefined);
});

test('问题首屏在桌面确认前返回且兼容现有中转校验，确认已失效时不恢复旧题组', async t => {
  const source = snapshot(), journal = new Journal(), adapter = new EventEmitter(), sent = [];
  adapter.close = () => {}; adapter.threadMentions = { available: async () => false, close() {} };
  adapter.conversations = new Map();
  adapter.index = { containsThread: () => true, historyCacheSource: () => 'unchanged', readHistory: () => assert.fail('缓存命中不能解析历史') };
  let finish;
  adapter.watch = () => new Promise(resolve => { finish = resolve; });
  const agent = new BridgeAgent({ config: {}, adapter, journal });
  t.after(() => agent.close());
  agent.send = message => { sent.push(message); return true; };
  agent.threadCache.save(source, 'unchanged');
  let confirmed = false;
  const pending = agent.handleRequest({ v: 1, type: 'request', transportId: 'synthetic-transport-01', requestId: 'synthetic-request-01', deviceId: 'phone', method: 'thread.watch', params: { threadId: source.threadId, previewId: 'synthetic-preview-01', activate: true } }).then(result => { confirmed = true; return result; });
  await nextTick();
  const preview = sent.find(message => message.type === 'thread.preview');
  assert.equal(validConversationPreviewEvent(preview), true);
  assert.equal(preview.snapshot.questionPreviews[0].questions[0].title, '合成问题');
  assert.deepEqual(preview.snapshot.questionGroups, []);
  assert.equal(confirmed, false);
  finish({ ...source, questionGroups: [], readOnly: false });
  const response = await pending;
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result.snapshot.questionGroups, []);
  assert.notEqual(response.result.contentRevision, preview.contentRevision);
});
