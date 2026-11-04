import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const json = data => data == null ? null : ({ ...data, getBoolean: key => data[key], getString: key => data[key] });
const receipt = () => json({ deleted: true, threadId: 'root', deletedThreadIds: ['root', 'child'] });
const flush = () => new Promise(resolve => setImmediate(resolve));

/** 执行实际应用服务和页面方法，不连接真实电脑或删除真实数据。 */
function fixture(storage = new Map()) {
  const watches = [], timers = new Map(), calls = [], removed = [], drafts = [], caches = [], notices = [], modals = [], life = {};
  let nextTimer = 0, flushing = false;
  function tick() { if (flushing) return; flushing = true; try { for (const w of watches) { const next = w.read(); if (next !== w.last) { const old = w.last; w.last = next; w.callback(next, old); } } } finally { flushing = false; } }
  const c = {
    connection: { cacheNamespace: 'synthetic-pair', connected: true, hostId: 'pc', activeThreadId: 'root', pendingCommands: [], computers: [{ id: 'pc', online: true }, { id: 'other', online: true }], snapshot: { threadId: 'root' }, epoch: 'e', sequence: 1 },
    reactive: value => new Proxy(value, { set(target, key, value) { target[key] = value; tick(); return true; } }),
    watch(source, callback, options = {}) { const read = typeof source === 'function' ? source : () => source.value; const w = { read, callback, last: read() }; watches.push(w); if (options.immediate) callback(w.last); },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    uni: { getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => storage.set(key, value), showToast: options => notices.push(options.title), showModal: options => modals.push(options), showLoading() { throw new Error('后台删除不能全屏等待'); }, hideKeyboard() {}, navigateBack: () => { c.returned++; }, reLaunch: () => { c.returned++; } },
    clearFileReportCache: (...args) => caches.push(args), clearDeletedDrafts: (...args) => drafts.push(args), removeDeletedThreads: (...args) => removed.push(args),
    ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }),
    pageHostId: { value: 'pc' }, pageThreadId: { value: 'root' }, pageVisible: { value: true }, busy: { value: false }, operationError: { value: '' }, archivePromptOpen: false,
    cachedDetail: { value: null }, cacheDirty: false, cacheWriteTimer: 0, historyRequest: 0, historyPage: { value: { messages: ['合成历史'] } }, historyError: { value: '' },
    closeActions() {}, notify: message => notices.push(message), onHide: fn => { life.hide = fn; }, onUnload: fn => { life.unload = fn; }, getCurrentPages: () => [{}, {}], returned: 0,
  };
  c.isCurrentPage = () => c.connection.hostId === c.pageHostId.value && c.connection.activeThreadId === c.pageThreadId.value;
  c.canWrite = { get value() { return c.connection.connected && !c.busy.value && !c.connection.pendingCommands.some(e => e.hostId === c.pageHostId.value && e.threadId === c.pageThreadId.value); } };
  function request(method, hostId, commandId, params) { const call = { method, hostId, commandId, params }; calls.push(call); return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = message => reject(new Error(message)); }); }
  c.bridge = {
    pendingCommand: (hostId, threadId) => c.connection.pendingCommands.find(e => e.hostId === hostId && e.threadId === threadId)?.id ?? '',
    rememberCommand(id, hostId, threadId, method) { if (!this.pendingCommand(hostId, threadId)) c.connection.pendingCommands.push({ id, hostId, threadId, method, namespace: c.connection.cacheNamespace }); },
    clearCommand(id, hostId) { c.connection.pendingCommands = c.connection.pendingCommands.filter(e => e.id !== id || e.hostId !== hostId); },
    syncPendingCommand() {}, restoreDeletionCommands() {},
    submitDeletion(threadId, commandId) { this.rememberCommand(commandId, c.connection.hostId, threadId, 'thread.delete'); return request('thread.delete', c.connection.hostId, commandId, { threadId }); },
    readCommandStatus: (hostId, commandId) => request('command.status', hostId, commandId, { commandId }),
  };
  const context = componentContext(c);
  const service = fs.readFileSync('apps/mobile/services/delete-tasks.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(service, { mode: 'transform' }) + '\nglobalThis.manager={deletionTasks,startDeletionTasks,startDeletion,checkDeletion,reconcileTasks,backgroundDeletionTasks,resumeDeletionTasks,deletionPending,acceptReceipt};', context);
  c.manager.startDeletionTasks();
  c.emit = () => { c.uni.navigateBack(); };
  const page = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
  const methods = page.slice(page.indexOf('// 永久删除必须完成两次独立确认'), page.indexOf('// 归档只在原生回执'));
  vm.runInContext(stripTypeScriptTypes(methods, { mode: 'transform' }) + '\nglobalThis.page={deleteFromMenu,answerDeleteFinal,deleteFinalVisible,deleteFinalContent};', context);
  return { c, ...c.manager, ...c.page, storage, calls, removed, drafts, caches, notices, modals, life, timers, tick,
    begin() { c.page.deleteFromMenu(); modals.at(-1).success({ confirm: true }); c.page.answerDeleteFinal(true); return calls.findLast(call => call.method === 'thread.delete'); },
    runTimer(delay) { const pair = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(pair, `缺少 ${delay}ms 定时器`); timers.delete(pair[0]); pair[1].fn(); },
  };
}

