import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// 执行页面脚本，模拟刷新时握手晚到以及离开页面后的电脑上线。
function fixture(read = async () => ({ tasks: [], getNumber: () => 0 })) {
  const page = fs.readFileSync('apps/mobile/pages/task-history/index.uvue', 'utf8');
  const source = page.split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\r?\n/gm, '');
  let changed, show, hide;
  const calls = [];
  const scope = vm.createContext({
    ref: value => ({ value }), computed: read => ({ get value() { return read(); } }),
    watch: (read, callback) => { changed = callback; },
    onLoad: () => {}, onShow: callback => { show = callback; }, onHide: callback => { hide = callback; }, onUnload: () => {},
    connection: { connected: false, computers: [], cacheNamespace: 'synthetic' },
    bridge: { resume: () => calls.push('恢复连接') },
    readSubmissionTasks: async (id, params) => { calls.push(id); return read(id, params); },
    submissionHistoryOrder: () => 0,
  });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={error,loading,reload,refreshHistory,refreshing,cursors,hostId,state};', scope);
  return { scope, calls, show: () => show(), hide: () => hide(), changed: () => changed() };
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
  page.refreshHistory(); page.refreshHistory();
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
  f.scope.subject.refreshHistory();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scope.subject.refreshing.value, false);
  assert.equal(f.scope.subject.error.value, '合成读取失败');
  f.scope.connection.connected = false;
  f.scope.subject.refreshHistory();
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
  f.scope.subject.refreshHistory();
  f.scope.subject.state.value = 'failed'; f.scope.subject.reload();
  pending[0]({ tasks: [], getNumber: () => 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scope.subject.refreshing.value, true);
  pending[1]({ tasks: [], getNumber: () => 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scope.subject.refreshing.value, false);
});
