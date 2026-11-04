import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { NativeMessageQueue, evaluateNativeMessageQueue } from '../apps/bridge/native-message-queue.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

const threadId = 'synthetic-thread', deviceId = 'synthetic-phone';
const modules = { kind: 'esm', shared: 'synthetic-services.js', services: 'appServices' };
// 导出函数依赖私有错误白名单；复用源码中的声明，避免在测试中另写一份规则。
const hintsSource = readFileSync(new URL('../apps/bridge/native-message-queue.mjs', import.meta.url), 'utf8').match(/const hints = \{[\s\S]*?\n\};/u)?.[0];
assert.ok(hintsSource, '需要加载当前实现的原生错误白名单');
beforeEach(() => { globalThis.__codexMobileNativeQueueReceipts = new Map(); });
afterEach(() => { globalThis.__codexMobileNativeQueueReceipts.clear(); });

/** 只提供原生读取契约的展示字段，不伪造真实会话内容。 */
function row(extra = {}) {
  return { id: 'synthetic-native-one', text: '合成队列正文', imageCount: 0, attachmentCount: 0, state: 'queued', error: '', canEdit: true, canCancel: true, canSteer: true, ...extra };
}

/** 端口、页面和模块解析全部注入；任何真实进程发现或网络调用都立即失败。 */
function fixture(t) {
  const f = { calls: [], events: [], verifies: 0, rows: [row()], urls: ['synthetic-page-one', 'synthetic-page-two'] };
  f.instance = { pid: 101, port: 12345, startedAt: 'synthetic-start', generation: 'one', executable: '/example/desktop/Codex', alive: true,
    async verify() { f.verifies++; await f.onVerify?.(f.verifies); } };
  f.entry = { owner: { clientId: 'synthetic-owner', hostId: 'local' }, watchers: new Set([deviceId]), state: { id: threadId } };
  f.adapter = {
    client: { instance: f.instance, assertCurrent() { f.onAssertCurrent?.(); } },
    conversations: new Map([[threadId, f.entry]]),
    subscribed(thread, device) {
      assert.equal(thread, threadId); assert.equal(device, deviceId);
      const entry = f.adapter.conversations.get(thread);
      assert.ok(entry?.watchers.has(device), '只能操作仍已订阅的合成会话');
      return entry;
    },
    snapshot(state) { return { threadId: state.id }; },
    emit(type, snapshot) { f.events.push({ type, snapshot }); },
  };
  f.queue = new NativeMessageQueue({
    adapter: f.adapter,
    discover: async () => assert.fail('不得发现真实进程'),
    fetcher: async () => assert.fail('不得访问真实页面'),
    evaluate: async () => assert.fail('不得建立预测连接'),
    resolveModules(executable) { assert.equal(executable, '/example/desktop/Codex'); return modules; },
    async evaluateNative(url, expression, write = false) {
      f.calls.push({ url, expression, write });
      if (write) return f.onWrite ? f.onWrite(url, expression) : { ok: true, canceled: true };
      if (f.onRead) return f.onRead(url, expression);
      return { supported: true, messages: structuredClone(f.rows) };
    },
  });
  clearInterval(f.queue.queueTimer);
  f.queue.targets = async port => { assert.equal(port.pid, 101); assert.equal(port.port, 12345); return [...f.urls]; };
  t.after(() => f.queue.close());
  f.read = () => f.queue.refresh(threadId, deviceId, { force: true });
  f.operate = (action = 'cancel', params = {}, message) => f.queue.operate(action, { threadId, queueId: f.queue.snapshot(threadId).queuedMessages?.[0]?.id, ...params }, 'synthetic-command', deviceId, message);
  return f;
}

test('首帧读取隐藏原生编号、标记桌面来源，快照不能反向修改缓存', async t => {
  const f = fixture(t); f.rows[0].source = 'untrusted-source';
  assert.equal(await f.read(), true);
  const snapshot = f.queue.snapshot(threadId), publicRow = snapshot.queuedMessages[0];
  assert.equal(snapshot.supportsNativeMessageQueue, true);
  assert.match(publicRow.id, /^desktop-[0-9a-f]{48}$/);
  assert.equal(publicRow.source, 'desktop'); assert.equal('nativeId' in publicRow, false);
  assert.equal(JSON.stringify(snapshot).includes('synthetic-native-one'), false);
  publicRow.text = '合成快照修改';
  assert.equal(f.queue.snapshot(threadId).queuedMessages[0].text, '合成队列正文');
  assert.deepEqual(f.events, [{ type: 'conversation', snapshot: { threadId } }]);
  await f.read(); assert.equal(f.events.length, 1);
  f.rows[0].text = '合成 PC 更新'; await f.read(); assert.equal(f.events.length, 2);
});

