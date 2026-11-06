import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const read = path => fs.readFileSync(path, 'utf8');
const service = name => read(`apps/mobile/services/${name}.uts`);
const page = read('apps/mobile/components/chat-detail/chat-detail.uvue');
const newEditor = read('apps/mobile/components/new-conversation/new-conversation.uvue');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const ref = value => ({ value });
const computed = run => ({ get value() { return run(); } });
const compile = source => stripTypeScriptTypes(source.replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, ''), { mode: 'transform' });
const between = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const mention = id => ({ id, title: '合成聊天 ' + id });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

/** 只执行真实 UTS 模块，所有候选和正文均为独立合成数据。 */
function helpers(extra = '') {
  const context = componentContext({ reactive: value => value });
  vm.runInContext(compile(service('thread-mentions') + '\n' + service('composer') + '\n' + extra), context);
  return context;
}

test('独立 @ 支持开头、中文正文及光标中间，缺少光标时不猜测末尾', () => {
  const f = helpers();
  for (const text of ['@', '请参考 @', '请参考 @设计', '请参考\n@设计', '参考（@设计']) assert.ok(f.findThreadMentionTrigger(text, text.length), text);
  const text = '前文 @设计 后文保留', cursor = text.indexOf(' 后文');
  const trigger = f.findThreadMentionTrigger(text, cursor);
  assert.equal(trigger.query, '设计');
  assert.deepEqual(plain(f.replaceThreadMentionTrigger(text, trigger)), { text: '前文  后文保留', cursor: 3 });
  assert.equal(f.findThreadMentionTrigger(text, -1), null);
});

test('邮箱、URL、链接目标、行内和围栏代码中的 @ 不触发', () => {
  const f = helpers();
  for (const text of ['a@example.com', 'https://example.com/@name', 'https://example.com/a@', '[@标题', '[链接](https://example.com/ @', '<https://example.com/ @', '`代码 @', '``代码 ` @', '```uts\nconst x = @', '~~~\n@', '    @', '\t@']) assert.equal(f.findThreadMentionTrigger(text, text.length), null, text);
  for (const text of ['`代码` @', '```uts\nconst x = 1\n```\n@', '~~~\n代码\n~~~\n@']) assert.ok(f.findThreadMentionTrigger(text, text.length), text);
});

test('触发替换只使用捕获片段，异步变化拒绝覆盖；引用去重且最多20个', () => {
  const f = helpers(), text = '保留 @搜索 结尾', trigger = f.findThreadMentionTrigger(text, 6);
  assert.equal(f.replaceThreadMentionTrigger('异步新草稿', trigger), null);
  assert.equal(f.copyThreadMentions([mention('a'), mention('a'), mention('b')]).length, 2);
  assert.throws(() => f.copyThreadMentions(Array.from({ length: 21 }, (_, i) => mention('t' + i))), /最多引用20/);
});

test('引用草稿按电脑和会话隔离，失败及未知保留，旧回执不清除重新选择', () => {
  const f = helpers();
  f.saveDraftThreadMentions('pc', 't', [mention('a'), mention('a')]); f.saveDraftThreadMentions('other', 't', [mention('b')]);
  assert.equal(f.readDraftThreadMentions('pc', 't').length, 1); assert.equal(f.readDraftThreadMentions('pc', 'other').length, 0);
  f.rememberSubmission('pc', 't', 'failed', ''); f.settleSubmission('pc', 'failed', false);
  assert.equal(f.readDraftThreadMentions('pc', 't').length, 1);
  f.rememberSubmission('pc', 't', 'unknown', '');
  f.saveDraftThreadMentions('pc', 't', []); f.saveDraftThreadMentions('pc', 't', [mention('a')]);
  f.settleSubmission('pc', 'unknown', true); assert.equal(f.readDraftThreadMentions('pc', 't').length, 1);
  f.rememberSubmission('pc', 't', 'success', ''); f.settleSubmission('pc', 'success', true);
  assert.equal(f.readDraftThreadMentions('pc', 't').length, 0); assert.equal(f.readDraftThreadMentions('other', 't').length, 1);
  f.clearDeletedDrafts('other', ['t']); assert.equal(f.readDraftThreadMentions('other', 't').length, 0);
});

