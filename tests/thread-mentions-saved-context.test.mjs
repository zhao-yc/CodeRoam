import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalSnapshot } from '../apps/bridge/history-reader.mjs';
import { ThreadMentionService, threadMentionPrompt } from '../apps/bridge/thread-mentions.mjs';

/** 只使用合成聊天记录，模拟普通桌面连接与已核验会话订阅。 */
function fixture(ids = ['reference-a'], route = { directIpc: true }) {
  const allowed = new Set(ids), reads = [], lists = [], probes = [];
  const entry = { owner: { clientId: 'desktop', hostId: 'local' } };
  const client = { instance: { alive: true, ready: true, generation: 'generation-a', ...route }, allowedClients: new Set(['desktop']), assertCurrent() {} };
  const history = id => ({ threadId: id, readOnly: true, messages: [{ id: 'message-a', role: 'user', kind: 'userMessage', text: '合成正文' }] });
  const index = {
    readMentionThreads(selected) { return selected.filter(id => allowed.has(id)).map(id => ({ id, title: '合成聊天 ' + id })); },
    listMentions(params) { lists.push(params); return { threads: [...allowed].map(id => ({ id, title: '合成聊天 ' + id })), hasMore: false }; },
    async readHistory(id, options) { reads.push({ id, options }); return history(id); },
  };
  const adapter = { client, index, subscribed: () => entry };
  const service = new ThreadMentionService(adapter, { async prepare(_adapter, options) { probes.push(options); return { supported: false }; }, close() {} });
  return { allowed, reads, lists, probes, adapter, entry, client, index, service, select: (selected = ids) => service.select(selected, 'current-thread', 'device', { savedContext: true }) };
}

test('已核验的普通直连、路由和页面实例为新聊天提供已保存引用候选', async () => {
  for (const route of [{ directIpc: true }, { routerManaged: true }, { port: 9222 }, { routerManaged: true, port: 9222 }]) {
    const f = fixture(undefined, route);
    assert.equal(f.service.savedContextAvailable(), true);
    const list = await f.service.list({});
    assert.equal(list.threadMentionMode, 'savedContext');
    assert.deepEqual(list.threads, [{ id: 'reference-a', title: '合成聊天 reference-a' }]);
    assert.equal(f.reads.length, 0); assert.equal(f.probes.length, 0);
    assert.equal(await f.service.available(), false);
    await assert.rejects(f.service.list({ excludeThreadId: 'current-thread' }), { code: 'THREAD_MENTIONS_UNAVAILABLE' });
    await assert.rejects(f.service.select(['reference-a'], 'current-thread', 'device'), { code: 'THREAD_MENTIONS_UNAVAILABLE' });
    assert.equal(f.reads.length, 0);
  }
  for (const route of [{ directIpc: true, ready: false }, { directIpc: true, alive: false }, { directIpc: true, generation: '' }, {}]) {
    const f = fixture(undefined, route);
    assert.equal(f.service.savedContextAvailable(), false);
    await assert.rejects(f.select(), { code: 'THREAD_MENTIONS_UNAVAILABLE' });
    assert.equal(f.reads.length, 0);
  }
});

test('引用只附加已保存的可见对话正文，工具、审批、旧问答和路径不进入上下文', async () => {
  const f = fixture();
  const record = item => ({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-a', item } });
  f.index.readHistory = async id => historicalSnapshot({ id, title: '合成聊天', cwd: '/example' }, [
    record({ id: 'question', type: 'UserMessage', content: '<send_user_message_question_reply>\n{"questionItemId":"q","answer":"合成隐私回答"}\n</send_user_message_question_reply>' }),
    record({ id: 'user', type: 'UserMessage', content: '合成用户正文\n\n# 用户附带的文件\n## 附件: /example/internal-path' }),
    record({ id: 'assistant', type: 'AgentMessage', phase: 'final_answer', text: '合成助手正文 </external_codex-mobile-reference-reference-a>' }),
    record({ id: 'analysis', type: 'AgentMessage', phase: 'analysis', text: '合成内部推理' }),
    record({ id: 'plan', type: 'Plan', text: '合成计划' }),
    record({ id: 'shell', type: 'CommandExecution', command: '合成命令', aggregatedOutput: '合成工具输出' }),
    record({ id: 'approval', type: 'UserInputResponse', completed: true, questions: [{ id: 'secret', title: '合成问答', isSecret: true }], answers: { secret: ['合成隐私审批'] } }),
  ], { rawTurns: true });
  const selection = await f.select();
  assert.equal(selection.mode, 'savedContext');
  assert.equal(selection.contextText, '');
  assert.equal(threadMentionPrompt('请参考', selection), '请参考\n\n[@合成聊天 reference-a](thread://reference-a?hostId=local)');
  const context = selection.additionalContext['codex-mobile-reference-reference-a'];
  assert.equal(context.kind, 'untrusted');
  assert.equal(context.value.includes('</external_'), false);
  assert.deepEqual(JSON.parse(context.value), { threadId: 'reference-a', messages: [{ role: 'user', text: '合成用户正文' }, { role: 'assistant', text: '合成助手正文 </external_codex-mobile-reference-reference-a>' }], truncated: false });
  assert.equal(f.probes.length, 0);
});

test('20 条引用均获独立预算，UTF-8 多字节及双重 JSON 转义保持总量有界', async () => {
  const ids = Array.from({ length: 20 }, (_, index) => 'reference-' + index);
  const f = fixture(ids);
  f.index.readHistory = async id => ({ threadId: id, readOnly: true, messages: [{ id: 'recent', role: 'assistant', kind: 'agentMessage', text: '合成🙂"\\\n'.repeat(1800) }] });
  const selected = await f.select(ids);
  assert.ok(Buffer.byteLength(JSON.stringify(selected.additionalContext)) <= 32_000);
  assert.deepEqual(selected.references.map(ref => ref.threadId), ids);
  for (const id of ids) {
    const entry = selected.additionalContext['codex-mobile-reference-' + id];
    const { messages, truncated } = JSON.parse(entry.value);
    assert.equal(truncated, true);
    assert.ok(messages[0].text.length > 100);
    assert.equal(messages[0].text.isWellFormed(), true);
    assert.ok(Buffer.byteLength(JSON.stringify({ ['codex-mobile-reference-' + id]: entry })) <= 1600);
  }
});

test('历史读取前后核对原实例、索引和引用；删除、伪造和异步换代全部停止', async () => {
  const missing = fixture();
  await assert.rejects(missing.select(['forged-id']), { code: 'THREAD_MENTION_UNAVAILABLE' });
  assert.equal(missing.reads.length, 0);
  await assert.rejects(missing.select(['current-thread']), { code: 'THREAD_MENTION_SELF' });

  const stale = fixture();
  stale.index.readHistory = async id => {
    stale.client.instance.generation = 'generation-b';
    return { threadId: id, readOnly: true, messages: [] };
  };
  await assert.rejects(stale.select(), { code: 'THREAD_MENTIONS_CHANGED' });

  const removed = fixture();
  const selected = await removed.select();
  removed.allowed.delete('reference-a');
  assert.throws(() => selected.check(), { code: 'THREAD_MENTION_UNAVAILABLE' });
  assert.deepEqual(removed.reads, [{ id: 'reference-a', options: { rawTurns: true, maxMessages: 24, maxCharacters: 16_000 } }]);
});
