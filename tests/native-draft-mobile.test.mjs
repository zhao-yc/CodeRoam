import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const read = path => fs.readFileSync(path, 'utf8');
const pngImage = 'data:image/png;base64,' + fs.readFileSync('apps/mobile/static/icons/check-dark.png').toString('base64');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const compile = source => stripTypeScriptTypes(source.replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, ''), { mode: 'transform' });

/** 给模拟传输补齐 UTSJSONObject 方法，数据和协议形状保持真实。 */
function json(value) {
  if (value == null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) json(nested);
  for (const name of ['String', 'Number', 'Boolean']) Object.defineProperty(value, 'get' + name, { configurable: true, value(key) { return this[key] ?? null; } });
  return value;
}
function snapshot(projectId = 'project-a', draftId = 'draft-a') {
  return { draftId, projectId, revision: 1, status: 'ready', settings: { model: 'model-a', effort: 'medium', serviceTier: '', mode: 'default' }, models: [
    { id: 'model-a', label: '模型 A', defaultEffort: 'medium', efforts: ['medium', 'high'], speeds: [{ id: '', label: '常速' }, { id: 'fast', label: '快速' }], supportsImages: true },
    { id: 'model-b', label: '模型 B', defaultEffort: 'high', efforts: ['high'], speeds: [{ id: '', label: '常速' }], supportsImages: true },
  ], permissions: { mode: 'default', revision: 'permission-1', options: ['default', 'read-only', 'full-access'].map(id => ({ id, label: id, enabled: true })) }, hasDesktopText: false };
}