/** 假时钟驱动真实选择器，显式控制搜索、分页和迟到回包。 */
function pickerFixture() {
  const calls = [], pending = [], emitted = [], watches = [], timers = new Map(), unmounts = [], notices = [];
  let clock = 0;
  const props = { hostId: 'pc', threadId: 'current', scopeId: 'current', initialQuery: '', mentions: [] };
  const connection = { hostId: 'pc', configurationRevision: 1, connected: true };
  const c = componentContext({ props, connection, ref, computed, defineProps: () => props, defineEmits: () => (...args) => emitted.push(args),
    setTimeout: (run, ms) => { assert.equal(ms, 250); timers.set(++clock, run); return clock; }, clearTimeout: id => timers.delete(id),
    watch: (_, run) => watches.push(run), onUnmounted: run => unmounts.push(run),
    uni: { getWindowInfo: () => ({ windowHeight: 740 }), showToast: value => notices.push(value.title) },
    bridge: { readThreadMentions(hostId, params) { calls.push({ hostId, method: 'threads.mentions', params: plain(params), write: false }); const wait = deferred(); pending.push(wait); return wait.promise; } },
  });
  const source = read('apps/mobile/components/thread-mention-picker/thread-mention-picker.uvue').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1];
  vm.runInContext(compile(service('thread-mentions') + '\n' + source) + '\nglobalThis.ui={query,options,selected,loading,error,hasMore,loadMore,retry,close,confirm,toggle,remove};', c);
  return { props, connection, calls, pending, emitted, watches, unmounts, notices, ui: c.ui, flush() { for (const run of [...timers.values()]) run(); timers.clear(); } };
}
const response = (ids, hasMore = false) => ({ supportsThreadMentions: true, threads: ids.map(id => ({ ...mention(id), projectLabel: '合成项目', updatedAt: 1 })), hasMore });

test('选择器只读查询当前电脑、每页30条，支持分页去重并排除当前聊天', async () => {
  const f = pickerFixture(); assert.deepEqual(f.calls[0], { hostId: 'pc', method: 'threads.mentions', params: { search: '', offset: 0, limit: 30, excludeThreadId: 'current' }, write: false });
  f.pending.shift().resolve(response(['a', 'current'], true)); await tick();
  assert.deepEqual(plain(f.ui.options.value.map(x => x.id)), ['a']);
  f.ui.loadMore(); assert.equal(f.calls[1].params.offset, 2);
  f.pending.shift().resolve(response(['a', 'b'])); await tick(); assert.deepEqual(plain(f.ui.options.value.map(x => x.id)), ['a', 'b']);
  f.ui.toggle(f.ui.options.value[0]); f.ui.toggle(f.ui.options.value[1]); f.ui.confirm();
  assert.deepEqual(plain(f.emitted[0]), ['confirm', [mention('a'), mention('b')]]);
});

test('搜索防抖250毫秒立即废弃旧结果，只执行最后关键词，失败可重试', async () => {
  const f = pickerFixture(), stale = f.pending.shift();
  f.ui.query.value = '早'; f.watches[0](); f.ui.query.value = '最后'; f.watches[0]();
  stale.resolve(response(['stale'])); await tick(); assert.equal(f.ui.options.value.length, 0); assert.equal(f.calls.length, 1);
  f.flush(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].params.search, '最后');
  f.pending.shift().reject(Error('合成网络异常')); await tick(); assert.match(f.ui.error.value, /合成网络/);
  f.ui.retry(); f.pending.shift().resolve(response([])); await tick(); assert.equal(f.ui.error.value, ''); assert.equal(f.ui.options.value.length, 0);
});

test('切电脑、聊天、项目、配对、关闭或卸载使迟到候选失效，取消不修改外部选择', async () => {
  for (const change of [f => { f.props.hostId = 'other'; }, f => { f.props.threadId = 'other'; }, f => { f.props.scopeId = 'project-b'; }, f => { f.connection.configurationRevision++; }, f => { f.connection.connected = false; }]) {
    const f = pickerFixture(); change(f); f.watches[1](); f.pending.shift().resolve(response(['old'])); await tick();
    assert.equal(f.ui.options.value.length, 0); assert.equal(f.emitted[0][0], 'close');
  }
  for (const close of [f => f.ui.close(), f => f.unmounts[0]()]) {
    const f = pickerFixture(); close(f); f.pending.shift().resolve(response(['old'])); await tick(); assert.equal(f.ui.options.value.length, 0);
  }
  const f = pickerFixture(); f.props.mentions.push(mention('original')); f.ui.close(); assert.equal(f.props.mentions.length, 1);
});

