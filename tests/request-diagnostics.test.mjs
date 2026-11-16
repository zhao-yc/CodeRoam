import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelay } from '../apps/relay/server.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { InstanceHub } from '../apps/bridge/instance-hub.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { TaskQueue } from '../apps/bridge/task-queue.mjs';
import { tokenHash } from '../packages/protocol/contracts.mjs';
import { createRequestDiagnostics } from '../packages/protocol/request-diagnostics.mjs';

/** 使用合成协议消息覆盖真实中转边界，不连接个人桌面或读取聊天正文。 */
function inbox(socket) {
  const buffered = [], waiting = [];
  socket.on('message', data => {
    const message = JSON.parse(data), at = waiting.findIndex(item => item.match(message));
    if (at < 0) buffered.push(message);
    else { const item = waiting.splice(at, 1)[0]; clearTimeout(item.timer); item.resolve(message); }
  });
  return match => {
    const at = buffered.findIndex(match);
    if (at >= 0) return Promise.resolve(buffered.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { match, resolve };
      item.timer = setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error('合成请求等待超时')); }, 5000);
      waiting.push(item);
    });
  };
}

async function fixture(t, options = {}) {
  const rows = [], hostToken = randomBytes(32).toString('base64url'), mobileToken = randomBytes(32).toString('base64url');
  const diagnostics = createRequestDiagnostics({ component: 'relay', write: line => rows.push(JSON.parse(line)) });
  const relay = createRelay({ identities: [
    { id: 'synthetic-host', role: 'host', hostId: 'synthetic-computer', tokenSha256: tokenHash(hostToken) },
    { id: 'synthetic-phone', role: 'mobile', hostIds: ['synthetic-computer'], tokenSha256: tokenHash(mobileToken) },
  ], requestTimeoutMs: 4000, diagnostics, ...options });
  t.after(() => relay.close());
  const address = await relay.listen(), url = `ws://127.0.0.1:${address.port}/ws`;
  const open = async token => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } }), next = inbox(socket);
    await next(message => message.type === 'welcome');
    return { socket, next };
  };
  const host = await open(hostToken), phone = await open(mobileToken);
  const call = (method = 'threads.list', params = {}) => {
    const requestId = randomUUID();
    phone.socket.send(JSON.stringify({ v: 1, type: 'request', requestId, hostId: 'synthetic-computer', method, params }));
    return requestId;
  };
  return { rows, diagnostics, host, phone, call, url, hostToken, mobileToken, open };
}

test('诊断日志丢弃正文、路径、令牌、原始编号及任意错误内容，跨进程只共享传输摘要', () => {
  const rows = [], first = createRequestDiagnostics({ component: 'relay', write: line => rows.push(JSON.parse(line)) });
  const second = createRequestDiagnostics({ component: 'bridge', write() {} });
  const secret = 'synthetic-sensitive-value', message = { transportId: randomUUID(), method: 'thread.history',
    hostId: secret, deviceId: secret, params: { threadId: secret, view: 'prefetch', text: secret, token: secret, cwd: secret } };
  const a = first.context(message), b = second.context(message);
  assert.equal(a.trace, b.trace); assert.notEqual(a.host, b.host);
  first.record('request.completed', a, { elapsedMs: 13.4, errorCode: secret, text: secret, params: message.params, error: secret });
  assert.equal(JSON.stringify(rows).includes(secret), false);
  assert.equal(JSON.stringify(rows).includes(message.transportId), false);
  assert.equal(rows[0].errorCode, 'OTHER'); assert.equal(rows[0].view, 'prefetch');
  assert.equal(rows[0].elapsedMs, 13); assert.ok(Date.parse(rows[0].time));
  assert.equal(first.context({ method: secret, transportId: secret }).method, 'unknown');
});

test('第 17 个请求记录全部 16 条积压及预加载类型，回执释放名额后可以继续请求', async t => {
  const f = await fixture(t), requests = [];
  for (let index = 0; index < 16; index++) {
    f.call(index % 2 ? 'threads.list' : 'thread.history', index % 2 ? {} : { threadId: `synthetic-thread-${index}`, view: 'prefetch' });
    requests.push(await f.host.next(message => message.type === 'request'));
  }
  const rejectedId = f.call();
  assert.equal((await f.phone.next(message => message.requestId === rejectedId)).error.code, 'BUSY');
  const busy = f.rows.find(row => row.event === 'request.busy');
  assert.equal(busy.pendingTotal, 16); assert.equal(busy.pendingMobile, 16); assert.equal(busy.mobileLimit, true); assert.equal(busy.globalLimit, false);
  assert.equal(busy.pending.mobile.oldest.length, 16); assert.equal(busy.pending.mobile.methods['thread.history'], 8);
  assert.equal(busy.pending.mobile.oldest.filter(item => item.view === 'prefetch').length, 8);
  const first = requests[0];
  f.host.socket.send(JSON.stringify({ type: 'response', transportId: first.transportId, result: { synthetic: true } }));
  await f.phone.next(message => message.requestId === first.requestId);
  const acceptedId = f.call();
  assert.equal((await f.host.next(message => message.requestId === acceptedId)).method, 'threads.list');
  const completed = f.rows.find(row => row.event === 'request.completed');
  assert.equal(completed.pendingTotal, 15); assert.equal(completed.delivered, true);
  assert.equal(completed.trace, f.rows.find(row => row.event === 'request.forwarded').trace);
  for (const value of [f.hostToken, f.mobileToken, first.params.threadId, first.requestId]) assert.equal(JSON.stringify(f.rows).includes(value), false);
});

