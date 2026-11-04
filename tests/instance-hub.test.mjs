import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { InstanceHub } from '../apps/bridge/instance-hub.mjs';
import { InstanceRuntime } from '../apps/bridge/instance-runtime.mjs';
import { NativeDraftController } from '../apps/bridge/native-draft-controller.mjs';
import { ThreadMentionDesktop } from '../apps/bridge/thread-mention-desktop.mjs';
import { InstanceIpcClient } from '../apps/bridge/instance-binding.mjs';

test('中转拒绝连接时保留关闭码，错误原因及私有配置不进入状态事件', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-close-code-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const hub = new InstanceHub({ config: { hostId: 'synthetic', codexHome: root, relayUrl: `ws://127.0.0.1:${server.address().port}`, token: 'synthetic-test' }, dataPath: root, discover: async () => [] });
  t.after(async () => { await hub.close(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'welcome', capabilities: { hostInstances: true } }));
    socket.once('message', () => socket.close(1011, '合成私有错误，禁止上报正文'));
  });
  const disconnected = once(hub, 'disconnected'); hub.start();
  assert.deepEqual((await disconnected)[0], { code: 1011 });
});

test('实例退出、PID 复用和管道换代只替换对应上下文，默认账本位置保持不变', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-hub-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaultHome = path.join(root, 'default'), otherHome = path.join(root, 'other');
  let rows = [{ pid: 101, startedAt: 1, nativePipe: 'pipe-one', codexHome: defaultHome }, { pid: 102, startedAt: 2, nativePipe: 'pipe-two', codexHome: otherHome }];
  const created = [];
  const hub = new InstanceHub({ config: { hostId: 'computer', codexHome: defaultHome, label: '合成电脑' }, dataPath: root, discover: async () => rows.map(x => ({ ...x })), createRuntime: ({ instance, dataPath }) => {
    const runtime = { instance, dataPath, agent: new EventEmitter(), ready: async () => { instance.ready = true; }, close: async () => { instance.alive = false; instance.ready = false; runtime.closed = true; } }; created.push(runtime); return runtime;
  } });
  await hub.refresh(); const [first, second] = [...hub.runtimes.values()]; assert.equal(first.dataPath, root); assert.notEqual(second.dataPath, root);
  rows[1].startedAt = 3; await hub.refresh(); assert.equal(second.closed, true); assert.equal(first.closed, undefined); const replacement = [...hub.runtimes.values()][1]; assert.equal(replacement.instance.id, second.instance.id); assert.notEqual(replacement.instance.generation, second.instance.generation);
  rows = [rows[1]]; await hub.refresh(); assert.equal(first.closed, true); assert.equal(hub.runtimes.size, 1); assert.equal(replacement.closed, undefined);
  await hub.close(); assert.equal(replacement.closed, true);
});

test('发现失败立即暂停全部实例，但保留身份和账本供核对', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-unavailable-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fail = false;
  const hub = new InstanceHub({ config: { hostId: 'computer', codexHome: root }, dataPath: root, discover: async () => { if (fail) throw new Error(); return [{ pid: 1, startedAt: 1, nativePipe: 'pipe', codexHome: root }]; }, createRuntime: ({ instance }) => ({ instance, agent: new EventEmitter(), ready: async () => { instance.ready = true; }, close: async () => {} }) });
  await hub.refresh(); const instance = [...hub.runtimes.values()][0].instance; fail = true; await hub.refresh(); assert.equal(instance.ready, false); assert.equal(hub.runtimes.size, 1); await hub.close();
});