test('选择器旧服务无确认，上限20条仍可取消已有选择', async () => {
  const old = pickerFixture(); old.pending.shift().resolve({ threads: [], hasMore: false }); await tick(); old.ui.confirm(); assert.equal(old.emitted.length, 0); assert.match(old.ui.error.value, /更新电脑/);
  const f = pickerFixture(); f.pending.shift().resolve(response(Array.from({ length: 21 }, (_, i) => 't' + i))); await tick();
  f.ui.options.value.forEach(thread => f.ui.toggle(thread)); assert.equal(f.ui.selected.value.length, 20); assert.equal(f.notices.length, 1);
  f.ui.toggle(f.ui.options.value[0]); f.ui.toggle(f.ui.options.value[20]); assert.equal(f.ui.selected.value.length, 20);
});

/** 运行会话页真实输入与发送函数，复用真实草稿和撤回服务。 */
function pageFixture() {
  const c = helpers(service('queue-edit')), calls = [], pending = [], notices = [];
  Object.assign(c,{composerBlurTimer:0,inputFocused:ref(true),clearTimeout(){}});
  Object.assign(c, { ref, computed, pageHostId: ref('pc'), pageThreadId: ref('current'), pageVisible: ref(true), canWrite: ref(true), busy: ref(false), imageBusy: ref(false), filesReady: ref(true), modelSupportsImages: ref(true), pendingAction: ref(''), operationError: ref(''), predictionFocus: ref(false), pluginOpen: ref(false), mentionOpen: ref(false), mentionCursor: ref(-1), mentionTrigger: ref(null), mentionDraftRevision: 0, mentionSourceRevision: 0, mentionContext: '', mentionSelection: '',
    connection: { hostId: 'pc', configurationRevision: 1, connected: true, pendingCommandId: '', snapshot: { supportsThreadMentions: true, supportsImages: true, supportsMessageQueue: true, supportsQueueEditing: true, status: 'idle' } },
    activeTurnId: ref(''), messageSendingPreferences: { behavior: 'queue' }, following: ref(false),
    notify: value => notices.push(value), closeComposerMenu() {}, focusComposerInput() {}, scrollLatest() {}, resumeFollowing() {}, isCurrentPage: () => true, uni: { hideKeyboard() {} },
    bridge: { request(method, params, write) { c.connection.pendingCommandId = 'command-' + calls.length; calls.push({ method, params: plain(params), write }); const wait = deferred(); pending.push(wait); return wait.promise; }, pendingCommand: () => c.connection.pendingCommandId },
  });
  c.draft = computed(() => c.readDraft(c.pageHostId.value, c.pageThreadId.value));
  c.draftMentions = computed(() => c.readDraftThreadMentions(c.pageHostId.value, c.pageThreadId.value));
  c.draftPlugins = computed(() => c.readDraftPlugins('pc', 'current')); c.draftImages = computed(() => c.readDraftImages('pc', 'current')); c.draftFiles = computed(() => c.readDraftFiles('pc', 'current'));
  const save = c.saveDraft; c.saveDraft = (...args) => { save(...args); c.mentionDraftRevision++; };
  vm.runInContext(compile(between(page, 'function resetThreadMention(', '// 只在会话页可见时') + between(page, 'function threadMentionContext(', '// 选图完成后')), c);
  vm.runInContext(compile(between(page, 'function send() {', '// 追加和取消都指向')), c);
  vm.runInContext(compile(between(page, 'function editQueuedMessage(', 'let stopPromptOpen')), c);
  return { c, calls, pending, notices };
}

