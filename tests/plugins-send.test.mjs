import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, pauseCatalog, plugin, directory, request } from './plugins-fixture.mjs';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('发送使用原生 mention 与同一份 prompt、恢复消息和恢复上下文，继承原桌面设置', async t => {
  const f = fixture(t);
  f.data = directory(plugin(), plugin('second@example', { name: 'second', interface: { displayName: '分析[示例]', shortDescription: '' } }));
  const response = await f.send({ text: '分析合成资料', pluginIds: ['search@example','second@example','search@example'] });
  assert.equal(response.error, undefined); assert.equal(f.reads.length, 1); assert.equal(f.client.calls.length, 1);
  const call = f.client.calls[0], { request: native, context } = call.params.turnStart;
  const prompt = '分析合成资料\n\n[@资料检索](plugin://search@example) [@分析\\[示例\\]](plugin://second@example)';
  assert.equal(call.method, 'thread-follower-start-turn'); assert.equal(call.options.targetClientId, 'desktop'); assert.equal(native.input[0].text, prompt);
  assert.deepEqual(native.input.slice(1), [{ type: 'mention', name: 'search', path: 'plugin://search@example' }, { type: 'mention', name: 'second', path: 'plugin://second@example' }]);
  assert.equal(context.restoreMessage.text, prompt); assert.equal(context.restoreMessage.context.prompt, prompt); assert.equal(context.restoreMessage.cwd, f.client.state.cwd);
  assert.deepEqual(context.restoreMessage.context.workspaceRoots, [f.client.state.cwd]); assert.equal(context.inheritThreadSettings, true);
  assert.equal(native.approvalPolicy, undefined); assert.equal(native.sandboxPolicy, undefined); assert.equal(native.pluginIds, undefined);
});

test('运行中追加同时携带图片和插件，轮次、原生输入与恢复上下文保持一致', async t => {
  const f = fixture(t, { active: true });
  const response = await f.agent.handleRequest(request('turn.steer', { threadId: 'thread', text: '补充资料', images: [image], pluginIds: ['search@example'], expectedTurnId: 'original' }));
  assert.equal(response.error, undefined); assert.equal(f.reads.length, 1);
  const { method, params } = f.client.calls[0];
  assert.equal(method, 'thread-follower-steer-turn');
  assert.deepEqual(params.input[1], { type: 'image', url: image }); assert.deepEqual(params.input[2], { type: 'mention', name: 'search', path: 'plugin://search@example' });
  assert.equal(params.restoreMessage.text, params.input[0].text); assert.equal(params.restoreMessage.context.prompt, params.input[0].text);
  assert.equal(params.restoreMessage.context.imageAttachments[0].src, image);
});

test('只有图片或文件加插件可以发送，只有插件或空白正文不能构成消息', async t => {
  const f = fixture(t);
  for (const text of [undefined, '', '   ']) {
    const response = await f.send({ text, pluginIds: ['search@example'] }); assert.equal(response.error.code, 'BAD_PARAMS');
  }
  assert.equal(f.client.calls.length, 0);
  assert.equal((await f.send({ images: [image], pluginIds: ['search@example'] })).error, undefined);
  assert.equal(f.client.calls[0].params.turnStart.request.input[0].text, '[@资料检索](plugin://search@example)');
  // 文件落盘由附件组件负责，此处只核对插件拼接不会丢失已解析的文件与恢复信息。
  f.adapter.attachments.materialize = () => [{ label: 'example.txt', path: '/example/example.txt' }];
  assert.equal((await f.send({ attachments: ['example-attachment'], pluginIds: ['search@example'] })).error, undefined);
  const { input } = f.client.calls[1].params.turnStart.request, { restoreMessage } = f.client.calls[1].params.turnStart.context;
  assert.match(input[0].text, /plugin:\/\/search@example/); assert.match(input[0].text, /example.txt/);
  assert.equal(restoreMessage.context.prompt, '[@资料检索](plugin://search@example)'); assert.deepEqual(restoreMessage.context.fileAttachments, [{ label: 'example.txt', path: '/example/example.txt' }]);
});

