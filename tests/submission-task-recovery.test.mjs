import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync('apps/mobile/components/submission-task-list/submission-task-list.uvue', 'utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm, '');
/** 执行实际组件脚本，只替换手机接口与弹窗，避免真实写操作。 */
function fixture(states) {
  const calls = [], modals = [], navigations = [];
  let reads = 0;
  const instance = { hostId: 'synthetic-host', snapshot: { paused: true, blockerId: 'synthetic-blocker' } };
  const scope = vm.createContext({
    computed: getter => ({ get value() { return getter(); } }), ref: value => ({ value }), defineProps: () => ({}), withDefaults: (props, defaults) => ({ ...defaults, ...props }), defineEmits: () => () => {},
    submissionTasks: { instances: [], pending: [] }, connection: { computers: [] },
    readSubmissionTasks: async (hostId, params) => {
      calls.push({ hostId, method: 'list', taskId: params.taskId });
      const state = states[Math.min(reads++, states.length - 1)];
      const snapshot = { paused: true, blockerId: 'synthetic-blocker', tasks: [{ id: 'synthetic-blocker', state: 'failed' }], ...state };
      return Object.assign(snapshot, { getBoolean: key => snapshot[key], getString: key => snapshot[key] });
    },
    controlSubmissionTask: async (hostId, taskId, action, confirmed) => { calls.push({ hostId, taskId, action, confirmed }); },
    uni: { navigateTo: value => navigations.push(value), showModal: modal => modals.push(modal) },
  });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={recoverPaused,working,error};', scope);
  return { ...scope.subject, calls, modals, navigations, instance };
}

test('已关闭的失败卡仍可从暂停提示直接继续，操作锁防止重复点击', async () => {
  const f = fixture([{}]);
  const first = f.recoverPaused(f.instance), duplicate = f.recoverPaused(f.instance);
  await Promise.all([first, duplicate]);
  assert.deepEqual(f.calls.map(call => call.action ?? call.method), ['list', 'resume']);
  assert.ok(f.calls.every(call => call.hostId === f.instance.hostId && call.taskId === 'synthetic-blocker'));
  assert.equal(f.working.value, ''); assert.equal(f.modals.length, 0);
});

test('未知任务先只读核对，确认成功后才继续后续任务', async () => {
  const f = fixture([{ tasks: [{ id: 'synthetic-blocker', state: 'unknown' }] }, { tasks: [{ id: 'synthetic-blocker', state: 'succeeded' }] }]);
  await f.recoverPaused(f.instance);
  assert.deepEqual(f.calls.map(call => call.action ?? call.method), ['list', 'reconcile', 'list', 'resume']);
  assert.equal(f.modals.length, 0);
});

test('无法核对的任务取消确认不执行，明确确认只跳过原任务而不重发', async () => {
  const f = fixture([{ tasks: [{ id: 'synthetic-blocker', state: 'unknown' }] }]);
  await f.recoverPaused(f.instance);
  assert.deepEqual(f.calls.map(call => call.action ?? call.method), ['list', 'reconcile', 'list']);
  assert.equal(f.modals.length, 1);
  f.modals[0].success({ confirm: false }); assert.equal(f.calls.length, 3);
  f.modals[0].success({ confirm: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1).action, 'skip'); assert.equal(f.calls.at(-1).confirmed, true);
});

test('暂停原因变化或属于其他设备时，不恢复错误的任务', async () => {
  const f = fixture([{ blockerId: 'another-blocker' }]);
  await f.recoverPaused(f.instance);
  assert.equal(f.calls.length, 1); assert.match(f.error.value, /暂停原因已变化/);
  f.instance.snapshot.blockerId = ''; await f.recoverPaused(f.instance);
  assert.equal(f.calls.length, 1); assert.equal(f.navigations.length, 1);
});
