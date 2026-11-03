import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { bindInstanceClients, bindBackendOwners, InstanceIpcClient, instancePages } from '../apps/bridge/instance-binding.mjs';

test('随机查询仅绑定同号且来源格式有效的协调广播，辅助页面失败不污染其他页面', async () => {
  const client = new EventEmitter(), owner = randomUUID(), foreign = randomUUID();
  const ids = await bindInstanceClients(client, {}, { pages: async () => ['unsupported', 'main'], query: async (url, nonce) => {
    if (url === 'unsupported') throw new Error('页面不支持');
    client.emit('broadcast', { method: 'thread-stream-following-status-requested', sourceClientId: foreign, params: { conversationId: randomUUID(), hostId: 'local' } });
    client.emit('broadcast', { method: 'thread-stream-following-status-requested', sourceClientId: owner, params: { conversationId: nonce, hostId: 'local' } });
  }, timeoutMs: 15 });
  assert.deepEqual([...ids], [owner]); assert.equal(client.listenerCount('broadcast'), 0);
  await assert.rejects(bindInstanceClients(client, {}, { pages: async () => ['main'], query: async () => {}, timeoutMs: 10 }), error => error.code === 'INSTANCE_NOT_READY');
  assert.equal(client.listenerCount('broadcast'), 0);
});

test('页面发现只构造核验端口下的固定页面地址，不使用返回的调试地址', async () => {
  const urls = await instancePages({ port: 9222 }, async () => ({ ok: true, text: async () => JSON.stringify([{ id: 'main', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://example.com/' }, { id: '../escape', type: 'page', url: 'app://-/index.html' }, { id: 'remote', type: 'page', url: 'https://example.com/' }]) }));
  assert.deepEqual(urls, ['ws://127.0.0.1:9222/devtools/page/main']);
});

test('相同会话编号只能发现绑定的原所有者，发送和广播不得跨实例', async () => {
  const instance = { alive: true, ready: true }, owner = randomUUID(), other = randomUUID(), requests = [];
  const client = new InstanceIpcClient({ instance, timeoutMs: 50 }); client.allowedClients.add(owner);
  client.socket = { writable: true, write(frame) { const request = JSON.parse(frame.subarray(4)); requests.push(request); queueMicrotask(() => client.handleMessage({ type: 'response', requestId: request.requestId, resultType: 'success', handledByClientId: owner, result: {} })); } };
  const result = await client.findOwner('same-thread'); assert.equal(result.clientId, owner); assert.equal(requests[0].targetClientId, owner);
  await client.request('thread-follower-start-turn', { conversationId: 'same-thread' }, 2, { targetClientId: owner });
  await assert.rejects(client.request('thread-follower-start-turn', {}, 2, { targetClientId: other }), error => error.code === 'INSTANCE_CHANGED');
  assert.throws(() => client.broadcast('thread-stream-following-changed', {}, 1, [other]), error => error.code === 'INSTANCE_CHANGED');
  let broadcasts = 0; client.on('broadcast', () => broadcasts++);
  client.handleMessage({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: other }); assert.equal(broadcasts, 0);
  client.handleMessage({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: owner }); assert.equal(broadcasts, 1);
  instance.alive = false; assert.throws(() => client.broadcast('thread-stream-following-changed', {}, 1, [owner]), error => error.code === 'INSTANCE_NOT_READY');
});

test('客户端退出立即撤销运行期绑定，旧来源广播不能恢复快照', () => {
  const instance = { alive: true, ready: true }, owner = randomUUID(), client = new InstanceIpcClient({ instance }); client.allowedClients.add(owner);
  let events = 0; client.on('broadcast', () => events++);
  client.handleMessage({ type: 'broadcast', method: 'client-status-changed', params: { clientId: owner, status: 'disconnected' } });
  client.handleMessage({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: owner });
  assert.equal(instance.ready, false); assert.equal(events, 0);
});

test('单实例直连只接受复核后的所有者，失去独占时拒绝发现新身份和发送', async () => {
  const owner = randomUUID(), other = randomUUID(), requests = [];
  let current = owner, exclusive = true;
  const instance = { alive: true, ready: true, directIpc: true, verify: async () => { if (!exclusive) throw Error('IPC 不再独占'); } };
  const client = new InstanceIpcClient({ instance });
  client.socket = { writable: true, write(frame) {
    const request = JSON.parse(frame.subarray(4));
    requests.push(request);
    queueMicrotask(() => client.handleMessage({ type: 'response', requestId: request.requestId, resultType: 'success', handledByClientId: current, result: {} }));
  } };
  assert.equal((await client.findOwner('合成聊天')).clientId, owner);
  assert.equal(requests[0].targetClientId, undefined);
  await client.request('thread-follower-start-turn', {}, 2, { targetClientId: owner });
  assert.equal(requests[1].targetClientId, owner);
  exclusive = false;
  // 模型设置仍定向到已知所有者，读接口不会触发再次扫描。
  await client.request('thread-follower-read-model-settings', {}, 1, { targetClientId: owner });
  await assert.rejects(client.request('thread-follower-read-model-settings', {}, 1, { targetClientId: other }), { code: 'INSTANCE_CHANGED' });
  current = other;
  await assert.rejects(client.findOwner('合成聊天'), /IPC 不再独占/);
  assert.deepEqual([...client.allowedClients], [owner]);
  await assert.rejects(client.request('thread-follower-start-turn', {}, 2, { targetClientId: owner }), /IPC 不再独占/);
  assert.equal(requests.length, 4);
});

test('后台身份要求全部实例完成只读归属核验，相同编号多所有者及核验期间变更均拒绝绑定', async () => {
  const a = { instance: { alive: true }, client: { allowedClients: new Set() } }, b = { instance: { alive: true }, client: { allowedClients: new Set() } }, id = randomUUID();
  const row = { hostId: 'local', threadId: randomUUID() };
  const discoverOwner = async () => ({ resultType: 'success', handledByClientId: id });
  await bindBackendOwners([a, b], { readOwnership: async () => [row], discoverOwner }); assert.equal(a.client.allowedClients.size, 0);
  let reads = 0;
  await bindBackendOwners([a, b], { readOwnership: async instance => { reads++; return instance === a.instance || reads > 2 ? [row] : []; }, discoverOwner }); assert.equal(a.client.allowedClients.size, 0);
  await bindBackendOwners([a, b], { readOwnership: async instance => instance === a.instance ? [row] : [], discoverOwner }); assert.equal(a.client.allowedClients.has(id), true); assert.equal(b.client.allowedClients.size, 0);
  await assert.rejects(bindBackendOwners([a, b], { readOwnership: async () => { throw new Error('无法核验'); }, discoverOwner }));
});
