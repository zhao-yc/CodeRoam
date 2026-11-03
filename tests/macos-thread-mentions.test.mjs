import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { InstanceHub } from '../apps/bridge/instance-hub.mjs';
import { ThreadMentionDesktop } from '../apps/bridge/thread-mention-desktop.mjs';
import { ThreadMentionService } from '../apps/bridge/thread-mentions.mjs';

/** 运行真实 Python 发现器，只有内核快照来自合成夹具，输出直接进入生产 Hub 和引用检查。 */
function discover(instances, extra = {}) {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./macos-discovery-fixture.py', import.meta.url))], { input: JSON.stringify({ instances, ...extra }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** 只替换桌面页面求值，保留发现、实例归属复核、端点绑定及候选门禁。 */
async function fixture(t, instances) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-mentions-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let rows = discover(instances).rows;
  const hub = new InstanceHub({ config: { hostId: 'synthetic', codexHome: '/synthetic/101' }, dataPath: root, discover: async () => rows,
    createRuntime: ({ instance }) => ({ instance, agent: new EventEmitter(), async ready() { await instance.verify(); instance.ready = true; }, async close() { instance.alive = false; instance.ready = false; } }), bindOwners: () => assert.fail('Mac 不借用全局实例') });
  t.after(() => hub.close()); await hub.refresh();
  const readers = [], urls = []; let duringEvaluate = () => {};
  t.after(() => readers.forEach(reader => reader.close()));
  const service = instance => {
    const reader = new ThreadMentionDesktop({ evaluate: async () => [], discover: async () => assert.fail('不得全局扫描'), resolveModules: () => ({}),
      fetcher: async url => { urls.push(url); return { ok: true, text: async () => JSON.stringify([{ type: 'page', id: 'SYNTHETIC', url: 'app://-/index.html' }]) }; },
      evaluateNative: async () => { await duringEvaluate(); return { supported: true, references: [], contextText: '' }; } });
    readers.push(reader);
    // 合成求值仍须通过模块名称校验，使用生产表达式允许的格式。
    reader.resolveModules = () => ({ initial: 'app-initial-abc.js', primary: 'app-primary-def.js', capability: 'thread-reference-capability-abc.js', formatter: 'fmt', readCapability: 'read', managerHostAtom: 'manager', conversationAtom: 'metadata', submitAtom: 'submit' });
    return new ThreadMentionService({ client: { instance, assertCurrent() { assert.ok(instance.ready); } }, index: { listMentions: () => ({ threads: [], hasMore: false }) } }, reader);
  };
  return { hub, service, urls, replace: next => { rows = discover(next).rows; }, during: fn => { duringEvaluate = fn; } };
}

test('Mac 发现器到引用检查：两实例有端口时分别绑定，无端口不借用另一实例', async t => {
  const f = await fixture(t, [{ pid: 101 }, { pid: 202, port: '23452' }]);
  const [one, two] = [...f.hub.runtimes.values()].map(r => r.instance);
  await assert.rejects(f.service(one).list({}), { code: 'THREAD_MENTIONS_UNAVAILABLE' });
  assert.equal(f.urls.length, 0);
  assert.equal((await f.service(two).list({})).supportsThreadMentions, true);
  assert.ok(f.urls.every(url => url.startsWith('http://127.0.0.1:23452/')));
  const both = await fixture(t, [{ pid: 101, port: '23451' }, { pid: 202, port: '23452' }]);
  for (const r of both.hub.runtimes.values()) assert.equal((await both.service(r.instance).list({})).supportsThreadMentions, true);
  assert.equal(new Set(both.urls.map(url => new URL(url).port)).size, 2);
});

test('Mac 拒绝其他进程、其他实例和非回环端口，不进行原生求值', async t => {
  for (const extra of [{ listenerPid: 999 }, { listenerPid: 202 }, { address: '*' }, { address: '0.0.0.0' }, { address: '[::1]' }]) {
    const f = await fixture(t, [{ pid: 101, port: '23451', ...extra }, { pid: 202 }]);
    const instance = [...f.hub.runtimes.values()][0].instance;
    assert.equal(instance.port, null);
    await assert.rejects(f.service(instance).list({}), { code: 'THREAD_MENTIONS_UNAVAILABLE' }); assert.equal(f.urls.length, 0);
  }
});

test('Mac 动态端口文件须属于本实例、本用户且晚于启动；重复参数拒绝', () => {
  const row = { pid: 101, port: '0', activePort: '23451' };
  assert.equal(discover([row]).rows[0].port, 23451);
  for (const extra of [{ stale: true }, { foreignFile: true }, { symlink: true }, { listenerPid: 999 }, { extraArgs: ['--remote-debugging-port=23452'] }, { activePort: '65536' }]) assert.equal(discover([{ ...row, ...extra }]).rows[0].port, null);
  assert.equal(discover([{ pid: 101, port: '23451', childPid: 303 }], { childParent: 101 }).rows[0].port, 23451);
  assert.equal(discover([{ pid: 101, port: '23451', childPid: 303 }], { childParent: 1 }).rows[0].port, null);
});

test('Mac 发现期间启动时间变化拒绝整份身份；引用求值期间重启不接纳旧结果', async t => {
  assert.equal(discover([{ pid: 101, port: '23451', restart: true }]).error, '实例身份已变化');
  const f = await fixture(t, [{ pid: 101, port: '23451' }]); const old = [...f.hub.runtimes.values()][0].instance;
  f.during(async () => { f.replace([{ pid: 102, port: '23451' }]); });
  await assert.rejects(f.service(old).list({}), { code: 'THREAD_MENTIONS_UNAVAILABLE' });
  assert.equal(old.ready, false);
});

test('Mac 引用读取前后端口换绑立即失效，下一轮发现重新生成实例代次', async t => {
  const f = await fixture(t, [{ pid: 101, port: '23451' }]); const old = [...f.hub.runtimes.values()][0].instance;
  const oldGeneration = old.generation;
  f.replace([{ pid: 101, port: '23452' }]);
  await assert.rejects(old.verify(), { code: 'INSTANCE_NOT_READY' });
  await f.hub.refresh(); const next = [...f.hub.runtimes.values()][0].instance;
  assert.notEqual(next.generation, oldGeneration); assert.equal(next.port, 23452); assert.equal(old.alive, false);
});
