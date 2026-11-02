import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { InstanceHub } from '../apps/bridge/instance-hub.mjs';

test('实例退出、PID 复用和管道换代只替换对应上下文，默认账本位置保持不变', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-hub-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaultHome = path.join(root, 'default'), otherHome = path.join(root, 'other');
  let rows = [{ pid: 101, startedAt: 1, nativePipe: 'pipe-one', codexHome: defaultHome }, { pid: 102, startedAt: 2, nativePipe: 'pipe-two', codexHome: otherHome }];
  const created = [];
  const hub = new InstanceHub({ config: { hostId: 'computer', codexHome: defaultHome, label: '合成电脑' }, dataPath: root, discover: async () => rows.map(x => ({ ...x })), createRuntime: ({ instance, dataPath }) => {
    const runtime = { instance, dataPath, agent: new EventEmitter(), ready: async () => { instance.ready = true; }, close: async () => { instance.alive = false; instance.ready = false; runtime.closed = true; } }; created.push(runtime); return runtime;
  } });
  await hub.refresh(); const [first, second] = [...hub.runtimes.values()]; assert.equal(first.dataPath, root); assert.notEqual(second.dataPath, root);
  rows[1].startedAt = 3; await hub.refresh(); assert.equal(second.closed, true); assert.equal(first.closed, undefined); const replacement = [...hub.runtimes.values()][1]; assert.equal(replacement.instance.id, second.instance.id); assert.notEqual(replacement.instance.generation, second.instance.generation);
  rows = [rows[1]]; await hub.refresh(); assert.equal(first.closed, true); assert.equal(hub.runtimes.size, 1); assert.equal(replacement.closed, undefined);
  await hub.close(); assert.equal(replacement.closed, true);
});

test('发现失败立即暂停全部实例，但保留身份和账本供核对', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-unavailable-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fail = false;
  const hub = new InstanceHub({ config: { hostId: 'computer', codexHome: root }, dataPath: root, discover: async () => { if (fail) throw new Error(); return [{ pid: 1, startedAt: 1, nativePipe: 'pipe', codexHome: root }]; }, createRuntime: ({ instance }) => ({ instance, agent: new EventEmitter(), ready: async () => { instance.ready = true; }, close: async () => {} }) });
  await hub.refresh(); const instance = [...hub.runtimes.values()][0].instance; fail = true; await hub.refresh(); assert.equal(instance.ready, false); assert.equal(hub.runtimes.size, 1); await hub.close();
});
