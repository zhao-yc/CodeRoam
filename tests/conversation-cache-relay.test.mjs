import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelay } from '../apps/relay/server.mjs';
import { tokenHash, validateRequest } from '../packages/protocol/contracts.mjs';

const revision = 'content:' + '1'.repeat(64);
const watching = (subscriptionId = randomUUID(), threadId = 'synthetic-chat') => ({ subscriptionId, threads: [{ threadId, revision: '' }] });
const envelope = (method, params, hostId = 'computer') => ({ v: 1, type: 'request', requestId: randomUUID(), method, params, hostId });

test('缓存订阅校验会话数量、唯一编号、版本和字段白名单', () => {
  const valid = watching();
  assert.doesNotThrow(() => validateRequest(envelope('threads.cache.watch', valid)));
  assert.doesNotThrow(() => validateRequest(envelope('threads.cache.watch', { ...valid, threads: [], verify: ['cached-chat'] })));
  for (const invalid of [
    { ...valid, subscriptionId: 'invalid' },
    { ...valid, threads: [] },
    { ...valid, threads: Array.from({ length: 21 }, (_, index) => ({ threadId: String(index), revision })) },
    { ...valid, threads: [...valid.threads, ...valid.threads] },
    { ...valid, threads: [{ ...valid.threads[0], revision: 'saved:123' }] },
    { ...valid, threads: [{ ...valid.threads[0], text: '合成正文' }] },
    { ...valid, verify: ['cached-chat', 'cached-chat'] },
    { ...valid, verify: Array.from({ length: 21 }, (_, index) => String(index)) },
    { ...valid, verify: [{ threadId: 'cached-chat' }] },
  ]) assert.throws(() => validateRequest(envelope('threads.cache.watch', invalid)), { code: 'BAD_PARAMS' });
  assert.throws(() => validateRequest(envelope('threads.cache.unwatch', valid)), { code: 'BAD_PARAMS' });
  assert.doesNotThrow(() => validateRequest(envelope('thread.watch', { threadId: 'synthetic-chat', contentRevision: revision })));
  assert.throws(() => validateRequest(envelope('thread.history', { threadId: 'synthetic-chat', contentRevision: revision })), { code: 'BAD_PARAMS' });
});

/** 各连接保存合成消息，测试通过后续同源帧确认无泄漏，不依赖固定延时。 */
function inbox(socket) {
  const all = [], queued = [], waiting = [];
  socket.on('error', () => {});
  socket.on('message', bytes => {
    const message = JSON.parse(bytes); all.push(message);
    const index = waiting.findIndex(entry => entry.match(message));
    if (index < 0) queued.push(message);
    else {
      const [entry] = waiting.splice(index, 1);
      clearTimeout(entry.timer); entry.resolve(message);
    }
  });
  const next = match => {
    const index = queued.findIndex(match);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { match, resolve, timer: setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); reject(new Error('等待合成中转消息超时')); }, 2500) };
      waiting.push(entry);
    });
  };
  return { socket, all, next, send: value => socket.send(JSON.stringify(value)), events: () => all.filter(message => message.type === 'thread.cache.event') };
}

async function fixture(t, options = {}) {
  const labels = ['computer', 'other', 'phone', 'outsider'];
  const tokens = Object.fromEntries(labels.map(label => [label, randomBytes(32).toString('base64url')]));
  const identities = labels.map((id, index) => ({ id, tokenSha256: tokenHash(tokens[id]), ...(index < 2 ? { role: 'host', hostId: id } : { role: 'mobile', hostIds: [id === 'phone' ? 'computer' : 'other'] }) }));
  const relay = createRelay({ identities, ...options });
  const address = await relay.listen(); t.after(() => relay.close());
  const connect = async id => {
    const connection = inbox(new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: `Bearer ${tokens[id]}` } }));
    connection.welcome = await connection.next(message => message.type === 'welcome');
    return connection;
  };
  const host = await connect('computer'), phone = await connect('phone');
  const sendWatch = async (connection, params, hostId) => {
    const request = envelope('threads.cache.watch', params, hostId);
    connection.send(request);
    return host.next(message => message.requestId === request.requestId);
  };
  const response = (connection, request) => connection.next(message => message.type === 'response' && message.requestId === request.requestId);
  const reply = (request, result = { ok: true }, error) => host.send({ v: 1, type: 'response', hostId: request.hostId, generation: request.generation, transportId: request.transportId, result, error });
  const release = subscriptionId => host.next(message => message.method === 'threads.cache.unwatch' && message.params.subscriptionId === subscriptionId);
  const publish = (request, extra = {}, sender = host) => {
    const threadId = extra.threadId ?? request.params.threads[0]?.threadId;
    sender.send({ v: 1, type: 'thread.cache.event', hostId: request.hostId, generation: request.generation, deviceId: request.deviceId, subscriptionId: request.params.subscriptionId,
      threadId, revision, snapshot: { threadId, title: '合成聊天', cwd: '', messages: [], turns: [] }, ...extra });
  };
  return { host, phone, connect, sendWatch, response, reply, release, publish, identities };
}

