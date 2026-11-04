import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runNewConversationTask } from '../apps/bridge/new-conversation-task.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

/** 组合任务只使用合成原生状态，逐步检查设置、权限、附件与发送的顺序。 */
function fixture(mode = 'desktopIpc', extra = {}) {
  const calls = [], scopes = [], updates = [], sends = [], checkpoints = new Map(), task = { id: randomUUID(), deviceId: 'phone', title: '合成新聊天', payload: { projectId: 'project', mode, text: '合成消息', images: [], attachments: ['synthetic-upload-123456'], choices: { effort: 'high' }, ...extra } };
  const state = { settings: { model: 'model', effort: 'medium', serviceTier: '', mode: 'default' }, models: [{ id: 'model', supportsImages: true }], permissions: { mode: 'default', revision: 'permission-1' } };
  const draftId = randomUUID(); let revision = 1, leased = false, nativeText = false, owned = false;
  const native = () => ({ draftId, revision, status: 'ready', ...structuredClone(state), hasDesktopText: nativeText, supportsThreadMentions: true });
  const agent = {
    newThreads: { project: async id => ({ id, label: '合成项目', cwd: 'synthetic-project' }) },
    retainTaskThread: async () => { assert.equal(owned, true, '空聊天必须先由原桌面加载'); leased = true; return () => { leased = false; calls.push('release'); }; },
    adapter: {
      watch: async (_id, watcher, options = {}) => { if (options.activate) { assert.match(watcher, /^submission-open:/); owned = true; calls.push('activate'); return; } assert.equal(leased, true); calls.push('watch'); },
      readSettings: async () => { assert.equal(leased, true); return structuredClone(state); },
      readPermissions: async () => { assert.equal(leased, true); return structuredClone(state.permissions); },
      attachments: { bindScope: async (deviceId, source, target, ids) => { calls.push('bind'); scopes.push({ deviceId, source, target, ids }); } },
    },
    nativeDrafts: { read: async () => native() },
    runTaskCommand: async (method, params, deviceId, commandId, guard) => {
      assert.equal(deviceId, 'phone'); assert.match(commandId, /^step-/); calls.push(method);
      if (method === 'thread.create') return { threadId: 'created-thread' };
      if (method === 'thread.settings.update') { Object.assign(state.settings, params.changes); return { ok: true }; }
      if (method === 'thread.permissions.update') { state.permissions.mode = params.mode; state.permissions.revision = 'permission-2'; return { ok: true }; }
      if (method === 'turn.send') { sends.push(params); assert.equal(guard.permissionRevision, state.permissions.revision); return { ok: true, threadId: params.threadId }; }
      if (method === 'thread.draft.open') return native();
      if (method === 'thread.draft.update') {
        assert.equal(params.expectedRevision, revision);
        const { permissionMode, ...settings } = params.changes; Object.assign(state.settings, settings);
        if (permissionMode) state.permissions.mode = permissionMode;
        revision++; return native();
      }
      if (method === 'thread.draft.send') { assert.equal(params.expectedRevision, revision); return { threadId: 'native-created-thread' }; }
      throw new Error('意外的合成命令');
    },
  };
  const context = {
    update: changes => { updates.push(changes); Object.assign(task, changes); },
    retainScope: scope => scopes.push({ retained: scope }),
    step: async (name, operation) => {
      if (checkpoints.has(name)) return checkpoints.get(name);
      const result = await operation('step-' + randomUUID()); checkpoints.set(name, result); return result;
    },
  };
  return { agent, task, context, calls, scopes, updates, sends, state, checkpoints, setNativeText: value => { nativeText = value; }, leased: () => leased };
}

test('普通新建只创建和发送，选择随首条请求提交而不独立应用', async () => {
  const f = fixture(), result = await runNewConversationTask(f.agent, f.task, f.context);
  assert.deepEqual(result, { ok: true, threadId: 'created-thread' });
  assert.deepEqual(f.calls, ['thread.create', 'activate', 'watch', 'bind', 'watch', 'turn.send', 'release']);
  assert.equal(f.sends[0].choices.effort,'high');assert.equal(f.state.settings.effort,'medium');
  assert.equal(f.scopes.find(scope => scope.target)?.source, 'task:' + f.task.id);
  assert.equal(f.scopes.find(scope => scope.target)?.target, 'created-thread'); assert.equal(f.leased(), false);
});

