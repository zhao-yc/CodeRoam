import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { deleteThread } from '../apps/bridge/thread-delete.mjs';
import { DesktopDeleteController } from '../apps/bridge/desktop-delete.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeError, validateRequest, WRITE_METHODS } from '../packages/protocol/contracts.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 使用独立合成状态覆盖真实删除编排，不连接原桌面或删除真实数据。 */
function fixture({ running = false, stopFails = false, lost = false } = {}) {
  const calls = [], tree = [{ id: 'root', archived: false }, { id: 'child', archived: false }, { id: 'archived', archived: true }];
  const adapter = new EventEmitter(), owner = { clientId: 'desktop', hostId: 'local' };
  adapter.conversations = new Map(); adapter.native = {};
  for (const item of tree.slice(0, 2)) adapter.conversations.set(item.id, { owner: { ...owner }, watchers: new Set(item.id === 'root' ? ['phone'] : []), state: { status: running ? 'active' : 'idle', activeTurnId: running ? 'turn-' + item.id : '', approvals: [], questionGroups: [] } });
  let removed = false;
  adapter.index = { readDeletionTree: () => tree.map(item => ({ ...item })), existingThreadIds: ids => removed ? [] : ids };
  adapter.subscribed = (id, device) => { const entry = adapter.conversations.get(id); if (!entry?.watchers.has(device)) throw new Error('未订阅'); return entry; };
  adapter.discoverOwner = async id => adapter.conversations.get(id)?.owner ?? null;
  adapter.watch = async (id, device) => { const entry = adapter.conversations.get(id); entry.watchers.add(device); calls.push('read:' + id); return { ...entry.state }; };
  adapter.operate = async (method, params) => { calls.push(method + ':' + params.threadId); if (stopFails) throw new Error('停止失败'); const state = adapter.conversations.get(params.threadId).state; state.activeTurnId = ''; state.status = 'idle'; state.approvals = []; state.questionGroups = []; };
  adapter.unwatch = (id, device) => { const entry = adapter.conversations.get(id); entry?.watchers.delete(device); if (entry && !entry.watchers.size) adapter.conversations.delete(id); };
  adapter.close = () => {};
  const controller = { async delete(_params, verify) { calls.push('prepare'); await verify(); calls.push('delete'); removed = true; if (lost) throw new BridgeError('DELETE_OUTCOME_UNKNOWN', '连接中断', true); } };
  return { adapter, controller, calls, tree };
}

test('永久删除为严格白名单写接口，拒绝目录、子对话列表和原生命令', () => {
  const request = params => ({ v: 1, type: 'request', requestId: 'delete-command-001', method: 'thread.delete', params });
  assert.equal(WRITE_METHODS.has('thread.delete'), true); validateRequest(request({ threadId: 'root' }));
  for (const extra of [{ cwd: '/synthetic' }, { deletedThreadIds: ['other'] }, { method: 'thread/delete' }, { force: true }]) assert.throws(() => validateRequest(request({ threadId: 'root', ...extra })));
});

test('主对话与子对话都停止并回读后才删除，成功后清理订阅', async () => {
  const f = fixture({ running: true }); let receipt;
  const result = await deleteThread(f.adapter, f.controller, 'root', 'phone', value => { receipt = value; });
  assert.deepEqual(result, { threadId: 'root', deleted: true, deletedThreadIds: ['root', 'child', 'archived'] }); assert.deepEqual(receipt, result);
  for (const id of ['root', 'child']) assert.ok(f.calls.indexOf('turn.stop:' + id) < f.calls.indexOf('delete'));
  assert.equal(f.adapter.conversations.size, 0); assert.equal(f.calls.some(call => call.includes('approval.reply')), false);
});

