import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PluginCatalog } from '../apps/bridge/plugins.mjs';
import { instanceCodexPath, ThreadCreationClient } from '../apps/bridge/thread-creation.mjs';
import { READ_METHODS, WRITE_METHODS, validateRequest, errorPayload } from '../packages/protocol/contracts.mjs';
import { fixture, pauseCatalog, plugin, directory, request } from './plugins-fixture.mjs';

test('目录按原生市场分组过滤安装、启用、可用性与禁用原因，并去重和投影', async () => {
  const records = [plugin(), plugin('off', { enabled: false }), plugin('not-installed', { installed: false }), plugin('admin', { availability: 'DISABLED_BY_ADMIN' }), plugin('null-availability', { availability: null }), plugin('future', { availability: 'ENABLED' }), plugin('reason', { disabledReason: 'unknown' }), plugin('truthy', { enabled: 'true' }), plugin('../forged'), plugin('valid', { availability: 'AVAILABLE', disabledReason: null, interface: null })];
  const data = directory(...records); data.marketplaces.push({ name: 'duplicate', plugins: [plugin(), plugin('last', { interface: { displayName: '最后', shortDescription: '简介', composerIcon: '/private/example/icon.png' }, source: { path: '/private/example/source' } })] });
  const calls = [], creation = { run: (cwd, action) => action((method, params) => { calls.push({ cwd, method, params }); return data; }) };
  const result = await new PluginCatalog({ creation }).read(path.resolve('fixture-project'));
  assert.deepEqual(result, { supportsPluginSelection: true, plugins: [
    { id: 'search@example', name: 'search', displayName: '资料检索', description: '检索合成资料' },
    { id: 'valid', name: 'search', displayName: 'search', description: '' },
    { id: 'last', name: 'search', displayName: '最后', description: '简介' },
  ] });
  assert.deepEqual(calls, [{ cwd: path.resolve('fixture-project'), method: 'plugin/installed', params: { cwds: [path.resolve('fixture-project')] } }]);
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(JSON.stringify(result).includes('诊断'), false);
});

test('空目录成功；读取失败、结构失配与创建错误均不回传原始错误或路径', async () => {
  assert.deepEqual(await new PluginCatalog({ creation: { run: async () => directory() } }).read(path.resolve('fixture-project')), { plugins: [], supportsPluginSelection: true });
  for (const run of [async () => { throw Object.assign(new Error('/private/example/secret 诊断'), { code: 'CREATION_REJECTED', cause: { path: '/private/example/secret' }, outcomeUnknown: true }); }, async () => ({}), async () => ({ marketplaces: [null] })]) {
    await assert.rejects(new PluginCatalog({ creation: { run } }).read(path.resolve('fixture-project')), error => {
      assert.deepEqual(errorPayload(error), { code: 'PLUGINS_UNAVAILABLE', message: '暂时无法读取插件，请确认电脑连接后重新读取', outcomeUnknown: false });
      assert.equal(error.cause, undefined); return true;
    });
  }
});

test('两个插件接口均为严格的只读编号白名单，不能传目录、原生路径和伪造名称', () => {
  for (const [method, params] of [['thread.plugins.read', { threadId: 'thread' }], ['thread.create.plugins', { projectId: 'project' }]]) {
    assert.equal(READ_METHODS.has(method), true); assert.equal(WRITE_METHODS.has(method), false);
    assert.doesNotThrow(() => validateRequest(request(method, params)));
    for (const key of ['cwd','cwds','path','input','pluginIds','name','displayName','source','codexHome','codexCliPath']) assert.throws(() => validateRequest(request(method, { ...params, [key]: 'forged' })));
    assert.throws(() => validateRequest(request(method, {})));
  }
  for (const method of ['plugin/installed','plugin/install','plugin/enable','thread.plugins.update']) assert.throws(() => validateRequest(request(method, { threadId: 'thread' })), { code: 'METHOD_NOT_ALLOWED' });
});

