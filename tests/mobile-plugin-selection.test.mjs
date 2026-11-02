import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const read = file => fs.readFileSync(file, 'utf8');
const compile = source => stripTypeScriptTypes(source.replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, ''), { mode: 'transform' });
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const sample = id => ({ id, name: id.split('@')[0], displayName: id.startsWith('design') ? '设计工具' : '示例插件', description: '用于整理需求与文档' });

/** 执行真实弹层脚本，以受控响应覆盖关闭、重试和切换目标的竞态。 */
function pickerFixture(plugins = []) {
  const calls = [], pending = [], emitted = [], watches = [], unmounts = [], notices = [];
  const props = { hostId: 'computer-a', threadId: 'thread-a', projectId: '', plugins };
  const connection = { hostId: 'computer-a', configurationRevision: 1, connected: true };
  const context = vm.createContext({ props, connection, uni: { getWindowInfo: () => ({ windowHeight: 740 }), showToast: value => notices.push(value.title) },
    defineProps: () => props, defineEmits: () => (...args) => emitted.push(args), ref: value => ({ value }),
    computed: run => ({ get value() { return run(); } }),
    watch: (read, run, options) => { watches.push(run); if (options?.immediate) run(); }, onUnmounted: run => unmounts.push(run),
    bridge: { request: (method, params) => { calls.push({ method, params }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
  });
  const source = read('apps/mobile/components/plugin-picker/plugin-picker.uvue').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1];
  vm.runInContext(compile(read('apps/mobile/services/plugins.uts') + '\n' + source) + '\nglobalThis.ui={load,close,confirm,toggle,clear,selected,query,filtered,missing,loading,error};', context);
  return { props, connection, calls, pending, emitted, watches, unmounts, notices, ui: context.ui };
}

test('插件面板支持名称和简介搜索、多选及确认，取消不改变调用方草稿', async () => {
  const selected = [{ id: 'docs@example', displayName: '文档工具' }], f = pickerFixture(selected);
  f.pending.shift().resolve({ supportsPluginSelection: true, plugins: [sample('docs@example'), sample('design@example')] }); await tick();
  f.ui.query.value = '设计'; assert.equal(f.ui.filtered.value[0].id, 'design@example');
  f.ui.query.value = '需求'; assert.equal(f.ui.filtered.value.length, 2);
  f.ui.toggle(sample('design@example')); assert.equal(f.ui.selected.value.length, 2); assert.equal(selected.length, 1);
  f.ui.confirm(); assert.deepEqual(plain(f.emitted[0]), ['confirm', [selected[0], { id: 'design@example', displayName: '设计工具' }]]);
  const canceled = pickerFixture(selected); canceled.ui.clear(); canceled.ui.close();
  assert.equal(selected.length, 1); assert.deepEqual(plain(canceled.emitted), [['close']]);
});

test('切换电脑、项目、配对或卸载后，迟到插件列表不会覆盖新目标', async () => {
  for (const change of [f => { f.props.threadId = 'thread-b'; }, f => { f.props.threadId = ''; f.props.projectId = 'project-b'; }, f => { f.connection.configurationRevision++; }, f => { f.connection.hostId = 'computer-b'; f.props.hostId = 'computer-b'; }]) {
    const f = pickerFixture(); const first = f.pending.shift(); change(f); f.watches[0]();
    const second = f.pending.shift(); second.resolve({ supportsPluginSelection: true, plugins: [sample('new@example')] }); await tick();
    first.resolve({ supportsPluginSelection: true, plugins: [sample('old@example')] }); await tick();
    assert.equal(f.ui.filtered.value[0].id, 'new@example');
  }
  const f = pickerFixture(); f.unmounts[0](); f.pending.shift().resolve({ supportsPluginSelection: true, plugins: [sample('old@example')] }); await tick();
  assert.equal(f.ui.filtered.value.length, 0);
});

test('旧服务、断线和插件失效均不静默丢弃选择，可重读或取消失效插件', async () => {
  const f = pickerFixture([{ id: 'gone@example', displayName: '旧插件' }]);
  f.pending.shift().reject(new Error('此操作不在允许的接口列表中')); await tick();
  assert.match(f.ui.error.value, /更新电脑连接服务和中转/); f.ui.confirm(); assert.equal(f.emitted.length, 0);
  const retried = f.ui.load(); f.pending.shift().resolve({ supportsPluginSelection: true, plugins: [] }); await retried;
  assert.equal(f.ui.missing.value.length, 1); f.ui.confirm(); assert.equal(f.emitted.length, 0);
  f.ui.toggle({ id: 'gone@example', displayName: '旧插件' }); f.ui.confirm(); assert.deepEqual(plain(f.emitted), [['confirm', []]]);
  const offline = pickerFixture(); offline.connection.connected = false; offline.watches[0](); assert.match(offline.ui.error.value, /先连接/);
});

test('插件选择上限与发送协议一致，到达上限后仍可取消并重新选择', async () => {
  const f = pickerFixture(), plugins = Array.from({ length: 21 }, (_, index) => sample('sample-' + index + '@example'));
  f.pending.shift().resolve({ supportsPluginSelection: true, plugins }); await tick();
  plugins.forEach(plugin => f.ui.toggle(plugin)); assert.equal(f.ui.selected.value.length, 20); assert.equal(f.notices.length, 1);
  f.ui.toggle(plugins[0]); f.ui.toggle(plugins[20]); assert.equal(f.ui.selected.value.length, 20);
  assert.equal(f.ui.selected.value.at(-1).id, plugins[20].id);
});

/** 草稿及新建编排使用同一套实际实现，验证成功回执的选择清理边界。 */
function draftFixture() {
  const calls = [];
  const connection = { hostId: 'computer-a', connected: true, computers: [{ id: 'computer-a', online: true }], snapshot: null };
  // 此处模拟已展开并连接的原生草稿，只替换新建编排导入的状态 API。
  const native = { hostId: 'computer-a', projectId: 'project', draftId: 'example-native-draft', watching: true, snapshot: { status: 'ready', revision: 1, hasDesktopText: false } };
  const bridge = { async openThread(threadId) { calls.push({ method: 'thread.watch', params: { threadId } }); } };
  const c = vm.createContext({ reactive: value => value, connection, bridge, uni: { removeStorageSync() {} },
    nativeDraftState: () => native,
    assertNativeDraftReady(state) { if (!state.watching || state.snapshot.status !== 'ready') throw Error('原生草稿未就绪'); },
    async readNativeDraft(state) { calls.push({ method: 'thread.draft.read', params: { draftId: state.draftId } }); return state.snapshot; },
    async sendNativeDraft(state, message) { calls.push({ method: 'thread.draft.send', params: plain(message) }); state.snapshot = { ...state.snapshot, status: 'promoted', threadId: 'created-thread' }; return 'created-thread'; },
    acknowledgeNativeDraftPromotion(state) { state.watching = false; },
  });
  vm.runInContext(compile(read('apps/mobile/services/composer.uts') + '\n' + read('apps/mobile/services/new-conversation.uts')) + '\nglobalThis.subject={readDraftPlugins,saveDraftPlugins,rememberSubmission,settleSubmission,clearDeletedDrafts,newDraft,sendNewConversation,beginNewConversation};', c);
  return { ui: c.subject, calls };
}

test('插件草稿按电脑与会话隔离，失败及未知保留，旧回执不清理重新选择的插件', () => {
  const { ui } = draftFixture(), plugin = { id: 'docs@example', displayName: '文档工具' };
  ui.saveDraftPlugins('computer-a', 'thread', [plugin]); ui.saveDraftPlugins('computer-b', 'thread', [plugin]);
  ui.rememberSubmission('computer-a', 'thread', 'failed', ''); ui.settleSubmission('computer-a', 'failed', false);
  assert.equal(ui.readDraftPlugins('computer-a', 'thread').length, 1);
  ui.rememberSubmission('computer-a', 'thread', 'unknown', ''); assert.equal(ui.readDraftPlugins('computer-a', 'thread').length, 1);
  ui.saveDraftPlugins('computer-a', 'thread', [plugin]); ui.settleSubmission('computer-a', 'unknown', true);
  assert.equal(ui.readDraftPlugins('computer-a', 'thread').length, 1);
  ui.rememberSubmission('computer-a', 'thread', 'success', ''); ui.settleSubmission('computer-a', 'success', true);
  assert.equal(ui.readDraftPlugins('computer-a', 'thread').length, 0); assert.equal(ui.readDraftPlugins('computer-b', 'thread').length, 1);
  ui.clearDeletedDrafts('computer-b', ['thread']); assert.equal(ui.readDraftPlugins('computer-b', 'thread').length, 0);
});

test('新对话原生通道未开放插件时明确拒绝并保留选择，移除插件后才发送首条消息', async () => {
  const f = draftFixture(), draft = f.ui.newDraft('computer-a', 'project'); draft.text = '整理需求'; draft.plugins = [{ id: 'docs@example', displayName: '文档工具' }];
  assert.equal(f.ui.newDraft('computer-a', 'other').plugins.length, 0);
  await assert.rejects(f.ui.sendNewConversation(draft, () => {}), /原生草稿暂不支持插件/);
  assert.deepEqual(plain(draft.plugins), [{ id: 'docs@example', displayName: '文档工具' }]); assert.equal(draft.text, '整理需求'); assert.equal(f.calls.length, 0);
  draft.plugins = []; await f.ui.sendNewConversation(draft, () => {});
  assert.equal(draft.plugins.length, 0); assert.equal(f.calls.filter(call => call.method === 'thread.draft.send').length, 1);
  assert.equal(f.calls.some(call => call.method === 'thread.create' || call.method === 'turn.send'), false);
});

test('只选择插件不会创建空对话或发送消息', async () => {
  const f = draftFixture(), draft = f.ui.newDraft('computer-a', 'project'); draft.plugins = [{ id: 'docs@example', displayName: '文档工具' }];
  await assert.rejects(f.ui.sendNewConversation(draft, () => {}), /输入内容或添加附件/); assert.equal(f.calls.length, 0);
});

test('历史消息将插件协议引用显示为可读标签，保留普通内容且不解析路径链接', () => {
  const context = vm.createContext({});
  vm.runInContext(compile(read('apps/mobile/services/plugins.uts')) + '\nglobalThis.render=pluginMessageText;', context);
  assert.equal(context.render('整理需求\n\n[@文档\\[示例\\]](plugin://docs@example)'), '整理需求\n\n@文档[示例]');
  assert.equal(context.render('[@内置工具](plugin://sample)'), '@内置工具');
  const ordinary = '[普通链接](https://example.com) [@文件](plugin://../private)';
  assert.equal(context.render(ordinary), ordinary);
});
