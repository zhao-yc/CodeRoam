import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MacInstanceIpcClient, navigateMacInstance } from '../apps/bridge/macos-instance-client.mjs';
import { InstanceHub } from '../apps/bridge/instance-hub.mjs';
import { InstanceRegistry } from '../apps/bridge/instance-registry.mjs';
import { InstanceRuntime } from '../apps/bridge/instance-runtime.mjs';

/** 合成 IPC 保留真实帧及响应分发，只替换系统通道。 */
function fixture() {
  const instance = { alive: true, ready: true, pid: 101, ipcSocketPath: '/private/example/one/ipc/ipc.sock' };
  const owner = randomUUID(), foreign = randomUUID(), requests = [];
  let valid = true, responder = owner;
  const client = new MacInstanceIpcClient({ instance, verify: async () => { if (!valid) { instance.ready = false; throw new Error('身份已变化'); } } });
  client.socket = { writable: true, write(frame) { const request = JSON.parse(frame.subarray(4)); requests.push(request); if (request.type === 'request') queueMicrotask(() => client.handleMessage({ type: 'response', requestId: request.requestId, resultType: 'success', handledByClientId: responder, result: {} })); } };
  return { client, instance, owner, foreign, requests, invalidate: () => { valid = false; }, respondAs: value => { responder = value; } };
}

test('Mac 只在专属 IPC 发现所有者，发送、回应与广播继续核对客户端归属', async () => {
  const { client, owner, foreign, requests, respondAs } = fixture();
  assert.equal(client.socketPath, '/private/example/one/ipc/ipc.sock');
  assert.equal((await client.findOwner(randomUUID())).clientId, owner);
  await client.request('thread-follower-start-turn', {}, 2, { targetClientId: owner });
  await assert.rejects(client.request('thread-follower-start-turn', {}, 2, { targetClientId: foreign }), error => error.code === 'INSTANCE_CHANGED');
  assert.equal(requests.length, 2);
  respondAs(foreign);
  await assert.rejects(client.request('thread-follower-start-turn', {}, 2, { targetClientId: owner }), error => error.code === 'INSTANCE_CHANGED');
  assert.throws(() => client.broadcast('thread-stream-following-changed', {}, 1, [foreign]), error => error.code === 'INSTANCE_CHANGED');
  let received = 0; client.on('broadcast', () => received++);
  client.handleMessage({ type: 'broadcast', sourceClientId: foreign, method: 'thread-stream-state-changed' });
  client.handleMessage({ type: 'broadcast', sourceClientId: owner, method: 'thread-stream-state-changed' });
  assert.equal(received, 1);
  client.handleClose(); assert.equal(client.instance.ready, false); assert.equal(client.allowedClients.size, 0);
});

test('Mac 身份变化后不发写请求，发现期间进程换代也不能接纳旧所有者', async () => {
  const first = fixture(); await first.client.findOwner(randomUUID()); first.invalidate();
  await assert.rejects(first.client.request('thread-follower-start-turn', {}, 2, { targetClientId: first.owner }));
  assert.equal(first.requests.length, 1);
  const second = fixture();
  second.client.verify = async () => { second.instance.ready = false; throw new Error('发现回应到达前进程换代'); };
  await assert.rejects(second.client.findOwner(randomUUID())); assert.equal(second.client.allowedClients.size, 0);
});

test('Mac 导航固定到已核验 PID，取消、无效编号和系统失败不能退回全局打开', async () => {
  const id = randomUUID(), calls = []; let current = true;
  const instance = { pid: 123 }, verify = async () => {}, launch = async (...args) => calls.push(args);
  await navigateMacInstance(instance, id, { verify, launch });
  assert.equal(calls[0][0], '/usr/bin/osascript'); assert.deepEqual(calls[0][1].slice(-2), ['123', id]);
  await assert.rejects(navigateMacInstance(instance, id + '?prompt=run', { verify, launch }), error => error.code === 'BAD_THREAD_ID');
  await assert.rejects(navigateMacInstance(instance, id, { verify: async () => { current = false; }, isCurrent: () => current, launch }), error => error.code === 'SUBSCRIPTION_CANCELED');
  await assert.rejects(navigateMacInstance(instance, id, { verify, launch: async () => { throw new Error('/private/example'); } }), error => error.code === 'DESKTOP_LOAD_FAILED' && !error.message.includes('/private'));
  assert.equal(calls.length, 1);
});

