import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ModelCatalog, executionSettings, validateSettings } from '../apps/bridge/model-settings.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { normalizeConversation } from '../apps/bridge/conversation.mjs';
import { conversationUpdate, applyConversationUpdate } from '../apps/bridge/updates.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { validateRequest } from '../packages/protocol/contracts.mjs';

const models = [
  { id: 'model-a', label: '模型甲', efforts: ['low', 'high', 'max'], defaultEffort: 'high', speeds: [{ id: '' }, { id: 'priority' }] },
  { id: 'model-b', label: '模型乙', efforts: ['medium'], defaultEffort: 'medium', speeds: [{ id: '' }] },
];
const current = { model: 'model-a', effort: 'high', serviceTier: 'priority', mode: 'default' };

/** 模拟原桌面所有者；真实设置更新后通过相同快照广播回读。 */
class SettingsDesktop extends EventEmitter {
  constructor() {
    super(); this.socket = { writable: true }; this.calls = [];
    this.state = { id: 'thread', latestModel: current.model, latestReasoningEffort: current.effort, latestThreadSettings: { ...current }, latestCollaborationMode: { mode: 'default', settings: { model: current.model, reasoning_effort: current.effort, developer_instructions: null } }, modelProvider: 'openai', turns: [], requests: [] };
  }
  async connect() {}
  async findOwner(_id, hostId) { return hostId === 'local' ? { clientId: 'desktop', hostId } : null; }
  broadcast(method, params) { if (method === 'thread-stream-following-changed' && params.following) this.publish(); }
  publish() { queueMicrotask(() => this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: 1, conversationState: structuredClone(this.state) } } })); }
  async request(method, params, version) {
    this.calls.push({ method, params, version });
    if (method === 'thread-follower-read-model-settings') return { resultType: 'success', result: { settings: { model: this.state.latestCollaborationMode?.settings?.model ?? this.state.latestModel, reasoningEffort: this.state.latestReasoningEffort, modelProvider: 'openai' } } };
    if (method === 'thread-follower-update-thread-settings') {
      this.beforeUpdate?.();
      // 与真实桌面一致：条件比较保存字段，而不是已经补全的显示设置。
      const condition = params.condition;
      if (condition && (this.state.latestReasoningEffort !== condition.ifEffortEquals || condition.ifModelEquals != null && this.state.latestModel !== condition.ifModelEquals)) return { resultType: 'success', result: { applied: false } };
      if (this.rejectUpdate) return { resultType: 'success', result: { applied: false } };
      this.state.latestThreadSettings = { ...this.state.latestThreadSettings, ...params.threadSettings };
      this.state.latestModel = params.threadSettings.model; this.state.latestReasoningEffort = params.threadSettings.effort; this.state.latestCollaborationMode = params.threadSettings.collaborationMode;
      this.publish(); return { resultType: 'success', result: { applied: true } };
    }
    return { resultType: 'success', result: { ok: true } };
  }
  close() {}
}

test('模型缓存仅输出可选能力，拒绝过期、缺失和不同提供方目录', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-models-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'models_cache.json');
  const cache = { fetched_at: new Date().toISOString(), identity: '不应回传的账户标识', models: [{ slug: 'model-a', display_name: '模型甲', visibility: 'list', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }], service_tiers: [{ id: 'priority', name: 'Fast' }], input_modalities: ['text'] }, { slug: 'hidden', visibility: 'hide' }] };
  fs.writeFileSync(file, JSON.stringify(cache)); const catalog = new ModelCatalog({ codexHome: home });
  const result = catalog.read(); assert.equal(result.length, 1); assert.deepEqual(result[0].efforts, ['high', 'max']); assert.equal(result[0].supportsImages, false); assert.equal(result[0].speeds[1].label, '快速'); assert.ok(!JSON.stringify(result).includes(cache.identity));
  assert.throws(() => catalog.read('other'), error => error.code === 'CATALOG_UNAVAILABLE');
  cache.fetched_at = new Date(Date.now() - 25 * 3600000).toISOString(); fs.writeFileSync(file, JSON.stringify(cache)); assert.throws(() => catalog.read(), error => error.code === 'CATALOG_EXPIRED');
  fs.unlinkSync(file); assert.throws(() => catalog.read(), error => error.code === 'CATALOG_UNAVAILABLE');
});