test('会话输入仅替换光标处触发片段，取消保留正文，异步修改和切电脑拒绝旧选择', () => {
  const f = pageFixture(), text = '前文 @关键词 后文';
  f.c.updateDraft({ detail: { value: text, cursor: text.indexOf(' 后文') } });
  assert.equal(f.c.mentionOpen.value, true); f.c.closeThreadMentions(); assert.equal(f.c.draft.value, text);
  f.c.updateDraft({ detail: { value: text, cursor: text.indexOf(' 后文') } }); f.c.selectThreadMentions([mention('a')]);
  assert.equal(f.c.draft.value, '前文  后文'); assert.equal(f.c.mentionCursor.value, 3); assert.deepEqual(plain(f.c.draftMentions.value), [mention('a')]);
  for (const change of [c => c.saveDraft('pc', 'current', '新的正文'), c => { c.saveDraft('pc', 'current', '临时'); c.saveDraft('pc', 'current', text); }, c => { c.connection.hostId = 'other'; }, c => { c.saveDraftThreadMentions('pc', 'current', [mention('new')]); }]) {
    const current = pageFixture(); current.c.updateDraft({ detail: { value: text, cursor: text.indexOf(' 后文') } }); change(current.c); const before = current.c.draft.value;
    current.c.selectThreadMentions([mention('old')]); assert.equal(current.c.draft.value, before); assert.ok(!current.c.draftMentions.value.some(x => x.id === 'old'));
  }
  const old = pageFixture(); old.c.connection.snapshot.supportsThreadMentions = undefined; old.c.updateDraft({ detail: { value: '@', cursor: 1 } }); assert.equal(old.c.mentionOpen.value, false);
});

test('普通发送、运行中追加和排队均传引用编号，兼容图片、文件及插件，成功只清本次引用', async () => {
  for (const behavior of ['queue', 'steer', 'send']) {
    const f = pageFixture(); f.c.messageSendingPreferences.behavior = behavior;
    if (behavior === 'steer') { f.c.activeTurnId.value = 'active-turn'; f.c.connection.snapshot.status = 'active'; }
    f.c.saveDraft('pc', 'current', '合成正文'); f.c.saveDraftThreadMentions('pc', 'current', [mention('a'), mention('a')]);
    f.c.saveDraftPlugins('pc', 'current', [{ id: 'synthetic-plugin', displayName: '合成插件' }]);
    f.c.saveDraftImages('pc', 'current', [{ id: 'image', src: 'data:image/png;base64,synthetic' }]);
    f.c.saveDraftFiles('pc', 'current', [{ id: 'file' }]);
    f.c.send(); assert.equal(f.calls.length, 1); const { method, params } = f.calls[0];
    assert.equal(method, behavior === 'steer' ? 'turn.steer' : 'turn.send'); assert.deepEqual(params.threadMentionIds, ['a']); assert.deepEqual(params.pluginIds, ['synthetic-plugin']);
    assert.equal(params.images.length, 1); assert.deepEqual(params.attachments, ['file']);
    assert.equal(params.queueAction, behavior === 'queue' ? 'enqueue' : undefined); if (behavior === 'steer') assert.equal(params.expectedTurnId, 'active-turn');
    f.c.saveDraftThreadMentions('pc', 'current', [mention('next')]); f.pending.shift().resolve({ queued: behavior === 'queue' }); await tick();
    assert.deepEqual(plain(f.c.draftMentions.value), [mention('next')]);
  }
});

test('只有标签不发送，旧服务不静默丢引用，明确失败和未知结果均保留标签', async () => {
  const only = pageFixture(); only.c.saveDraftThreadMentions('pc', 'current', [mention('a')]); only.c.send(); assert.equal(only.calls.length, 0);
  only.c.saveDraft('pc', 'current', '合成正文'); only.c.connection.snapshot.supportsThreadMentions = false; only.c.send(); assert.equal(only.calls.length, 0); assert.equal(only.c.draftMentions.value.length, 1);
  for (const unknown of [false, true]) {
    const f = pageFixture(); f.c.saveDraft('pc', 'current', '保留正文'); f.c.saveDraftThreadMentions('pc', 'current', [mention('a')]); f.c.send();
    if (!unknown) f.c.connection.pendingCommandId = '';
    f.pending.shift().reject(Error(unknown ? '结果未知' : '明确失败')); await tick();
    assert.equal(f.c.draftMentions.value.length, 1); assert.equal(f.c.draft.value, '保留正文'); assert.equal(f.calls.length, 1);
  }
});