test('两次确认后只提交一次，第二层无名称且执行时不锁住页面', async () => {
  const f = fixture(); f.deleteFromMenu(); f.deleteFromMenu(); assert.equal(f.modals.length, 1); assert.equal(f.calls.length, 0);
  f.modals[0].success({ confirm: true }); assert.equal(f.deleteFinalContent.value, '正在执行的任务会先停止。确认永久删除吗？');
  f.answerDeleteFinal(true); f.answerDeleteFinal(true); assert.equal(f.calls.length, 1); assert.equal(f.c.busy.value, false); assert.equal(f.startDeletion('pc', 'root'), false);
  const persisted = f.storage.get('codex-mobile-delete-tasks-v1-synthetic-pair'); assert.ok(persisted.includes(f.calls[0].commandId)); assert.equal(persisted.includes('合成历史'), false);
  f.calls[0].resolve(receipt()); await flush(); assert.equal(f.c.returned, 1); assert.equal(f.deletionTasks.tasks.length, 0);
  f.runTimer(250); assert.deepEqual(f.notices, ['永久删除成功']);
});

test('任一步取消、切换目标或离开页面后旧确认均不发请求', () => {
  for (const action of ['first', 'second', 'hide', 'unload', 'host', 'thread']) {
    const f = fixture(); f.deleteFromMenu();
    if (action === 'first') f.modals[0].success({ confirm: false });
    else { f.modals[0].success({ confirm: true }); if (action === 'hide') f.life.hide(); if (action === 'unload') f.life.unload(); if (action === 'host') f.c.connection.hostId = 'other'; if (action === 'thread') f.c.pageThreadId.value = 'other'; f.tick(); f.answerDeleteFinal(action !== 'second'); }
    assert.equal(f.calls.length, 0); assert.equal(f.drafts.length, 0);
  }
});

test('返回并打开其他电脑聊天后，成功只清理原目标且不导航', async () => {
  const f = fixture(), call = f.begin(); f.c.pageVisible.value = false; f.life.hide(); f.life.unload();
  f.c.connection.hostId = 'other'; f.c.connection.activeThreadId = 'root'; f.c.pageHostId.value = 'other';
  const currentSnapshot = { threadId: 'root', messages: [{ id: 'same-id', text: '另一台电脑的正文' }] };
  const currentPreview = { threadId: 'root', readOnly: true, messages: [{ id: 'same-id', text: '另一台电脑的预览' }] };
  f.c.connection.snapshot = currentSnapshot; f.c.connection.preview = currentPreview;
  f.tick(); call.resolve(receipt()); await flush();
  assert.equal(f.c.returned, 0); assert.equal(f.c.connection.activeThreadId, 'root'); assert.equal(f.c.historyPage.value.messages[0], '合成历史');
  assert.equal(f.removed[0][0], 'pc'); assert.deepEqual(Array.from(f.removed[0][1]), ['root', 'child']); assert.equal(f.drafts[0][0], 'pc'); assert.deepEqual(Array.from(f.drafts[0][1]), ['root', 'child']);
  assert.equal(f.removed.length, 1); assert.equal(f.drafts.length, 1); assert.equal(f.caches.length, 1);
  assert.equal(f.caches[0][0], 'synthetic-pair'); assert.equal(f.caches[0][1], 'pc'); assert.deepEqual(Array.from(f.caches[0][2]), ['root', 'child']);
  assert.equal(f.c.connection.snapshot, currentSnapshot); assert.equal(f.c.connection.preview, currentPreview);
  assert.equal(f.acceptReceipt({ namespace: 'synthetic-pair', hostId: 'pc', threadId: 'root' }, receipt()), false); assert.equal(f.removed.length, 1);
});