test('插件编号有界、去重且仅发送、追加和入队可用，旧消息仍兼容', () => {
  for (const method of ['turn.send','turn.steer']) {
    for (const pluginIds of [undefined, [], ['search@example'], ['a','a'], ['a'.repeat(200)], Array.from({ length: 20 }, (_, i) => `p${i}`)]) assert.doesNotThrow(() => validateRequest(request(method, { threadId: 'thread', text: '合成消息', ...(pluginIds === undefined ? {} : { pluginIds }) })));
    for (const pluginIds of [null, 'search@example', {}, [''], [' '], [1], ['a'.repeat(201)], Array(21).fill('a'), ['plugin://search@example'], ['../file'], ['C:\\example\\file'], ['%2e%2e%2ffile'], ['a#path'], ['a\nb']]) assert.throws(() => validateRequest(request(method, { threadId: 'thread', text: '合成消息', pluginIds })));
    for (const key of ['input','restoreMessage','cwd','path','plugins','pluginNames']) assert.throws(() => validateRequest(request(method, { threadId: 'thread', text: '合成消息', [key]: 'forged' })));
  }
  assert.doesNotThrow(() => validateRequest(request('turn.send', { threadId: 'thread', queueAction: 'enqueue', text: '合成消息', pluginIds: ['search@example'] })));
  for (const method of ['turn.retry','turn.stop','question.reply','thread.create','thread.settings.update']) assert.throws(() => validateRequest(request(method, { threadId: 'thread', projectId: 'project', pluginIds: [] })));
  for (const queueAction of ['cancel','steer']) assert.throws(() => validateRequest(request('turn.send', { threadId: 'thread', queueAction, queueId: 'queued', expectedTurnId: 'turn', pluginIds: [] })));
});

test('聊天读取必须先订阅，项目读取复用同一个实例创建客户端', async t => {
  const f = fixture(t);
  assert.equal((await f.agent.handleRequest(request('thread.plugins.read', { threadId: 'thread' }))).error.code, 'SUBSCRIPTION_REQUIRED');
  assert.equal(f.reads.length, 0);
  await f.adapter.watch('thread', 'phone');
  for (const [method, params] of [['thread.plugins.read', { threadId: 'thread' }], ['thread.create.plugins', { projectId: 'project' }]]) {
    const response = await f.agent.handleRequest(request(method, params));
    assert.equal(response.error, undefined); assert.equal(response.result.supportsPluginSelection, true); assert.equal(response.result.plugins[0].id, 'search@example');
  }
  assert.equal(f.adapter.pluginCatalog.creation, f.newThreads.creation); assert.equal(f.reads.length, 2);
});

test('目录读取期间取消订阅、替换 entry、所有者或 cwd 都丢弃迟到结果', async t => {
  for (const mutate of [f => f.adapter.unwatch('thread','phone'), f => { const entry = f.adapter.conversations.get('thread'); f.adapter.conversations.set('thread', { ...entry }); }, f => { f.adapter.conversations.get('thread').owner = { clientId: 'other', hostId: 'local' }; }, f => { f.adapter.conversations.get('thread').owner.clientId = 'other'; }, f => { f.adapter.conversations.get('thread').state.cwd = path.resolve('other-project'); }]) {
    const f = fixture(t); await f.adapter.watch('thread','phone'); const pause = pauseCatalog(f);
    const reading = f.adapter.readPlugins('thread','phone'); const rejected = assert.rejects(reading, error => ['SUBSCRIPTION_REQUIRED','PLUGINS_CHANGED'].includes(error.code));
    await pause.entered; mutate(f); pause.release(); await rejected; assert.equal(f.client.calls.length, 0);
  }
});

test('聊天和项目读取期间实例换代、离线或创建目录改变都拒绝返回', async t => {
  for (const method of ['thread.plugins.read','thread.create.plugins']) for (const mutate of [f => { f.client.instance.generation = 'generation-b'; }, f => { f.client.instance.alive = false; }, f => { f.creation.codexHome = path.resolve('other-home'); }, f => { f.creation.codexCliPath = path.resolve('other-cli'); }]) {
    const f = fixture(t); await f.adapter.watch('thread','phone'); const pause = pauseCatalog(f);
    const reading = f.agent.handleRequest(request(method, method === 'thread.plugins.read' ? { threadId: 'thread' } : { projectId: 'project' }));
    await pause.entered; mutate(f); pause.release(); const response = await reading;
    assert.equal(response.result, undefined); assert.equal(response.error.code, 'PLUGINS_CHANGED'); assert.equal(response.error.outcomeUnknown, false);
  }
});

