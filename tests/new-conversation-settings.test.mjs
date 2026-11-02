import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';

const selected = { model: 'model-a', effort: 'medium', serviceTier: '', mode: 'default' };
const models = [{ id: selected.model, defaultEffort: 'medium', efforts: ['medium', 'high'], speeds: [{ id: '' }] }];

/** 按真实桌面的原始字段和 JSON 传输检查条件，初建会话尚未保存推理强度。 */
class NewConversationDesktop extends EventEmitter {
  constructor(effort) {
    super();
    this.socket = { writable: true }; this.calls = []; this.revision = 0;
    this.state = {
      id: 'created-thread', cwd: '/', latestModel: selected.model, latestReasoningEffort: effort,
      latestThreadSettings: { model: selected.model, effort, serviceTier: null },
      latestCollaborationMode: { mode: 'default', settings: { model: selected.model, reasoning_effort: effort } },
      modelProvider: 'openai', turns: [], requests: [],
    };
  }
  async connect() {}
  async findOwner(_id, hostId) { return hostId === 'local' ? { clientId: 'desktop', hostId } : null; }
  broadcast(method, params) { if (method === 'thread-stream-following-changed' && params.following) this.publish(); }
  publish() {
    const revision = ++this.revision, conversationState = JSON.parse(JSON.stringify(this.state));
    queueMicrotask(() => this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { hostId: 'local', conversationId: this.state.id, change: { type: 'snapshot', revision, conversationState } } }));
  }
  async request(method, original) {
    const params = JSON.parse(JSON.stringify(original));
    this.calls.push({ method, params });
    if (method === 'thread-follower-read-model-settings') return { resultType: 'success', result: { settings: { model: selected.model, reasoningEffort: this.state.latestReasoningEffort, modelProvider: 'openai' } } };
    if (method === 'thread-follower-update-thread-settings') {
      this.beforeUpdate?.();
      const condition = params.condition;
      if (condition && (this.state.latestReasoningEffort !== condition.ifEffortEquals || condition.ifModelEquals != null && this.state.latestModel !== condition.ifModelEquals)) return { resultType: 'success', result: { applied: false } };
      Object.assign(this.state, { latestModel: params.threadSettings.model, latestReasoningEffort: params.threadSettings.effort, latestThreadSettings: params.threadSettings, latestCollaborationMode: params.threadSettings.collaborationMode });
      this.publish();
      return { resultType: 'success', result: { applied: true } };
    }
    return { resultType: 'success', result: { ok: true } };
  }
  close() {}
}

/** 执行手机实际新建编排并接入实际桥接适配器，只有桌面传输使用合成数据。 */
function fixture(t, effort) {
  const client = new NewConversationDesktop(effort);
  const adapter = new DesktopAdapter({ client, modelCatalog: { read: () => models } });
  t.after(() => adapter.close());
  const connection = { hostId: 'pc', connected: true, computers: [{ id: 'pc', online: true }], snapshot: null };
  let creations = 0, commands = 0;
  const bridge = {
    pendingCommand: () => '',
    async request(method, params) {
      const value = method === 'thread.create' ? (++creations, { threadId: client.state.id }) : await adapter.operate(method, params, 'command-' + ++commands, 'phone');
      return Object.assign(value, { getString(key) { return this[key] ?? null; } });
    },
    async openCreatedThread(id) { connection.snapshot = await adapter.watch(id, 'phone', { history: false }); },
  };
  const context = vm.createContext({ reactive: value => value, uni: { removeStorageSync() {} }, bridge, connection, saveDraft() {}, saveDraftImages() {}, saveDraftFiles() {}, rememberSubmission() {}, settleSubmission() {} });
  const source = stripTypeScriptTypes(fs.readFileSync('apps/mobile/services/new-conversation.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, ''), { mode: 'transform' });
  vm.runInContext(source + '\nglobalThis.subject={newDraft,sendNewConversation};', context);
  const draft = context.subject.newDraft('pc', 'project');
  Object.assign(draft, { text: '合成的新任务', settings: { ...selected }, settingsChanged: true });
  return { client, adapter, draft, send: () => context.subject.sendNewConversation(draft, () => {}), creations: () => creations };
}

test('新建会话原始强度为空时，先应用中等强度再发送且只创建一次', async t => {
  for (const effort of [null, undefined]) {
    const f = fixture(t, effort);
    assert.equal(await f.send(), 'created-thread');
    const update = f.client.calls.find(call => call.method === 'thread-follower-update-thread-settings');
    assert.equal(update.params.condition.ifEffortEquals, effort);
    assert.equal(f.client.state.latestReasoningEffort, 'medium');
    assert.equal(f.creations(), 1);
    const methods = f.client.calls.map(call => call.method);
    assert.ok(methods.indexOf('thread-follower-update-thread-settings') < methods.indexOf('thread-follower-start-turn'));
    assert.equal(methods.filter(method => method === 'thread-follower-start-turn').length, 1);
    assert.equal(f.draft.text, '');
  }
});

test('真实设置冲突保留新建草稿且不发送，用户重试复用已创建的空会话', async t => {
  const f = fixture(t, null);
  f.client.beforeUpdate = () => { f.client.state.latestReasoningEffort = 'high'; f.client.publish(); };
  await assert.rejects(f.send(), { code: 'SETTINGS_CHANGED' });
  assert.equal(f.draft.threadId, 'created-thread');
  assert.equal(f.draft.text, '合成的新任务');
  assert.equal(f.draft.settingsApplied, false);
  assert.equal(f.client.calls.some(call => call.method === 'thread-follower-start-turn'), false);
  f.client.beforeUpdate = null;
  assert.equal(await f.send(), 'created-thread');
  assert.equal(f.creations(), 1);
  assert.equal(f.client.calls.filter(call => call.method === 'thread-follower-start-turn').length, 1);
});