/** 实际执行状态层、新建编排和正式聊天本地草稿，仅替换传输与系统 API。 */
function fixture({ component = false, storage = new Map() } = {}) {
  const calls = [], hooks = new Map(), backend = new Map(), pending = new Map(), watches = [], emitted = [], unmounts = [];
  const connection = { hostId: 'pc-a', cacheNamespace: 'example-pairing', configurationRevision: 1, connected: true, configured: true, computers: [{ id: 'pc-a', online: true }, { id: 'pc-b', online: true }], snapshot: null };
  let serial = 0, created = 0, state;
  const bridge = {
    pendingCommand: (hostId, scope) => pending.get(hostId + ':' + scope) ?? '',
    clearCommand: (id, hostId) => { for (const [key, value] of pending) if (key.startsWith(hostId + ':') && value === id) pending.delete(key); },
    request(method, params, write = false) {
      const hostId = connection.hostId, commandId = write ? 'command-' + ++serial : '';
      const scope = hostId + ':';
      calls.push({ hostId, method, params: plain(params), write, commandId });
      if (write) pending.set(scope, commandId);
      const run = async () => {
        if (hooks.has(method)) return hooks.get(method)(params, hostId);
        if (method === 'projects.list') return { supportsNativeNewDraft: true, projects: [{ id: 'project-a', label: '示例项目', cwd: '/example' }], selectedProjectId: 'project-a' };
        if (method === 'thread.draft.open') {
          let value = [...backend.values()].find(entry => entry.hostId === hostId && entry.projectId === params.projectId && entry.status !== 'promoted');
          if (!value) { value = { ...snapshot(params.projectId, 'draft-' + ++created), hostId }; backend.set(hostId + ':' + value.draftId, value); }
          value.status = 'ready'; return { snapshot: plain(value) };
        }
        const value = backend.get(hostId + ':' + params.draftId);
        if (method === 'thread.draft.read') return { snapshot: plain(value) };
        if (method === 'thread.draft.unwatch') return {};
        if (method === 'thread.draft.update') {
          for (const [key, change] of Object.entries(params.changes)) {
            if (key === 'permissionMode') { value.permissions.mode = change; value.permissions.revision += '-next'; }
            else value.settings[key] = change;
          }
          value.revision++; return { snapshot: plain(value) };
        }
        if (method === 'thread.draft.send') { value.status = 'promoted'; value.threadId = 'thread-' + value.draftId; value.revision++; return { threadId: value.threadId }; }
        if (method === 'attachment.begin') return { nextChunk: 0 };
        if (method === 'attachment.chunk') return { nextChunk: params.index + 1, received: 3 };
        if (method === 'attachment.finish') return {};
        if (method === 'command.status') return { state: 'unknown' };
        throw Error('测试不允许其他协议：' + method);
      };
      return Promise.resolve().then(run).then(result => { if (write) pending.delete(scope); return json(result); }, error => { if (write) pending.delete(scope); throw error; });
    },
    async openThread(threadId) { calls.push({ hostId: connection.hostId, method: 'thread.watch', params: { threadId, activate: true } }); if (hooks.has('thread.watch')) await hooks.get('thread.watch')(); connection.activeThreadId = threadId; },
    selectComputer(id) { connection.hostId = id; },
  };
  const props = { expanded: false };
  const context = vm.createContext({ bridge, connection, reactive: value => value, ref: value => ({ value }),
    computed: run => ({ get value() { return run(); } }),
    watch: (get, run, options) => { watches.push({ get, run }); if (options?.immediate) run(get()); },
    nextTick: run => Promise.resolve().then(run), onMounted() {}, onUnmounted: run => unmounts.push(run),
    defineProps: () => props, withDefaults: (value, defaults) => Object.assign(value, { ...defaults, ...value }), defineEmits: () => (...args) => emitted.push(args),
    setTimeout: () => 1, clearTimeout() {},
    uni: { removeStorageSync: key => storage.delete(key), getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => storage.set(key, value), getWindowInfo: () => ({ windowWidth: 390, windowHeight: 760 }), hideKeyboard() {}, showToast() {} },
    FILE_CHUNK_BYTES: 3, readFileBase64: async () => 'YWJj', computerIcon: () => 'laptop', bindImagePaste: () => () => {},
  });
  let source = ['apps/mobile/services/composer.uts', 'apps/mobile/services/native-draft.uts', 'apps/mobile/services/new-conversation.uts', 'apps/mobile/services/execution-settings.uts'].map(read).join('\n');
  if (component) source += '\n' + read('apps/mobile/components/new-conversation/new-conversation.uvue').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1];
  const names = 'nativeDraftState,watchNativeDraft,closeNativeDraft,applyNativeDraftSnapshot,readNativeDraft,updateNativeDraft,sendNativeDraft,checkNativeDraftCommand,newDraft,assignUnselectedDraft,sendNewConversation,openPromotedConversation,readDraft,readDraftImages,readDraftFiles,readDraftPlugins';
  vm.runInContext(compile(source) + '\nglobalThis.subject={' + names + (component ? ',syncEditorVisibility,loadProjects,loadSettings,chooseProject,selectSetting,selectPermission,composerAction,followPromotion,checkDraftOutcome,projectId,draft,native,settings,canSend' : '') + '};', context);
  state = context.subject;
  const current = () => backend.get(connection.hostId + ':' + state.nativeDraftState(connection.hostId, 'project-a').draftId);
  return { ...state, connection, props, calls, hooks, backend, watches, emitted, unmounts, current, storage,
    async open(hostId = 'pc-a', projectId = 'project-a') { connection.hostId = hostId; await state.watchNativeDraft(hostId, projectId); return state.nativeDraftState(hostId, projectId); },
    event(value, hostId = connection.hostId) { state.applyNativeDraftSnapshot(json(plain(value)), hostId); },
  };
}

test('展开打开原生草稿，收起只 unwatch，重新展开同编号只读且保留插件和文字', async () => {
  const f = fixture(), local = f.newDraft('pc-a', '');
  local.text = '合成手机输入'; local.plugins = [{ id: 'docs@example', displayName: '文档插件' }]; f.assignUnselectedDraft('pc-a', 'project-a');
  const state = await f.open(); f.closeNativeDraft('pc-a', 'project-a'); await tick();
  assert.equal(f.calls.at(-1).method, 'thread.draft.unwatch');
  await f.open();
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1);
  assert.equal(f.nativeDraftState('pc-a', 'project-a').draftId, state.draftId);
  assert.equal(f.newDraft('pc-a', 'project-a').text, '合成手机输入'); assert.equal(f.newDraft('pc-a', 'project-a').plugins[0].id, 'docs@example');
  assert.equal(f.calls.some(call => call.method === 'thread.create'), false);
});

