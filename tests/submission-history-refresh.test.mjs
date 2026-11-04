import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// 执行页面脚本，模拟刷新时握手晚到以及离开页面后的电脑上线。
function fixture() {
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
    readSubmissionTasks: async id => { calls.push(id); return { tasks: [], getNumber: () => 0 }; },
    submissionHistoryOrder: () => 0,
  });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={error,loading,reload};', scope);
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
