import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelay } from '../apps/relay/server.mjs';
import { tokenHash } from '../packages/protocol/contracts.mjs';

/** 保留消息队列，以连接初始快照作为断言依据，避免依赖真实时间等待。 */
function inbox(socket) {
  const messages = [], waiting = [];
  socket.on('message', data => {
    const value = JSON.parse(data), at = waiting.findIndex(entry => entry.predicate(value));
    if (at < 0) { messages.push(value); return; }
    const entry = waiting.splice(at, 1)[0]; clearTimeout(entry.timer); entry.resolve(value);
  });
  return { messages, next(predicate) {
    const at = messages.findIndex(predicate);
    if (at >= 0) return Promise.resolve(messages.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { predicate, resolve };
      entry.timer = setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); reject(new Error('等待在线快照超时')); }, 2000);
      waiting.push(entry);
    });
  } };
}

async function fixture(t, options = {}) {
  const childId = 'pc~' + randomUUID();
  const entries = [
    { id: 'host', role: 'host', hostId: 'pc' }, { id: 'other-host', role: 'host', hostId: 'other' },
    { id: 'phone', role: 'mobile', hostIds: ['pc'] }, { id: 'child-phone', role: 'mobile', hostIds: [childId] },
    { id: 'other-phone', role: 'mobile', hostIds: ['other'] },
  ];
  const tokens = new Map(entries.map(entry => { const token = randomBytes(32).toString('base64url'); entry.tokenSha256 = tokenHash(token); return [entry.id, token]; }));
  const relay = createRelay({ identities: entries, ...options });
  const address = await relay.listen(); t.after(() => relay.close());
  const open = async id => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: `Bearer ${tokens.get(id)}` } });
    const queue = inbox(socket), welcome = await queue.next(value => value.type === 'welcome');
    return { socket, welcome, ...queue, send: value => socket.send(JSON.stringify(value)), presence: hostId => queue.next(value => value.type === 'clients.presence' && value.hostId === hostId) };
  };
  return { open, childId, entries };
}

test('在线数按授权真实连接聚合，多标签分别计数且控制快照不发给手机', async t => {
  const f = await fixture(t), host = await f.open('host'), otherHost = await f.open('other-host');
  assert.equal(host.welcome.capabilities.clientPresence, true);
  const initial = await host.presence('pc'); assert.equal(initial.onlineCount, 0);
  await otherHost.presence('other');
  const first = await f.open('phone'); assert.equal((await host.presence('pc')).onlineCount, 1);
  const second = await f.open('phone'); const two = await host.presence('pc'); assert.equal(two.onlineCount, 2); assert.ok(two.revision > initial.revision);
  const outsider = await f.open('other-phone'); assert.equal((await otherHost.presence('other')).onlineCount, 1);
  first.socket.terminate(); const one = await host.presence('pc'); assert.equal(one.onlineCount, 1); assert.ok(one.revision > two.revision);
  second.socket.terminate(); assert.equal((await host.presence('pc')).onlineCount, 0);
  outsider.send({ v: 1, type: 'request', requestId: randomUUID(), method: 'ping', params: {} });
  await outsider.next(value => value.type === 'response');
  assert.equal(outsider.messages.some(value => value.type === 'clients.presence'), false);
  assert.equal(host.messages.some(value => value.type === 'clients.presence'), false);
  assert.deepEqual(Object.keys(one).sort(), ['hostId', 'onlineCount', 'revision', 'type', 'v']);
});

test('同根连接分别通知各实例及代次，换代和重连发送完整初始快照', async t => {
  const f = await fixture(t), parentPhone = await f.open('phone'), childPhone = await f.open('child-phone'), host = await f.open('host');
  const original = await host.presence('pc'); assert.equal(original.onlineCount, 1);
  const parentGeneration = randomUUID(), childGeneration = randomUUID();
  host.send({ v: 1, type: 'host.instances', instances: [{ id: 'pc', generation: parentGeneration, online: true }, { id: f.childId, generation: childGeneration, online: true }] });
  const parent = await host.presence('pc'), child = await host.presence(f.childId);
  assert.equal(parent.generation, parentGeneration); assert.equal(parent.onlineCount, 1);
  assert.equal(child.generation, childGeneration); assert.equal(child.onlineCount, 2);
  const nextGeneration = randomUUID();
  host.send({ v: 1, type: 'host.instances', instances: [{ id: 'pc', generation: parentGeneration, online: true }, { id: f.childId, generation: nextGeneration, online: true }] });
  await host.presence('pc'); const next = await host.presence(f.childId);
  assert.equal(next.generation, nextGeneration); assert.ok(next.revision > child.revision);
  const replacement = await f.open('host'); const reconnected = await replacement.presence('pc');
  assert.equal(reconnected.onlineCount, 1); assert.ok(reconnected.revision > parent.revision);
  replacement.send({ v: 1, type: 'host.instances', instances: [{ id: f.childId, generation: nextGeneration, online: true }] });
  const restored = await replacement.presence(f.childId); assert.equal(restored.onlineCount, 2); assert.ok(restored.revision > next.revision);
  parentPhone.socket.terminate(); childPhone.socket.terminate();
});

test('授权撤销后重算人数，手机伪造控制帧被拒绝且不会转发电脑', async t => {
  const f = await fixture(t, { heartbeatMs: 20 }), host = await f.open('host'); await host.presence('pc');
  const phone = await f.open('phone'); const online = await host.presence('pc');
  f.entries.find(entry => entry.id === 'phone').hostIds = [];
  const revoked = await host.presence('pc'); assert.equal(revoked.onlineCount, 0); assert.ok(revoked.revision > online.revision);
  phone.send({ v: 1, type: 'clients.presence', hostId: 'pc', onlineCount: 100, revision: 999 });
  const closeCode = await new Promise(resolve => phone.socket.once('close', resolve)); assert.equal(closeCode, 1008);
  host.send({ v: 1, type: 'host.ready', label: '测试电脑' });
  const fresh = await host.presence('pc'); assert.equal(fresh.onlineCount, 0); assert.ok(fresh.revision < 999);
  assert.equal(host.messages.some(value => value.type === 'clients.presence' && value.onlineCount === 100), false);
});