test('open 尚未返回时收起重开复用同一个在途操作，不重复 native open', async () => {
  const f = fixture(), wait = deferred(), value = snapshot();
  f.hooks.set('thread.draft.open', () => wait.promise); f.backend.set('pc-a:draft-a', value);
  const first = f.watchNativeDraft('pc-a', 'project-a'); const rejected = assert.rejects(first, /目标已切换/);
  await tick(); f.closeNativeDraft('pc-a', 'project-a'); const second = f.watchNativeDraft('pc-a', 'project-a');
  wait.resolve({ snapshot: value }); await rejected; await second;
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1);
  assert.equal(f.nativeDraftState('pc-a', 'project-a').snapshot.draftId, 'draft-a');
});

test('共享 open 的两个回读分别结束，较早回执不能提前解除忙碌状态或允许新写入', async () => {
  const f = fixture(), opened = deferred(), reads = [deferred(), deferred()], value = snapshot();
  f.hooks.set('thread.draft.open', () => opened.promise);
  let index = 0; f.hooks.set('thread.draft.read', () => reads[index++].promise);
  const first = f.watchNativeDraft('pc-a', 'project-a'), second = f.watchNativeDraft('pc-a', 'project-a');
  opened.resolve({ snapshot: value }); await tick();
  const state = f.nativeDraftState('pc-a', 'project-a'); assert.equal(state.operations, 2);
  reads[0].resolve({ snapshot: value }); await first;
  assert.equal(state.busy, true); assert.equal(state.operations, 1);
  await assert.rejects(f.updateNativeDraft(state, { effort: 'high' }), /正在同步/);
  reads[1].resolve({ snapshot: value }); await second; assert.equal(state.busy, false); assert.equal(state.operations, 0);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1);
});

test('电脑与项目切换使迟到 read/update 和旧事件失效，同名编号不串电脑', async () => {
  const f = fixture(), old = await f.open(), wait = deferred();
  f.hooks.set('thread.draft.read', () => wait.promise);
  const reading = f.readNativeDraft(old), rejected = assert.rejects(reading, /目标已切换/);
  f.closeNativeDraft('pc-a', 'project-a'); f.hooks.delete('thread.draft.read');
  const other = await f.open('pc-b', 'project-b');
  wait.resolve({ snapshot: { ...snapshot(), revision: 90 } }); await rejected;
  f.event({ ...snapshot('project-b', other.draftId), revision: 99 }, 'pc-a');
  assert.equal(other.snapshot.revision, 1); assert.equal(other.snapshot.projectId, 'project-b');
  f.connection.hostId = 'pc-a'; const next = await f.open('pc-a', 'project-c');
  assert.equal(next.snapshot.projectId, 'project-c'); assert.equal(old.watching, false);
  await assert.rejects(f.sendNativeDraft(old, { text: '旧项目内容' }), /暂停/);
});

test('设置 UPDATE 后必须 readback 才显示，模型、强度、速度和 plan 不本地冒充', async () => {
  for (const changes of [{ model: 'model-b' }, { effort: 'high' }, { serviceTier: 'fast' }, { mode: 'plan' }]) {
    const f = fixture(), state = await f.open(), initial = plain(state.snapshot), ack = deferred(), back = deferred();
    f.hooks.set('thread.draft.update', () => ack.promise); f.hooks.set('thread.draft.read', () => back.promise);
    const updating = f.updateNativeDraft(state, changes); await tick();
    assert.deepEqual(plain(state.snapshot), initial);
    ack.resolve({ snapshot: { ...initial, settings: { ...initial.settings, ...changes }, revision: 2 } }); await tick();
    f.event({ ...initial, settings: { ...initial.settings, ...changes }, revision: 2 });
    assert.deepEqual(plain(state.snapshot), initial);
    back.resolve({ snapshot: { ...initial, settings: { ...initial.settings, ...changes }, revision: 2 } }); await updating;
    for (const [key, value] of Object.entries(changes)) assert.equal(state.snapshot.settings[key], value);
    const write = f.calls.find(call => call.method === 'thread.draft.update'); assert.equal(write.write, true); assert.equal(write.params.expectedRevision, 1);
    assert.equal(f.calls.at(-1).method, 'thread.draft.read');
  }
});

