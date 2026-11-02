import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { NewThreadService } from '../apps/bridge/new-thread-service.mjs';
import { validateSettings } from '../apps/bridge/model-settings.mjs';
import { ThreadCreationClient } from '../apps/bridge/thread-creation.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { validateRequest } from '../packages/protocol/contracts.mjs';

const id = '01a19a44-f889-7d01-8272-e5b7d14492da';

/** 可控 stdio 服务直接执行真实创建客户端，核对协议顺序和进程隔离。 */
function creationFixture(handler = () => ({})) {
  const calls = [], launches = [];
  const launch = (executable, args, options) => {
    launches.push({ executable, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 0);
    child.stdin = new Writable({ write(data, _encoding, done) {
      const message = JSON.parse(data.toString()); calls.push(message);
      if (message.id !== undefined) queueMicrotask(() => {
        const result = message.method === 'thread/start' ? { thread: { id } } : handler(message);
        const response = Buffer.from(JSON.stringify({ id: message.id, result }) + '\n');
        // 覆盖中文 JSON 在任意 UTF-8 字节边界拆包的情况。
        for (let offset = 0; offset < response.length; offset++) child.stdout.write(response.subarray(offset, offset + 1));
      });
      done();
    } });
    child.stdin.on('finish', () => child.emit('exit', 0)); return child;
  };
  return { client: new ThreadCreationClient({ launch, resolveCli: () => '本机CLI', codexHome: '/隔离配置' }), calls, launches };
}

test('空会话先登记编号再设置标题落盘，辅助连接不启动轮次且保留原有权限配置', async () => {
  const f = creationFixture(); let checkpoint = false;
  assert.deepEqual(await f.client.create('/项目', '首条消息标题', result => { checkpoint = result.threadId === id; assert.equal(f.calls.some(call => call.method === 'thread/name/set'), false); }), { threadId: id });
  assert.equal(checkpoint, true);
  assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'initialized', 'thread/start', 'thread/name/set']);
  assert.deepEqual(f.calls[2].params, { cwd: '/项目' });
  assert.deepEqual(f.calls[3].params, { threadId: id, name: '首条消息标题' });
  assert.equal(f.launches[0].options.windowsHide, true); assert.equal(f.launches[0].options.shell, false);
  assert.equal(f.launches[0].options.env.CODEX_HOME, '/隔离配置');
});

test('初始化未就绪属于明确失败，创建后登记失败则保持结果未知', async () => {
  const launch = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 0); child.stdin.on('finish', () => child.emit('exit', 0)); return child;
  };
  const client = new ThreadCreationClient({ launch, resolveCli: () => '本机CLI', timeoutMs: 5 }), journal = new Journal();
  await assert.rejects(journal.execute('phone', 'initializing-command', 'thread.create', { projectId: 'p' }, () => client.create('/项目')), { code: 'CREATION_NOT_READY', outcomeUnknown: false });
  assert.equal(journal.status('phone', 'initializing-command').state, 'done'); journal.close();
  const f = creationFixture(); await assert.rejects(f.client.create('/项目', '标题', () => { throw new Error('账本不可写'); }), { outcomeUnknown: true });
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
});

test('项目设置读取保留中文并且不执行创建、审批或模型请求', async () => {
  const f = creationFixture(() => ({ config: { model: '中文模型' } }));
  assert.equal((await f.client.readConfig('/项目')).config.model, '中文模型');
  assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'initialized', 'config/read']);
});

test('未指定模型时读取电脑默认模型，不把目录首项当作默认值', async () => {
  const f = creationFixture(message => message.method === 'config/read' ? { config: { model: null } } : { data: [{ id: 'first', isDefault: false }, { id: 'default', model: 'default-model', isDefault: true, defaultReasoningEffort: 'high' }] });
  assert.equal((await f.client.readConfig('/项目')).defaultModel.model, 'default-model');
  assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'initialized', 'config/read', 'model/list']);
});

