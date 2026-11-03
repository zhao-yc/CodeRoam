import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';
import { encodeFrame, FrameDecoder, IpcClient } from '../packages/protocol/ipc-client.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { WindowsIpcRouter } from '../apps/bridge/windows-ipc-router.mjs';

/** 用真实双工流模拟两个管道端，不打开 Windows 全局管道。 */
function attach(router, pid, startedAt = 100) {
  const fromPeer = new PassThrough();
  const toPeer = new PassThrough();
  const socket = Duplex.from({ readable: fromPeer, writable: toPeer });
  const messages = [];
  const events = new EventEmitter();
  const decoder = new FrameDecoder(message => { messages.push(message); events.emit('frame'); });
  toPeer.on('data', chunk => decoder.push(chunk));
  router.accept(socket, { pid, startedAt });
  return {
    socket, messages,
    send: message => fromPeer.write(encodeFrame(message)),
    write: chunk => fromPeer.write(chunk),
    async take(predicate) {
      const signal = AbortSignal.timeout(1000);
      let index;
      while ((index = messages.findIndex(predicate)) < 0) await once(events, 'frame', { signal });
      return messages.splice(index, 1)[0];
    },
  };
}

async function initialize(peer, requestId = 'init') {
  peer.send({ type: 'request', requestId, method: 'initialize', version: 0, params: { clientType: 'codex-test', pid: 999, startedAt: 999 } });
  const response = await peer.take(message => message.type === 'response' && message.requestId === requestId);
  assert.equal(response.resultType, 'success');
  assert.equal(response.method, 'initialize');
  assert.equal(response.handledByClientId, response.result.clientId);
  return response.result.clientId;
}

const request = (peer, requestId, targetClientId, extra = {}) => peer.send({
  type: 'request', requestId, method: 'thread-owner-discovery', version: 1, params: { conversationId: 'synthetic-chat' }, targetClientId, ...extra,
});
const probe = peer => peer.take(message => message.type === 'client-discovery-request');
const answer = (peer, id, canHandle) => peer.send({ type: 'client-discovery-response', requestId: id, response: { canHandle } });
const response = (peer, id) => peer.take(message => message.type === 'response' && message.requestId === id);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('按宿主核验的进程启动时间绑定多个客户端，同 PID 旧身份不能复用', async t => {
  const router = new WindowsIpcRouter();
  t.after(() => router.close());
  const observed = [];
  router.on('clientsChanged', identity => observed.push(identity));
  const first = attach(router, 20), another = attach(router, 20), reused = attach(router, 20, 101);
  assert.deepEqual(router.clientIds({ pid: 20, startedAt: 100 }), new Set());
  const ids = [await initialize(first), await initialize(another)];
  assert.equal(await initialize(first, 'repeat-init'), ids[0]);
  const newId = await initialize(reused);
  assert.deepEqual(router.clientIds({ pid: 20, startedAt: 100 }), new Set(ids));
  assert.deepEqual(router.clientIds({ pid: 20, startedAt: 101 }), new Set([newId]));
  assert.deepEqual(router.clientIds({ pid: 999, startedAt: 999 }), new Set());
  const closed = new Promise(resolve => first.socket.once('close', resolve));
  first.socket.destroy();
  await closed;
  assert.deepEqual(router.clientIds({ pid: 20, startedAt: 100 }), new Set([ids[1]]));
  assert.deepEqual(observed, [{ pid: 20, startedAt: 100 }, { pid: 20, startedAt: 100 }, { pid: 20, startedAt: 101 }, { pid: 20, startedAt: 100 }]);
  router.close();
  assert.equal(router.ready, false);
  assert.deepEqual(router.clientIds({ pid: 20, startedAt: 101 }), new Set());
});

test('定向请求隔离其他实例，发现和回复只接受实际目标连接', async t => {
  const router = new WindowsIpcRouter();
  t.after(() => router.close());
  const caller = attach(router, 10), target = attach(router, 20), third = attach(router, 30);
  const callerId = await initialize(caller), targetId = await initialize(target), thirdId = await initialize(third);
  request(caller, 'caller-request', targetId, { sourceClientId: thirdId });
  const discovery = await probe(target);
  assert.equal(discovery.request.sourceClientId, callerId);
  assert.equal(discovery.request.targetClientId, targetId);
  answer(third, discovery.requestId, true);
  await flush();
  assert.equal(target.messages.some(message => message.type === 'request'), false);
  assert.equal(third.messages.some(message => message.type === 'client-discovery-request'), false);
  answer(target, discovery.requestId, true);
  const forwarded = await target.take(message => message.type === 'request');
  assert.notEqual(forwarded.requestId, 'caller-request');
  assert.deepEqual(forwarded.params, { conversationId: 'synthetic-chat' });
  third.send({ type: 'response', requestId: forwarded.requestId, resultType: 'success', handledByClientId: targetId, result: { forged: true } });
  await flush();
  assert.equal(caller.messages.some(message => message.requestId === 'caller-request'), false);
  target.send({ type: 'response', requestId: forwarded.requestId, resultType: 'success', handledByClientId: thirdId, result: { accepted: true } });
  const reply = await response(caller, 'caller-request');
  assert.equal(reply.handledByClientId, targetId);
  assert.equal(reply.sourceClientId, targetId);
  assert.deepEqual(reply.result, { accepted: true });
});