test('队列撤回恢复引用、插件与附件，引用草稿和异步新增标签阻止覆盖', async () => {
  const queued = { text: '合成消息', images: [], attachments: [], plugins: [{ id: 'synthetic-plugin', displayName: '合成插件' }], threadMentions: [mention('a')] };
  const result = { draft: queued, getBoolean: () => true, getString: () => 'queue' };
  const f = pageFixture(); f.c.editQueuedMessage('queue'); f.pending.shift().resolve(result); await tick();
  assert.deepEqual(plain(f.c.draftMentions.value), [mention('a')]); assert.equal(f.c.draftPlugins.value.length, 1); assert.equal(f.c.draft.value, '合成消息'); assert.equal(f.calls[1].params.queueAction, 'cancel');
  const blocked = pageFixture(); blocked.c.saveDraftThreadMentions('pc', 'current', [mention('existing')]); blocked.c.editQueuedMessage('queue'); assert.equal(blocked.calls.length, 0);
  const raced = pageFixture(); raced.c.editQueuedMessage('queue'); raced.c.saveDraftThreadMentions('pc', 'current', [mention('new')]); raced.pending.shift().resolve(result); await tick();
  assert.deepEqual(plain(raced.c.draftMentions.value), [mention('new')]); assert.equal(raced.c.draft.value, ''); assert.equal(raced.calls.length, 1);
});

/** 首条消息使用真实原生状态机和发送流程，传输仅保留合成草稿。 */
function newFixture() {
  const calls = [], snapshots = new Map(), storage = new Map(); let pendingId = '', serial = 0, sendHook = null;
  const connection = { hostId: 'pc', cacheNamespace: 'synthetic', connected: true, computers: [{ id: 'pc', online: true }] };
  const bridge = {
    pendingCommand: () => pendingId, clearCommand: () => { pendingId = ''; },
    request(method, params, write = false) {
      calls.push({ method, params: plain(params), write }); if (write) pendingId = 'command-' + ++serial;
      return Promise.resolve().then(async () => {
        let result = {};
        if (method === 'thread.draft.open') {
          result = { draftId: 'draft-' + params.projectId, projectId: params.projectId, revision: 1, status: 'ready', settings: { model: 'synthetic' }, models: [{ id: 'synthetic', supportsImages: true }], permissions: {}, hasDesktopText: false, supportsThreadMentions: true };
          snapshots.set(result.draftId, result);
        } else if (method === 'thread.draft.read') result = snapshots.get(params.draftId);
        else if (method === 'thread.draft.send') {
          if (sendHook != null) await sendHook();
          Object.assign(snapshots.get(params.draftId), { status: 'promoted', threadId: 'created' }); result = { threadId: 'created' };
        }
        if (write) pendingId = '';
        return Object.assign(result, { getString: key => result[key] ?? null, getNumber: key => result[key] ?? null, getBoolean: key => result[key] ?? null });
      });
    },
    async openThread(threadId) { calls.push({ method: 'thread.watch', params: { threadId } }); },
  };
  const c = componentContext({ reactive: value => value, connection, bridge, uni: { getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) }, readFileBase64: async () => '', FILE_CHUNK_BYTES: 3 });
  vm.runInContext(compile(['thread-mentions', 'composer', 'native-draft', 'new-conversation'].map(service).join('\n')), c);
  return { c, calls, snapshots, setSendHook: run => { sendHook = run; }, async open() { await c.watchNativeDraft('pc', 'project'); return c.newDraft('pc', 'project'); } };
}

test('新建输入同样保留光标后正文，取消不删触发片段，迟到选择不覆盖新项目或新草稿', async () => {
  for (const action of ['confirm', 'cancel', 'changed', 'reverted', 'project']) {
    const f = newFixture(); const c = f.c, watches = [];
    c.projectReady = ref(true); c.newConversationMode = ref('nativeDraft'); c.mentionsAvailable = ref(true);
    Object.assign(c, { ref, props: { expanded: true }, busy: ref(false), focused: ref(false), mentionOpen: ref(false), mentionCursor: ref(-1), mentionTrigger: ref(null), mentionDraftRevision: 0, mentionSourceRevision: 0, mentionContext: '', mentionSelectionRevision: 0, projectId: ref('project'), watch: (_, run) => watches.push(run), notify() {}, focusDraftInput() {}, closeMenus() {} });
    c.connection.configurationRevision = 1; c.uni.hideKeyboard = () => {};
    c.draft = computed(() => c.newDraft('pc', c.projectId.value)); c.native = computed(() => c.nativeDraftState('pc', c.projectId.value));
    vm.runInContext(compile(between(newEditor, 'function threadMentionContext(', 'function closeMenus(') + between(newEditor, 'function updateText(', '// 附件和长文本')), c);
    const text = '开始 @检索 保留结尾'; c.updateText({ detail: { value: text, cursor: text.indexOf(' 保留结尾') } }); assert.equal(c.mentionOpen.value, true);
    if (action === 'cancel') { c.closeThreadMentions(); assert.equal(c.draft.value.text, text); assert.equal(c.mentionCursor.value, text.indexOf(' 保留结尾')); continue; }
    if (action === 'changed' || action === 'reverted') { c.draft.value.text = '异步正文'; watches[0](); if (action === 'reverted') { c.draft.value.text = text; watches[0](); } }
    if (action === 'project') c.projectId.value = 'other';
    const before = c.draft.value.text; c.selectThreadMentions([mention('a')]);
    if (action === 'confirm') { assert.equal(c.draft.value.text, '开始  保留结尾'); assert.equal(c.mentionCursor.value, 3); assert.equal(c.draft.value.threadMentions[0].id, 'a'); }
    else { assert.equal(c.draft.value.text, before); assert.equal(c.draft.value.threadMentions.length, 0); }
  }
});