test('并发首帧刷新共用请求，结束后清理进行中的读取', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.onRead = async () => { entered.resolve(); await release.promise; return { supported: true, messages: f.rows }; };
  const first = f.read(); await entered.promise;
  const second = f.read(); release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.calls.length, 1); assert.equal(f.queue.reads.size, 0);
});

test('读取可跳过不支持页面，后续优先复用已核验页面', async t => {
  const f = fixture(t);
  f.onRead = async url => {
    if (url === 'synthetic-page-one') throw Error('合成页面不兼容');
    return { supported: true, messages: f.rows };
  };
  assert.equal(await f.read(), true); assert.equal(await f.read(), true);
  assert.deepEqual(f.calls.map(call => call.url), ['synthetic-page-one', 'synthetic-page-two', 'synthetic-page-two']);
  assert.ok(f.calls.every(call => !call.write));
});

test('读取中 owner、订阅或实例身份改变时不接受旧页面结果', async t => {
  const changes = [
    ['owner客户端', f => { f.entry.owner.clientId = 'synthetic-other-owner'; }],
    ['owner主机', f => { f.entry.owner.hostId = 'durable'; }],
    ['订阅对象', f => { f.adapter.conversations.set(threadId, { ...f.entry }); }],
    ['实例代次', f => { f.instance.generation = 'two'; }],
    ['实例端口', f => { f.instance.port = 12346; }],
    ['实例进程', f => { f.instance.pid = 202; }],
    ['实例退出', f => { f.instance.alive = false; }],
  ];
  for (const [label, change] of changes) await t.test(label, async sub => {
    const f = fixture(sub);
    f.onRead = async () => { change(f); return { supported: true, messages: f.rows }; };
    assert.equal(await f.read(), false);
    assert.deepEqual(f.queue.snapshot(threadId), {}); assert.equal(f.events.length, 0);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].write, false);
  });
});

test('读取期间替换整个实例对象必须拒绝旧实例结果', async t => {
  const f = fixture(t);
  f.onRead = async () => {
    f.adapter.client.instance = { ...f.instance, pid: 202, port: 12346, generation: 'two' };
    return { supported: true, messages: f.rows };
  };
  assert.equal(await f.read(), false, '不能继续用闭包中未变化的旧实例通过身份核对');
  assert.deepEqual(f.queue.snapshot(threadId), {});
});

test('无调试端口不扫描不写入，读取失败保留旧展示并禁用能力', async t => {
  const f = fixture(t); assert.equal(await f.read(), true);
  f.instance.port = null;
  assert.equal(await f.read(), false);
  const snapshot = f.queue.snapshot(threadId), value = snapshot.queuedMessages[0];
  assert.equal(snapshot.supportsNativeMessageQueue, false); assert.equal(value.text, '合成队列正文');
  assert.equal(value.canEdit, false); assert.equal(value.canCancel, false); assert.equal(value.canSteer, false);
  await assert.rejects(f.operate(), { code: 'NATIVE_QUEUE_UNAVAILABLE' });
  assert.equal(f.calls.length, 1);
});

test('操作前复核 owner 和实例，变化时不能向页面写入', async t => {
  for (const change of ['owner', 'instance']) await t.test(change, async sub => {
    const f = fixture(sub); await f.read(); f.verifies = 0;
    f.onVerify = count => {
      if (count !== 2) return;
      if (change === 'owner') f.entry.owner.clientId = 'synthetic-other-owner';
      else f.instance.generation = 'two';
    };
    await assert.rejects(f.operate(), { code: 'NATIVE_QUEUE_CHANGED' });
    assert.equal(f.calls.filter(call => call.write).length, 0);
  });
});

test('写入前整个实例被替换时必须拒绝，不能沿用旧页面绑定', async t => {
  const f = fixture(t); await f.read(); f.verifies = 0;
  f.onVerify = count => {
    if (count === 2) f.adapter.client.instance = { ...f.instance, pid: 202, port: 12346, generation: 'two' };
  };
  await assert.rejects(f.operate(), { code: 'NATIVE_QUEUE_CHANGED' });
  assert.equal(f.calls.filter(call => call.write).length, 0);
});