test('明确失败保留历史和草稿，未知结果继续保护原目标', async () => {
  for (const known of [true, false]) {
    const f = fixture(), call = f.begin(); if (known) f.c.bridge.clearCommand(call.commandId, call.hostId); call.reject(known ? '停止失败' : '结果需要核对'); await flush();
    assert.equal(f.deletionTasks.tasks[0].state, known ? 'failed' : 'unknown'); assert.equal(f.deletionPending('pc', 'root'), !known); assert.equal(f.removed.length, 0); assert.equal(f.drafts.length, 0); assert.notEqual(f.c.historyPage.value, null);
  }
});

test('锁屏断线后向原电脑核对成功，不重放删除或停止', async () => {
  const f = fixture(), call = f.begin(); f.backgroundDeletionTasks(); f.c.connection.connected = false; f.tick(); call.reject('连接中断'); await flush();
  f.c.pageVisible.value = false; f.c.connection.hostId = 'other'; f.c.connection.activeThreadId = 'different'; f.resumeDeletionTasks(); f.c.connection.connected = true; f.tick();
  const check = f.calls.at(-1); assert.equal(check.method, 'command.status'); assert.equal(check.hostId, 'pc'); assert.equal(check.commandId, call.commandId);
  check.resolve(json({ state: 'done', result: receipt() })); await flush(); assert.equal(f.removed.length, 1); assert.equal(f.c.returned, 0); assert.equal(f.calls.filter(e => e.method === 'thread.delete').length, 1);
});

test('刷新恢复及目标不在列表时仍保留原编号核对入口', async () => {
  const first = fixture(), call = first.begin(), reopened = fixture(first.storage);
  assert.equal(reopened.calls.some(e => e.method === 'thread.delete'), false);
  const check = reopened.calls.at(-1); assert.equal(check.method, 'command.status'); assert.equal(check.commandId, call.commandId); check.resolve(json({ state: 'not_found' })); await flush();
  assert.equal(reopened.deletionTasks.tasks[0].state, 'unknown'); assert.equal(reopened.deletionPending('pc', 'root'), true); assert.match(fs.readFileSync('apps/mobile/components/chat-list/chat-list.uvue', 'utf8'), /<deletion-task-list/);
});

test('存储失败不发送，重新配对后旧回执不清理新配对', async () => {
  const blocked = fixture(); blocked.c.uni.setStorageSync = () => { throw new Error('禁止存储'); }; blocked.begin(); assert.equal(blocked.calls.length, 0); assert.equal(blocked.deletionTasks.tasks.length, 0); assert.match(blocked.c.operationError.value, /无法保存/);
  const late = fixture(), call = late.begin(); late.c.connection.cacheNamespace = 'new-pair'; late.tick(); call.resolve(receipt()); await flush(); assert.equal(late.removed.length, 0); assert.equal(late.drafts.length, 0); assert.equal(late.c.returned, 0);
});

test('运行中三秒核对，未知结果停止轮询且不能依据部分回执清理', async () => {
  const f = fixture(); f.begin(); f.runTimer(3000); const check = f.calls.at(-1); assert.equal(check.method, 'command.status'); check.resolve(json({ state: 'pending' })); await flush();
  assert.equal(f.deletionTasks.tasks[0].state, 'running'); f.runTimer(3000); f.calls.at(-1).resolve(json({ state: 'unknown', result: json({ deletionPending: true, threadId: 'root', deletedThreadIds: ['root', 'child'] }) })); await flush();
  assert.equal(f.deletionTasks.tasks[0].state, 'unknown'); assert.equal(f.removed.length, 0); assert.equal([...f.timers.values()].some(timer => timer.delay === 3000), false); assert.equal(f.calls.filter(e => e.method === 'thread.delete').length, 1);
});

test('旧版待核对记录和多电脑同号聊天各自隔离', async () => {
  const f = fixture(); f.c.connection.pendingCommands = ['pc', 'other'].map((hostId, i) => ({ hostId, threadId: 'root', id: 'legacy-delete-command-' + i, method: 'thread.delete' })); f.reconcileTasks(); assert.equal(f.deletionTasks.tasks.length, 2); assert.equal(f.calls.length, 2);
  f.c.pageVisible.value = false; f.calls[0].resolve(json({ state: 'done', result: receipt() })); f.calls[1].resolve(json({ state: 'unknown' })); await flush(); assert.equal(f.deletionPending('pc', 'root'), false); assert.equal(f.deletionPending('other', 'root'), true); assert.equal(f.removed[0][0], 'pc');
});