test('异步设置回执不能覆盖新项目，detached 暂停写入且只在手动重连时 open', async () => {
  const f = fixture(), state = await f.open(), wait = deferred();
  f.hooks.set('thread.draft.update', () => wait.promise);
  const updating = f.updateNativeDraft(state, { mode: 'plan' }), rejected = assert.rejects(updating, /目标已切换/);
  f.closeNativeDraft('pc-a', 'project-a');
  // 保留 bridge 的默认空 scope；旧写操作未结束时新项目可切换，不能再发第二次写请求。
  await assert.rejects(f.watchNativeDraft('pc-a', 'project-b'), /操作正在提交/);
  wait.resolve({}); await rejected;
  const next = await f.open('pc-a', 'project-b'); assert.equal(next.snapshot.settings.mode, 'default');
  const detached = { ...plain(next.snapshot), status: 'detached', revision: 2 }; f.event(detached);
  await assert.rejects(f.updateNativeDraft(next, { effort: 'high' }), /暂停/);
  const count = f.calls.filter(call => call.method === 'thread.draft.open').length;
  f.backend.set('pc-a:' + next.draftId, { ...detached, hostId: 'pc-a' });
  await f.watchNativeDraft('pc-a', 'project-b'); assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, count);
  await f.watchNativeDraft('pc-a', 'project-b', true); assert.equal(next.snapshot.status, 'ready');
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, count + 1);
});

test('完整访问必须确认，并将确认标志和草稿版本一同交给原生 UPDATE', async () => {
  const f = fixture(), state = await f.open();
  await assert.rejects(f.updateNativeDraft(state, { permissionMode: 'full-access' }), /先确认/);
  assert.equal(f.calls.some(call => call.method === 'thread.draft.update'), false);
  await f.updateNativeDraft(state, { permissionMode: 'full-access' }, true);
  assert.equal(state.snapshot.permissions.mode, 'full-access');
  const write = f.calls.find(call => call.method === 'thread.draft.update');
  assert.equal(write.params.confirmedFullAccess, true); assert.equal(write.params.expectedRevision, 1);
});

test('电脑先 promotion：手机打开对应正式聊天，保留文字和插件且不发送', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc-a', 'project-a');
  draft.text = '未发送的手机文字'; draft.plugins = [{ id: 'docs@example', displayName: '文档插件' }];
  f.event({ ...plain(state.snapshot), status: 'promoted', threadId: 'desktop-thread', revision: 2 });
  await assert.rejects(f.sendNewConversation(draft, () => {}), /电脑已发送/);
  assert.equal(await f.openPromotedConversation(draft), 'desktop-thread');
  assert.equal(f.readDraft('pc-a', 'desktop-thread'), '未发送的手机文字'); assert.equal(draft.text, '未发送的手机文字');
  assert.equal(f.readDraftPlugins('pc-a', 'desktop-thread')[0].id, 'docs@example');
  assert.equal(f.calls.some(call => call.method === 'thread.draft.send' || call.method === 'turn.send' || call.method === 'thread.create'), false);
  assert.equal(f.calls.filter(call => call.method === 'thread.watch').length, 1);
});