test('项目来自完整桌面保存清单，失效目录和任意手机路径不能用于创建', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-new-project-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, '项目'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { a: { id: 'project', name: '完整项目', rootPaths: [directory] }, b: { id: 'missing', rootPaths: [path.join(home, '已删除')] } }, 'selected-project': { type: 'local', projectId: 'project' } }));
  const calls = [];
  const service = new NewThreadService({ codexHome: home, creation: { create: async (...args) => { calls.push(args); return { threadId: id }; }, readConfig: async () => ({ config: { model: 'configured', model_reasoning_effort: 'high' } }) }, catalog: { read: () => [{ id: 'configured', defaultEffort: 'medium' }] } });
  assert.deepEqual(service.projects().projects, [{ id: 'project', label: '完整项目', cwd: directory }]);
  assert.equal(service.projects().selectedProjectId, 'project');
  assert.equal((await service.settings('project')).settings.effort, 'high');
  await assert.rejects(async () => service.create('../任意路径'), { code: 'PROJECT_NOT_FOUND' }); assert.equal(calls.length, 0);
  await service.create('project'); assert.equal(calls[0][0], directory);
});

test('新对话配置中的常速别名可随首次发送设置通过校验，快速档位保持原值', async () => {
  const models = [{ id: 'model', defaultEffort: 'high', efforts: ['high', 'max'], speeds: [{ id: '' }, { id: 'priority' }] }];
  for (const tier of [undefined, null, 'default', '', 'priority']) {
    const service = new NewThreadService({ creation: { readConfig: async () => ({ config: { model: 'model', model_reasoning_effort: 'high', service_tier: tier } }) }, catalog: { read: () => models } });
    service.project = () => ({ cwd: '/项目' });
    const { settings } = await service.settings('project');
    const expectedTier = tier === 'priority' ? 'priority' : '';
    assert.equal(settings.serviceTier, expectedTier);
    // 模拟用户只改推理强度后，首次发送仍携带全部四项设置。
    const changes = { ...settings, effort: 'max' };
    const result = validateSettings(changes, { ...settings, serviceTier: '' }, models);
    assert.equal(result.selected.serviceTier, expectedTier);
    assert.equal(result.threadSettings.serviceTier, expectedTier || null);
    assert.equal(result.selected.effort, 'max');
  }
});

test('创建协议不要求旧会话编号，拒绝手机传入目录、权限、程序和设置覆盖', () => {
  const request = params => ({ v: 1, type: 'request', requestId: 'new-thread-command-001', method: 'thread.create', params });
  assert.doesNotThrow(() => validateRequest(request({ projectId: 'project', title: '新任务' })));
  for (const params of [{ projectId: '' }, { projectId: 'p', cwd: '/任意' }, { projectId: 'p', approvalPolicy: 'never' }, { projectId: 'p', model: 'model' }, { projectId: 'p', executable: 'cmd.exe' }, { projectId: 'p', title: 'a'.repeat(81) }]) assert.throws(() => validateRequest(request(params)));
});

test('并发重放同一创建请求只建一次，已创建但后续失败的编号仍可从账本核对', async () => {
  const journal = new Journal(), adapter = new EventEmitter(); adapter.close = () => {};
  let created = 0;
  const agent = new BridgeAgent({ config: {}, adapter, journal, newThreads: { async create(_projectId, _title, checkpoint) { created++; checkpoint({ threadId: id }); return { threadId: id }; } } });
  const message = { v: 1, type: 'request', requestId: 'new-thread-command-001', method: 'thread.create', deviceId: 'phone', params: { projectId: 'project' } };
  const responses = await Promise.all([agent.handleRequest(message), agent.handleRequest(message)]);
  assert.equal(created, 1); assert.deepEqual(responses.map(response => response.result.threadId), [id, id]);
  agent.newThreads.create = async (_projectId, _title, checkpoint) => { checkpoint({ threadId: id }); throw Object.assign(new Error('连接中断'), { outcomeUnknown: true }); };
  const failed = await agent.handleRequest({ ...message, requestId: 'new-thread-command-002' });
  assert.equal(failed.error.outcomeUnknown, true);
  const status = journal.status('phone', 'new-thread-command-002'); assert.equal(status.state, 'unknown'); assert.equal(status.result.threadId, id);
  await agent.close();
});