test('新建首条消息携带引用编号和图片附件，按电脑及项目隔离，只有标签不创建聊天', async () => {
  const f = newFixture(), draft = await f.open(); f.c.setNewDraftThreadMentions(draft, [mention('a'), mention('a')]);
  assert.equal(f.c.newDraft('other', 'project').threadMentions.length, 0); assert.equal(f.c.newDraft('pc', 'other').threadMentions.length, 0);
  await assert.rejects(f.c.sendNewConversation(draft, () => {}), /输入内容或添加附件/); assert.equal(f.calls.some(x => x.method === 'thread.draft.send'), false);
  draft.text = '合成首条'; draft.images = [{ id: 'image', src: 'data:image/png;base64,synthetic' }];
  await f.c.sendNewConversation(draft, () => {});
  const sent = f.calls.find(x => x.method === 'thread.draft.send'); assert.deepEqual(sent.params.threadMentionIds, ['a']); assert.equal(sent.params.images.length, 1); assert.equal(draft.threadMentions.length, 0);
  assert.equal(f.calls.filter(x => x.method === 'thread.draft.send').length, 1); assert.equal(f.calls.some(x => x.method === 'turn.send'), false);
});

test('首条失败及未知保留原选择，成功旧回执不清理发送中新增的引用和正文', async () => {
  const failed = newFixture(), draft = await failed.open(); draft.text = '保留首条'; failed.c.setNewDraftThreadMentions(draft, [mention('a')]); failed.setSendHook(() => { throw Error('结果未知'); });
  await assert.rejects(failed.c.sendNewConversation(draft, () => {}), /结果未知/); assert.equal(draft.threadMentions.length, 1); assert.equal(draft.text, '保留首条');
  const f = newFixture(), next = await f.open(), wait = deferred(); next.text = '发送正文'; f.c.setNewDraftThreadMentions(next, [mention('a')]); f.setSendHook(() => wait.promise);
  const sending = f.c.sendNewConversation(next, () => {}); await tick(); next.text = '后续正文'; f.c.setNewDraftThreadMentions(next, [mention('next')]); wait.resolve(); await sending;
  assert.deepEqual(plain(next.threadMentions), [mention('next')]); assert.equal(next.text, '后续正文');
  assert.deepEqual(plain(f.c.readDraftThreadMentions('pc', 'created')), [mention('next')]); assert.equal(f.c.readDraft('pc', 'created'), '后续正文');
});

test('项目分配与电脑已发送迁移完整保留引用，正式聊天已有标签不覆盖', async () => {
  const f = newFixture(), initial = f.c.newDraft('pc', ''); initial.text = '未分配正文'; f.c.setNewDraftThreadMentions(initial, [mention('a')]); f.c.assignUnselectedDraft('pc', 'project');
  const draft = await f.open(); assert.equal(draft.threadMentions.length, 1); assert.equal(initial.threadMentions.length, 0);
  const state = f.c.nativeDraftState('pc', 'project'); state.snapshot.status = 'promoted'; state.snapshot.threadId = 'desktop-sent';
  await f.c.openPromotedConversation(draft); assert.deepEqual(plain(f.c.readDraftThreadMentions('pc', 'desktop-sent')), [mention('a')]); assert.equal(draft.threadMentions.length, 1);
  assert.equal(f.calls.some(x => x.method === 'thread.draft.send'), false);
  const protectedDraft = newFixture(), next = await protectedDraft.open(); protectedDraft.c.setNewDraftThreadMentions(next, [mention('source')]); protectedDraft.c.saveDraftThreadMentions('pc', 'desktop-sent', [mention('existing')]);
  const promoted = protectedDraft.c.nativeDraftState('pc', 'project'); promoted.snapshot.status = 'promoted'; promoted.snapshot.threadId = 'desktop-sent'; await protectedDraft.c.openPromotedConversation(next);
  assert.deepEqual(plain(protectedDraft.c.readDraftThreadMentions('pc', 'desktop-sent')), [mention('existing')]);
});