test('电脑有文字拒绝覆盖；上传期间 promotion 也不提交首条消息', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc-a', 'project-a'); draft.text = '手机输入';
  f.event({ ...plain(state.snapshot), revision: 2, hasDesktopText: true });
  await assert.rejects(f.sendNewConversation(draft, () => {}), /已有内容/);
  f.event({ ...plain(state.snapshot), revision: 3, hasDesktopText: false });
  draft.files = [{ id: 'file-a', name: 'example.txt', size: 3, source: '/example', data: 'YWJj', status: 'local', progress: 0, error: '' }];
  f.hooks.set('attachment.finish', () => { f.event({ ...plain(state.snapshot), revision: 4, status: 'promoted', threadId: 'desktop-thread' }); return {}; });
  await assert.rejects(f.sendNewConversation(draft, () => {}), /电脑已发送/);
  assert.equal(f.calls.some(call => call.method === 'thread.draft.send'), false); assert.equal(draft.text, '手机输入');
});

test('首条图片直接传递压缩data URI，只有文档在 draftId 范围分片上传，且只原生提交一次', async () => {
  const f = fixture(); await f.open(); const draft = f.newDraft('pc-a', 'project-a');
  draft.text = '首条合成消息'; draft.images = [{ id: 'image-a', src: pngImage }];
  draft.files = [{ id: 'file-a', name: 'example.txt', size: 3, source: '/example', data: 'YWJj', status: 'local', progress: 0, error: '' }];
  const sending = f.sendNewConversation(draft, () => {}); await assert.rejects(f.sendNewConversation(draft, () => {}), /正在提交/);
  const threadId = await sending;
  const uploads = f.calls.filter(call => call.method.startsWith('attachment.'));
  assert.equal(uploads.length, 3); assert.ok(uploads.every(call => call.params.draftId === 'draft-1' && call.params.uploadId === 'file-a' && !('threadId' in call.params)));
  const sends = f.calls.filter(call => call.method === 'thread.draft.send'); assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].params.images, [pngImage]); assert.deepEqual(sends[0].params.attachments, ['file-a']);
  assert.equal('plugins' in sends[0].params, false);
  assert.equal(f.calls.at(-2).method, 'thread.watch'); assert.equal(f.connection.activeThreadId, threadId);
  assert.equal(draft.text, ''); assert.equal(draft.plugins.length, 0);
  assert.equal(f.calls.some(call => ['thread.create', 'thread.settings.update', 'thread.permissions.update', 'turn.send'].includes(call.method)), false);
});

test('纯图片首条直接 native send data URI，不调用文档附件上传', async () => {
  const f = fixture(); await f.open(); const draft = f.newDraft('pc-a', 'project-a');
  draft.images = [{ id: 'image-a', src: pngImage }];
  await f.sendNewConversation(draft, () => {});
  assert.equal(f.calls.some(call => call.method.startsWith('attachment.')), false);
  const sends = f.calls.filter(call => call.method === 'thread.draft.send'); assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].params.images, [pngImage]); assert.equal(sends[0].params.text, '');
  assert.equal(draft.images.length, 0);
});

test('未开放原生插件输入时在上传和发送前明确拒绝，保留原插件选择而不静默丢弃', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc-a', 'project-a');
  draft.text = '带插件的合成消息'; draft.plugins = [{ id: 'docs@example', displayName: '文档插件' }];
  draft.images = [{ id: 'image-a', src: 'data:image/png;base64,YWJj' }];
  const count = f.calls.length;
  await assert.rejects(f.sendNewConversation(draft, () => {}), /暂不支持插件/);
  await assert.rejects(f.sendNativeDraft(state, { text: draft.text, plugins: draft.plugins }), /暂不支持插件/);
  assert.equal(f.calls.length, count); assert.equal(draft.plugins.length, 1); assert.equal(draft.text, '带插件的合成消息');
});

