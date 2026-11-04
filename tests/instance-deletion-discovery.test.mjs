import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DesktopDeleteController, createInstanceDeletionDiscovery } from '../apps/bridge/desktop-delete.mjs';
import { InstanceRuntime } from '../apps/bridge/instance-runtime.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

/** 实例身份和页面响应均使用合成数据，不发现、导航或删除真实桌面聊天。 */
function fixture(executable = 'Codex.exe') {
  const calls = [], instance = { id: 'synthetic-instance', pid: 42, port: 12345, executable: 'C:/synthetic/releases/99.0.0/' + executable, generation: randomUUID(), startedAt: 'synthetic-started-at', alive: true, ready: true };
  instance.verify = async () => { calls.push('verify'); };
  const client = { instance, assertCurrent() { calls.push('assert'); } };
  return { instance, client, calls, discover: createInstanceDeletionDiscovery(instance, client) };
}

test('已核验的新版本 Codex.exe 和 ChatGPT.exe 均只返回绑定实例的端口', async () => {
  for (const executable of ['Codex.exe', 'ChatGPT.exe']) {
    const f = fixture(executable);
    assert.deepEqual(await f.discover(), [{ pid: 42, port: 12345, executable: f.instance.executable }]);
    assert.deepEqual(f.calls, ['assert', 'verify', 'assert']);
    const result = await f.discover(); result[0].pid = 999;
    assert.equal((await f.discover())[0].pid, 42, '返回对象不能修改实例绑定');
  }
});

test('未开放、非法或缺失端口不借用其他实例，也不尝试打开新端口', async () => {
  for (const port of [null, undefined, 0, -1, 65536, 123.5, '12345']) {
    const f = fixture(); f.instance.port = port;
    f.client.otherInstances = [{ pid: 99, port: 54321, executable: 'C:/synthetic/other/Codex.exe' }];
    const discover = createInstanceDeletionDiscovery(f.instance, f.client);
    assert.deepEqual(await discover(), []); assert.equal(f.instance.port, port);
    assert.deepEqual(f.calls, ['assert', 'verify', 'assert']);
  }
});

test('核验期间进程、端口、版本路径、代次或启动时间变化时拒绝旧绑定', async () => {
  for (const field of ['pid', 'port', 'executable', 'generation', 'startedAt']) {
    const f = fixture(); f.instance.verify = async () => { f.instance[field] = typeof f.instance[field] === 'number' ? f.instance[field] + 1 : 'synthetic-changed'; };
    await assert.rejects(f.discover(), { code: 'INSTANCE_CHANGED' }, field);
  }
});

test('发现器创建后身份已换代，不能把新字段当作原实例继续删除', async () => {
  const f = fixture(); f.instance.generation = randomUUID();
  await assert.rejects(f.discover(), { code: 'INSTANCE_CHANGED' }); assert.deepEqual(f.calls, ['assert']);
});

test('实例已离线、未就绪或客户端换绑其他实例时不返回任何页面', async () => {
  for (const change of ['alive', 'ready', 'client']) {
    const f = fixture();
    f.instance.verify = async () => { if (change === 'client') f.client.instance = { ...f.instance }; else f.instance[change] = false; };
    await assert.rejects(f.discover(), { code: 'INSTANCE_CHANGED' }, change);
  }
  const f = fixture(); f.client.instance = { ...f.instance };
  await assert.rejects(f.discover(), { code: 'INSTANCE_CHANGED' }); assert.equal(f.calls.includes('verify'), false);
});

test('客户端或系统核验失败时保持拒绝，不回退到全局发现器', async () => {
  const disconnected = fixture(); disconnected.client.assertCurrent = () => { throw new BridgeError('INSTANCE_NOT_READY', '合成实例未就绪'); };
  await assert.rejects(disconnected.discover(), { code: 'INSTANCE_NOT_READY' }); assert.equal(disconnected.calls.length, 0);
  const failed = fixture(); failed.instance.verify = async () => { throw new BridgeError('INSTANCE_CHANGED', '合成身份失效'); };
  await assert.rejects(failed.discover(), { code: 'INSTANCE_CHANGED' });
  const unverified = fixture(); unverified.instance.verify = async () => false;
  await assert.rejects(unverified.discover(), { code: 'INSTANCE_CHANGED' });
  const late = fixture(); late.client.assertCurrent = () => { late.calls.push('assert'); if (late.calls.length > 1) throw new BridgeError('INSTANCE_NOT_READY', '合成绑定已撤销'); };
  await assert.rejects(late.discover(), { code: 'INSTANCE_NOT_READY' }); assert.equal(late.calls.includes('verify'), true);
});