test('超时、迟到回执和电脑断线均留下可关联记录，写操作仍保持结果未知语义', async t => {
  const f = await fixture(t, { requestTimeoutMs: 150 });
  const readId = f.call(), request = await f.host.next(message => message.type === 'request');
  assert.equal((await f.phone.next(message => message.requestId === readId)).error.code, 'REQUEST_TIMEOUT');
  const timeout = f.rows.find(row => row.event === 'request.timeout');
  assert.equal(timeout.pendingTotal, 0); assert.ok(timeout.elapsedMs >= 100);
  f.host.socket.send(JSON.stringify({ type: 'response', transportId: request.transportId, result: {} }));
  // 用同一连接的下一次正常回执作为顺序屏障，避免依赖固定睡眠。
  const nextId = f.call(), next = await f.host.next(message => message.requestId === nextId);
  f.host.socket.send(JSON.stringify({ type: 'response', transportId: next.transportId, result: {} }));
  await f.phone.next(message => message.requestId === nextId);
  assert.equal(f.rows.find(row => row.event === 'response.late').trace, timeout.trace);
  const writeId = f.call('turn.send', { threadId: 'synthetic-thread', text: '合成消息' });
  await f.host.next(message => message.requestId === writeId); f.host.socket.terminate();
  const response = await f.phone.next(message => message.requestId === writeId);
  assert.equal(response.error.outcomeUnknown, true);
  assert.equal(f.rows.find(row => row.event === 'request.cancelled').outcomeUnknown, true);
  assert.ok(f.rows.some(row => row.event === 'connection.close' && row.role === 'host'));
});

test('全局积压快照有界，保留全部方法计数而最多输出最早 16 条', () => {
  const rows = [], diagnostics = createRequestDiagnostics({ component: 'relay', write: line => rows.push(JSON.parse(line)) });
  const entries = Array.from({ length: 1024 }, () => ({ diagnostic: diagnostics.context({ method: 'threads.list', transportId: randomUUID() }) }));
  diagnostics.record('request.busy', diagnostics.context({ method: 'threads.list' }), { globalLimit: true }, { global: entries });
  assert.equal(rows[0].pending.global.count, 1024); assert.equal(rows[0].pending.global.methods['threads.list'], 1024);
  assert.equal(rows[0].pending.global.oldest.length, 16); assert.equal(rows[0].pending.global.truncated, true);
});

test('日志写入失败不会改变真实请求与回执', async t => {
  const diagnostics = createRequestDiagnostics({ component: 'relay', write() { throw new Error('合成输出故障'); } });
  const f = await fixture(t, { diagnostics }), id = f.call(), request = await f.host.next(message => message.requestId === id);
  f.host.socket.send(JSON.stringify({ type: 'response', transportId: request.transportId, result: { ok: true } }));
  assert.equal((await f.phone.next(message => message.requestId === id)).result.ok, true);
});

test('电脑端区分会话锁等待和实际执行，错误响应及早返回均完成计数', async () => {
  const rows = [], diagnostics = createRequestDiagnostics({ component: 'bridge', write: line => rows.push(JSON.parse(line)) });
  let unlock;
  const held = new Promise(resolve => { unlock = resolve; });
  const agent = Object.assign(Object.create(BridgeAgent.prototype), { diagnostics, diagnosticInFlight: 0,
    threadLocks: new Map([['synthetic-thread', held]]), deletingIds: new Set(),
    journal: { execute: async (_device, _id, _method, _params, execute) => execute() },
    adapter: { operate: async () => ({ ok: true }) } });
  const message = { v: 1, type: 'request', requestId: randomUUID(), transportId: randomUUID(), deviceId: 'synthetic-phone',
    method: 'turn.send', params: { threadId: 'synthetic-thread', text: '合成消息' } };
  const running = agent.handleRequest(message);
  assert.equal(agent.diagnosticInFlight, 1); assert.equal(rows.some(row => row.event === 'bridge.execute'), false);
  unlock(); assert.equal((await running).result.ok, true);
  assert.equal(rows.find(row => row.event === 'bridge.execute').lockQueued, true);
  assert.equal(rows.find(row => row.event === 'bridge.completed').trace, rows[0].trace);
  await agent.handleRequest({ ...message, method: 'unsupported' });
  assert.equal(agent.diagnosticInFlight, 0); assert.equal(rows.at(-1).failed, true);
});

