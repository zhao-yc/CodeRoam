import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelay } from '../apps/relay/server.mjs';
import { tokenHash } from '../packages/protocol/contracts.mjs';

/** 按消息类型等待，保留乱序回执，以真实 WebSocket 验证实例路由。 */
function inbox(socket) {
  const rows = [], waiters = [];
  socket.on('message', data => { const value = JSON.parse(data); const at = waiters.findIndex(x => x.match(value)); if (at < 0) rows.push(value); else { const waiter = waiters.splice(at, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(value); } });
  return match => { const at = rows.findIndex(match); if (at >= 0) return Promise.resolve(rows.splice(at, 1)[0]); return new Promise((resolve, reject) => { const waiter = { match, resolve }; waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('等待实例消息超时')); }, 3000); waiters.push(waiter); }); };
}
async function fixture(t) {
  const tokens = [0, 1, 2].map(() => randomBytes(32).toString('base64url'));
  const identities = [{ id: 'computer', role: 'host', hostId: 'computer', tokenSha256: tokenHash(tokens[0]) }, { id: 'phone', role: 'mobile', hostIds: ['computer'], tokenSha256: tokenHash(tokens[1]) }, { id: 'outsider', role: 'mobile', hostIds: ['other'], tokenSha256: tokenHash(tokens[2]) }];
  const relay = createRelay({ identities, requestTimeoutMs: 1000 }), address = await relay.listen(); t.after(() => relay.close());
  const open = async token => { const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: `Bearer ${token}` } }), next = inbox(socket); const welcome = await next(x => x.type === 'welcome'); return { socket, next, welcome }; };
  const host = await open(tokens[0]), phone = await open(tokens[1]), outside = await open(tokens[2]);
  const child = 'computer~' + randomUUID(), generations = [randomUUID(), randomUUID()];
  const manifest = () => host.socket.send(JSON.stringify({ type: 'host.instances', instances: [{ id: 'computer', generation: generations[0], label: '合成电脑', online: true }, { id: child, generation: generations[1], label: '合成电脑 · 实例 2', online: true }] }));
  manifest(); await phone.next(x => x.type === 'hosts' && x.hosts.some(row => row.id === child && row.online));
  return { host, phone, outside, child, generations, manifest, identities, open, tokens };
}
function send(phone, hostId, method, params) { const requestId = randomUUID(); phone.socket.send(JSON.stringify({ v: 1, type: 'request', requestId, hostId, method, params })); return requestId; }

test('父电脑授权自动覆盖实例，实例独立改名，其他手机不能访问', async t => {
  const f = await fixture(t); assert.equal(f.host.welcome.capabilities.hostInstances, true);
  let id = send(f.outside, f.child, 'threads.list', {}); assert.equal((await f.outside.next(x => x.requestId === id)).error.code, 'HOST_FORBIDDEN');
  id = send(f.phone, f.child, 'host.profile.update', { displayName: '合成第二设备', icon: 'code', expectedRevision: 0 }); assert.equal((await f.phone.next(x => x.requestId === id)).result.computer.label, '合成第二设备');
  f.generations[1] = randomUUID(); f.manifest();
  const hosts = await f.phone.next(x => x.type === 'hosts' && x.hosts.some(row => row.id === f.child && row.instanceGeneration === f.generations[1]));
  assert.equal(hosts.hosts.find(x => x.id === f.child).label, '合成第二设备'); assert.equal(hosts.hosts.find(x => x.id === 'computer').label, '合成电脑');
});

test('相同会话编号分别路由到实例，伪造来源及旧代次回应不能完成请求', async t => {
  const f = await fixture(t), requests = [];
  for (const hostId of ['computer', f.child]) {
    const id = send(f.phone, hostId, 'thread.watch', { threadId: 'same-thread' }); const request = await f.host.next(x => x.type === 'request'); requests.push(request);
    assert.equal(request.hostId, hostId); assert.equal(request.generation, f.generations[hostId === 'computer' ? 0 : 1]);
    f.host.socket.send(JSON.stringify({ type: 'response', transportId: request.transportId, hostId: hostId === 'computer' ? f.child : 'computer', generation: request.generation, result: { wrong: true } }));
    f.host.socket.send(JSON.stringify({ type: 'response', transportId: request.transportId, hostId, generation: request.generation, result: { correct: hostId } }));
    assert.equal((await f.phone.next(x => x.requestId === id)).result.correct, hostId);
  }
  f.host.socket.send(JSON.stringify({ type: 'event', hostId: f.child, generation: randomUUID(), threadId: 'same-thread', marker: 'stale' }));
  f.host.socket.send(JSON.stringify({ type: 'event', hostId: f.child, generation: f.generations[1], threadId: 'same-thread', marker: 'current' }));
  assert.equal((await f.phone.next(x => x.type === 'event')).marker, 'current');
  f.identities[1].hostIds = [];
  const id = send(f.phone, f.child, 'threads.list', {}); assert.equal((await f.phone.next(x => x.requestId === id)).error.code, 'HOST_FORBIDDEN');
});

test('单实例换代使其在途写操作结果待核对，另一设备请求仍可正常完成', async t => {
  const f = await fixture(t);
  const writeId = send(f.phone, f.child, 'turn.send', { threadId: 'same-thread', text: '合成消息' }); await f.host.next(x => x.type === 'request' && x.method === 'turn.send');
  const readId = send(f.phone, 'computer', 'threads.list', {}), read = await f.host.next(x => x.type === 'request' && x.method === 'threads.list');
  f.generations[1] = randomUUID(); f.manifest();
  const response = await f.phone.next(x => x.requestId === writeId); assert.equal(response.error.code, 'OUTCOME_UNKNOWN'); assert.equal(response.error.outcomeUnknown, true);
  f.host.socket.send(JSON.stringify({ type: 'response', transportId: read.transportId, hostId: 'computer', generation: f.generations[0], result: { threads: [] } })); assert.deepEqual((await f.phone.next(x => x.requestId === readId)).result.threads, []);
});

test('新版连接退出后旧桥接可恢复原设备，子实例离线记录不丢失', async t => {
  const f = await fixture(t); f.host.socket.terminate(); await f.phone.next(x => x.type === 'hosts' && x.hosts.every(row => !row.online));
  const legacy = await f.open(f.tokens[0]); const hosts = await f.phone.next(x => x.type === 'hosts' && x.hosts.some(row => row.id === 'computer' && row.online)); assert.equal(hosts.hosts.find(x => x.id === f.child).online, false);
  const id = send(f.phone, 'computer', 'threads.list', {}), request = await legacy.next(x => x.type === 'request'); assert.equal(request.generation, undefined);
  legacy.socket.send(JSON.stringify({ type: 'response', transportId: request.transportId, result: { threads: [] } })); assert.deepEqual((await f.phone.next(x => x.requestId === id)).result.threads, []);
});