test('首条再次核对能力，旧原生草稿不静默发送引用，保留现有插件限制', async () => {
  const f = newFixture(), draft = await f.open(); draft.text = '合成正文'; f.c.setNewDraftThreadMentions(draft, [mention('a')]);
  f.c.nativeDraftState('pc', 'project').snapshot.supportsThreadMentions = false;
  await assert.rejects(f.c.sendNewConversation(draft, () => {}), /更新电脑连接服务/); assert.equal(draft.threadMentions.length, 1); assert.equal(f.calls.some(x => x.method === 'thread.draft.send'), false);
  const changed = newFixture(), next = await changed.open(); next.text = '合成正文'; changed.c.setNewDraftThreadMentions(next, [mention('a')]);
  await assert.rejects(changed.c.sendNewConversation(next, message => { if (message === '正在发送…') changed.c.nativeDraftState('pc', 'project').snapshot.supportsThreadMentions = false; }), /更新电脑连接服务/);
  assert.equal(changed.calls.some(x => x.method === 'thread.draft.send'), false); assert.equal(next.threadMentions.length, 1);
});

test('历史可见引用保持普通正文、插件及普通链接，不显示 thread 内部链接', () => {
  const f = helpers(), ordinary = '开头代码 `const x = 1`\n[普通链接](https://example.com)\n正文';
  assert.equal(f.threadMentionMessageText(ordinary + '\n[@合成\\[聊天\\]](thread://thread-id?hostId=local)'), ordinary + '\n@合成[聊天]');
  assert.equal(f.threadMentionMessageText('[@插件](plugin://synthetic)'), '[@插件](plugin://synthetic)');
});

test('页面将标签计入展开及预测抑制，队列展示和增量快照保留能力字段', () => {
  const prediction = page.match(/const predictionAllowed = computed\(.*$/m)[0]; assert.match(prediction, /draftMentions\.value\.length == 0/);
  const expanded = page.match(/const composerExpanded = computed\(.*$/m)[0]; assert.match(expanded, /draftMentions\.value\.length > 0/);
  assert.match(newEditor, /draft\.value\.threadMentions\.length \* 44/); assert.match(newEditor, /mentionOpen && props\.expanded && projectReady/);
  assert.match(read('apps/mobile/components/message-queue/message-queue.uvue'), /message\.threadMentions/);
  assert.match(service('bridge'), /supportsThreadMentions: update\.supportsThreadMentions == true/);
  assert.match(read('apps/mobile/components/thread-mention-picker/thread-mention-picker.uvue'), /height: Math\.min\(88, selected\.length \* 44\) \+ 'px'/);
});

test('聊天查询公开封装限定已授权在线电脑和只读白名单，通用请求仍为私有', async () => {
  const source = service('bridge'), method = source.match(/  readThreadMentions\([^]*?\n  \}/)[0];
  const calls = [], connection = { computers: [{ id: 'pc', online: true }, { id: 'offline', online: false }] };
  const c = componentContext({ connection });
  vm.runInContext(compile('class Subject {\n' + method + '\n}\nglobalThis.subject = new Subject();'), c);
  c.subject.requestForComputer = (...args) => { calls.push(plain(args)); return Promise.resolve({}); };
  await assert.rejects(c.subject.readThreadMentions('other', {}), /取消授权/); await assert.rejects(c.subject.readThreadMentions('offline', {}), /离线/); assert.equal(calls.length, 0);
  await c.subject.readThreadMentions('pc', { search: '合成', offset: 0, limit: 30 });
  assert.deepEqual(calls[0], ['pc', 'threads.mentions', { search: '合成', offset: 0, limit: 30 }, false]);
  assert.match(source, /private requestForComputer\(/); assert.doesNotMatch(read('apps/mobile/components/thread-mention-picker/thread-mention-picker.uvue'), /requestForComputer\(/);
});