/** 只替换固定页面步骤，仍运行真实控制器的目标、弹窗和最终提交校验。 */
function controllerFixture({ mismatch = false, processId = 42 } = {}) {
  const f = fixture(), phases = []; let committed = false;
  const page = { close() { phases.push('close'); }, async step(phase) {
    phases.push(phase);
    if (phase === 'inspect') return { target: true, dialog: !committed, matched: !mismatch, ready: true };
    if (phase === 'open') return { state: 'opened' };
    if (phase === 'commit') { committed = true; return { state: 'submitted' }; }
    return { state: 'done' };
  } };
  const controller = new DesktopDeleteController({ platform: 'win32', discover: f.discover,
    fetcher: async url => { phases.push('fetch'); assert.equal(url, 'http://127.0.0.1:12345/json/list'); return { ok: true, text: async () => JSON.stringify([{ id: 'synthetic-page', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://example.com/untrusted' }]) }; },
    openPage: async url => { phases.push('connect'); assert.equal(url, 'ws://127.0.0.1:12345/devtools/page/synthetic-page'); return page; },
  });
  const params = { threadId: 'synthetic-thread', hostId: 'local', commandId: randomUUID(), deadline: Date.now() + 1100, native: { processId, navigate: async id => { assert.equal(id, 'synthetic-thread'); phases.push('navigate'); } } };
  return { ...f, phases, controller, params };
}

test('绑定实例页面仍执行原目标、弹窗核对及最终回读后才提交', async () => {
  const f = controllerFixture(); await f.controller.delete(f.params, async () => { f.phases.push('verify-target'); });
  assert.ok(f.phases.indexOf('verify-target') > f.phases.indexOf('open'));
  assert.ok(f.phases.indexOf('commit') > f.phases.indexOf('verify-target'));
  assert.ok(f.phases.includes('cancel')); assert.equal(f.phases.at(-1), 'close');
});

test('其他进程不能借用原实例端口，目标弹窗或最终回读变化也不提交', async () => {
  const other = controllerFixture({ processId: 999 });
  await assert.rejects(other.controller.delete(other.params, async () => { throw new Error('不能进入最终回读'); }), { code: 'DELETE_UNSUPPORTED' });
  assert.equal(other.phases.includes('fetch'), false); assert.equal(other.phases.includes('commit'), false);
  const mismatch = controllerFixture({ mismatch: true });
  await assert.rejects(mismatch.controller.delete(mismatch.params, async () => { throw new Error('不能进入最终回读'); }), { code: 'DELETE_TARGET_CHANGED', outcomeUnknown: false });
  assert.equal(mismatch.phases.includes('commit'), false);
  const changed = controllerFixture();
  await assert.rejects(changed.controller.delete(changed.params, async () => { throw new BridgeError('THREAD_CHANGED', '合成目标已变化'); }), { code: 'THREAD_CHANGED' });
  assert.equal(changed.phases.includes('commit'), false); assert.ok(changed.phases.includes('cancel'));
});

test('InstanceRuntime 为删除控制器注入同一实例发现器，不再依赖旧版本全局端口扫描', async t => {
  const temporaryRoot = path.join(process.cwd(), '.cache'); fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'instance-deletion-'));
  const f = fixture(); Object.assign(f.instance, { platform: 'win32', codexHome: path.join(directory, 'synthetic-home'), nativePipe: 'synthetic-pipe' });
  const runtime = new InstanceRuntime({ instance: f.instance, config: {}, dataPath: directory, send: () => {} });
  t.after(async () => { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  runtime.client.allowedClients.add(randomUUID());
  assert.deepEqual(await runtime.agent.deleteController.discover(), [{ pid: 42, port: 12345, executable: f.instance.executable }]);
  assert.deepEqual(f.calls, ['verify']);
  f.instance.port = null;
  await assert.rejects(runtime.agent.deleteController.discover(), { code: 'INSTANCE_CHANGED' });
});