test('项目目录在异步查询期间变化会使目录结果失效', async t => {
  const f = fixture(t), pause = pauseCatalog(f);
  const sharedProject = { id: 'project', cwd: f.projectCwd }; f.newThreads.project = () => sharedProject;
  const reading = f.agent.handleRequest(request('thread.create.plugins', { projectId: 'project' }));
  await pause.entered; sharedProject.cwd = path.resolve('other-project'); pause.release();
  assert.equal((await reading).error.code, 'PLUGINS_CHANGED');
});

test('初次身份核验期间创建配置改变时，不启动目录查询', async () => {
  let queries = 0;
  const creation = { codexHome: 'original', async run() { queries++; return directory(); } };
  const catalog = new PluginCatalog({ creation, async verify() { creation.codexHome = 'changed'; } });
  await assert.rejects(catalog.read(path.resolve('fixture-project')), { code: 'PLUGINS_CHANGED' });
  assert.equal(queries, 0);
});

test('读取失败也重新检查退订，迟到失败不能返回已取消聊天的目录状态', async t => {
  const f = fixture(t); await f.adapter.watch('thread','phone'); const pause = pauseCatalog(f);
  const gate = f.onCatalog; f.onCatalog = async () => { await gate(); throw new Error('合成目录错误'); };
  const reading = f.adapter.readPlugins('thread','phone'), rejected = assert.rejects(reading, { code: 'SUBSCRIPTION_REQUIRED' });
  await pause.entered; f.adapter.unwatch('thread','phone'); pause.release(); await rejected;
});

test('实例 CLI 只在原桌面安装目录中解析，不使用其他版本或环境变量', () => {
  const win = { executable: 'C:\\Applications\\Codex\\Codex.exe' };
  assert.equal(instanceCodexPath(win, { exists: () => true, stat: () => ({ isFile: () => true }) }), 'C:\\Applications\\Codex\\resources\\codex.exe');
  const mac = { platform: 'darwin', executable: '/Applications/Example.app/Contents/MacOS/Codex' };
  assert.equal(instanceCodexPath(mac, { exists: () => true, stat: () => ({ isFile: () => true }) }), '/Applications/Example.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  assert.throws(() => instanceCodexPath(win, { exists: () => false }), { code: 'CREATION_UNSUPPORTED' });
});

test('原生目录短连接使用指定 CODEX_HOME、桌面 CLI 和 cwds，创建错误码保持原样', async () => {
  let launchOptions, program, args;
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  child.stdin.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) {
    const message = JSON.parse(line); if (!message.id) continue;
    const result = message.method === 'plugin/installed' ? directory(plugin()) : {};
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
  } });
  const home = path.resolve('fixture-home'), cwd = path.resolve('fixture-project');
  const creation = new ThreadCreationClient({ codexHome: home, resolveCli: () => 'verified-desktop-cli', launch(executable, argv, options) { program = executable; args = argv; launchOptions = options; return child; } });
  assert.equal((await new PluginCatalog({ creation }).read(cwd)).plugins.length, 1);
  assert.equal(program, 'verified-desktop-cli'); assert.deepEqual(args, ['app-server','--listen','stdio://']); assert.equal(launchOptions.env.CODEX_HOME, home); assert.equal(launchOptions.cwd, cwd); assert.equal(launchOptions.shell, false);
  child.emit('exit');
  const unsupported = new ThreadCreationClient({ resolveCli() { throw Object.assign(new Error('原创建错误'), { code: 'CREATION_UNSUPPORTED' }); } });
  await assert.rejects(unsupported.run(cwd, () => {}), { code: 'CREATION_UNSUPPORTED' });
  await assert.rejects(new PluginCatalog({ creation: unsupported }).read(cwd), { code: 'PLUGINS_UNAVAILABLE' });
});