test('实例路由尚未找到目标也记录电脑接收和失败，不能形成诊断盲区', async () => {
  const rows = [], diagnostics = createRequestDiagnostics({ component: 'bridge', write: line => rows.push(JSON.parse(line)) });
  const hub = Object.assign(Object.create(InstanceHub.prototype), { diagnostics, runtimes: new Map() });
  const response = await hub.request({ transportId: randomUUID(), hostId: 'synthetic-missing', method: 'threads.list' });
  assert.equal(response.error.code, 'INSTANCE_OFFLINE');
  assert.deepEqual(rows.map(row => row.event), ['bridge.received', 'bridge.completed']);
  assert.equal(rows[0].trace, rows[1].trace);
});

test('Windows 核验原因写入执行记录，原始管道、实例和异常内容不会进入日志', async t => {
  const rows = [], diagnostics = createRequestDiagnostics({ component: 'bridge', write: line => rows.push(JSON.parse(line)) });
  const id = 'synthetic-private-instance', nativePipe = 'synthetic-private-pipe', rawError = 'synthetic-private-error';
  const desktop = { pid: 101, startedAt: 1, nativePipe, soleIpc: true };
  const wrongPipeOwner = { ...desktop, soleIpc: false };
  const hub = Object.assign(Object.create(InstanceHub.prototype), { diagnostics, runtimes: new Map(), publish() {} });
  const journal = new Journal();
  const queue = new TaskQueue({
    journal,
    execute: ({ deviceId, commandId, payload }) => journal.execute(deviceId, commandId, payload.method, payload.params,
      () => hub.verifyWindowsInstance(hub.runtimes.get(id).instance)),
  });
  t.after(async () => { await queue.close(); journal.close(); });
  const cases = [
    ['SESSION_PIPE_TIMEOUT', 'Windows 会话管道探测超时', { rows: [wrongPipeOwner], windowsProbe: { sessionPipe: 'timeout' } }],
    ['SESSION_PIPE_OWNER_MISMATCH', 'Windows 会话管道归属不匹配', { rows: [wrongPipeOwner], windowsProbe: { sessionPipe: 'owner_mismatch' } }],
    ['TOOL_PIPE_TIMEOUT', 'Windows 工具管道探测超时', { rows: [], windowsProbe: { toolPipeTimeouts: [nativePipe] } }],
    ['DESKTOP_NOT_FOUND', '未找到所选 Windows 实例', { rows: [], windowsProbe: { toolPipeTimeouts: ['synthetic-other-pipe'] } }],
    ['INSTANCE_NOT_READY', 'Windows 实例未就绪', { rows: [desktop] }, { ready: false }],
    ['DISCOVERY_FAILED', 'Windows 实例扫描失败', new Error(rawError)],
    ['ROUTER_CLIENT_MISSING', 'Windows 实例未就绪，本机管道尚未连接', null, { directIpc: false, routerManaged: true, routerClientIds: () => new Set() }, 'router'],
    ['INSTANCE_NOT_READY', 'Windows 实例未就绪', null, { directIpc: false, ready: false }, 'bound'],
  ];
  for (const [reason, message, scan, state, mode = 'direct'] of cases) {
    const instance = { ...desktop, id, alive: true, ready: true, directIpc: true, ...state };
    hub.runtimes.set(id, { instance });
    hub.discover = async () => {
      if (scan instanceof Error) throw scan;
      assert.ok(scan, '非直连模式不启动额外扫描');
      return scan;
    };
    const taskId = randomUUID();
    queue.submit('synthetic-phone', { taskId, kind: 'command', payload: { method: 'turn.send', params: { threadId: 'synthetic-thread', text: '合成消息' } } });
    await queue.pump();
    await assert.rejects(queue.wait('synthetic-phone', taskId), { code: 'INSTANCE_NOT_READY', message });
    for (const view of ['active', 'history']) {
      const snapshot = queue.list('synthetic-phone', { view });
      const task = snapshot.tasks.find(row => row.id === taskId);
      assert.equal(snapshot.paused, true);
      assert.equal(task.state, 'failed');
      assert.equal(task.error, message);
    }
    assert.equal(instance.ready, false);
    const log = rows.at(-1);
    assert.equal(log.event, 'instance.verification_failed');
    assert.equal(log.reason, reason);
    assert.equal(log.mode, mode);
    assert.equal(log.errorCode, 'INSTANCE_NOT_READY');
    assert.ok(log.elapsedMs >= 0);
    queue.resume();
  }
  const ready = { ...desktop, id, alive: true, ready: true, directIpc: true };
  hub.runtimes.set(id, { instance: ready });
  hub.discover = async () => ({ rows: [desktop] });
  await hub.verifyWindowsInstance(ready);
  assert.equal(rows.length, cases.length);
  diagnostics.record('instance.verification_failed', null, { reason: rawError, mode: rawError });
  assert.equal(rows.at(-1).reason, 'OTHER');
  assert.equal(rows.at(-1).mode, undefined);
  for (const value of [id, nativePipe, rawError]) assert.equal(JSON.stringify(rows).includes(value), false);
});