test('创建后原桌面加载失败保留创建编号并释放独立观察者，不发送首条或再次创建', async () => {
  const f = fixture(), released = [];
  f.agent.adapter.watch = async (_id, watcher, options) => { assert.equal(options.activate, true); assert.match(watcher, /^submission-open:/); throw new BridgeError('OWNER_UNAVAILABLE', '合成桌面尚未加载聊天'); };
  f.agent.adapter.unwatch = (threadId, watcher) => released.push({ threadId, watcher });
  await assert.rejects(runNewConversationTask(f.agent, f.task, f.context), { code: 'OWNER_UNAVAILABLE' });
  assert.deepEqual(f.calls, ['thread.create']);
  assert.equal(f.task.threadId, 'created-thread');
  assert.equal(released.length, 1); assert.match(released[0].watcher, /^submission-open:/);
  assert.equal(f.leased(), false);
});

test('组合检查点再次执行时不会重复创建、修改设置或发送', async () => {
  const f = fixture(); await runNewConversationTask(f.agent, f.task, f.context); await runNewConversationTask(f.agent, f.task, f.context);
  assert.equal(f.calls.filter(call => call === 'thread.create').length, 1);
  assert.equal(f.calls.filter(call => call === 'turn.send').length, 1);
});

test('原生新建保持最新草稿修订，附件绑定草稿范围并在首条确认后返回正式编号', async () => {
  const f = fixture('nativeDraft', {choices:{}}), result = await runNewConversationTask(f.agent, f.task, f.context);
  assert.deepEqual(result, { ok: true, threadId: 'native-created-thread' });
  assert.deepEqual(f.calls, ['thread.draft.open', 'bind', 'thread.draft.send']);
  assert.match(f.scopes.find(scope => scope.target)?.target, /^draft:/);
});

test('完整访问缺少显式确认时，在创建桌面聊天之前拒绝', async () => {
  for (const mode of ['desktopIpc', 'nativeDraft']) {
    const f = fixture(mode, { choices: { permissionMode: 'full-access' } });
    await assert.rejects(runNewConversationTask(f.agent, f.task, f.context), { code: 'PERMISSION_CONFIRMATION_REQUIRED' }); assert.deepEqual(f.calls, []);
  }
});

test('跟随电脑默认值遇到完整访问时，也必须显式选择和确认', async () => {
  for (const mode of ['desktopIpc', 'nativeDraft']) {
    const f = fixture(mode, { choices: { permissionMode: 'desktop-default' } }); f.state.permissions.mode = 'full-access';
    await assert.rejects(runNewConversationTask(f.agent, f.task, f.context), { code: 'PERMISSION_CONFIRMATION_REQUIRED' });
    assert.equal(f.calls.includes('turn.send'), false); assert.equal(f.calls.includes('thread.draft.send'), false); assert.equal(f.leased(), false);
  }
});

test('附件处理期间电脑默认设置变化时，显式选择仍随首条请求发送', async () => {
  const f = fixture();
  f.agent.adapter.attachments.bindScope = async () => { f.state.settings.effort = 'low'; };
  await runNewConversationTask(f.agent, f.task, f.context);
  assert.equal(f.sends[0].choices.effort, 'high');assert.equal(f.state.settings.effort,'low');
  assert.equal(f.task.threadId, 'created-thread'); assert.equal(f.calls.includes('turn.send'), true); assert.equal(f.leased(), false);
});

test('原生已有电脑正文和不支持的插件不会被任务覆盖或静默移除', async () => {
  const occupied = fixture('nativeDraft'); occupied.setNativeText(true);
  await assert.rejects(runNewConversationTask(occupied.agent, occupied.task, occupied.context), { code: 'DRAFT_HAS_DESKTOP_TEXT' }); assert.equal(occupied.calls.includes('thread.draft.send'), false);
  const plugin = fixture('nativeDraft', { pluginIds: ['synthetic-plugin'] });
  await assert.rejects(runNewConversationTask(plugin.agent, plugin.task, plugin.context), { code: 'PLUGINS_UNAVAILABLE' }); assert.deepEqual(plugin.calls, []);
});

test('首条发送结果未知只记录原检查点，不会补发或重新创建', async () => {
  const f = fixture(), original = f.agent.runTaskCommand;
  f.agent.runTaskCommand = async (...args) => { if (args[0] === 'turn.send') { f.calls.push('uncertain-send'); throw new BridgeError('OUTCOME_UNKNOWN', '合成发送回执未知', true); } return original(...args); };
  await assert.rejects(runNewConversationTask(f.agent, f.task, f.context), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.calls.filter(call => call === 'thread.create').length, 1); assert.equal(f.calls.filter(call => call === 'uncertain-send').length, 1);
  assert.equal(f.task.threadId, 'created-thread'); assert.equal(f.leased(), false);
});