test('附件合计超过三个在上传前拒绝，换原生草稿后不能复用旧上传完成状态', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc-a', 'project-a'); draft.text = '合成消息';
  const draftId = state.draftId;
  draft.images = Array.from({ length: 4 }, (_, id) => ({ id: 'image-' + id, src: 'data:image/png;base64,YWJj' }));
  await assert.rejects(f.sendNewConversation(draft, () => {}), /最多添加3个/);
  assert.equal(f.calls.some(call => call.method.startsWith('attachment.')), false);
  draft.images = []; draft.attachmentDraftId = 'old-draft';
  draft.files = [{ id: 'file-a', name: 'example.txt', size: 3, source: '/example', data: 'YWJj', status: 'ready', progress: 100, error: '' }];
  await f.sendNewConversation(draft, () => {});
  assert.ok(f.calls.some(call => call.method === 'attachment.begin' && call.params.draftId === draftId));
});

test('open 结果未知保留原命令，重开与重连不重放，通过 command.status 恢复草稿', async () => {
  const f = fixture(), value = snapshot();
  f.hooks.set('thread.draft.open', () => { throw Error('打开结果未知'); });
  await assert.rejects(f.watchNativeDraft('pc-a', 'project-a'), /需要核对|核对原操作/);
  const state = f.nativeDraftState('pc-a', 'project-a'), commandId = state.pendingCommandId;
  assert.ok(commandId); f.closeNativeDraft('pc-a', 'project-a');
  await assert.rejects(f.watchNativeDraft('pc-a', 'project-a'), /需要核对/);
  await assert.rejects(f.watchNativeDraft('pc-a', 'project-a', true), /需要核对/);
  f.backend.set('pc-a:draft-a', value); f.hooks.set('command.status', () => ({ state: 'done', result: { snapshot: value } }));
  await f.checkNativeDraftCommand(state);
  assert.equal(state.snapshot.draftId, 'draft-a'); assert.equal(state.outcomeUnknown, false);
  assert.equal(f.calls.find(call => call.method === 'command.status').params.commandId, commandId);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1);
});

test('send 结果未知查账前后都不重复提交，unknown/not_found 不能解除保护', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc-a', 'project-a'); draft.text = '保留手机文字';
  f.hooks.set('thread.draft.send', () => { throw Error('发送结果未知'); });
  await assert.rejects(f.sendNewConversation(draft, () => {}), /核对/);
  const commandId = state.pendingCommandId; assert.ok(commandId); assert.equal(draft.text, '保留手机文字');
  await assert.rejects(f.sendNewConversation(draft, () => {}), /需要核对/);
  for (const outcome of ['unknown', 'pending', 'not_found']) {
    f.hooks.set('command.status', () => ({ state: outcome })); await assert.rejects(f.checkNativeDraftCommand(state), /仍待核对/); assert.equal(state.outcomeUnknown, true);
  }
  f.hooks.set('command.status', () => ({ state: 'done', result: { threadId: 'confirmed-thread' } }));
  assert.equal(await f.checkNativeDraftCommand(state), 'confirmed-thread');
  await assert.rejects(f.sendNewConversation(draft, () => {}), /电脑已发送/);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.send').length, 1);
  assert.ok(f.calls.filter(call => call.method === 'command.status').every(call => call.params.commandId === commandId));
});

test('手机提交成功时切换电脑，迟到成功仍保护原草稿，返回后不能再 send', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc-a', 'project-a'); draft.text = '合成消息';
  f.hooks.set('thread.draft.read', () => ({ snapshot: plain(f.current()) }));
  // 模拟 native submit 在电脑切换后才确认成功。
  const wait = deferred(); f.hooks.set('thread.draft.send', async () => { await wait.promise; f.connection.hostId = 'pc-b'; return { threadId: 'sent-thread' }; });
  const sending = f.sendNewConversation(draft, () => {}), rejected = assert.rejects(sending, /目标已切换/); await tick(); wait.resolve(); await rejected;
  assert.equal(draft.text, '合成消息'); assert.equal(f.calls.filter(call => call.method === 'thread.draft.send').length, 1);
  assert.equal(state.snapshot.status, 'promoted');
  f.connection.hostId = 'pc-a';
  await assert.rejects(f.sendNewConversation(draft, () => {}), /电脑已发送/);
});

