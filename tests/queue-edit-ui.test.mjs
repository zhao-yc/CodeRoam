import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const tick = () => new Promise(resolve => setImmediate(resolve));
/** 执行真实草稿恢复模块；测试数据仅包含合成正文和附件。 */
function fixture() {
  const drafts = new Map(), images = new Map(), files = new Map(), plugins = new Map(), mentions = new Map(), calls = [], pending = [], notices = [];
  const key = (host, thread) => host + ':' + thread;
  const context = componentContext({ reactive: x => x,
    readDraft: (h, t) => drafts.get(key(h, t)) ?? '', readDraftImages: (h, t) => images.get(key(h, t)) ?? [], readDraftFiles: (h, t) => files.get(key(h, t)) ?? [],
    saveDraft: (h, t, x) => drafts.set(key(h, t), x), saveDraftImages: (h, t, x) => images.set(key(h, t), x), saveDraftFiles: (h, t, x) => files.set(key(h, t), x)
  });
  const code = fs.readFileSync('apps/mobile/services/queue-edit.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(code, { mode: 'transform' }) + ';globalThis.helper={beginQueueEdit,finishQueueEdit,isQueueEditing,restoreQueuedDraft};', context);
  const ref = value => ({ value });
  Object.assign(context, { canWrite: ref(true), imageBusy: ref(false), pageVisible: ref(true), pageHostId: ref('pc'), pageThreadId: ref('thread'), draftPlugins: ref([]), draftMentions: ref([]), connection: { hostId: 'pc', snapshot: { supportsQueueEditing: true } }, busy: ref(false), pendingAction: ref(''), operationError: ref(''), readDraftThreadMentions: (h, t) => mentions.get(key(h, t)) ?? [], saveDraftThreadMentions: (h, t, x) => mentions.set(key(h, t), x), readDraftPlugins: (h, t) => plugins.get(key(h, t)) ?? [], saveDraftPlugins: (h, t, x) => plugins.set(key(h, t), x), notify: x => notices.push(x), focusComposerInput: () => notices.push('输入框获得焦点'), bridge: { request(method, params, write) { calls.push({ method, params, write }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } }, JSON: { ...JSON, parse: JSON.parse, stringify: JSON.stringify } });
  context.isCurrentPage = () => context.connection.hostId === context.pageHostId.value;
  const page = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
  const start = page.indexOf('function editQueuedMessage('), end = page.indexOf('let stopPromptOpen', start);
  vm.runInContext(stripTypeScriptTypes(page.slice(start, end), { mode: 'transform' }) + ';globalThis.edit=editQueuedMessage;', context);
  const response = draft => ({ draft, getBoolean: name => name === 'edited', getString: name => name === 'queueId' ? 'queue-id' : '' });
  return { ...context.helper, context, drafts, images, files, plugins, mentions, calls, pending, notices, edit: context.edit, response };
}

test('撤回成功后恢复文字、图片和附件并聚焦，清理确认不会发送草稿', async () => {
  const f = fixture(); f.edit('queue-id'); assert.equal(f.calls[0].params.queueAction, 'edit'); assert.equal(f.isQueueEditing('pc', 'thread'), true); assert.equal(f.drafts.size, 0);
  f.pending.shift().resolve(f.response({ text: '原合成消息', images: ['data:image/png;base64,synthetic'], attachments: [{ id: 'upload-id', name: '合成.txt', size: 12 }] })); await tick();
  assert.equal(f.drafts.get('pc:thread'), '原合成消息'); assert.equal(f.images.get('pc:thread')[0].src, 'data:image/png;base64,synthetic'); assert.equal(f.files.get('pc:thread')[0].status, 'ready'); assert.equal(f.files.get('pc:thread')[0].id, 'upload-id');
  assert.equal(f.calls[1].params.queueAction, 'cancel'); assert.equal(f.calls[1].params.text, undefined); assert.equal(f.isQueueEditing('pc', 'thread'), false); assert.ok(f.notices.includes('输入框获得焦点'));
  f.context.saveDraft('pc', 'thread', '编辑后的文字'); f.pending.shift().reject(Error('清理超时')); await tick(); assert.equal(f.drafts.get('pc:thread'), '编辑后的文字'); assert.equal(f.calls.length, 2);
});

test('已有草稿或撤回期间的并发新草稿都不会被覆盖，失败保留撤回记录', async () => {
  const f = fixture(); f.context.saveDraft('pc', 'thread', '已有草稿'); f.edit('queue-id'); assert.equal(f.calls.length, 0); assert.match(f.notices[0], /已有草稿/);
  f.context.saveDraft('pc', 'thread', ''); f.edit('queue-id'); f.context.saveDraft('pc', 'thread', '期间出现的新草稿');
  f.pending.shift().resolve(f.response({ text: '待编辑消息', images: [], attachments: [] })); await tick();
  assert.equal(f.drafts.get('pc:thread'), '期间出现的新草稿'); assert.equal(f.calls.length, 1); assert.match(f.context.operationError.value, /已有草稿/); assert.equal(f.context.busy.value, false);
});

test('切换电脑后的迟到回执仅恢复原聊天草稿，不向新电脑清理或抢焦点', async () => {
  const f = fixture(); f.edit('queue-id'); f.context.connection.hostId = 'other'; f.context.pageHostId.value = 'other'; f.context.pageVisible.value = false;
  f.pending.shift().resolve(f.response({ text: '原聊天草稿', images: [], attachments: [] })); await tick();
  assert.equal(f.drafts.get('pc:thread'), '原聊天草稿'); assert.equal(f.drafts.has('other:thread'), false); assert.equal(f.calls.length, 1); assert.equal(f.notices.length, 0); assert.equal(f.isQueueEditing('pc', 'thread'), false);
});

test('撤回失败或回执损坏不恢复、不清理、不发送，输入锁可释放', async () => {
  for (const badResponse of [false, true]) {
    const f = fixture(); f.edit('queue-id'); const request = f.pending.shift();
    if (badResponse) request.resolve({ getBoolean: () => false, getString: () => '', draft: {} }); else request.reject(Error('任务已开始发送'));
    await tick(); assert.equal(f.drafts.size, 0); assert.equal(f.calls.length, 1); assert.equal(f.isQueueEditing('pc', 'thread'), false); assert.equal(f.context.busy.value, false);
  }
});

test('恢复前完整校验附件，插件不支持时保留服务端记录，支持时完整恢复选择', () => {
  const f = fixture(); const draft = { text: '合成插件消息', images: [], attachments: [], plugins: [{ id: 'synthetic-plugin', displayName: '合成插件' }] };
  assert.throws(() => f.restoreQueuedDraft('pc', 'thread', 'q', draft), /更新手机客户端/); assert.equal(f.drafts.size, 0);
  let selected; f.restoreQueuedDraft('pc', 'thread', 'q', draft, false, values => { selected = values; }); assert.equal(selected[0].id, 'synthetic-plugin');
  f.context.saveDraft('pc', 'thread', ''); assert.throws(() => f.restoreQueuedDraft('pc', 'thread', 'q', { text: '合成', images: [], attachments: [{ id: '', name: '', size: 0 }] }), /附件无效/); assert.equal(f.drafts.get('pc:thread'), '');
});
