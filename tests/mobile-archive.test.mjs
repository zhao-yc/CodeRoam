import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 执行页面实际归档方法，检查弹窗取消、跨页回执和未知结果恢复。 */
function fixture() {
  const source = fs.readFileSync('apps/mobile/pages/conversation/index.uvue', 'utf8');
  const methods = source.slice(source.indexOf('// 归档只在原生回执'), source.indexOf('// 自动跟随只在靠近底部'));
  const checking = source.slice(source.indexOf('function checkPending()'), source.indexOf('// 目标表单与聊天草稿独立'));
  const json = value => Object.assign(value, { getString(key) { return this[key] ?? null; }, getBoolean(key) { return this[key] ?? null; } });
  const context = { operationError: { value: '' }, pageHostId: { value: 'pc' }, pageThreadId: { value: 'thread' }, pageVisible: { value: true }, canWrite: { value: true }, busy: { value: false }, pendingAction: { value: '' }, checking: { value: false }, activeTurnId: { value: '' }, approvalCount: { value: 0 }, connection: { connected: true, hostId: 'pc', activeThreadId: 'thread', snapshot: { status: 'idle' }, threads: [{ id: 'thread' }, { id: 'other' }], pendingCommandId: '', error: '', epoch: 'epoch', sequence: 5 }, calls: [], notices: [], returned: 0, draft: '保留的草稿' };
  let modal, respond, reject, ledger;
  context.loadingEvents = []; context.unloadCallbacks = [];
  context.onUnload = callback => context.unloadCallbacks.push(callback);
  let home;
  context.uni = { showLoading: options => context.loadingEvents.push(options), hideLoading: () => context.loadingEvents.push('关闭'), showModal: options => { modal = options; }, showToast() {}, navigateBack: () => { context.returned++; home.show(); }, reLaunch: () => { context.returned++; home.show(); } };
  context.bridge = {
    request(method, params, write) { context.calls.push({ method, params, write }); context.connection.pendingCommandId = 'command'; return new Promise((resolve, fail) => { respond = result => { context.connection.pendingCommandId = ''; resolve(json(result)); }; reject = unknown => { if (!unknown) context.connection.pendingCommandId = ''; fail(new Error(unknown ? '结果待核对' : '归档失败')); }; }); },
    clearCommand(id) { if (context.connection.pendingCommandId === id) context.connection.pendingCommandId = ''; },
    checkPending: async () => json(ledger),
  };
  Object.assign(context, { removeArchivedThread() {}, notify: message => context.notices.push(message), closeActions() {}, getCurrentPages: () => [{}, {}], isCurrentPage: () => context.connection.hostId === context.pageHostId.value && context.connection.activeThreadId === context.pageThreadId.value, acceptPlanReceipt: () => false, settleSubmission() {}, refresh() {} });
  const notices = fs.readFileSync('apps/mobile/services/page-notices.uts', 'utf8').replace(/\bexport /g, '');
  vm.runInNewContext(stripTypeScriptTypes(notices + '\n' + methods + checking, { mode: 'transform' }) + '\nglobalThis.subject={archiveFromMenu,checkPending};', context);
  home = homeFixture(context.consumeArchiveSuccessNotice);
  return { ...context.subject, context, home, createHome: () => homeFixture(context.consumeArchiveSuccessNotice), modal: () => modal, respond: value => respond(value), reject: unknown => reject(unknown), ledger: value => { ledger = value; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

/** 在独立页面上下文执行列表的实际生命周期，模拟详情卸载后列表仍然存活。 */
function homeFixture(consumeArchiveSuccessNotice) {
  const source = fs.readFileSync('apps/mobile/pages/index/index.uvue', 'utf8');
  const lifecycle = source.slice(source.indexOf('// 归档反馈属于列表页面'), source.indexOf('// 列表状态来自实际读取结果'));
  const timers = new Map(), callbacks = {};
  let timerId = 0;
  const context = { consumeArchiveSuccessNotice, archiveSuccessVisible: { value: false }, archiveSuccessTimer: 0, pageVisible: { value: false }, editingNewConversation: { value: false }, statusTimer: 0, restoreThreadScroll() {}, updateClock() {}, closeComputerMenu() {}, clearInterval() {}, setInterval: () => 1, setTimeout: (callback, duration) => { timers.set(++timerId, { callback, duration }); return timerId; }, clearTimeout: id => timers.delete(id), onShow: callback => { callbacks.show = callback; }, onHide: callback => { callbacks.hide = callback; }, onUnload: callback => { callbacks.unload = callback; } };
  vm.runInNewContext(stripTypeScriptTypes(lifecycle, { mode: 'transform' }), context);
  return { ...callbacks, visible: context.archiveSuccessVisible, timers };
}

test('菜单归档可取消，重复点击不叠加提交，确认成功后才返回列表且保留草稿', async () => {
  const f = fixture(); f.archiveFromMenu(); f.modal().success({ confirm: false });
  assert.equal(f.context.calls.length, 0); assert.equal(f.context.returned, 0);
  assert.equal(f.context.loadingEvents.length, 0);
  f.archiveFromMenu(); f.modal().success({ confirm: true }); f.context.canWrite.value = false; f.archiveFromMenu();
  assert.equal(f.context.calls.length, 1); assert.equal(f.context.returned, 0); assert.equal(f.context.connection.threads.length, 2);
  assert.equal(f.context.loadingEvents[0].title, '正在归档…'); assert.equal(f.context.loadingEvents[0].mask, true); assert.equal(f.context.notices.length, 0);
  f.respond({ threadId: 'thread', archived: true }); await flush();
  assert.equal(f.context.returned, 1); assert.deepEqual(Array.from(f.context.connection.threads, item => item.id), ['other']);
  assert.equal(f.context.connection.snapshot, null); assert.equal(f.context.connection.activeThreadId, ''); assert.equal(f.context.draft, '保留的草稿');
  assert.equal(f.context.loadingEvents.at(-1), '关闭'); assert.equal(f.context.notices.length, 0);
  assert.equal(f.home.visible.value, true);
});

test('返回或重开列表由列表生命周期显示成功提示，详情卸载和加载框清理不移除提示', async () => {
  for (const reopen of [false, true]) {
    const f = fixture();
    let navigation;
    f.context.getCurrentPages = () => reopen ? [{}] : [{}, {}];
    f.context.uni[reopen ? 'reLaunch' : 'navigateBack'] = options => { navigation = options; };
    f.archiveFromMenu(); f.modal().success({ confirm: true });
    f.respond({ threadId: 'thread', archived: true }); await flush();
    assert.ok(navigation);
    if (reopen) assert.equal(navigation.url, '/pages/index/index');
    assert.equal(f.home.visible.value, false, '列表显示前只交接结果');
    assert.equal(f.context.notices.length, 0, '详情页不显示成功提示');
    const home = reopen ? f.createHome() : f.home;
    home.show();
    f.context.unloadCallbacks.forEach(callback => callback());
    f.context.uni.hideLoading();
    assert.equal(home.visible.value, true, '提示属于列表，不随详情和全局加载框销毁');
    assert.equal(home.timers.size, 1);
    const timer = [...home.timers.values()][0];
    assert.equal(timer.duration, 3000);
    timer.callback();
    assert.equal(home.visible.value, false);
    home.show();
    assert.equal(home.visible.value, false, '旧结果只能消费一次');
  }
});

test('导航失败时在详情提示实际归档结果，并清除待交接提示', async () => {
  const f = fixture();
  f.context.uni.navigateBack = options => options.fail({});
  f.archiveFromMenu(); f.modal().success({ confirm: true });
  f.respond({ threadId: 'thread', archived: true }); await flush();
  assert.deepEqual(f.context.notices, ['归档成功']);
  f.home.show();
  assert.equal(f.home.visible.value, false);
});

test('列表隐藏或卸载时停止提示计时，再次显示不会重复提示', async () => {
  for (const leave of ['hide', 'unload']) {
    const f = fixture();
    f.archiveFromMenu(); f.modal().success({ confirm: true });
    f.respond({ threadId: 'thread', archived: true }); await flush();
    assert.equal(f.home.visible.value, true);
    f.home[leave]();
    assert.equal(f.home.visible.value, false); assert.equal(f.home.timers.size, 0);
    f.home.show(); assert.equal(f.home.visible.value, false);
  }
});

test('确认前切换电脑或任务开始后不会误发归档', () => {
  const f = fixture(); f.archiveFromMenu(); f.context.connection.hostId = 'another'; f.modal().success({ confirm: true }); assert.equal(f.context.calls.length, 0);
  const running = fixture(); running.context.activeTurnId.value = 'turn'; running.archiveFromMenu(); assert.equal(running.modal(), undefined); assert.equal(running.context.calls.length, 0);
});

test('明确失败和未知结果均保留当前页面、列表与草稿，未知结果不自动重试', async () => {
  for (const unknown of [false, true]) {
    const f = fixture(); f.archiveFromMenu(); f.modal().success({ confirm: true }); f.reject(unknown); await flush();
    assert.equal(f.context.returned, 0); assert.equal(f.context.connection.threads.length, 2); assert.equal(f.context.draft, '保留的草稿');
    assert.equal(f.context.calls.length, 1); assert.equal(f.context.connection.pendingCommandId, unknown ? 'command' : '');
    assert.equal(f.context.busy.value, false);
    assert.equal(f.context.operationError.value, unknown ? '结果待核对' : '归档失败');
    assert.equal(f.context.connection.error, '');
    assert.equal(f.context.loadingEvents.at(-1), '关闭'); assert.notEqual(f.context.notices.at(-1), '归档成功');
    f.home.show(); assert.equal(f.home.visible.value, false);
  }
});

test('断线后核对原生成功回执才返回列表，普通未知结果仍保持待确认', async () => {
  for (const confirmed of [true, false]) {
    const f = fixture(); f.context.connection.pendingCommandId = 'command';
    f.ledger({ state: 'unknown', ...(confirmed ? { result: { archived: true, threadId: 'thread', getBoolean(key) { return this[key]; }, getString(key) { return this[key]; } } } : {}) });
    f.checkPending(); await flush();
    assert.equal(f.context.returned, confirmed ? 1 : 0); assert.equal(f.context.connection.pendingCommandId, confirmed ? '' : 'command');
    assert.equal(f.context.calls.length, 0);
  }
});

test('离开页面后的成功回执不导航其他页面，也不清空另一台电脑的会话', async () => {
  const f = fixture(); f.archiveFromMenu(); f.modal().success({ confirm: true }); f.context.connection.hostId = 'another';
  f.context.unloadCallbacks.forEach(callback => callback());
  assert.equal(f.context.loadingEvents.at(-1), '关闭'); const count = f.context.loadingEvents.length;
  f.respond({ threadId: 'thread', archived: true }); await flush();
  assert.equal(f.context.returned, 0); assert.equal(f.context.connection.threads.length, 2); assert.equal(f.context.connection.activeThreadId, 'thread');
  assert.equal(f.context.loadingEvents.length, count); assert.equal(f.context.notices.length, 0);
  f.home.show(); assert.equal(f.home.visible.value, false);
});

test('归档后使在途多电脑列表回执失效，同号会话只从归档电脑移除', async () => {
  const requests = [], connection = { configured: true, connected: true, configurationRevision: 1, computers: [{ id: 'pc', label: '电脑', online: true }, { id: 'other', label: '其他电脑', online: true }] };
  const context = { watch:()=>{}, liveThreadLists:{updates:[]}, reactive: value => value, connection, bridge: { readComputerThreads: hostId => new Promise(resolve => requests.push({ hostId, resolve })) } };
  const source = fs.readFileSync('apps/mobile/services/thread-list.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={threadList,refreshComputerThreads,removeArchivedThread};', context);
  const f = context.subject; f.refreshComputerThreads();
  requests.forEach(request => request.resolve({ threads: [{ id: 'thread' }] })); await flush();
  f.threadList.computers[0].subscribed=false; f.refreshComputerThreads('pc'); f.removeArchivedThread('pc', 'thread'); requests[2].resolve({ threads: [{ id: 'thread' }] }); await flush();
  assert.equal(f.threadList.computers[0].threads.length, 0); assert.equal(f.threadList.computers[1].threads.length, 1);
  f.refreshComputerThreads('pc'); assert.equal(requests.length, 4); requests[3].resolve({ threads: [] }); await flush();
  assert.equal(f.threadList.computers[0].loading, false);
});

test('详情操作开始和失败均不覆盖列表需要展示的连接错误', async () => {
  const f = fixture(); f.context.connection.error = '连接已断开';
  f.archiveFromMenu(); f.modal().success({ confirm: true });
  assert.equal(f.context.connection.error, '连接已断开');
  f.reject(false); await flush();
  assert.equal(f.context.operationError.value, '归档失败');
  assert.equal(f.context.connection.error, '连接已断开');
});

test('返回列表后的迟到归档错误不会写入全局提示', async () => {
  const f = fixture(); f.archiveFromMenu(); f.modal().success({ confirm: true });
  f.context.connection.activeThreadId = ''; f.reject(false); await flush();
  assert.equal(f.context.operationError.value, '');
  assert.equal(f.context.connection.error, '');
});