test('未知和发送中消息即使有公开编号也禁止编辑取消和追加', async t => {
  for (const state of ['unknown', 'sending']) await t.test(state, async sub => {
    const f = fixture(sub); f.rows = [row({ state, canEdit: false, canCancel: false, canSteer: false })];
    await f.read();
    for (const action of ['edit', 'cancel', 'steer']) await assert.rejects(f.operate(action, { expectedTurnId: 'synthetic-turn' }), { code: 'NATIVE_QUEUE_CHANGED' });
    assert.equal(f.calls.filter(call => call.write).length, 0);
  });
});

test('写操作只把公开编号映射回绑定的原生编号并携带预期轮次', async t => {
  const f = fixture(t); await f.read();
  f.onWrite = async (_url, expression) => {
    assert.ok(expression.endsWith(',"steer",' + JSON.stringify({ hostId: 'local', threadId, id: 'synthetic-native-one', expectedTurnId: 'synthetic-turn', commandId: 'synthetic-command' }) + ')})()'));
    f.rows = []; return { ok: true, queued: false };
  };
  assert.deepEqual(await f.operate('steer', { expectedTurnId: 'synthetic-turn' }), { ok: true, queued: false });
  assert.equal(f.calls.filter(call => call.write).length, 1);
  assert.deepEqual(f.queue.snapshot(threadId).queuedMessages, []);
});

test('入队回执映射为公开编号，编辑草稿仅返回原生明确回执', async t => {
  const f = fixture(t);
  f.onWrite = async () => ({ ok: true, queued: true, nativeId: 'synthetic-native-new' });
  const result = await f.operate('enqueue', {}, { id: 'synthetic-mobile-new', text: '合成入队', context: { prompt: '合成入队' } });
  assert.match(result.queueId, /^desktop-[0-9a-f]{48}$/); assert.equal('nativeId' in result, false);
  const draft = { text: '合成原生撤回正文', images: [], attachments: [] };
  f.onWrite = async () => ({ ok: true, edited: true, draft });
  assert.deepEqual(await f.operate('edit'), { ok: true, edited: true, draft });
});

test('写入超时保持结果未知，不向其他页面重试或自动重放', async t => {
  const f = fixture(t); await f.read();
  f.onWrite = async () => { throw new BridgeError('OUTCOME_UNKNOWN', '合成写入超时', true); };
  await assert.rejects(f.operate(), error => error.code === 'OUTCOME_UNKNOWN' && error.outcomeUnknown === true);
  await f.read(); await f.read();
  assert.deepEqual(f.calls.filter(call => call.write).map(call => call.url), ['synthetic-page-one']);
  assert.equal(f.queue.snapshot(threadId).queuedMessages.length, 1);
});

test('写后 owner 或实例失效仅报告未知结果，不能宣称明确成功', async t => {
  for (const change of ['owner', 'instance']) await t.test(change, async sub => {
    const f = fixture(sub); await f.read();
    f.onWrite = async () => {
      if (change === 'owner') f.entry.owner.clientId = 'synthetic-other-owner';
      else f.instance.alive = false;
      return { ok: true, canceled: true };
    };
    await assert.rejects(f.operate(), error => error.code === 'OUTCOME_UNKNOWN' && error.outcomeUnknown === true);
    assert.equal(f.calls.filter(call => call.write).length, 1);
  });
});

test('页面未明确确认写入成功时报告未知结果且不换页', async t => {
  const f = fixture(t); await f.read(); f.onWrite = async () => ({ ok: false });
  await assert.rejects(f.operate(), error => error.code === 'OUTCOME_UNKNOWN' && error.outcomeUnknown === true);
  assert.equal(f.calls.filter(call => call.write).length, 1);
});

test('后台轮询仅保留详情观察者，清理缓存和关闭后不再读取', async t => {
  const f = fixture(t); await f.read();
  f.entry.watchers = new Set([Symbol('合成缓存跟随'), 'list-status', 'conversation-cache', 'message-queue', 'status:synthetic', 'submission:synthetic']);
  f.queue.poll(); assert.deepEqual(f.queue.snapshot(threadId), {});
  f.entry.watchers.add(deviceId); await f.read(); f.queue.forget(threadId);
  assert.deepEqual(f.queue.snapshot(threadId), {});
  f.queue.close(); assert.equal(await f.read(), false);
  assert.equal(f.calls.length, 2);
});

