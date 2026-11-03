import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const page = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
const helpers = fs.readFileSync('apps/mobile/services/execution-settings.uts', 'utf8').replace(/\bexport /g, '');
const methods = page.slice(page.indexOf('function loadSettings()'), page.indexOf('// 选中即同步电脑输入框设置'));
const watcherStart = page.indexOf('watch((): string => connection.hostId +');
const watchers = page.slice(watcherStart, page.indexOf('// 占位预测使用独立测量值', watcherStart));
const initial = { model: 'model-a', effort: 'high', serviceTier: '', mode: 'default' };
const catalog = [{ id: 'model-a', efforts: ['low', 'high'], defaultEffort: 'high' }];
const settle = () => new Promise(resolve => setImmediate(resolve));

/** 用真实页面函数和监听器模拟异步顺序，计时器手动推进，避免测试等待及重放写请求。 */
function fixture() {
  const pending = [], subscriptions = [], timers = new Map();
  let timerId = 0;
  const ref = value => ({ value });
  const context = componentContext({
    settingsRequest: 0, settingsSnapshotRevision: 0, settingsRetryTimer: 0, settingsRetryCount: 0,
    settings: ref(null), models: ref([]), settingsLoading: ref(false), settingsBusy: ref(false), settingsError: ref(''),
    readOnly: ref(false), composerMenu: ref(''), actionsVisible: ref(false), canWrite: ref(true),
    pageThreadId: ref('thread-a'), currentPage: true,
    connection: { hostId: 'host-a', activeThreadId: 'thread-a', subscriptionRevision: 1, connected: true,
      snapshot: { threadId: 'thread-a', supportsExecutionSettings: true, executionSettings: { ...initial } } },
    isCurrentPage: () => context.currentPage,
    closeComposerMenu: () => { context.composerMenu.value = ''; },
    changeComposerSection: section => { context.composerMenu.value = section; }, updateMenuHeight() {},
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    bridge: { request: (method, params, write) => {
      assert.equal(method, 'thread.settings.read'); assert.equal(write, undefined);
      return new Promise((resolve, reject) => pending.push({ params, resolve, reject }));
    } },
    watch: (_read, changed) => subscriptions.push(changed),
  });
  vm.runInContext(stripTypeScriptTypes(helpers + '\n' + methods + '\n' + watchers, { mode: 'transform' }), context);
  return { context, pending, subscriptions, timers,
    reply: async (settings = initial, models = catalog) => { pending.shift().resolve({ settings, models }); await settle(); },
    fail: async () => { pending.shift().reject(new Error('读取超时')); await settle(); },
    tick: () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); },
  };
}

test('空强度快照不清除已确认值，重新读取解析电脑模型的具体默认档位', async () => {
  const f = fixture(), c = f.context;
  c.settings.value = { ...initial };
  c.connection.snapshot.executionSettings = { ...initial, effort: '', mode: 'plan' };
  f.subscriptions[1]();
  assert.equal(c.settings.value.effort, 'high');
  assert.equal(c.settings.value.mode, 'plan');
  assert.equal(f.pending.length, 1);
  await f.reply({ ...initial, effort: '', mode: 'plan' });
  assert.equal(c.settings.value.effort, 'high');
  assert.equal(c.effortLabel(c.settings.value.effort), '高');
});

test('首次空强度按同模型目录解析，不硬编码高档或沿用其他模型', async () => {
  const f = fixture(), c = f.context;
  c.settings.value = { ...initial, model: 'model-b', effort: 'high' };
  c.loadSettings();
  await f.reply({ ...initial, effort: '' }, [{ ...catalog[0], defaultEffort: 'low' }]);
  assert.equal(c.settings.value.model, 'model-a');
  assert.equal(c.settings.value.effort, 'low');
  assert.equal(c.effortLabel(''), '同步中…');
});

test('未解析到实际强度时保留已确认值并允许重读，不把空值宣称为默认', async () => {
  const f = fixture(), c = f.context;
  c.settings.value = { ...initial }; c.loadSettings();
  await f.reply({ ...initial, effort: '' }, [{ ...catalog[0], defaultEffort: '' }]);
  assert.equal(c.settings.value.effort, 'high');
  assert.ok(c.settingsError.value.includes('思考强度'));
  assert.equal(f.timers.size, 1);
});

test('读取中到达不完整快照，回执补全强度并保留新的模式和速度', async () => {
  const f = fixture(), c = f.context;
  c.loadSettings();
  c.connection.snapshot.executionSettings = { ...initial, effort: '', mode: 'plan', serviceTier: 'priority' };
  f.subscriptions[1]();
  assert.equal(f.pending.length, 1);
  await f.reply();
  assert.equal(c.settings.value.effort, 'high');
  assert.equal(c.settings.value.mode, 'plan');
  assert.equal(c.settings.value.serviceTier, 'priority');
});

test('迟到读取不能覆盖快照中明确的新强度，也不能跨模型补值', async () => {
  for (const incoming of [{ ...initial, effort: 'low' }, { ...initial, model: 'model-b', effort: '' }]) {
    const f = fixture(), c = f.context;
    c.settings.value = { ...initial }; c.loadSettings();
    c.connection.snapshot.executionSettings = incoming; f.subscriptions[1]();
    await f.reply();
    assert.equal(c.settings.value.model, incoming.model);
    assert.equal(c.settings.value.effort, incoming.effort);
  }
});

test('目录失败后已有模型也会在打开菜单时补读，重复打开不重复请求', async () => {
  const f = fixture(), c = f.context;
  c.settings.value = { ...initial };
  c.openComposerMenu('settings'); c.openComposerMenu('models');
  assert.equal(f.pending.length, 1);
  await f.fail();
  assert.equal(f.timers.size, 1);
  c.openComposerMenu('settings');
  assert.equal(f.pending.length, 1); assert.equal(f.timers.size, 0);
  await f.reply();
  assert.equal(c.settingsError.value, ''); assert.equal(c.models.value.length, 1);
  assert.equal(c.settingsRetryCount, 0);
});

test('只读加载失败最多自动重试两次，空目录也按失败处理', async () => {
  const f = fixture(), c = f.context;
  c.loadSettings(); await f.fail(); f.tick();
  await f.reply(initial, []); f.tick(); await f.fail();
  assert.equal(c.settingsRetryCount, 2); assert.equal(f.timers.size, 0);
  assert.equal(c.settingsLoading.value, false); assert.equal(c.settingsError.value, '读取超时');
});

test('重连取消旧重试及旧回执，离页、只读和写入期间不发送恢复请求', async () => {
  const f = fixture(), c = f.context;
  c.loadSettings(); await f.fail();
  f.subscriptions[0]();
  assert.equal(f.timers.size, 0); assert.equal(f.pending.length, 1);
  const old = f.pending.shift(); f.subscriptions[0]();
  old.resolve({ settings: { ...initial, effort: 'low' }, models: catalog }); await settle();
  assert.equal(c.settings.value, null);
  await f.reply(); assert.equal(c.settings.value.effort, 'high');
  for (const change of [() => { c.currentPage = false; }, () => { c.readOnly.value = true; }, () => { c.settingsBusy.value = true; }]) {
    c.currentPage = true; c.readOnly.value = false; c.settingsBusy.value = false; change(); c.loadSettings();
    assert.equal(f.pending.length, 0);
  }
});
