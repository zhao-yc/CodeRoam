import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 执行手机实际连接代码，复现实例仍显示在线但运行代次已经变化的情况。 */
function fixture() {
  const context = vm.createContext({ reactive: x => x, uni: { getStorageSync: () => '', setStorageSync() {}, removeStorageSync() {} }, setTimeout, clearTimeout });
  const source = fs.readFileSync('apps/mobile/services/bridge.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.fixture={MobileBridge,connection,liveThreadLists}', context);
  const { MobileBridge, connection, liveThreadLists } = context.fixture, bridge = new MobileBridge(), watched = [];
  bridge.watch = id => watched.push(id);
  Object.assign(connection, { configured: true, connected: true, hostId: 'computer', activeThreadId: 'thread', epoch: 'old', sequence: 9, snapshot: { threadId: 'thread' }, computers: [{ id: 'computer', online: true, instanceGeneration: 'old' }] });
  const receive = value => bridge.receive({ ...value, getString(key) { return this[key] ?? null; }, getNumber(key) { return this[key] ?? null; } });
  return { bridge, connection, liveThreadLists, watched, receive };
}

test('实例换代立即废弃旧快照和列表序列，只恢复只读订阅', () => {
  const f = fixture(); f.liveThreadLists.updates = [{ hostId: 'computer', revision: 40, threads: [] }];
  f.receive({ type: 'hosts', hosts: [{ id: 'computer', online: true, instanceGeneration: 'new' }] });
  assert.equal(f.connection.snapshot, null); assert.equal(f.connection.epoch, ''); assert.equal(f.connection.sequence, 0); assert.equal(f.liveThreadLists.updates.length, 0); assert.deepEqual(f.watched, ['thread']);
});

test('旧实例的迟到会话及列表推送被拒绝，新代次列表可以重新从小序号开始', () => {
  const f = fixture(); f.receive({ type: 'threads.event', hostId: 'computer', generation: 'stale', revision: 99, threads: [{ id: 'wrong' }] }); assert.equal(f.liveThreadLists.updates.length, 0);
  f.receive({ type: 'event', hostId: 'computer', threadId: 'thread', generation: 'stale', epoch: 'old', seq: 100 }); assert.equal(f.connection.sequence, 9);
  f.receive({ type: 'threads.event', hostId: 'computer', generation: 'old', revision: 1, threads: [{ id: 'correct' }] }); assert.equal(f.connection.threads[0].id, 'correct');
});