test('切换模型降至支持的默认档位，计划模式保留模型和强度且不接受权限字段', () => {
  const changed = validateSettings({ model: 'model-b', mode: 'plan' }, current, models);
  assert.deepEqual(changed.selected, { model: 'model-b', effort: 'medium', serviceTier: '', mode: 'plan' });
  assert.deepEqual(changed.threadSettings.collaborationMode, { mode: 'plan', settings: { model: 'model-b', reasoning_effort: 'medium', developer_instructions: null } });
  for (const changes of [{ approvalPolicy: 'never' }, { sandboxPolicy: {} }, { effort: 'ultra' }, { model: 'unknown' }, { serviceTier: 'ultrafast' }, { mode: 'unknown' }, { effort: 1 }, {}]) assert.throws(() => validateSettings(changes, current, models));
  assert.equal(validateSettings({ mode: 'default' }, { ...current, mode: 'plan' }, models).selected.effort, 'high');
});

test('快照及增量保留真实下一轮设置，历史轮次不冒充当前设置', () => {
  assert.equal(executionSettings({ turns: [{ params: { model: 'old' } }] }), null);
  assert.equal(executionSettings({ latestModel: 'model-a', latestThreadSettings: { serviceTier: 'default' } }).serviceTier, '');
  const first = normalizeConversation({ id: 'thread', latestModel: 'model-a', latestReasoningEffort: 'high', turns: [{ items: [{ id: 'message', type: 'agentMessage', text: '正文'.repeat(1000) }] }] });
  const changed = { ...first, executionSettings: { ...current, mode: 'plan' } };
  const update = conversationUpdate({ snapshot: first, seq: 1 }, changed);
  assert.equal(update.kind, 'delta'); const result = applyConversationUpdate({ snapshot: first, seq: 1, epoch: 'test' }, { ...update, seq: 2, epoch: 'test' });
  assert.equal(result.snapshot.executionSettings.mode, 'plan'); assert.equal(result.snapshot.supportsExecutionSettings, true);
});

test('旧草稿提交常速 default 时规范化且仍拒绝模型未支持的速度', () => {
  const legacy = validateSettings({ effort: 'max', serviceTier: 'default' }, current, models);
  assert.equal(legacy.selected.serviceTier, '');
  assert.equal(legacy.threadSettings.serviceTier, null);
  assert.equal(validateSettings({ effort: 'max' }, { ...current, serviceTier: 'default' }, models).selected.serviceTier, '');
  assert.throws(() => validateSettings({ serviceTier: 'ultrafast' }, current, models), { code: 'SPEED_UNAVAILABLE' });
});

test('模型设置复用原所有者更新与回读，运行中仍不传活动轮次或权限覆盖', async t => {
  const client = new SettingsDesktop(), adapter = new DesktopAdapter({ client, modelCatalog: { read: () => models } }); t.after(() => adapter.close());
  await adapter.watch('thread', 'phone'); client.state.turns = [{ turnId: 'active', status: 'inProgress', items: [] }];
  const result = await adapter.operate('thread.settings.update', { threadId: 'thread', changes: { model: 'model-b', mode: 'plan' } }, 'command', 'phone');
  const call = client.calls.find(call => call.method === 'thread-follower-update-thread-settings');
  assert.equal(call.version, 2); assert.deepEqual(call.params.condition, { ifModelEquals: 'model-a', ifEffortEquals: 'high' });
  assert.equal(call.params.activeTurnId, undefined); assert.equal(call.params.threadSettings.approvalPolicy, undefined); assert.equal(call.params.threadSettings.sandboxPolicy, undefined);
  assert.deepEqual(result.settings, { model: 'model-b', effort: 'medium', serviceTier: '', mode: 'plan' });
  assert.ok(!client.calls.some(call => call.method === 'thread-follower-start-turn'));
});

test('桌面拒绝并发覆盖时明确失败，不给手机返回伪成功', async t => {
  const client = new SettingsDesktop(), adapter = new DesktopAdapter({ client, modelCatalog: { read: () => models } }); t.after(() => adapter.close());
  client.rejectUpdate = true;
  await assert.rejects(adapter.operate('thread.settings.update', { threadId: 'thread', changes: { mode: 'plan' } }, 'command', 'phone'), error => error.code === 'SETTINGS_CHANGED');
  assert.equal(client.state.latestCollaborationMode.mode, 'default');
});

