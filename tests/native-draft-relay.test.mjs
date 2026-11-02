import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelay } from '../apps/relay/server.mjs';
import { tokenHash } from '../packages/protocol/contracts.mjs';

/** 保存全部消息并按条件接收，负向断言通过同连接顺序屏障验证，不靠短暂等待猜测。 */
function inbox(socket) {
  const rows = [], all = [], waiting = [];
  socket.on('error', () => {});
  socket.on('message', data => {
    const value = JSON.parse(data); all.push(value);
    const at = waiting.findIndex(entry => entry.match(value));
    if (at < 0) rows.push(value);
    else { const entry = waiting.splice(at, 1)[0]; clearTimeout(entry.timer); entry.resolve(value); }
  });
  const next = match => {
    const at = rows.findIndex(match); if (at >= 0) return Promise.resolve(rows.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { match, resolve };
      entry.timer = setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); reject(new Error('等待合成草稿消息超时')); }, 3000);
      waiting.push(entry);
    });
  };
  return { socket, all, next, events: () => all.filter(message => message.type === 'thread.draft.changed') };
}

/** 所有令牌、主机、草稿和实例均为内存合成数据，使用真实回环 WebSocket 完成鉴权与转发。 */
async function fixture(t, { legacy = false, requestTimeoutMs = 1000 } = {}) {
  const names = ['computer', 'other', 'phone-a', 'phone-b', 'outsider'];
  const tokens = Object.fromEntries(names.map(name => [name, randomBytes(32).toString('base64url')]));
  const identities = names.map(name => name === 'computer' || name === 'other'
    ? { id: name, role: 'host', hostId: name, tokenSha256: tokenHash(tokens[name]) }
    : { id: name, role: 'mobile', hostIds: [name === 'outsider' ? 'other' : 'computer'], tokenSha256: tokenHash(tokens[name]) });
  const relay = createRelay({ identities, requestTimeoutMs }), address = await relay.listen();
  t.after(() => relay.close());
  const phones = [];
  const connect = async name => {
    const connection = inbox(new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: `Bearer ${tokens[name]}` } }));
    const welcome = await connection.next(message => message.type === 'welcome');
    if (welcome.role === 'mobile') phones.push(connection);
    return connection;
  };
  const host = await connect('computer'), otherHost = await connect('other'), phone = await connect('phone-a'), second = await connect('phone-b'), outside = await connect('outsider');
  const child = 'computer~' + randomUUID(), generations = new Map([['computer', randomUUID()], [child, randomUUID()]]);
  const manifest = async () => {
    host.socket.send(JSON.stringify({ type: 'host.instances', instances: [...generations].map(([id, generation]) => ({ id, generation, label: '合成实例', online: true })) }));
    await phone.next(message => message.type === 'hosts' && message.hosts.some(row => row.id === child && row.instanceGeneration === generations.get(child) && row.online));
  };
  if (!legacy) await manifest();
  const request = (connection, hostId, method, params) => {
    const requestId = randomUUID();
    connection.socket.send(JSON.stringify({ v: 1, type: 'request', requestId, hostId, method, params }));
    return requestId;
  };
  const reply = (transport, result, error, sender = host, extra = {}) => sender.socket.send(JSON.stringify({ v: 1, type: 'response', transportId: transport.transportId, hostId: transport.hostId, generation: transport.generation, result, error, ...extra }));
  const barrier = async (sender = host) => {
    const marker = '合成屏障-' + randomUUID(); sender.socket.send(JSON.stringify({ type: 'host.ready', label: marker }));
    const visible = sender === otherHost ? outside : phones.find(connection => connection !== outside && connection.socket.readyState === WebSocket.OPEN);
    await visible.next(message => message.type === 'hosts' && message.hosts.some(row => row.label === marker));
    await Promise.all(phones.filter(connection => connection.socket.readyState === WebSocket.OPEN).map(async connection => {
      const id = request(connection, undefined, 'ping', {}); await connection.next(message => message.requestId === id);
    }));
  };
  const subscribe = async (connection, hostId, snapshot, method = 'thread.draft.read') => {
    const id = request(connection, hostId, method, method === 'thread.draft.open' ? { projectId: snapshot.projectId } : { draftId: snapshot.draftId });
    const transport = await host.next(message => message.type === 'request' && message.requestId === id);
    reply(transport, snapshot); const response = await connection.next(message => message.requestId === id); assert.equal(response.error, undefined);
    return transport;
  };
  const changed = (hostId, snapshot, deviceId = 'phone-a', extra = {}, sender = host) => sender.socket.send(JSON.stringify({ v: 1, type: 'thread.draft.changed', hostId, generation: legacy ? undefined : generations.get(hostId), deviceId, snapshot, ...extra }));
  return { relay, host, otherHost, phone, second, outside, phones, child, generations, identities, connect, manifest, request, reply, barrier, subscribe, changed };
}