test('缓存正文按实例、设备、订阅和会话定向转发，允许回执前推送', async t => {
  const f = await fixture(t), sibling = await f.connect('phone'), outside = await f.connect('outsider'), other = await f.connect('other');
  assert.equal(f.phone.welcome.capabilities.conversationCache, true);
  const child = 'computer~' + randomUUID(), generation = randomUUID();
  f.host.send({ type: 'host.instances', instances: [{ id: child, generation, label: '合成实例', online: true }] });
  await f.phone.next(message => message.type === 'hosts' && message.hosts.some(row => row.id === child && row.online));
  const params = watching(), one = await f.sendWatch(f.phone, params, child), two = await f.sendWatch(sibling, params, child);
  assert.notEqual(one.params.subscriptionId, two.params.subscriptionId);
  assert.notEqual(one.params.subscriptionId, params.subscriptionId);
  const unrelated = 'different-chat';
  f.publish(one, { deviceId: 'outsider' });
  f.publish(one, { threadId: unrelated, snapshot: { threadId: unrelated, messages: [], turns: [] } });
  f.publish(one, { generation: randomUUID() });
  f.publish(one, { hostId: 'other' }, other);
  f.publish(one);
  const frame = await f.phone.next(message => message.type === 'thread.cache.event');
  assert.equal(frame.hostId, child);
  assert.equal(frame.generation, generation);
  assert.equal(frame.subscriptionId, params.subscriptionId);
  assert.equal(frame.deviceId, undefined);
  f.reply(one, { ok: true, ignored: '额外字段' }); f.reply(two);
  assert.deepEqual((await f.response(f.phone, one)).result, { ok: true });
  assert.deepEqual((await f.response(sibling, two)).result, { ok: true });
  assert.equal(f.phone.events().length, 1);
  assert.equal(sibling.events().length, 0);
  assert.equal(outside.events().length, 0);
  const threadId = params.threads[0].threadId, nextRevision = 'content:' + '2'.repeat(64);
  f.publish(one, { snapshot: undefined, baseRevision: revision, revision: nextRevision, update: { threadId, order: [], upserts: [], appends: [] } });
  const delta = await f.phone.next(message => message.type === 'thread.cache.event');
  assert.equal(delta.baseRevision, revision);
  assert.equal(delta.revision, nextRevision);
  f.publish(one, { snapshot: undefined, revision: '', removed: true });
  assert.equal((await f.phone.next(message => message.type === 'thread.cache.event')).removed, true);
  f.host.send({ type: 'host.instances', instances: [{ id: child, generation: randomUUID(), label: '合成实例', online: true }] });
  await f.phone.next(message => message.type === 'hosts' && message.hosts.some(row => row.id === child && row.instanceGeneration !== generation));
  f.publish(one);
  f.host.send({ type: 'host.ready', label: '合成换代屏障' });
  await f.phone.next(message => message.type === 'hosts' && message.hosts.some(row => row.label === '合成换代屏障'));
  assert.equal(f.phone.events().length, 3);
});

test('替换、显式退订、权限撤销及手机断线只释放对应上游观察', async t => {
  const f = await fixture(t), first = watching(), second = watching();
  const one = await f.sendWatch(f.phone, first), two = await f.sendWatch(f.phone, second);
  await f.release(one.params.subscriptionId);
  f.publish(one); f.reply(one);
  assert.equal((await f.response(f.phone, one)).error.code, 'SUBSCRIPTION_CANCELED');
  const staleUnwatch = envelope('threads.cache.unwatch', { subscriptionId: first.subscriptionId });
  f.phone.send(staleUnwatch);
  assert.deepEqual((await f.response(f.phone, staleUnwatch)).result, { ok: true });
  f.publish(two); f.reply(two);
  assert.equal((await f.phone.next(message => message.type === 'thread.cache.event')).subscriptionId, second.subscriptionId);
  await f.response(f.phone, two);
  assert.equal(f.phone.events().length, 1);
  f.identities.find(identity => identity.id === 'phone').hostIds = [];
  f.publish(two); await f.release(two.params.subscriptionId);
  const ping = envelope('ping', {}); f.phone.send(ping); await f.response(f.phone, ping);
  assert.equal(f.phone.events().length, 1);
  f.identities.find(identity => identity.id === 'phone').hostIds = ['computer'];
  const three = await f.sendWatch(f.phone, watching());
  f.phone.socket.close(); await f.release(three.params.subscriptionId);
});