test('设置回读失败保留原显示并暂停写入，手动只读恢复后才可再选设置', async () => {
  const f = fixture(), state = await f.open();
  f.hooks.set('thread.draft.read', () => { throw Error('回读失败'); });
  await assert.rejects(f.updateNativeDraft(state, { effort: 'high' }), /回读失败/);
  assert.equal(state.snapshot.settings.effort, 'medium'); assert.equal(state.needsReadback, true);
  await assert.rejects(f.updateNativeDraft(state, { effort: 'medium' }), /尚未回读确认/);
  f.hooks.delete('thread.draft.read'); await f.readNativeDraft(state);
  assert.equal(state.snapshot.settings.effort, 'high'); assert.equal(state.needsReadback, false);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.update').length, 1);
});

test('正式聊天导航失败只重试打开，不重复已经成功的 native submit', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc-a', 'project-a'); draft.text = '已成功的合成消息';
  f.hooks.set('thread.watch', () => { throw Error('导航失败'); });
  await assert.rejects(f.sendNewConversation(draft, () => {}), /导航失败/);
  assert.equal(draft.text, ''); assert.equal(state.snapshot.status, 'promoted');
  await assert.rejects(f.sendNewConversation(draft, () => {}), /电脑已发送/);
  f.hooks.delete('thread.watch'); await f.openPromotedConversation(draft);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.send').length, 1);
});

test('刷新保留未知命令编号并只查账；核对记录不含文字、图片、插件', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc-a', 'project-a'); draft.text = '不可持久化的合成正文';
  f.hooks.set('thread.draft.send', () => { throw Error('发送结果未知'); });
  await assert.rejects(f.sendNewConversation(draft, () => {}), /核对/);
  assert.ok([...f.storage.values()].every(value => !value.includes(draft.text)));
  const reloaded = fixture({ storage: f.storage });
  await assert.rejects(reloaded.watchNativeDraft('pc-a', 'project-a'), /需要核对/);
  const restored = reloaded.nativeDraftState('pc-a', 'project-a'); assert.equal(restored.pendingCommandId, state.pendingCommandId);
  reloaded.backend.set('pc-a:' + state.draftId, { ...plain(state.snapshot), revision: 2, status: 'promoted', threadId: 'confirmed-thread' });
  reloaded.hooks.set('command.status', () => ({ state: 'done', result: { threadId: 'confirmed-thread' } }));
  assert.equal(await reloaded.checkNativeDraftCommand(restored), 'confirmed-thread');
  assert.equal(restored.snapshot.status, 'promoted'); assert.equal(reloaded.storage.size, 0);
  assert.ok(reloaded.calls.every(call => call.method === 'command.status' || call.method === 'thread.draft.read'));
});

/** 权限组件使用原脚本验证确认弹窗和 emit；已有会话路径仍保留原方法。 */
function permissionFixture(overrides = {}) {
  const calls = [], emitted = [], watches = [], modals = [];
  const props = { threadId: '', projectId: 'project-a', selectedMode: '', disabled: false, active: true, draftId: 'draft-a', nativeDraft: true, nativeState: snapshot().permissions, nativeStatus: 'ready', nativeBusy: false, ...overrides };
  const connection = { hostId: 'pc-a', connected: true, subscriptionRevision: 1, computers: [{ id: 'pc-a', online: true }], snapshot: { threadId: 'thread-a', supportsPermissionSettings: true, permissionSettings: snapshot().permissions } };
  const c = vm.createContext({ connection, ref: value => ({ value }), computed: run => ({ get value() { return run(); } }),
    watch: (get, run, options) => { watches.push(run); if (options?.immediate) run(get.value); }, onUnmounted() {},
    defineProps: () => props, withDefaults: value => value, defineEmits: () => (...args) => emitted.push(args), permissionLabel: value => value,
    uni: { showModal: options => modals.push(options), getWindowInfo: () => ({ windowWidth: 390, windowHeight: 760 }), getElementById: () => null },
    bridge: { async request(method, params, write) { calls.push({ method, params, write }); return json(snapshot().permissions); } },
  });
  vm.runInContext(compile(read('apps/mobile/components/permissions-control/permissions-control.uvue').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1]) + '\nglobalThis.subject={choose,load,mode,state,openMenu};', c);
  return { ...c.subject, props, connection, calls, emitted, watches, modals };
}