test('两个 Windows 实例分别核对原生草稿身份，端口换代后只暂停原绑定', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-draft-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [{ pid: 101, startedAt: 1, nativePipe: 'pipe-one', codexHome: root, port: 1234, executable: 'desktop.exe' }, { pid: 102, startedAt: 2, nativePipe: 'pipe-two', codexHome: path.join(root, 'second'), port: 1235, executable: 'desktop.exe' }];
  let discoveries = 0;
  const hub = new InstanceHub({ config: { hostId: 'computer', codexHome: root }, dataPath: root, discover: async () => { discoveries++; return rows.map(row => ({ ...row })); }, bindOwners: async () => {}, createRuntime: ({ instance }) => ({ instance, agent: new EventEmitter(), ready: async () => { instance.ready = true; }, close: async () => { instance.alive = false; instance.ready = false; } }) });
  t.after(() => hub.close()); await hub.refresh();
  const [first, second] = [...hub.runtimes.values()].map(runtime => runtime.instance);
  await Promise.all([first.verify(), second.verify()]);
  assert.equal(first.ready, true); assert.equal(second.ready, true);
  assert.equal(discoveries, 1, '草稿核对复用周期发现，不重复枚举系统进程');
  rows[0].port = 4321;
  await hub.refresh();
  await assert.rejects(first.verify(), { code: 'INSTANCE_NOT_READY' });
  await second.verify(); assert.equal(second.ready, true); assert.equal(first.ready, false);
});