test('停止失败不打开删除入口，保留手机原订阅', async () => {
  const f = fixture({ running: true, stopFails: true }); await assert.rejects(deleteThread(f.adapter, f.controller, 'root', 'phone'), { code: 'DELETE_STOP_FAILED' });
  assert.equal(f.calls.includes('prepare'), false); assert.equal(f.adapter.conversations.get('root').watchers.has('phone'), true);
});

test('原生确认框准备期间关联范围变化时不提交删除', async () => {
  const f = fixture(); f.controller.delete = async (_params, verify) => { f.tree.push({ id: 'new-child', archived: false }); await verify(); f.calls.push('delete'); };
  await assert.rejects(deleteThread(f.adapter, f.controller, 'root', 'phone'), { code: 'THREAD_CHANGED' }); assert.equal(f.calls.includes('delete'), false);
});

test('最终回读之后原桌面取消确认框仍为明确失败，不虚报删除结果未知', async () => {
  const f = fixture(); let prepared = false;
  f.controller.delete = async (_params, verify) => { await verify(); prepared = true; throw new BridgeError('DELETE_TARGET_CHANGED', '原桌面确认框已取消，对话尚未删除'); };
  await assert.rejects(deleteThread(f.adapter, f.controller, 'root', 'phone'), { code: 'DELETE_TARGET_CHANGED', outcomeUnknown: false });
  assert.equal(prepared, true); assert.equal(f.calls.includes('delete'), false);
});

test('提交表达式明确回报目标已变化时不保留未知删除状态', async () => {
  let verified = false;
  const page = { close() {}, async step(phase) { if (phase === 'inspect') return { target: true, matched: true, ready: true, dialog: true }; return { state: phase === 'open' ? 'opened' : 'changed' }; } };
  const controller = new DesktopDeleteController({ platform: 'win32', discover: async () => [{ pid: 42, port: 1234 }], fetcher: async () => ({ ok: true, text: async () => JSON.stringify([{ id: 'synthetic', type: 'page', url: 'app://-/index.html' }]) }), openPage: async () => page });
  await assert.rejects(controller.delete({ threadId: 'root', hostId: 'local', commandId: 'synthetic-command', deadline: Date.now() + 5000, native: { processId: 42, navigate: async () => {} } }, async () => { verified = true; }), { code: 'DELETE_TARGET_CHANGED', outcomeUnknown: false });
  assert.equal(verified, true);
});

test('提交后断线与部分删除均保留未知结果，不能登记成功', async () => {
  for (const partial of [false, true]) {
    const f = fixture({ lost: !partial }); let checkpointed = false;
    if (partial) f.adapter.index.existingThreadIds = () => ['child'];
    await assert.rejects(deleteThread(f.adapter, f.controller, 'root', 'phone', value => { checkpointed = value.deleted === true; }), { outcomeUnknown: true });
    assert.equal(checkpointed, false); assert.equal(f.calls.filter(call => call === 'delete').length, 1);
  }
});

test('重复请求由账本去重，原命令可恢复成功回执', async t => {
  const f = fixture(), journal = new Journal(); const agent = new BridgeAgent({ config: {}, adapter: f.adapter, journal, deleteController: f.controller }); t.after(() => agent.close());
  const request = { v: 1, type: 'request', requestId: 'delete-command-001', method: 'thread.delete', deviceId: 'phone', params: { threadId: 'root' } };
  const responses = await Promise.all([agent.handleRequest(request), agent.handleRequest(request)]);
  assert.equal(responses[0].result?.deleted, true); assert.deepEqual(responses[1].result, responses[0].result);
  assert.equal(f.calls.filter(call => call === 'delete').length, 1); assert.equal(journal.status('phone', request.requestId).result.deleted, true);
});