test('Mac 两套独立配置分别在线，共用 IPC、进程换代或发现失败立即拒绝原操作', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-instance-hub-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const row = (pid, home, userData = null) => ({ platform: 'darwin', pid, startedAt: pid, nativePipe: 'native-' + pid, executable: '/Applications/Example.app', codexHome: home, ipcSocketPath: home + '/ipc/ipc.sock', userData });
  let rows = [row(1, root), row(2, root + '/other')], failed = false;
  const hub = new InstanceHub({ config: { hostId: 'computer', codexHome: root }, dataPath: root, discover: async () => { if (failed) throw new Error(); return rows.map(value => ({ ...value })); }, bindOwners: () => assert.fail('Mac 不查询 Windows 的全局后台身份'), createRuntime: ({ instance }) => ({ instance, agent: new EventEmitter(), ready: async () => { await instance.verify(); instance.ready = true; }, close: async () => { instance.alive = false; instance.ready = false; } }) });
  t.after(() => hub.close());
  await hub.refresh(); const [first, second] = [...hub.runtimes.values()]; assert.equal(hub.manifest().filter(x => x.online).length, 2);
  rows.push(row(3, root, root + '/ui'));
  await assert.rejects(first.instance.verify(), error => error.code === 'INSTANCE_NOT_READY');
  await hub.refresh(); assert.equal(first.instance.ready, false); assert.equal(second.instance.ready, true);
  rows = rows.slice(0, 2); rows[0].startedAt++;
  await assert.rejects(first.instance.verify()); await hub.refresh(); assert.equal(first.instance.alive, false);
  const replacement = hub.runtimes.get('computer'); assert.notEqual(replacement.instance.generation, first.instance.generation);
  failed = true; await assert.rejects(replacement.instance.verify()); assert.equal(replacement.instance.ready, false);
});

test('Mac 区分大小写的目录不会合并设备身份，Windows 保留原有归一化规则', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-instance-case-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { file: path.join(root, 'instances.json'), hostId: 'computer', defaultHome: root, platform: 'darwin' };
  const registry = new InstanceRegistry(options);
  assert.notEqual(registry.identify({ codexHome: root + '/One' }).id, registry.identify({ codexHome: root + '/one' }).id);
  // 预期路径沿用运行平台的分隔符，避免在 Windows 上因混用斜杠误报。
  assert.equal(new InstanceRegistry({ ...options, file: path.join(root, 'windows.json'), platform: 'win32' }).canonical(root + '/One'), path.join(root, 'one').toLowerCase());
});

test('实例离线时先关闭 IPC，已有实时订阅不会阻止账本和上下文释放', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-instance-close-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const instance = { platform: 'darwin', pid: 101, codexHome: root, ipcSocketPath: root + '/ipc/ipc.sock', alive: true, ready: true, verify: async () => {} };
  const runtime = new InstanceRuntime({ instance, config: {}, dataPath: root, send: () => {} });
  runtime.client.socket = { writable: true, destroy() { this.writable = false; } };
  runtime.adapter.conversations.set(randomUUID(), { owner: { clientId: randomUUID(), hostId: 'local' }, waiters: [] });
  await runtime.close();
  assert.equal(runtime.client.socket.writable, false); assert.equal(runtime.adapter.stopped, true); assert.equal(runtime.adapter.conversations.size, 0);
  assert.throws(() => runtime.agent.journal.db.prepare('SELECT 1'), /not open|closed|关闭/i);
});