test('离开热门窗口的本机缓存只接收移除通知，不能接收快照或增量', async t => {
  const f = await fixture(t), threadId = 'previously-cached-chat';
  const request = await f.sendWatch(f.phone, { subscriptionId: randomUUID(), threads: [], verify: [threadId] });
  assert.deepEqual(request.params.verify, [threadId]);
  f.publish(request, { threadId });
  f.publish(request, { threadId, snapshot: undefined, baseRevision: 'content:' + '2'.repeat(64), update: { threadId, order: [], upserts: [], appends: [] } });
  f.publish(request, { threadId: 'unrequested-chat', revision: '', snapshot: undefined, removed: true });
  f.publish(request, { threadId, revision: '', snapshot: undefined, removed: true });
  f.reply(request);
  assert.deepEqual((await f.response(f.phone, request)).result, { ok: true });
  assert.deepEqual(f.phone.events().map(message => ({ threadId: message.threadId, removed: message.removed })), [{ threadId, removed: true }]);
});

test('旧守护进程失败或超时后，释放缓存路由并保留可识别的降级错误', async t => {
  const f = await fixture(t, { requestTimeoutMs: 150 });
  const first = await f.sendWatch(f.phone, watching());
  f.reply(first, null, { code: 'METHOD_NOT_ALLOWED', message: '合成旧版本' });
  assert.equal((await f.response(f.phone, first)).error.code, 'METHOD_NOT_ALLOWED');
  await f.release(first.params.subscriptionId);
  const second = await f.sendWatch(f.phone, watching());
  assert.equal((await f.response(f.phone, second)).error.code, 'REQUEST_TIMEOUT');
  await f.release(second.params.subscriptionId);
  f.publish(second);
  f.host.send({ type: 'host.ready', label: '合成超时屏障' });
  await f.phone.next(message => message.type === 'hosts' && message.hosts.some(row => row.label === '合成超时屏障'));
  assert.equal(f.phone.events().length, 0);
});

test('压缩回执只替代发起该请求的标签页事件，其他详情订阅仍收到同一序列', async t => {
  const f = await fixture(t), sibling = await f.connect('phone'), threadId = 'synthetic-chat';
  const regular = envelope('thread.watch', { threadId }); sibling.send(regular);
  const first = await f.host.next(message => message.requestId === regular.requestId);
  f.reply(first); await f.response(sibling, regular);
  const compact = envelope('thread.watch', { threadId, contentRevision: revision }); f.phone.send(compact);
  const second = await f.host.next(message => message.requestId === compact.requestId);
  f.host.send({ v: 1, type: 'event', threadId, seq: 8, excludeTransportId: second.transportId });
  f.reply(second, { snapshot: { threadId }, seq: 8, contentBaseRevision: revision });
  const event = await sibling.next(message => message.type === 'event');
  assert.equal(event.seq, 8);
  assert.equal(event.excludeTransportId, undefined);
  assert.equal((await f.response(f.phone, compact)).result.seq, 8);
  assert.equal(f.phone.all.some(message => message.type === 'event'), false);
});

test('等待紧凑回执只过滤同版本的异步首帧，正文变化及回执后的增量仍送达', async t => {
  const f = await fixture(t), sibling = await f.connect('phone'), threadId = 'synthetic-chat';
  const hostId = 'computer~' + randomUUID(), generation = randomUUID(), newer = 'content:' + '2'.repeat(64);
  f.host.send({ type: 'host.instances', instances: [{ id: hostId, generation, label: '合成实例', online: true }] });
  await Promise.all([f.phone, sibling].map(connection => connection.next(message => message.type === 'hosts' && message.hosts.some(row => row.id === hostId && row.online))));
  const regular = envelope('thread.watch', { threadId }, hostId); sibling.send(regular);
  const first = await f.host.next(message => message.requestId === regular.requestId);
  f.reply(first); await f.response(sibling, regular);
  const compact = envelope('thread.watch', { threadId, contentRevision: revision }, hostId); f.phone.send(compact);
  const second = await f.host.next(message => message.requestId === compact.requestId);
  const snapshot = { v: 1, type: 'event', kind: 'snapshot', hostId, generation, threadId, seq: 8, contentRevision: revision, snapshot: { threadId, messages: [] } };
  f.host.send(snapshot);
  assert.equal((await sibling.next(message => message.type === 'event')).seq, 8);
  f.host.send({ ...snapshot, seq: 9, contentRevision: newer });
  assert.equal((await f.phone.next(message => message.type === 'event')).seq, 9);
  f.reply(second, { snapshot: { threadId }, seq: 9, contentBaseRevision: revision, contentRevision: newer });
  f.host.send({ v: 1, type: 'event', kind: 'delta', hostId, generation, threadId, seq: 10, baseSeq: 9, contentRevision: newer });
  assert.equal((await f.response(f.phone, compact)).result.seq, 9);
  assert.equal((await f.phone.next(message => message.type === 'event')).baseSeq, 9);
  assert.deepEqual(f.phone.all.flatMap(message => message.type === 'event' ? [message.seq] : message.requestId === compact.requestId ? ['回执'] : []), [9, '回执', 10]);
});
