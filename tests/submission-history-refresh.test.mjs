import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// 执行页面脚本，模拟刷新时握手晚到以及离开页面后的电脑上线。
function fixture(read = async () => ({ tasks: [], getNumber: () => 0 }), tick = async () => {}) {
  const page = fs.readFileSync('apps/mobile/pages/task-history/index.uvue', 'utf8');
  const source = page.split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\r?\n/gm, '');
  let changed, show, hide, back, resize;
  const calls = [];
  const scope = vm.createContext({
    ref: value => ({ value }), computed: read => ({ get value() { return read(); } }),
    nextTick: tick,
    watch: (read, callback) => { changed = callback; },
    onLoad: () => {}, onShow: callback => { show = callback; }, onHide: callback => { hide = callback; }, onUnload: () => {},
    onBackPress: callback => { back = callback; }, onResize: callback => { resize = callback; },
    uni: { hideKeyboard: () => {}, getWindowInfo: () => ({ windowHeight: 640 }) },
    connection: { connected: false, computers: [], cacheNamespace: 'synthetic' },
    bridge: { resume: () => calls.push('恢复连接') },
    readSubmissionTasks: async (id, params) => { calls.push(id); return read(id, params); },
    submissionHistoryOrder: () => 0,
  });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={error,loading,reload,refreshHistory,refreshing,cursors,hostId,state,chooseHost,selectHost,hostPickerOpen,hostPickerHeight};', scope);
  return { scope, calls, show: () => show(), hide: () => hide(), changed: () => changed(), back: () => back(), resize: () => resize() };
}

test('刷新直达记录页，握手和电脑列表分别恢复时自动查询', async () => {
  const f = fixture(); f.show();
  assert.equal(f.scope.subject.error.value, '');
  assert.deepEqual(f.calls, ['恢复连接']);
  f.scope.connection.connected = true; f.changed();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['恢复连接']);
  f.scope.connection.computers = [{ id: 'synthetic-computer', online: true }]; f.changed();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['恢复连接', 'synthetic-computer']);
  assert.equal(f.scope.subject.loading.value, false);
  f.hide(); f.changed();
  assert.deepEqual(f.calls, ['恢复连接', 'synthetic-computer']);
});

test('下拉刷新保留实例和状态筛选、重置分页，重复手势只发一次查询', async () => {
  let finish, query;
  const f = fixture((id, params) => { query = { id, params }; return new Promise(resolve => { finish = resolve; }); });
  f.scope.connection.connected = true;
  f.scope.connection.computers = [{ id: 'synthetic-instance', online: true }];
  const page = f.scope.subject;
  page.hostId.value = 'synthetic-instance'; page.state.value = 'failed';
  page.cursors.value = [{ hostId: 'synthetic-instance', before: 123, more: false }];
  const refresh = page.refreshHistory(); page.refreshHistory();
  await refresh;
  assert.equal(page.refreshing.value, true);
  assert.deepEqual(f.calls, ['synthetic-instance']);
  assert.equal(query.id, 'synthetic-instance');
  assert.equal(query.params.state, 'failed');
  assert.equal(query.params.before, undefined);
  finish({ tasks: [], getNumber: () => 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.refreshing.value, false);
  assert.equal(page.loading.value, false);
  assert.equal(page.hostId.value, 'synthetic-instance');
  assert.equal(page.state.value, 'failed');
});

test('下拉刷新失败、离线和离开页面都能收起刷新状态', async () => {
  const f = fixture(async () => { throw new Error('合成读取失败'); });
  f.scope.connection.connected = true;
  f.scope.connection.computers = [{ id: 'synthetic-instance', online: true }];
  await f.scope.subject.refreshHistory();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scope.subject.refreshing.value, false);
  assert.equal(f.scope.subject.error.value, '合成读取失败');
  f.scope.connection.connected = false;
  await f.scope.subject.refreshHistory();
  assert.equal(f.scope.subject.refreshing.value, false);
  assert.equal(f.calls.at(-1), '恢复连接');
  f.scope.subject.refreshing.value = true;
  f.hide();
  assert.equal(f.scope.subject.refreshing.value, false);
});

test('旧刷新回执不能提前结束筛选切换后的新一轮刷新', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => { pending.push(resolve); }));
  f.scope.connection.connected = true;
  f.scope.connection.computers = [{ id: 'synthetic-instance', online: true }];
  await f.scope.subject.refreshHistory();
  f.scope.subject.state.value = 'failed'; f.scope.subject.reload();
  pending[0]({ tasks: [], getNumber: () => 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scope.subject.refreshing.value, true);
  pending[1]({ tasks: [], getNumber: () => 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scope.subject.refreshing.value, false);
});

test('未配对时先渲染刷新开始再结束；渲染期间离页则取消后续查询', async () => {
  let render;
  const f = fixture(undefined, () => new Promise(resolve => { render = resolve; }));
  const pending = f.scope.subject.refreshHistory();
  assert.equal(f.scope.subject.refreshing.value, true);
  assert.deepEqual(f.calls, []);
  render(); await pending;
  assert.equal(f.scope.subject.refreshing.value, false);
  assert.deepEqual(f.calls, ['恢复连接']);
  const leaving = f.scope.subject.refreshHistory();
  f.hide(); render(); await leaving;
  assert.deepEqual(f.calls, ['恢复连接']);
});

test('实例面板选择只改变记录筛选，重复选择不重查，移除的实例不能被选中', async () => {
  const f = fixture();
  f.scope.connection.connected = true;
  f.scope.connection.hostId = 'current-chat-instance';
  f.scope.connection.computers = [{ id: 'history-instance', online: true }];
  const page = f.scope.subject;
  page.state.value = 'failed'; page.chooseHost();
  assert.equal(page.hostPickerOpen.value, true);
  page.selectHost('history-instance');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.hostId.value, 'history-instance');
  assert.equal(page.state.value, 'failed');
  assert.equal(f.scope.connection.hostId, 'current-chat-instance');
  assert.equal(page.hostPickerOpen.value, false);
  assert.deepEqual(f.calls, ['history-instance']);
  page.chooseHost(); page.selectHost('history-instance');
  assert.deepEqual(f.calls, ['history-instance']);
  assert.equal(page.hostPickerOpen.value, false);
  page.chooseHost(); page.selectHost('removed-instance');
  assert.equal(page.hostId.value, 'history-instance');
  assert.equal(page.hostPickerOpen.value, true);
  assert.equal(f.back(), true);
  assert.equal(page.hostPickerOpen.value, false);
  assert.equal(f.back(), false);
  page.chooseHost(); page.selectHost('');
  assert.equal(page.hostId.value, '');
  assert.equal(page.hostPickerOpen.value, false);
});

test('实例面板按可视高度限制长列表，并在离页时关闭', () => {
  const f = fixture(), page = f.scope.subject;
  f.scope.connection.computers = Array.from({ length: 40 }, (_, i) => ({ id: 'synthetic-' + i }));
  page.chooseHost(); assert.equal(page.hostPickerHeight.value, 380);
  f.scope.uni.getWindowInfo = () => ({ windowHeight: 240 }); f.resize();
  assert.equal(page.hostPickerHeight.value, 80);
  f.hide(); assert.equal(page.hostPickerOpen.value, false);
});
