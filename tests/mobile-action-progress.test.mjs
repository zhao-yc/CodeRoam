import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { componentContext } from './helpers/component-context.mjs';

const ref = value => ({ value });
const flush = () => new Promise(setImmediate);

/** 执行页面真实方法，检查审批回执只解除原按钮且不会刷新其他电脑。 */
test('拒绝审批只标记所选操作，失败可重试，切换电脑后忽略旧回执', async () => {
  const page = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
  const begin = page.indexOf('function reply(id: string');
  const pending = [];
  let refreshes = 0;
  const scope = componentContext({
    busy: ref(false), pendingAction: ref(''), operationError: ref(''), handledApprovalIds: ref([]),
    pageHostId: ref('pc-a'), pageThreadId: ref('thread'), connection: { hostId: 'pc-a' },
    bridge: { request: (...request) => new Promise((resolve, reject) => pending.push({ request, resolve, reject })) },
    isCurrentPage: () => scope.connection.hostId === scope.pageHostId.value,
    canWrite: { get value() { return !scope.busy.value; } }, notify() {}, refresh() { refreshes++; }
  });
  vm.runInContext(stripTypeScriptTypes(page.slice(begin, page.indexOf('\n}', begin) + 2)) + '\nglobalThis.reply = reply;', scope);
  scope.reply('approval-a', 'turn', 'decline');
  scope.reply('approval-a', 'turn', 'decline');
  assert.equal(pending.length, 1);
  assert.equal(scope.pendingAction.value, 'approval:decline:approval-a');
  assert.match(page, /@click="reply\(approval.id, approval.turnId, 'decline'\)"[^>]*正在提交拒绝/);
  pending[0].reject(Error('合成请求超时')); await flush();
  assert.equal(scope.pendingAction.value, '');
  assert.equal(scope.operationError.value, '合成请求超时');
  scope.reply('approval-a', 'turn', 'decline');
  scope.connection.hostId = 'pc-b';
  pending[1].resolve({}); await flush();
  assert.deepEqual(scope.handledApprovalIds.value, []);
  assert.equal(scope.pendingAction.value, '');
  assert.equal(refreshes, 0);
});

/** 以同步观察模拟同一事件循环内的断开和自动重连。 */
test('手动重连只跟踪本次握手，自动重连和其他入口各自独立', () => {
  const source = fs.readFileSync('apps/mobile/services/manual-reconnect.uts', 'utf8').replace(/^import .*\n/gm, '').replace('export ', '');
  const connection = { connected: false, connectionAttempt: 0 };
  const observers = [];
  let resumes = 0;
  function setAttempt(value) {
    connection.connectionAttempt = value;
    for (const changed of observers) changed(value);
  }
  const scope = vm.createContext({
    connection, ref, watch: (_read, changed) => observers.push(changed),
    bridge: { resume() { resumes++; if (!connection.connectionAttempt) setAttempt(1); } }
  });
  vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.entry = useManualReconnect;', scope);
  const first = scope.entry(), second = scope.entry();
  first.reconnect(); first.reconnect();
  assert.equal(resumes, 1);
  assert.equal(first.reconnecting.value, true);
  assert.equal(second.reconnecting.value, false);
  setAttempt(0); setAttempt(2);
  assert.equal(first.reconnecting.value, false);
  second.reconnect();
  assert.equal(second.reconnecting.value, true);
  setAttempt(0);
  assert.equal(second.reconnecting.value, false);
});