/** 快照仅包含公开协议字段，不使用真实会话正文、目录或原生窗口身份。 */
function snapshot(draftId = randomUUID(), revision = 1) {
  return { draftId, projectId: 'synthetic-project', revision, status: 'ready', settings: { model: 'synthetic-model', effort: 'high', serviceTier: '', mode: 'default' }, models: [], permissions: { mode: 'default', revision: 'synthetic-permission', options: [] }, hasDesktopText: false };
}

test('仅 open/read 成功后定向转发：隔离设备、标签页、草稿、实例与项目', async t => {
  const f = await fixture(t), draft = snapshot(), sibling = await f.connect('phone-a'), another = snapshot();
  f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 0);
  await f.subscribe(f.phone, f.child, draft, 'thread.draft.open');
  await f.subscribe(f.second, f.child, another);
  f.changed(f.child, { ...draft, revision: 2 }); await f.barrier();
  assert.equal(f.phone.events().length, 1); assert.equal(f.phone.events()[0].hostId, f.child); assert.equal(f.phone.events()[0].generation, f.generations.get(f.child));
  for (const connection of [f.second, f.outside, sibling]) assert.equal(connection.events().length, 0);
  for (const [hostId, value, deviceId] of [[f.child, another, 'phone-a'], ['computer', draft, 'phone-a'], [f.child, draft, 'phone-b'], [f.child, { ...draft, projectId: 'another-project' }, 'phone-a']]) f.changed(hostId, value, deviceId);
  await f.barrier(); assert.equal(f.phone.events().length, 1); assert.equal(f.second.events().length, 0);
  await f.subscribe(sibling, f.child, draft); f.changed(f.child, { ...draft, revision: 3 }); await f.barrier();
  assert.equal(f.phone.events().length, 2); assert.equal(sibling.events().length, 1);
});

test('伪造主机、外部电脑连接、旧 generation、缺少目标与非法草稿事件均被丢弃', async t => {
  const f = await fixture(t), draft = snapshot(); await f.subscribe(f.phone, f.child, draft);
  f.changed(f.child, draft, 'phone-a', { generation: randomUUID() });
  f.changed(f.child, draft, 'phone-a', { generation: undefined });
  f.changed(f.child, draft, 'phone-a', { hostId: 'other' });
  f.changed(f.child, draft, undefined, { deviceId: undefined });
  f.changed(f.child, { ...draft, draftId: '../escape' });
  f.changed(f.child, draft, 'phone-a', { v: 2 });
  f.changed(f.child, draft, 'phone-a', {}, f.otherHost);
  await f.barrier(f.otherHost); await f.barrier(); assert.equal(f.phone.events().length, 0);
  f.changed(f.child, { ...draft, revision: 2 }); await f.barrier(); assert.equal(f.phone.events().length, 1);
});

test('失败、错草稿、错项目或错实例的响应不会建立订阅或返回其他草稿', async t => {
  const f = await fixture(t), draft = snapshot();
  let id = f.request(f.phone, f.child, 'thread.draft.open', { projectId: draft.projectId });
  let transport = await f.host.next(message => message.requestId === id);
  f.reply(transport, undefined, { code: 'DRAFT_UNAVAILABLE', message: '合成失败' }); assert.ok((await f.phone.next(message => message.requestId === id)).error);
  id = f.request(f.phone, f.child, 'thread.draft.read', { draftId: draft.draftId }); transport = await f.host.next(message => message.requestId === id);
  f.reply(transport, snapshot()); assert.equal((await f.phone.next(message => message.requestId === id)).error.code, 'BAD_DRAFT_RESPONSE');
  id = f.request(f.phone, f.child, 'thread.draft.open', { projectId: 'different-project' }); transport = await f.host.next(message => message.requestId === id);
  f.reply(transport, draft); assert.equal((await f.phone.next(message => message.requestId === id)).error.code, 'BAD_DRAFT_RESPONSE');
  id = f.request(f.phone, f.child, 'thread.draft.read', { draftId: draft.draftId }); transport = await f.host.next(message => message.requestId === id);
  f.reply(transport, draft, undefined, f.host, { hostId: 'computer', generation: f.generations.get('computer') });
  f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 0);
  f.reply(transport, draft); await f.phone.next(message => message.requestId === id);
  f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 1);
});

