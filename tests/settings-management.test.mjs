import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {componentContext} from './helpers/component-context.mjs';

const ref = value => ({value});
const computed = get => ({get value() { return get(); }});
const script = file => fs.readFileSync(file, 'utf8').split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\r?\n/gm, '');

/** 执行真实连接页脚本，人工控制确认框、操作锁与配对更新的顺序。 */
function fixture(configured = true) {
  const modals = [], calls = [], lifecycle = {}, watchers = [];
  const connection = {configured, connected: true, hostId: 'host-a', activeThreadId: 'thread-a', snapshot: {threadId: 'thread-a'}, configurationRevision: 1, computers: [{id: 'host-a', label: '合成电脑', online: false}, {id: 'host-b', label: '合成实例', online: true}]};
  const options = {pending: false, saveError: '', clearError: ''};
  const bridge = {hasPendingCommands: () => options.pending, configure(value) { if (options.saveError) throw new Error(options.saveError); calls.push(['configure', value]); connection.configured = true; connection.connected = false; }, forgetConfiguration() { if (options.clearError) throw new Error(options.clearError); calls.push(['forget']); connection.configured = false; }, selectComputer() { assert.fail('设置操作不能切换执行电脑'); }};
  const context = componentContext({ref, computed, watch: (_read, changed) => watchers.push(changed), connection, bridge, computerIcon: () => 'laptop', useManualReconnect: () => () => calls.push(['reconnect']), onLoad: fn => lifecycle.load = fn, onShow: fn => lifecycle.show = fn, onHide: fn => lifecycle.hide = fn, onUnload: fn => lifecycle.unload = fn, onBackPress: fn => lifecycle.back = fn, getCurrentPages: () => [{}], uni: {hideKeyboard() {}, showModal: value => modals.push(value), showToast: value => calls.push(['toast', value.title]), reLaunch: value => calls.push(['route', value.url])}});
  vm.runInContext(stripTypeScriptTypes(script('apps/mobile/pages/connection/index.uvue'), {mode: 'transform'}) + ';globalThis.subject={configuration,configExpanded,connectionAnchor,confirming,editingComputer,editorBusy,editComputer,closeEditor,importConfig,forgetConfiguration,reconnect};', context);
  return {...context.subject, options, connection, calls, modals, lifecycle, watchers};
}

test('连接页查看离线电脑和实例只打开资料快照，取消不改变聊天或订阅', () => {
  const f = fixture(), snapshot = f.connection.snapshot;
  f.editComputer('host-b'); assert.equal(f.editingComputer.value.id, 'host-b');
  assert.notEqual(f.editingComputer.value, f.connection.computers[1]);
  f.closeEditor(); assert.equal(f.editingComputer.value, null);
  f.editComputer('host-a'); assert.equal(f.editingComputer.value.online, false);
  assert.equal(f.connection.hostId, 'host-a'); assert.equal(f.connection.activeThreadId, 'thread-a'); assert.equal(f.connection.snapshot, snapshot);
  assert.equal(f.calls.length, 0);
  f.watchers[0](); assert.equal(f.editingComputer.value, null);
});

test('首次导入不确认且留在连接页，保存成功清空凭据输入，握手前不宣布已连接', () => {
  const f = fixture(false); f.configuration.value = '合成配置'; f.importConfig();
  assert.equal(f.modals.length, 0); assert.equal(f.configuration.value, ''); assert.equal(f.connection.connected, false);
  assert.equal(f.calls.filter(call => call[0] === 'configure').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'route'), false);
  assert.equal(f.calls.at(-1)[1], '配置已保存，正在连接');
});

test('替换配置需确认，取消不覆盖原连接；重复点击只打开一个确认框', () => {
  const f = fixture(); f.configuration.value = '合成配置'; f.importConfig(); f.importConfig();
  assert.equal(f.modals.length, 1); assert.equal(f.confirming.value, true);
  f.modals[0].success({confirm: false}); assert.equal(f.configuration.value, '合成配置'); assert.equal(f.calls.length, 0);
  f.importConfig(); f.modals[1].success({confirm: true}); assert.equal(f.calls[0][0], 'configure'); assert.equal(f.configuration.value, '');
});

test('确认期间出现待核对操作、配对改变或离页后，不执行旧的替换和清除', () => {
  for (const action of ['importConfig', 'forgetConfiguration']) {
    for (const change of ['pending', 'pairing', 'hide', 'unload']) {
      const f = fixture(); f.configuration.value = '合成配置'; f[action]();
      if (change === 'pending') f.options.pending = true;
      if (change === 'pairing') { f.connection.configurationRevision++; f.watchers[0](); }
      if (change === 'hide') f.lifecycle.hide();
      if (change === 'unload') f.lifecycle.unload();
      f.modals[0].success({confirm: true});
      assert.equal(f.calls.some(call => call[0] === 'configure' || call[0] === 'forget'), false, change);
    }
  }
});