test('桌面控制绑定同一原生进程，提交前回读失败不会点击删除', async () => {
  const steps = [], page = { close() {}, async step(phase) { steps.push(phase); if (phase === 'inspect') return { target: true, dialog: true, matched: true, ready: true }; return { state: phase === 'open' ? 'opened' : 'submitted' }; } };
  const controller = new DesktopDeleteController({ platform: 'win32', discover: async () => [{ pid: 42, port: 1234 }], fetcher: async () => ({ ok: true, text: async () => JSON.stringify([{ id: 'synthetic', type: 'page', url: 'app://-/index.html' }]) }), openPage: async url => { assert.equal(url, 'ws://127.0.0.1:1234/devtools/page/synthetic'); return page; } });
  await assert.rejects(controller.delete({ threadId: 'root', hostId: 'local', commandId: 'command', deadline: Date.now() + 5000, native: { processId: 42, navigate: async () => {} } }, async () => { throw new Error('状态变化'); }), { code: 'DELETE_UNAVAILABLE' });
  assert.equal(steps.includes('commit'), false); assert.equal(steps.at(-1), 'cancel');
});

test('回执丢失后只读核对完整范围，部分删除和跨设备查询不能收口', async t => {
  for (const partial of [false, true]) {
    const f = fixture({ lost: true }), journal = new Journal();
    if (partial) f.adapter.index.existingThreadIds = () => ['child'];
    journal.append('root', { snapshot: { threadId: 'root' } }); journal.append('child', { snapshot: { threadId: 'child' } }); journal.append('other', { snapshot: { threadId: 'other' } });
    const agent = new BridgeAgent({ config: {}, adapter: f.adapter, journal, deleteController: f.controller }); t.after(() => agent.close());
    const request = { v: 1, type: 'request', requestId: 'delete-command-unknown', method: 'thread.delete', deviceId: 'phone', params: { threadId: 'root' } };
    assert.equal((await agent.handleRequest(request)).error.outcomeUnknown, true);
    const check = { v: 1, type: 'request', requestId: 'check-command-unknown', method: 'command.status', deviceId: 'other-phone', params: { commandId: request.requestId } };
    assert.equal((await agent.handleRequest(check)).result.state, 'not_found');
    check.deviceId = 'phone'; const status = (await agent.handleRequest(check)).result;
    assert.equal(status.state, partial ? 'unknown' : 'done'); assert.equal(f.calls.filter(call => call === 'delete').length, 1);
    if (!partial) { assert.equal(status.result.deleted, true); assert.deepEqual(journal.db.prepare('SELECT thread_id FROM events').all().map(row => row.thread_id), ['other']); }
  }
});

test('定位失败保留匹配诊断，不记录页面内容或进入最终删除', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-diagnostic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'delete-ui-diagnostics.jsonl'), phases = [];
  const page = { close() {}, async step(phase) { phases.push(phase); return { target: true, targetCount: 2, visibleCount: 0, aliasCount: 2, title: '不应记录的合成标题', content: '不应记录的合成正文' }; } };
  const controller = new DesktopDeleteController({ platform: 'win32', diagnosticPath: file, discover: async () => [{ pid: 42, port: 1234 }], fetcher: async () => ({ ok: true, text: async () => JSON.stringify(['one', 'two'].map(id => ({ id, type: 'page', url: 'app://-/index.html' }))) }), openPage: async () => page });
  await assert.rejects(controller.delete({ threadId: 'root', hostId: 'local', commandId: 'synthetic-command', deadline: Date.now() + 5000, native: { processId: 42, navigate: async () => {} } }, async () => { throw new Error('不应进入回读提交'); }), { code: 'DELETE_TARGET_UNAVAILABLE', message: '原桌面多个窗口包含该聊天，请关闭重复窗口后重试' });
  assert.equal(phases.includes('open'), false); assert.equal(phases.includes('commit'), false);
  const text = fs.readFileSync(file, 'utf8'), entries = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.find(entry => entry.phase === 'locate').aliasCount, 2);
  assert.equal(entries.find(entry => entry.phase === 'located').candidateCount, 2);
  assert.equal(entries.at(-1).committed, false);
  assert.equal(text.includes('合成标题'), false); assert.equal(text.includes('合成正文'), false);
});