test('Windows 普通启动可直连，第二个实例或 IPC 归属变化立即使原代次失效', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-direct-'));
  const first = { pid: 101, startedAt: 1, nativePipe: 'pipe-one', codexHome: root, soleIpc: true };
  const second = { pid: 102, startedAt: 2, nativePipe: 'pipe-two', codexHome: path.join(root, 'second'), port: 1234 };
  let rows = [first], probed = [];
  const hub = new InstanceHub({ config: { hostId: 'computer', codexHome: root }, dataPath: root, discover: async () => rows.map(row => ({ ...row })), bindOwners: async runtimes => { probed = runtimes.map(runtime => runtime.instance.pid); }, createRuntime: ({ instance }) => ({ instance, agent: new EventEmitter(), ready: async () => { instance.ready = instance.directIpc || !!instance.port; }, close: async () => { instance.alive = false; instance.ready = false; } }) });
  t.after(async () => { await hub.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.refresh();
  const direct = hub.runtimes.get('computer').instance;
  assert.equal(direct.directIpc, true);
  assert.equal(hub.manifest()[0].online, true);
  assert.deepEqual(probed, []);
  await direct.verify();

  // 第二个进程可能还没建好工具管道，发现器此时也会撤销独占证明。
  rows = [{ ...first, soleIpc: false }];
  await assert.rejects(direct.verify(), { code: 'INSTANCE_NOT_READY' });
  assert.equal(hub.manifest()[0].online, false);
  rows = [{ ...first, soleIpc: false, port: 2345 }, second];
  await hub.refresh();
  assert.equal(direct.alive, false);
  assert.deepEqual(probed, [101, 102]);
  assert.equal(hub.manifest().every(row => row.online), true);
  assert.notEqual(hub.runtimes.get('computer').instance.generation, direct.generation);

  rows = [{ ...first, pid: 103, startedAt: 3 }];
  await hub.refresh();
  assert.equal(hub.runtimes.get('computer').instance.directIpc, true);
  assert.equal(hub.manifest()[0].online, true);
});

test('普通启动时永久删除在进入操作队列前被拒绝，带端口的实例仍走原删除流程', async () => {
  const instance = { directIpc: true, generation: 'current', alive: true, verify: async () => {} };
  const handled = [];
  const runtime = { instance, client: { assertCurrent() {} }, agent: { handleRequest(message) { handled.push(message.method); } } };
  const request = method => InstanceRuntime.prototype.request.call(runtime, { generation: instance.generation, method });
  await assert.rejects(request('thread.delete'), { code: 'DELETE_UNSUPPORTED' });
  await request('threads.list');
  instance.directIpc = false;
  await request('thread.delete');
  assert.deepEqual(handled, ['threads.list', 'thread.delete']);
});

test('两个无端口实例仅接受本路由验证的连接，旧进程身份撤销不影响另一个实例', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-router-'));
  const rows = [{ pid: 101, startedAt: 1, nativePipe: 'pipe-one', codexHome: root }, { pid: 102, startedAt: 2, nativePipe: 'pipe-two', codexHome: path.join(root, 'second') }];
  const peers = new Map([['101:1', 'first'], ['102:2', 'second']]);
  const ipcHost = {
    ready: true,
    clientIds: row => new Set([peers.get(`${row.pid}:${row.startedAt}`)].filter(Boolean)),
    ownsConnection: id => id === 'bridge',
    close() {},
  };
  const hub = new InstanceHub({
    config: { hostId: 'computer', codexHome: root }, dataPath: root, ipcHost,
    discover: async () => rows.map(row => ({ ...row })),
    bindOwners: async () => assert.fail('内核身份绑定不能退回全局归属推测'),
    createRuntime: ({ instance }) => ({
      instance, agent: new EventEmitter(),
      async ready() { instance.ready = instance.routerClientIds().size > 0; },
      async close() { instance.ready = instance.alive = false; },
    }),
  });
  t.after(async () => { await hub.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.refresh();
  const [first, second] = [...hub.runtimes.values()].map(runtime => runtime.instance);
  assert.equal(hub.manifest().every(row => row.online), true);
  assert.equal(first.directIpc, false);
  const client = new InstanceIpcClient({ instance: first });
  client.clientId = 'outside';
  assert.throws(() => client.assertCurrent(), { code: 'INSTANCE_NOT_READY' });
  client.clientId = 'bridge';
  client.assertCurrent();
  assert.deepEqual([...client.allowedClients], ['first']);
  assert.throws(() => client.broadcast('test', {}, 0, ['second']), { code: 'INSTANCE_CHANGED' });
  peers.delete('101:1');
  await assert.rejects(first.verify(), { code: 'INSTANCE_NOT_READY' });
  await second.verify();
  assert.equal(second.ready, true);
});

test('单实例只读请求和不可用的原生页面能力不扫描进程，写入仍复核', async () => {
  let scans = 0;
  const instance = { directIpc: true, generation: 'current', alive: true, verify: async () => { scans++; } };
  const client = { instance, assertCurrent() {} };
  const runtime = { instance, client, agent: { handleRequest(message) { return message.method; } } };
  const draft = new NativeDraftController({ instance });
  const mention = new ThreadMentionDesktop();
  try {
    for (const method of ['threads.list', 'thread.history', 'thread.watch', 'projects.list']) {
      assert.equal(await InstanceRuntime.prototype.request.call(runtime, { generation: instance.generation, method }), method);
    }
    assert.equal(await draft.capabilities(), false);
    assert.equal(await mention.capabilities({ client }), false);
    assert.equal(scans, 0);
    assert.equal(await InstanceRuntime.prototype.request.call(runtime, { generation: instance.generation, method: 'turn.send' }), 'turn.send');
    assert.equal(scans, 1);
  } finally {
    draft.close();
    mention.close();
  }
});

test('Mac 项目读取复用当前绑定，其他读写继续核验；断线或旧代次均不返回缓存结果',async()=>{
  let scans=0,handled=0,release;
  const instance={generation:'current',alive:true,ready:true,verify:async()=>{scans++;}};
  const runtime={isMac:true,instance,client:{assertCurrent(){if(!instance.ready)throw Object.assign(Error('合成离线'),{code:'INSTANCE_NOT_READY'});}},agent:{handleRequest:async message=>{handled++;if(release)await new Promise(done=>{release=done;});return message.method;}}};
  const request=(method,generation='current')=>InstanceRuntime.prototype.request.call(runtime,{generation,method});
  assert.equal(await request('projects.list'),'projects.list');assert.equal(scans,0);
  for(const method of ['threads.list','thread.draft.open','turn.send'])assert.equal(await request(method),method);
  assert.equal(scans,3);
  await assert.rejects(request('projects.list','old'),{code:'INSTANCE_CHANGED'});assert.equal(handled,4);
  release=true;const pending=request('projects.list');await Promise.resolve();instance.ready=false;release();
  await assert.rejects(pending,{code:'INSTANCE_NOT_READY'});
  await assert.rejects(request('projects.list'),{code:'INSTANCE_NOT_READY'});assert.equal(handled,5);
});