/** 原样执行导出函数源码，仅替换词法依赖为内存 WebSocket 和可控时钟，完全不联网。 */
function cdpFixture(t, respond) {
  const received = Promise.withResolvers(), timers = new Map();
  const f = { url: 'ws://example.com/synthetic-page', received: received.promise, requests: [], terminations: 0 };
  class SyntheticWebSocket extends EventEmitter {
    constructor(url, options) {
      super(); assert.equal(url, f.url); f.options = options;
      queueMicrotask(() => this.emit('open'));
    }
    send(data) {
      const request = JSON.parse(data); f.requests.push(request); received.resolve(request);
      respond?.({ send: value => this.emit('message', Buffer.from(value)), terminate: () => this.emit('close') }, request);
    }
    terminate() { f.terminations++; queueMicrotask(() => this.emit('close')); }
  }
  const evaluate = vm.runInNewContext(hintsSource + '\n(' + evaluateNativeMessageQueue.toString() + ')', {
    WebSocket: SyntheticWebSocket, BridgeError,
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  f.evaluate = (write = false) => evaluate(f.url, 'synthetic-expression', write);
  f.tick = elapsed => { for (const [id, timer] of [...timers]) if (timer.delay <= elapsed) { timers.delete(id); timer.callback(); } };
  t.after(() => { assert.equal(timers.size, 0, '所有传输定时器必须释放'); });
  return f;
}

test('原生传输等待 Promise 并返回明确值，忽略无关编号及非 JSON 帧', async t => {
  const f = await cdpFixture(t, (socket, request) => {
    socket.send('合成非JSON帧');
    socket.send(JSON.stringify({ id: 2, result: { result: { value: '合成无关结果' } } }));
    socket.send(JSON.stringify({ id: request.id, result: { result: { value: { supported: true, messages: [] } } } }));
  });
  assert.equal(JSON.stringify(await f.evaluate()), JSON.stringify({ supported: true, messages: [] }));
  const request = await f.received;
  assert.deepEqual(request, { id: 1, method: 'Runtime.evaluate', params: { expression: 'synthetic-expression', returnByValue: true, awaitPromise: true, timeout: 8000 } });
  assert.equal(f.options.handshakeTimeout, 2000); assert.equal(f.options.perMessageDeflate, false);
  assert.equal(f.terminations, 1);
});

test('原生传输只公开白名单错误，不泄漏原始路径与异常正文', async t => {
  const f = await cdpFixture(t, (socket, request) => {
    socket.send(JSON.stringify({ id: request.id, result: { exceptionDetails: { exception: { description: 'Error: NATIVE_QUEUE_TURN_CHANGED\n    at /example/private/internal.js:10' } } } }));
  });
  await assert.rejects(f.evaluate(true), error => {
    assert.equal(error.code, 'NATIVE_QUEUE_TURN_CHANGED');
    assert.equal(error.message.includes('/example/private'), false);
    assert.equal(error.outcomeUnknown, false); return true;
  });
});

test('未知原生异常不能借正文中的错误名伪装白名单回执', async t => {
  const f = await cdpFixture(t, (socket, request) => {
    socket.send(JSON.stringify({ id: request.id, result: { exceptionDetails: { exception: { description: 'Error: 合成正文含 NATIVE_QUEUE_CHANGED 及 /example/private/internal.js' } } } }));
  });
  await assert.rejects(f.evaluate(true), error => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN'); assert.equal(error.outcomeUnknown, true);
    assert.equal(error.message.includes('/example/private'), false); return true;
  });
});

test('连接中断时读操作报不可用，写操作保留结果未知', async t => {
  for (const write of [false, true]) await t.test(write ? '写操作' : '读操作', async sub => {
    const f = await cdpFixture(sub, socket => socket.terminate());
    await assert.rejects(f.evaluate(write), error => error.code === (write ? 'OUTCOME_UNKNOWN' : 'NATIVE_QUEUE_UNAVAILABLE') && error.outcomeUnknown === write);
  });
});

test('原生写超时由模拟时钟触发，单个页面只收到一次请求', async t => {
  let requests = 0;
  const f = await cdpFixture(t, () => { requests++; });
  const pending = assert.rejects(f.evaluate(true), error => error.code === 'OUTCOME_UNKNOWN' && error.outcomeUnknown === true);
  await f.received;
  f.tick(8999); assert.equal(f.terminations, 0);
  f.tick(9000);
  await pending;
  assert.equal(requests, 1);
});
