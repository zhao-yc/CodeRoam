import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDeleteController } from '../apps/bridge/native-delete.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

/** 合成索引同时保留归档和未归档记录，模拟原桌面持有者与官方删除连接。 */
function fixture(mode = {}) {
  const calls = [], rows = new Map([['root', false], ['child', false], ['archived', true]]);
  const instance = { alive: true, ready: true, ...mode, async verify() { if (!this.alive) throw new BridgeError('INSTANCE_CHANGED', '合成实例已变化'); } };
  const adapter = { client: { instance, assertCurrent() { if (!instance.alive) throw new BridgeError('INSTANCE_CHANGED', '合成实例已变化'); } }, index: { existingThreadIds: ids => ids.filter(id => rows.has(id)), readDeletionTree: () => [...rows].map(([id, archived]) => ({ id, archived })) } };
  const archiveController = { async archive(params, verify) { await verify(); calls.push(['archive', params.threadId]); rows.set(params.threadId, true); } };
  const creation = { codexHome: '/synthetic-home', async run(cwd, action) { calls.push(['connect', cwd]); return action(async (method, params) => { calls.push([method, params.threadId]); rows.delete(params.threadId); return {}; }); } };
  const controller = new NativeDeleteController({ adapter, archiveController, creation });
  const params = { threadId: 'root', hostId: 'local', commandId: 'synthetic-delete-command', deadline: Date.now() + 10000, deletionTree: [...rows].map(([id, archived]) => ({ id, archived })), async verifyArchive(item) { calls.push(['verify', item.id]); } };
  const verify = async () => { calls.push(['checkpoint', 'root']); };
  return { controller, adapter, archiveController, creation, calls, rows, instance, params, verify };
}

for (const mode of [{ directIpc: true }, { routerManaged: true }, { routerManaged: true, port: 12345 }]) {
  test('原生永久删除兼容启动方式 ' + JSON.stringify(mode), async () => {
    const f = fixture(mode);
    await f.controller.delete(f.params, f.verify);
    assert.equal(f.rows.size, 0);
    assert.deepEqual(f.calls, [
      ['connect', '/synthetic-home'], ['checkpoint', 'root'], ['verify', 'child'], ['archive', 'child'], ['verify', 'root'], ['archive', 'root'],
      ['thread/delete', 'archived'], ['thread/delete', 'child'], ['thread/delete', 'root'],
    ]);
  });
}

test('官方删除回执丢失时仅核对原编号，已消失继续收口且每个目标只调用一次', async () => {
  const f = fixture();
  f.creation.run = async (_cwd, action) => action(async (method, params) => {
    f.calls.push([method, params.threadId]); f.rows.delete(params.threadId);
    throw new BridgeError('CREATION_NOT_READY', '合成回执丢失');
  });
  await f.controller.delete(f.params, f.verify);
  assert.equal(f.rows.size, 0);
  assert.equal(f.calls.filter(([method]) => method === 'thread/delete').length, 3);
});

test('部分删除或归档失败保留未知状态，不把归档当删除且不自动重放', async () => {
  const f = fixture();
  f.creation.run = async (_cwd, action) => action(async (_method, params) => {
    if (params.threadId === 'child') throw Error('合成连接中断');
    f.rows.delete(params.threadId);
  });
  await assert.rejects(f.controller.delete(f.params, f.verify), { code: 'DELETE_OUTCOME_UNKNOWN', outcomeUnknown: true });
  assert.deepEqual([...f.rows], [['root', true], ['child', true]]);
  const archived = fixture();
  archived.archiveController.archive = async (_params, verify) => { await verify(); throw Error('合成归档回执丢失'); };
  await assert.rejects(archived.controller.delete(archived.params, archived.verify), { code: 'DELETE_OUTCOME_UNKNOWN', outcomeUnknown: true });
  assert.equal(archived.rows.size, 3);
});

test('初始化或最终核验失败时不开始归档，实例换代立即停止', async () => {
  const f = fixture();
  f.creation.run = async () => { throw new BridgeError('CREATION_NOT_READY', '合成初始化失败'); };
  await assert.rejects(f.controller.delete(f.params, f.verify), { code: 'DELETE_UNAVAILABLE', outcomeUnknown: false });
  assert.equal(f.calls.length, 0);
  const changed = fixture(); changed.instance.alive = false;
  await assert.rejects(changed.controller.delete(changed.params, changed.verify), { code: 'INSTANCE_CHANGED', outcomeUnknown: false });
  assert.deepEqual(changed.calls, [['connect', '/synthetic-home']]);
});

test('提交后索引不可读仍返回未知，底层错误正文不透传', async () => {
  const f = fixture();
  f.archiveController.archive = async (_params, verify) => {
    await verify();
    f.adapter.index.existingThreadIds = () => { throw Error('合成内部私有信息'); };
    throw Error('合成内部私有信息');
  };
  await assert.rejects(f.controller.delete(f.params, f.verify), error => error.code === 'DELETE_OUTCOME_UNKNOWN' && error.outcomeUnknown === true && !error.message.includes('私有信息'));
});

test('归档后新增附属会话或被重新打开时停止永久删除', async () => {
  for (const change of [rows => rows.set('unexpected', true), rows => rows.set('child', false)]) {
    const f = fixture(), archive = f.archiveController.archive;
    f.archiveController.archive = async (...args) => { await archive(...args); if (args[0].threadId === 'root') change(f.rows); };
    await assert.rejects(f.controller.delete(f.params, f.verify), { code: 'DELETE_OUTCOME_UNKNOWN', outcomeUnknown: true });
    assert.equal(f.calls.some(([method]) => method === 'thread/delete'), false);
  }
});