test('原生权限组件确认后只 emit select，不本地修改权限、不退回 thread.create.permissions', async () => {
  const f = permissionFixture(); assert.equal(f.calls.length, 0);
  let selecting = f.choose('full-access'); f.modals.shift().success({ confirm: false }); await selecting;
  assert.equal(f.emitted.some(event => event[0] === 'select'), false);
  selecting = f.choose('full-access'); f.modals.shift().success({ confirm: true }); await selecting;
  assert.deepEqual(plain(f.emitted.find(event => event[0] === 'select')), ['select', 'full-access', true]);
  assert.equal(f.mode.value, 'default'); assert.equal(f.calls.length, 0);
  const absent = permissionFixture({ draftId: '', nativeState: null, nativeStatus: '' }); await absent.load();
  assert.equal(absent.calls.length, 0);
});

test('完整访问弹窗期间切电脑或权限版本变化取消旧确认，已有会话仍读写原权限接口', async () => {
  for (const change of [f => { f.connection.hostId = 'pc-b'; }, f => { f.props.nativeState = { ...f.props.nativeState, revision: 'permission-2' }; f.watches[1](); }]) {
    const f = permissionFixture(), choosing = f.choose('full-access'); change(f); f.modals.shift().success({ confirm: true }); await choosing;
    assert.equal(f.emitted.some(event => event[0] === 'select'), false); assert.equal(f.calls.length, 0);
  }
  const existing = permissionFixture({ threadId: 'thread-a', projectId: '', draftId: '', nativeDraft: false, nativeState: null, nativeStatus: '' });
  await existing.load(); await existing.choose('read-only');
  assert.deepEqual(existing.calls.map(call => call.method), ['thread.permissions.read', 'thread.permissions.update']); assert.equal(existing.calls[1].write, true);
});

test('新建组件只在展开并通过 projects 能力检查后 open，设置选择不提前改变显示', async () => {
  const f = fixture({ component: true }); f.loadProjects(); await tick(); assert.equal(f.calls.length, 0);
  f.props.expanded = true; f.loadProjects(); await tick(); await tick();
  assert.equal(f.projectId.value, 'project-a'); assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1);
  const wait = deferred(); f.hooks.set('thread.draft.update', () => wait.promise);
  const selecting = f.selectSetting('effort', 'high'); await tick(); assert.equal(f.settings.value.effort, 'medium');
  f.current().settings.effort = 'high'; f.current().revision++; wait.resolve({}); await selecting;
  assert.equal(f.settings.value.effort, 'high');
  const legacy = fixture({ component: true }); legacy.props.expanded = true; legacy.hooks.set('projects.list', () => ({ supportsThreadCreation: true, projects: [] }));
  legacy.loadProjects(); await tick(); assert.equal(legacy.calls.some(call => call.method === 'thread.draft.open'), false);
});

test('显式重新展开仍调用原生新聊天，连接恢复读取不能自动重复打开', async () => {
  const f=fixture({component:true});
  f.props.expanded=true;f.syncEditorVisibility(true);await tick();await tick();await tick();
  const first=f.calls.filter(call=>call.method==='thread.draft.open').length;
  assert.equal(first,1);
  f.props.expanded=false;f.syncEditorVisibility(false);await tick();
  f.props.expanded=true;f.syncEditorVisibility(true);await tick();await tick();await tick();
  assert.equal(f.calls.filter(call=>call.method==='thread.draft.open').length,first+1);
  f.loadProjects();await tick();await tick();
  assert.equal(f.calls.filter(call=>call.method==='thread.draft.open').length,first+1);
});