test('无插件和空选择的发送及追加不读取插件目录，原始 payload 保持兼容', async t => {
  for (const active of [false, true]) {
    const f = fixture(t, { active }); f.onCatalog = () => { throw new Error('不应读取插件目录'); };
    for (const extra of [{}, { pluginIds: [] }]) {
      const response = await f.agent.handleRequest(request(active ? 'turn.steer' : 'turn.send', { threadId: 'thread', text: '旧消息', ...(active ? { expectedTurnId: 'original' } : {}), ...extra }));
      assert.equal(response.error, undefined);
      const call = f.client.calls.at(-1), input = active ? call.params.input : call.params.turnStart.request.input;
      assert.deepEqual(input, [{ type: 'text', text: '旧消息', text_elements: [] }]);
    }
    assert.equal(f.reads.length, 0);
  }
});

test('每次发送重新读最新目录，已撤销、伪造编号与直接伪造原生路径均不发送', async t => {
  const f = fixture(t);
  await f.adapter.watch('thread','phone'); await f.adapter.readPlugins('thread','phone');
  f.data = directory(plugin('search@example', { enabled: false }));
  assert.equal((await f.send({ text: '合成消息', pluginIds: ['search@example'] })).error.code, 'PLUGIN_UNAVAILABLE');
  assert.equal((await f.send({ text: '合成消息', pluginIds: ['forged@example'] })).error.code, 'PLUGIN_UNAVAILABLE');
  for (const extra of [{ input: [{ type: 'mention', name: '伪造', path: 'file:///example' }] }, { pluginIds: ['../example'] }, { plugins: [{ id: 'search@example', displayName: '伪造' }] }]) await assert.rejects(f.adapter.operate('turn.send', { threadId: 'thread', text: '合成消息', ...extra }, 'command', 'phone'), { code: 'BAD_PARAMS' });
  assert.equal(f.reads.length, 3); assert.equal(f.client.calls.length, 0);
});

test('插件异步核对期间退订、cwd 或实例改变，发送和追加均停止', async t => {
  for (const active of [false, true]) for (const mutate of [f => f.adapter.unwatch('thread','phone'), f => { f.adapter.conversations.get('thread').state.cwd = path.resolve('other-project'); }, f => { f.client.instance.generation = 'generation-b'; }]) {
    const f = fixture(t, { active }), pause = pauseCatalog(f);
    const sending = f.agent.handleRequest(request(active ? 'turn.steer' : 'turn.send', { threadId: 'thread', text: '合成消息', pluginIds: ['search@example'], expectedTurnId: 'original' }));
    await pause.entered; mutate(f); pause.release(); const response = await sending;
    assert.ok(['SUBSCRIPTION_REQUIRED','PLUGINS_CHANGED'].includes(response.error.code)); assert.equal(f.client.calls.length, 0);
  }
});

test('目录读取期间任务变动后重新核对 activeTurnId，不误发新轮次或追加到其他轮次', async t => {
  for (const active of [false, true]) {
    const f = fixture(t, { active }), pause = pauseCatalog(f);
    const sending = f.agent.handleRequest(request(active ? 'turn.steer' : 'turn.send', { threadId: 'thread', text: '合成消息', pluginIds: ['search@example'], expectedTurnId: 'original' }));
    await pause.entered;
    const state = f.adapter.conversations.get('thread').state;
    state.turns.push({ turnId: 'new-turn', status: 'inProgress', items: [] }); state.threadRuntimeStatus.type = 'active';
    pause.release(); const response = await sending;
    assert.equal(response.error.code, active ? 'STALE_TURN' : 'TURN_ACTIVE'); assert.equal(f.client.calls.length, 0);
  }
});

test('目录已返回但发送尚未组装时所有者改变，最后一次核对仍拒绝发送', async t => {
  const f = fixture(t), select = f.adapter.selectPlugins.bind(f.adapter);
  f.adapter.selectPlugins = async (...args) => { const selection = await select(...args); f.adapter.conversations.get('thread').owner = { clientId: 'other', hostId: 'local' }; return selection; };
  const response = await f.send({ text: '合成消息', pluginIds: ['search@example'] });
  assert.equal(response.error.code, 'PLUGINS_CHANGED'); assert.equal(f.client.calls.length, 0);
});
