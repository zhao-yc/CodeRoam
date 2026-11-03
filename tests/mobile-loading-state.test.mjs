import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// 执行页面真实计算逻辑，覆盖初次加载、切换会话和旧服务的能力判断。
test('会话加载期间不误报升级，收到当前会话后恢复真实模型状态', () => {
  const source = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
  const start = source.indexOf('const executionSettingsUnavailable =');
  const end = source.indexOf('const modelSupportsImages =', start);
  const context = componentContext({
    computed: fn => ({ get value() { return fn(); } }),
    connection: { connected: true, snapshot: null }, pageThreadId: { value: 'current' },
    settingsBusy: { value: false }, settings: { value: null }, models: { value: [] },
    shortModelLabel: label => label, effortLabel: label => label
  });
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)) + ';globalThis.state={executionSettingsUnavailable,modelLabel};', context);
  const state = context.state;
  assert.equal(state.executionSettingsUnavailable.value, false);
  assert.equal(state.modelLabel.value, '正在加载…');
  context.connection.snapshot = { threadId: 'previous', readOnly: true, supportsExecutionSettings: false };
  assert.equal(state.executionSettingsUnavailable.value, false);
  assert.equal(state.modelLabel.value, '正在加载…');
  context.connection.snapshot = { threadId: 'current', supportsExecutionSettings: true };
  assert.equal(state.executionSettingsUnavailable.value, false);
  assert.equal(state.modelLabel.value, '跟随电脑端');
  context.settings.value = { model: 'example-model', effort: 'high' };
  assert.equal(state.modelLabel.value, 'example-model high');
  context.connection.snapshot.supportsExecutionSettings = false;
  assert.equal(state.executionSettingsUnavailable.value, true);
  delete context.connection.snapshot.supportsExecutionSettings;
  assert.equal(state.executionSettingsUnavailable.value, true);
  context.connection.snapshot = null; context.connection.connected = false;
  assert.equal(state.executionSettingsUnavailable.value, false);
  assert.equal(state.modelLabel.value, '等待连接');
});
