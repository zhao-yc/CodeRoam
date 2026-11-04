import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 执行真实页面查询流程，验证旧实例失败不会影响其他实例的记录和标题。 */
test('执行记录按实例隔离错误，失败实例不继续翻页，成功实例仍解析聊天标题', async () => {
  const page = fs.readFileSync('apps/mobile/pages/task-history/index.uvue', 'utf8');
  const body = page.slice(page.indexOf('async function loadMore()'), page.indexOf('function reload()'));
  const calls = [], titles = [], cursors = { value: [{ hostId: 'legacy-host', more: true, before: 0 }, { hostId: 'current-host', more: true, before: 0 }] };
  const rows = { value: [] }, error = { value: '' }, loading = { value: false };
  const context = vm.createContext({
    request: 1, connection: { connected: true, cacheNamespace: 'synthetic-pair' }, category: { value: 'operation' }, state: { value: '' },
    loading, error, rows, cursors, refreshing: { value: false }, hostName: id => id, submissionHistoryOrder: () => 0,
    readSubmissionTasks: async (hostId, params) => {
      calls.push({ hostId, params });
      if (hostId === 'legacy-host') throw Error('请更新连接服务');
      return { tasks: [{ id: 'synthetic-operation', kind: 'operation', threadTitle: '持久化标题' }], getBoolean: () => true, getNumber: () => 0 };
    },
    loadChatTitles: async hostId => { titles.push(hostId); },
  });
  vm.runInContext(stripTypeScriptTypes(body, { mode: 'transform' }) + '\nglobalThis.load=loadMore;', context);
  await context.load();
  assert.equal(calls.length, 2); assert.equal(calls[1].params.category, 'operation');
  assert.equal(rows.value[0].task.threadTitle, '持久化标题'); assert.equal(rows.value.length, 1); assert.equal(rows.value[0].hostId, 'current-host');
  assert.equal(titles.length, 0); assert.match(error.value, /legacy-host：请更新连接服务/);
  assert.equal(cursors.value[0].more, false); assert.equal(loading.value, false);
});
