import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { HostProfiles } from '../apps/relay/host-profiles.mjs';
import { createRelay } from '../apps/relay/server.mjs';
import { tokenHash, validateRequest } from '../packages/protocol/contracts.mjs';

const request = (params = {}) => ({ v: 1, type: 'request', requestId: randomUUID(), hostId: 'pc', method: 'host.profile.update', params: { displayName: '办公室', icon: 'desktop', expectedRevision: 0, ...params } });

/** 独立临时目录只存测试连接外观，不读取真实配对配置。 */
function store(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-host-profiles-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return path.join(directory, 'profiles.json'); }

test('外观持久化、主机重连与重启不会覆盖自定义名称和图标', t => {
  const file = store(t), profiles = new HostProfiles(file);
  profiles.observe('pc', { label: '系统别名', hostname: 'example-pc', connectionType: 'codex-desktop' });
  profiles.update('pc', { displayName: ' 办公室 ', icon: 'desktop', expectedRevision: 0 });
  const reopened = new HostProfiles(file);
  reopened.observe('pc', { label: '另一个别名', hostname: 'new-pc', connectionType: 'codex-desktop' });
  const computer = reopened.computer('pc', false);
  assert.equal(computer.label, '办公室'); assert.equal(computer.icon, 'desktop'); assert.equal(computer.hostname, 'new-pc'); assert.equal(computer.profileRevision, 1); assert.ok(computer.lastConnectedAt > 0); assert.equal(computer.online, false);
  assert.throws(() => reopened.update('pc', { displayName: '旧草稿', icon: 'code', expectedRevision: 0 }), /其他客户端修改/);
  assert.equal(reopened.computer('pc', false).label, '办公室');
});

test('落盘失败保留旧内存，损坏文件拒绝启动，不默默清空数据', t => {
  const file = store(t), profiles = new HostProfiles(file);
  profiles.observe('pc', { label: '原值' });
  profiles.file = path.join(file, '不能写入的目录');
  assert.throws(() => profiles.update('pc', { displayName: '新值', icon: 'code', expectedRevision: 0 }), /保存失败/);
  assert.equal(profiles.computer('pc', false).label, '原值'); assert.equal(profiles.get('pc').profileRevision, 0);
  fs.writeFileSync(file, '{损坏'); assert.throws(() => new HostProfiles(file), /无法读取/);
});

test('协议拒绝空名称、控制字符、超长名称、任意图标、非法版本和越界字段', () => {
  assert.equal(validateRequest(request()).method, 'host.profile.update');
  for (const params of [{ displayName: '  ' }, { displayName: 'a\nb' }, { displayName: '名'.repeat(101) }, { icon: '../settings' }, { expectedRevision: -1 }, { expectedRevision: 0.5 }, { token: '不接受' }]) assert.throws(() => validateRequest(request(params)), /显示名称|参数无效/);
});

/** 保留消息队列，广播先于回执到达也能按条件读取。 */
function inbox(socket) {
  const messages = [], waiters = [];
  socket.on('message', data => { const message = JSON.parse(data); const index = waiters.findIndex(item => item.predicate(message)); if (index < 0) messages.push(message); else { const item = waiters.splice(index, 1)[0]; clearTimeout(item.timer); item.resolve(message); } });
  return predicate => { const index = messages.findIndex(predicate); if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]); return new Promise((resolve, reject) => { const item = { predicate, resolve }; item.timer = setTimeout(() => { waiters.splice(waiters.indexOf(item), 1); reject(new Error('等待连接外观同步超时')); }, 3000); waiters.push(item); }); };
}

test('离线电脑可编辑，广播限定授权手机，并发版本冲突不覆盖新值', async t => {
  const tokens = Array.from({ length: 3 }, () => randomBytes(32).toString('base64url'));
  const relay = createRelay({ profiles: new HostProfiles(store(t)), identities: tokens.map((token, index) => ({ id: '手机' + index, role: 'mobile', hostIds: index === 2 ? ['other'] : ['pc'], tokenSha256: tokenHash(token) })) });
  const address = await relay.listen(); t.after(() => relay.close());
  const open = async token => { const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: `Bearer ${token}` } }); const next = inbox(socket); const welcome = await next(value => value.type === 'welcome'); assert.equal(welcome.capabilities.hostProfiles, true); return { socket, next }; };
  const [first, second, forbidden] = await Promise.all(tokens.map(open));
  const denied = request(); forbidden.socket.send(JSON.stringify(denied)); assert.equal((await forbidden.next(value => value.requestId === denied.requestId)).error.code, 'HOST_FORBIDDEN');
  const edit = request(); first.socket.send(JSON.stringify(edit));
  const broadcast = await second.next(value => value.type === 'hosts' && value.hosts[0].label === '办公室'); assert.equal(broadcast.hosts[0].icon, 'desktop'); assert.equal(broadcast.hosts[0].online, false);
  assert.equal((await first.next(value => value.requestId === edit.requestId)).result.computer.profileRevision, 1);
  const conflict = request({ displayName: '旧草稿' }); second.socket.send(JSON.stringify(conflict)); assert.equal((await second.next(value => value.requestId === conflict.requestId)).error.code, 'PROFILE_CONFLICT');
  const ping = { ...request(), method: 'ping', params: {} }; forbidden.socket.send(JSON.stringify(ping)); await forbidden.next(value => value.requestId === ping.requestId);
  // 未授权手机接收到的 hosts 始终只有它自己的电脑。
  const received = []; forbidden.socket.on('message', data => received.push(JSON.parse(data)));
  const final = request({ displayName: '最终名称', expectedRevision: 1 }); first.socket.send(JSON.stringify(final)); await first.next(value => value.requestId === final.requestId);
  await forbidden.next(value => value.type === 'hosts'); assert.equal(received.some(value => value.hosts?.some(host => host.id === 'pc')), false);
});