test('计划切换保留原始空强度条件，显示设置仍沿用协作模式的有效强度', async t => {
  for (const effort of [null, undefined]) {
    const client = new SettingsDesktop(), adapter = new DesktopAdapter({ client, modelCatalog: { read: () => models } }); t.after(() => adapter.close());
    client.state.latestReasoningEffort = effort;
    const result = await adapter.operate('thread.settings.update', { threadId: 'thread', changes: { mode: 'plan' } }, 'command', 'phone');
    const call = client.calls.find(call => call.method === 'thread-follower-update-thread-settings');
    assert.equal(call.params.condition.ifEffortEquals, effort);
    assert.deepEqual(result.settings, { ...current, mode: 'plan' });
    assert.equal(client.calls.filter(call => call.method === 'thread-follower-update-thread-settings').length, 1);
    assert.ok(!client.calls.some(call => call.method === 'thread-follower-start-turn'));
  }
});

test('协作模式与保存模型不一致时，以保存字段检查并发并更新实际选项', async t => {
  const client = new SettingsDesktop(), adapter = new DesktopAdapter({ client, modelCatalog: { read: () => models } }); t.after(() => adapter.close());
  client.state.latestModel = 'saved-model';
  const result = await adapter.operate('thread.settings.update', { threadId: 'thread', changes: { mode: 'plan' } }, 'command', 'phone');
  const call = client.calls.find(call => call.method === 'thread-follower-update-thread-settings');
  assert.equal(call.params.condition.ifModelEquals, 'saved-model');
  assert.equal(call.params.threadSettings.model, current.model);
  assert.equal(result.settings.mode, 'plan');
});

test('读取完成后桌面强度真正发生变化时，仍拒绝旧设置且不自动重试', async t => {
  const client = new SettingsDesktop(), adapter = new DesktopAdapter({ client, modelCatalog: { read: () => models } }); t.after(() => adapter.close());
  client.state.latestReasoningEffort = null;
  client.beforeUpdate = () => { client.state.latestReasoningEffort = 'max'; };
  await assert.rejects(adapter.operate('thread.settings.update', { threadId: 'thread', changes: { mode: 'plan' } }, 'command', 'phone'), { code: 'SETTINGS_CHANGED' });
  assert.equal(client.state.latestReasoningEffort, 'max');
  assert.equal(client.state.latestCollaborationMode.mode, 'default');
  assert.equal(client.calls.filter(call => call.method === 'thread-follower-update-thread-settings').length, 1);
});

test('空闲或运行中单独修改模型和推理强度均立即回读桌面确认，保留当前轮次', async t => {
  for (const active of [false, true]) {
    for (const changes of [{ model: 'model-b' }, { effort: 'max' }]) {
      const client = new SettingsDesktop(), adapter = new DesktopAdapter({ client, modelCatalog: { read: () => models } });
      t.after(() => adapter.close());
      if (active) client.state.turns = [{ turnId: 'active', status: 'inProgress', items: [] }];
      const before = structuredClone(client.state.turns);
      const result = await adapter.operate('thread.settings.update', { threadId: 'thread', changes }, 'command', 'phone');
      for (const [key, value] of Object.entries(changes)) assert.equal(result.settings[key], value);
      assert.equal(result.settings.model, client.state.latestCollaborationMode.settings.model);
      assert.equal(result.settings.effort, client.state.latestReasoningEffort);
      assert.deepEqual(client.state.turns, before);
      assert.equal(client.calls.filter(call => call.method === 'thread-follower-update-thread-settings').length, 1);
      assert.equal(client.calls.some(call => /start-turn|steer-turn|interrupt-turn/.test(call.method)), false);
    }
  }
});

test('设置请求使用白名单与业务账本去重，禁止未订阅读取其他会话', async t => {
  const client = new SettingsDesktop(), adapter = new DesktopAdapter({ client, modelCatalog: { read: () => models } }), journal = new Journal();
  const agent = new BridgeAgent({ config: {}, adapter, journal }); t.after(() => agent.close());
  await assert.rejects(adapter.readSettings('thread', 'other'), error => error.code === 'SUBSCRIPTION_REQUIRED');
  const message = { v: 1, type: 'request', requestId: 'settings-command-123456', deviceId: 'phone', method: 'thread.settings.update', params: { threadId: 'thread', changes: { effort: 'max' } } };
  validateRequest(message); const first = await agent.handleRequest(message), second = await agent.handleRequest(message);
  assert.equal(first.error, undefined); assert.deepEqual(first, second); assert.equal(client.calls.filter(call => call.method === 'thread-follower-update-thread-settings').length, 1);
});