test('授权撤销立即阻断推送，在途 open 成功也不能重新建立订阅', async t => {
  const f = await fixture(t), draft = snapshot(); await f.subscribe(f.phone, f.child, draft);
  const id = f.request(f.phone, f.child, 'thread.draft.open', { projectId: draft.projectId }), transport = await f.host.next(message => message.requestId === id);
  f.identities.find(identity => identity.id === 'phone-a').hostIds = [];
  f.changed(f.child, draft); f.reply(transport, draft);
  assert.equal((await f.phone.next(message => message.requestId === id)).error.code, 'HOST_FORBIDDEN');
  // 用另一个仍获授权的手机建立顺序屏障，避免依赖被撤权手机的电脑列表。
  const marker = '合成撤权屏障'; f.host.socket.send(JSON.stringify({ type: 'host.ready', label: marker }));
  await f.second.next(message => message.type === 'hosts' && message.hosts.some(row => row.label === marker));
  const ping = f.request(f.phone, undefined, 'ping', {}); await f.phone.next(message => message.requestId === ping); assert.equal(f.phone.events().length, 0);
});

test('unwatch 失败保留订阅，成功后撤销，随后 read 可以恢复', async t => {
  const f = await fixture(t), draft = snapshot(); await f.subscribe(f.phone, f.child, draft);
  let id = f.request(f.phone, f.child, 'thread.draft.unwatch', { draftId: draft.draftId }), transport = await f.host.next(message => message.requestId === id);
  f.reply(transport, undefined, { code: 'DRAFT_UNAVAILABLE', message: '合成失败' }); await f.phone.next(message => message.requestId === id);
  f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 1);
  id = f.request(f.phone, f.child, 'thread.draft.unwatch', { draftId: draft.draftId }); transport = await f.host.next(message => message.requestId === id);
  f.reply(transport, { ok: true }); await f.phone.next(message => message.requestId === id);
  f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 1);
  await f.subscribe(f.phone, f.child, draft); f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 2);
});

test('迟到 read/open 不会撤销已成功 unwatch，更新的 read 不被旧 unwatch 回执删除', async t => {
  const f = await fixture(t), draft = snapshot(); await f.subscribe(f.phone, f.child, draft);
  for (const method of ['thread.draft.read', 'thread.draft.open']) {
    const readId = f.request(f.phone, f.child, method, method.endsWith('open') ? { projectId: draft.projectId } : { draftId: draft.draftId });
    const reading = await f.host.next(message => message.requestId === readId);
    const unwatchId = f.request(f.phone, f.child, 'thread.draft.unwatch', { draftId: draft.draftId }), unwatch = await f.host.next(message => message.requestId === unwatchId);
    f.reply(unwatch, { ok: true }); await f.phone.next(message => message.requestId === unwatchId);
    f.reply(reading, draft); await f.phone.next(message => message.requestId === readId);
    f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 0);
  }
  const id = f.request(f.phone, f.child, 'thread.draft.unwatch', { draftId: draft.draftId }), transport = await f.host.next(message => message.requestId === id);
  await f.subscribe(f.phone, f.child, draft); f.reply(transport, { ok: true }); await f.phone.next(message => message.requestId === id);
  f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 1);
});

