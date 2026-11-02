import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstanceRegistry } from '../apps/bridge/instance-registry.mjs';
import { HostInstances } from '../apps/relay/host-instances.mjs';
import { randomUUID } from 'node:crypto';
import { Journal } from '../apps/bridge/journal.mjs';

test('默认实例保留原编号，独立配置和共享配置多开均有持久匿名身份', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-registry-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { file: path.join(root, 'instances.json'), hostId: 'computer', defaultHome: path.join(root, 'default'), label: '合成电脑', backupDirectory: path.join(root, 'backup') };
  const registry = new InstanceRegistry(options), original = registry.identify({ codexHome: options.defaultHome }), shared = registry.identify({ codexHome: options.defaultHome, userData: path.join(root, 'another-ui') }), isolated = registry.identify({ codexHome: path.join(root, 'isolated') });
  assert.equal(original.id, 'computer'); assert.notEqual(shared.id, isolated.id); assert.match(shared.id, /^computer~[0-9a-f-]{36}$/);
  const restored = new InstanceRegistry(options); assert.equal(restored.identify({ codexHome: path.join(root, 'isolated'), pid: 999 }).id, isolated.id);
  assert.equal(fs.existsSync(path.join(root, 'backup', '实例登记备份说明.md')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.file)), JSON.parse(fs.readFileSync(path.join(root, 'backup', 'instances.json'))));
});

test('中转实例清单原子拒绝越权、重复和无效代次，重载后保留离线关系', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-instances-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'instances.json'), instances = new HostInstances(file), id = 'computer~' + randomUUID(), generation = randomUUID();
  instances.update('computer', [{ id, generation, online: true, label: '合成实例' }]);
  assert.equal(instances.owns('computer', id, generation), true); assert.equal(instances.authorized(['computer'], id), true); assert.equal(instances.authorized(['other'], id), false);
  for (const rows of [[{ id: 'other', generation, online: true }], [{ id, generation, online: true }, { id, generation, online: true }], [{ id, generation: 'bad', online: true }]]) assert.throws(() => instances.update('computer', rows));
  assert.equal(instances.owns('computer', id, generation), true);
  const restored = new HostInstances(file); assert.deepEqual(restored.ids(['computer']), ['computer', id]); assert.equal(restored.row(id).online, false);
  instances.update('computer', []); assert.equal(instances.row(id).online, false);
});

test('损坏的实例编号不能用于构造逃逸的数据目录', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-invalid-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'instances.json'); fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ id: '../../other', home: root, userData: 'default', ordinal: 1 }] }));
  assert.throws(() => new InstanceRegistry({ file, hostId: 'computer', defaultHome: root }), /身份记录无效/);
});

test('同号命令在不同实例独立去重，实例重启只核对未知回执而不自动执行', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-journals-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new Journal(path.join(root, 'first.sqlite')), second = new Journal(path.join(root, 'second.sqlite')), id = randomUUID(), params = { threadId: 'same-thread', text: '合成消息' }; let calls = 0;
  await first.execute('phone', id, 'turn.send', params, async () => { calls++; return { instance: 'first' }; });
  await second.execute('phone', id, 'turn.send', params, async () => { calls++; return { instance: 'second' }; });
  assert.equal((await first.execute('phone', id, 'turn.send', params, async () => { calls++; })).instance, 'first'); assert.equal(calls, 2);
  first.db.prepare("UPDATE commands SET state='pending' WHERE command_id=?").run(id); first.close();
  const restored = new Journal(path.join(root, 'first.sqlite'));
  try { assert.equal(restored.status('phone', id).state, 'unknown'); await assert.rejects(restored.execute('phone', id, 'turn.send', params, async () => { calls++; }), error => error.code === 'OUTCOME_UNKNOWN'); assert.equal(calls, 2); assert.equal(second.status('phone', id).state, 'done'); }
  finally { restored.close(); second.close(); }
});
