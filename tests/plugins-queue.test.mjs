import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageQueue } from '../apps/bridge/message-queue.mjs';
import { fixture, plugin, directory } from './plugins-fixture.mjs';

test('入队保存编号和已核对名称，decorate 仅展示约定插件字段且保留原始正文', async t => {
  const f = fixture(t, { active: true });
  const response = await f.enqueue({ text: '合成消息', pluginIds: ['search@example','search@example'] });
  assert.equal(response.error, undefined); assert.equal(f.reads.length, 1); assert.equal(f.client.calls.length, 0);
  const payload = JSON.parse(f.queue.rows('thread')[0].payload);
  assert.deepEqual(payload.pluginIds, ['search@example']); assert.deepEqual(payload.plugins, [{ id: 'search@example', displayName: '资料检索' }]); assert.equal(payload.text, '合成消息');
  const display = f.queue.decorate({ threadId: 'thread' }).queuedMessages[0];
  assert.deepEqual(display.plugins, payload.plugins); assert.equal(display.text, '合成消息'); assert.equal(JSON.stringify(display).includes('private'), false); assert.equal(JSON.stringify(display).includes('plugin://'), false);
});

test('插件不可用或只有插件不能入队，拒绝前不产生可投递记录', async t => {
  const f = fixture(t, { active: true });
  assert.equal((await f.enqueue({ pluginIds: ['search@example'] })).error.code, 'BAD_PARAMS');
  // 已接纳但业务校验失败会暂停实例，人工处理后才允许继续测试下一次提交。
  const blocker = f.agent.taskQueue.list('phone').blockerId;
  if (blocker) await f.agent.taskQueue.control('phone', { taskId: blocker, action: 'resume' });
  assert.equal(f.reads.length, 0);
  f.data = directory();
  assert.equal((await f.enqueue({ text: '合成消息', pluginIds: ['search@example'] })).error.code, 'PLUGIN_UNAVAILABLE');
  assert.equal(f.queue.rows('thread').length, 0); assert.equal(f.client.calls.length, 0); assert.equal(f.adapter.conversations.has('thread'), false);
});

test('手机退出后队列仍重读最新目录，投递使用重新核对的名称和原生 mention', async t => {
  const f = fixture(t, { active: true }); await f.enqueue({ text: '合成消息', pluginIds: ['search@example'] });
  f.adapter.unwatch('thread','phone');
  f.data = directory(plugin('search@example', { name: 'latest-search', interface: { displayName: '最新名称', shortDescription: '简介' } }));
  f.client.idle(); await f.queue.pump(); await f.queue.pump();
  assert.equal(f.reads.length, 2); assert.equal(f.client.calls.length, 1);
  const { input } = f.client.calls[0].params.turnStart.request;
  assert.deepEqual(input.at(-1), { type: 'mention', name: 'latest-search', path: 'plugin://search@example' }); assert.equal(input[0].text, '合成消息\n\n[@最新名称](plugin://search@example)');
  assert.equal(f.queue.rows('thread')[0].state, 'dispatched');
});

test('自动投递前插件失效或查询失败则暂停整条队列，错误明确且不会自动重发', async t => {
  for (const queryFails of [false,true]) {
    const f = fixture(t, { active: true }); await f.enqueue({ text: '第一条', pluginIds: ['search@example'] }); await f.enqueue({ text: '第二条' });
    if (queryFails) f.onCatalog = () => { throw new Error('/private/example/secret 原始诊断'); };
    else f.data = directory(plugin('search@example', { installed: false }));
    f.client.idle(); await f.queue.pump(); await f.queue.pump();
    const rows = f.queue.rows('thread'); assert.equal(rows[0].state, 'failed'); assert.equal(rows[1].state, 'queued'); assert.equal(f.client.calls.length, 0);
    assert.match(rows[0].error, /插件.*队列已暂停/); assert.equal(rows[0].error.includes('secret'), false);
    assert.equal(f.reads.length, 2);
  }
});