test('全局发现以第一个确认的候选为目标，断开候选后其余候选仍可确认', async t => {
  const router = new WindowsIpcRouter();
  t.after(() => router.close());
  const caller = attach(router, 10), lost = attach(router, 20), target = attach(router, 30);
  await initialize(caller); await initialize(lost); const targetId = await initialize(target);
  request(caller, 'global-request');
  const discovery = await probe(target);
  await probe(lost);
  lost.socket.destroy();
  answer(target, discovery.requestId, true);
  const forwarded = await target.take(message => message.type === 'request');
  target.send({ type: 'response', requestId: forwarded.requestId, resultType: 'success', result: {} });
  assert.equal((await response(caller, 'global-request')).handledByClientId, targetId);
  request(caller, 'negative-discovery');
  answer(target, (await probe(target)).requestId, false);
  assert.equal((await response(caller, 'negative-discovery')).error, 'no-client-found');
});

test('路由保留广播目标范围，重写来源并拒绝客户端伪造断线通知', async t => {
  const router = new WindowsIpcRouter();
  t.after(() => router.close());
  const caller = attach(router, 10), target = attach(router, 20), third = attach(router, 30);
  const callerId = await initialize(caller), targetId = await initialize(target), thirdId = await initialize(third);
  const message = { type: 'broadcast', sourceClientId: thirdId, method: 'thread-read-state-changed', version: 3, targetClientIds: [targetId], params: { threadId: 'synthetic-chat' } };
  // 验证同一消息经过半包拼接后仍然保留原协议参数。
  const frame = encodeFrame(message);
  caller.write(frame.subarray(0, 2));
  caller.write(frame.subarray(2));
  const delivered = await target.take(item => item.method === message.method);
  assert.deepEqual(delivered, { ...message, sourceClientId: callerId });
  caller.send({ type: 'broadcast', method: 'client-status-changed', params: { clientId: thirdId, status: 'disconnected' } });
  await flush();
  assert.equal(third.messages.some(item => item.method === message.method), false);
  assert.equal(target.messages.some(item => item.params?.status === 'disconnected'), false);
  third.socket.destroy();
  const status = await target.take(item => item.method === 'client-status-changed' && item.params.status === 'disconnected');
  assert.equal(status.sourceClientId, thirdId);
  assert.equal(status.params.clientId, thirdId);
  assert.equal(status.version, 0);
});

test('超时、已知目标断开和损坏帧分别收口，不影响其他连接', async t => {
  const router = new WindowsIpcRouter({ discoveryTimeoutMs: 100, requestTimeoutMs: 100, maxFrameBytes: 2048 });
  t.after(() => router.close());
  const caller = attach(router, 10), target = attach(router, 20), invalid = attach(router, 30);
  await initialize(caller); const targetId = await initialize(target); await initialize(invalid);
  request(caller, 'discovery-timeout', targetId);
  const expired = await probe(target);
  assert.equal((await response(caller, 'discovery-timeout')).error, 'no-client-found');
  answer(target, expired.requestId, true);
  request(caller, 'request-timeout', targetId);
  answer(target, (await probe(target)).requestId, true);
  await target.take(message => message.type === 'request');
  assert.equal((await response(caller, 'request-timeout')).error, 'request-timeout');
  request(caller, 'connection-lost', targetId);
  answer(target, (await probe(target)).requestId, true);
  await target.take(message => message.type === 'request');
  target.socket.destroy();
  assert.equal((await response(caller, 'connection-lost')).error, 'request-timeout');
  const invalidId = [...router.clientIds({ pid: 30, startedAt: 100 })][0];
  request(caller, 'not-dispatched', invalidId);
  await probe(invalid);
  const invalidClosed = new Promise(resolve => invalid.socket.once('close', resolve));
  const badHeader = Buffer.alloc(4);
  badHeader.writeUInt32LE(2049);
  invalid.write(badHeader);
  await invalidClosed;
  assert.equal((await response(caller, 'not-dispatched')).error, 'no-client-found');
  assert.deepEqual(router.clientIds({ pid: 30, startedAt: 100 }), new Set());
  assert.deepEqual(router.clientIds({ pid: 10, startedAt: 100 }).size, 1);
});

test('未初始化的连接不进入发现清单，超时后释放连接', async t => {
  const router = new WindowsIpcRouter({ initializeTimeoutMs: 75 });
  t.after(() => router.close());
  const caller = attach(router, 10), idle = attach(router, 20);
  const idleClosed = new Promise(resolve => idle.socket.once('close', resolve));
  await initialize(caller);
  idle.send({ type: 'broadcast', method: 'thread-read-state-changed', params: {} });
  request(caller, 'no-ready-client');
  assert.equal((await response(caller, 'no-ready-client')).error, 'no-client-found');
  await idleClosed;
  assert.equal(caller.messages.some(message => message.method === 'thread-read-state-changed'), false);
  assert.deepEqual(router.clientIds({ pid: 20, startedAt: 100 }), new Set());
});

test('已派发操作断线时，原客户端和账本保留结果未知', async t => {
  const router = new WindowsIpcRouter(), journal = new Journal();
  t.after(() => { router.close(); journal.close(); });
  const caller = attach(router, 10), target = attach(router, 20);
  const client = new IpcClient();
  client.clientId = await initialize(caller);
  client.socket = { writable: true, write: caller.write };
  const targetClientId = await initialize(target);
  const params = { threadId: 'synthetic-chat' };
  const executing = journal.execute('synthetic-phone', 'synthetic-command', 'turn.send', params,
    () => client.request('thread-follower-start-turn', params, 2, { targetClientId }));
  const rejected = assert.rejects(executing, error => error.code === 'OUTCOME_UNKNOWN' && error.outcomeUnknown === true);
  const discovery = await probe(target);
  answer(target, discovery.requestId, true);
  await target.take(message => message.type === 'request');
  target.socket.destroy();
  client.handleMessage(await response(caller, discovery.request.requestId));
  await rejected;
  assert.equal(journal.status('synthetic-phone', 'synthetic-command').state, 'unknown');
});