test('保存和清除失败保留原连接与输入，错误提示不泄漏原始异常', () => {
  const f = fixture(false); f.configuration.value = '无效配置'; f.options.saveError = '模拟包含私密内容的异常'; f.importConfig();
  assert.equal(f.configuration.value, '无效配置'); assert.equal(f.calls.at(-1)[1], '配置无效，请核对电脑生成的内容');
  const g = fixture(); g.options.clearError = '模拟私密异常'; g.forgetConfiguration(); g.modals[0].success({confirm: true});
  assert.equal(g.connection.configured, true); assert.match(g.calls.at(-1)[1], /无法清除本地连接/);
});

test('旧添加入口展开配置；清除取消不操作，确认后保留页面并重连入口仅恢复连接', () => {
  const f = fixture(); f.lifecycle.load({add: 'true'}); assert.equal(f.configExpanded.value, true); assert.equal(f.connectionAnchor.value, 'connection-config');
  f.forgetConfiguration(); f.modals[0].success({confirm: false}); assert.equal(f.calls.length, 0);
  f.forgetConfiguration(); f.modals[1].success({confirm: true}); assert.equal(f.connection.configured, false); assert.equal(f.calls[0][0], 'forget');
  f.reconnect(); assert.equal(f.calls.at(-1)[0], 'reconnect');
});

test('连接概览按全部实例统计，断线不保留实时在线结论', () => {
  const connection = {configured: false, connected: false, status: '尚未配置', error: '', computers: []};
  const context = vm.createContext({connection, computed});
  const source = fs.readFileSync('apps/mobile/services/connection-presentation.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replaceAll('export ', '');
  vm.runInContext(stripTypeScriptTypes(source, {mode: 'transform'}) + ';globalThis.subject={connectionStatusLabel,connectionSummary,computerConnectionLabel};', context);
  const s = context.subject; assert.equal(s.connectionStatusLabel.value, '未配置');
  connection.configured = true; connection.status = '正在连接'; assert.equal(s.connectionStatusLabel.value, '连接中');
  connection.status = '等待重连'; assert.equal(s.connectionStatusLabel.value, '重连中');
  connection.status = '需要重新配对'; assert.equal(s.connectionStatusLabel.value, '连接失败'); assert.match(s.connectionSummary.value, /已失效/);
  connection.connected = true; assert.match(s.connectionSummary.value, /暂无可访问/);
  connection.computers = [{id: 'pc', online: true}, {id: 'pc-instance', online: true}, {id: 'offline', online: false}];
  assert.equal(s.connectionStatusLabel.value, '已连接'); assert.equal(s.connectionSummary.value, '2 台在线，共 3 台电脑或实例');
  connection.computers.forEach(item => item.online = false); assert.match(s.connectionSummary.value, /^0 台在线/);
  connection.computers[0].online = true; connection.connected = false;
  assert.equal(s.computerConnectionLabel(connection.computers[0]), '待更新'); assert.doesNotMatch(s.connectionSummary.value, /台在线/);
});

test('浏览器通知拒绝和不支持时没有无效开启入口，测试操作仅在就绪后显示', () => {
  const state = {supported: true, permission: 'default', enabled: false, ready: false, error: '', busy: false};
  const context = componentContext({ref, computed, browserNotifications: state, browserNotificationLabel: () => '', enableBrowserNotifications() {}, disableBrowserNotifications() {}, testBrowserNotification() {}});
  vm.runInContext(stripTypeScriptTypes(script('apps/mobile/components/browser-notification-setting/browser-notification-setting.uvue'), {mode: 'transform'}) + ';globalThis.subject={canEnable,canRetry,description};', context);
  const s = context.subject; assert.equal(s.canEnable.value, true);
  state.permission = 'denied'; assert.equal(s.canEnable.value, false); assert.match(s.description.value, /站点设置/);
  state.permission = 'granted'; state.supported = false; assert.equal(s.canEnable.value, false); assert.equal(s.canRetry.value, false);
  state.supported = true; state.enabled = true; state.error = '初始化失败'; assert.equal(s.canRetry.value, true); assert.equal(s.description.value, '初始化失败');
  state.ready = true; assert.equal(s.canRetry.value, false);
  const source = fs.readFileSync('apps/mobile/components/browser-notification-setting/browser-notification-setting.uvue', 'utf8');
  assert.match(source, /v-if="browserNotifications.ready"/);
});