test('手动追加队列也重新验证插件，成功只发送一次，失效保留失败项', async t => {
  for (const available of [true,false]) {
    const f = fixture(t, { active: true }), response = await f.enqueue({ text: '追加合成要求', pluginIds: ['search@example'] });
    if (!available) f.data = directory();
    const result = await f.send({ queueAction: 'steer', queueId: response.result.queueId, expectedTurnId: 'original' });
    assert.equal(f.reads.length, 2);
    if (available) {
      assert.equal(result.error, undefined); assert.equal(f.queue.rows('thread').length, 0); assert.equal(f.client.calls[0].method, 'thread-follower-steer-turn');
      assert.deepEqual(f.client.calls[0].params.input.at(-1), { type: 'mention', name: 'search', path: 'plugin://search@example' });
    } else { assert.equal(result.error.code, 'PLUGIN_UNAVAILABLE'); assert.equal(f.queue.rows('thread')[0].state, 'failed'); }
    f.client.idle(); await f.queue.pump(); assert.equal(f.client.calls.length, available ? 1 : 0);
  }
});

test('原生发送结果未知时保留插件展示并暂停，不重复查目录或重发消息', async t => {
  const f = fixture(t, { active: true }); await f.enqueue({ text: '合成消息', pluginIds: ['search@example'] });
  f.client.error = Object.assign(new Error('合成结果未知'), { outcomeUnknown: true }); f.client.idle();
  await f.queue.pump(); await f.queue.pump();
  assert.equal(f.queue.rows('thread')[0].state, 'unknown'); assert.equal(f.client.calls.length, 1); assert.equal(f.reads.length, 2);
  assert.deepEqual(f.queue.decorate({ threadId: 'thread' }).queuedMessages[0].plugins, [{ id: 'search@example', displayName: '资料检索' }]);
  assert.match(f.queue.rows('thread')[0].error, /不会自动重发/);
});

test('旧 payload 和空选择保持无插件格式，队列恢复后零目录查询正常投递', async t => {
  for (const extra of [{}, { pluginIds: [] }]) {
    const f = fixture(t, { active: true }); await f.enqueue({ text: '旧消息', ...extra });
    const payload = JSON.parse(f.queue.rows('thread')[0].payload);
    assert.equal(Object.hasOwn(payload, 'pluginIds'), false); assert.equal(Object.hasOwn(payload, 'plugins'), false); assert.equal(Object.hasOwn(f.queue.decorate({ threadId: 'thread' }).queuedMessages[0], 'plugins'), false);
    f.queue.close();
    f.queue = new MessageQueue({ journal: f.journal, adapter: f.adapter, exclusive: (_id, action) => action(), changed: () => {} }); clearInterval(f.queue.timer); t.after(() => f.queue.close());
    f.client.idle(); await f.queue.pump();
    assert.equal(f.reads.length, 0); assert.equal(f.client.calls.length, 1); assert.deepEqual(f.client.calls[0].params.turnStart.request.input, [{ type: 'text', text: '旧消息', text_elements: [] }]);
  }
});

test('携带插件的崩溃中发送恢复为未知，原有已核对名称保留且不重放', async t => {
  const f = fixture(t, { active: true }); await f.enqueue({ text: '合成消息', pluginIds: ['search@example'] });
  f.journal.db.prepare("UPDATE message_queue SET state='sending'").run(); f.queue.close();
  const restored = new MessageQueue({ journal: f.journal, adapter: f.adapter, exclusive: (_id, action) => action(), changed: () => {} }); clearInterval(restored.timer); t.after(() => restored.close());
  f.client.idle(); await restored.pump();
  assert.equal(restored.rows('thread')[0].state, 'unknown'); assert.equal(f.client.calls.length, 0); assert.equal(f.reads.length, 1);
  assert.deepEqual(restored.decorate({ threadId: 'thread' }).queuedMessages[0].plugins, [{ id: 'search@example', displayName: '资料检索' }]);
});

test('插件校验完成后入队前目录改变，不保存消息并释放空队列的订阅', async t => {
  const f = fixture(t, { active: true }), select = f.adapter.selectPlugins.bind(f.adapter);
  f.adapter.selectPlugins = async (...args) => { const selection = await select(...args); f.adapter.conversations.get('thread').state.cwd += '-changed'; return selection; };
  const response = await f.enqueue({ text: '合成消息', pluginIds: ['search@example'] });
  assert.equal(response.error.code, 'PLUGINS_CHANGED'); assert.equal(f.queue.rows('thread').length, 0); assert.equal(f.adapter.conversations.has('thread'), false);
});