test('同设备多标签页共享观察，仅最后一个退订或断开才向原 host 转发 unwatch', async t => {
  const f = await fixture(t), draft = snapshot(), sibling = await f.connect('phone-a');
  await f.subscribe(f.phone, f.child, draft); await f.subscribe(sibling, f.child, draft);
  const id = f.request(f.phone, f.child, 'thread.draft.unwatch', { draftId: draft.draftId });
  assert.equal((await f.phone.next(message => message.requestId === id)).result.ok, true);
  f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 0); assert.equal(sibling.events().length, 1);
  assert.equal(f.host.all.filter(message => message.method === 'thread.draft.unwatch').length, 0);
  sibling.socket.close();
  const release = await f.host.next(message => message.method === 'thread.draft.unwatch');
  assert.equal(release.deviceId, 'phone-a'); assert.equal(release.hostId, f.child); assert.equal(release.generation, f.generations.get(f.child)); assert.deepEqual(release.params, { draftId: draft.draftId });
  assert.equal(f.host.all.some(message => message.method === 'thread.delete'), false);
});

test('手机断线时在途 open 的迟到成功回执仅释放观察，不向同身份未订阅标签页泄漏', async t => {
  const f = await fixture(t), draft = snapshot(), sibling = await f.connect('phone-a');
  const id = f.request(f.phone, f.child, 'thread.draft.open', { projectId: draft.projectId }), transport = await f.host.next(message => message.requestId === id);
  f.phone.socket.close(); await new Promise(resolve => f.phone.socket.once('close', resolve));
  f.reply(transport, draft);
  const release = await f.host.next(message => message.method === 'thread.draft.unwatch'); assert.equal(release.params.draftId, draft.draftId);
  f.changed(f.child, draft); await f.barrier(); assert.equal(sibling.events().length, 0);
});

test('实例换代只使该实例订阅失效，旧事件和旧回执均不能复活，read 后才恢复', async t => {
  const f = await fixture(t), draft = snapshot(); await f.subscribe(f.phone, f.child, draft); await f.subscribe(f.phone, 'computer', draft);
  const id = f.request(f.phone, f.child, 'thread.draft.read', { draftId: draft.draftId }), transport = await f.host.next(message => message.requestId === id), old = f.generations.get(f.child);
  f.generations.set(f.child, randomUUID()); await f.manifest(); assert.equal((await f.phone.next(message => message.requestId === id)).error.code, 'INSTANCE_CHANGED');
  f.reply(transport, draft); f.changed(f.child, draft, 'phone-a', { generation: old }); f.changed(f.child, draft); f.changed('computer', draft); await f.barrier();
  assert.equal(f.phone.events().length, 1); assert.equal(f.phone.events()[0].hostId, 'computer');
  await f.subscribe(f.phone, f.child, draft); f.changed(f.child, draft); await f.barrier(); assert.equal(f.phone.events().length, 2);
});

test('主机重连即使复用 generation 也不能继承订阅，旧连接事件不可送达', async t => {
  const f = await fixture(t), draft = snapshot(); await f.subscribe(f.phone, f.child, draft);
  const replacement = await f.connect('computer');
  replacement.socket.send(JSON.stringify({ type: 'host.instances', instances: [...f.generations].map(([id, generation]) => ({ id, generation, label: '合成重连实例', online: true })) }));
  await f.phone.next(message => message.type === 'hosts' && message.hosts.some(row => row.id === f.child && row.online && row.label === '合成重连实例'));
  f.changed(f.child, draft, 'phone-a', {}, replacement);
  const marker = '合成重连屏障'; replacement.socket.send(JSON.stringify({ type: 'host.ready', label: marker }));
  await f.phone.next(message => message.type === 'hosts' && message.hosts.some(row => row.id === 'computer' && row.label === marker));
  const ping = f.request(f.phone, undefined, 'ping', {}); await f.phone.next(message => message.requestId === ping); assert.equal(f.phone.events().length, 0);
});

test('旧单主机连接仍按已鉴权来源转发，不能用 hostId 或 generation 冒用实例', async t => {
  const f = await fixture(t, { legacy: true }), draft = snapshot(); await f.subscribe(f.phone, 'computer', draft);
  f.changed('other', draft); f.changed('computer', draft, 'phone-a', { generation: randomUUID() }); await f.barrier(); assert.equal(f.phone.events().length, 0);
  f.changed('computer', { ...draft, revision: 2 }); await f.barrier(); assert.equal(f.phone.events().length, 1); assert.equal(f.phone.events()[0].hostId, 'computer');
});
