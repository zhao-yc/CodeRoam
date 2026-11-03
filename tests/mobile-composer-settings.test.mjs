import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 执行实际页面方法，验证异步设置与上传的会话归属和错误恢复。 */
function fixture() {
  const source = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
  const methods = source.slice(source.indexOf('function onDraftBlur()'), source.indexOf('\nwatch((): string => connection.hostId', source.indexOf('function onDraftBlur()')));
  const files = new Map(), calls = [], pending = [];
  const context = componentContext({
    predictionFocus: { value: false }, inputFocused: { value: false }, pageVisible: { value: true }, composerBlurTimer: 0, nextTick: run => Promise.resolve().then(run), composerMenu: { value: '' }, menuHeight: { value: 200 }, keyboardInset: { value: 0 },
    models: { value: [] }, settings: { value: { model: 'model-a', effort: 'high', mode: 'default', serviceTier: '' } }, settingsBusy: { value: false }, settingChoice: { value: '' }, retryingFileIds: { value: [] }, settingsLoading: { value: false }, settingsError: { value: '' }, busy: { value: false }, settingsRequest: 0, settingsSnapshotRevision: 0,
    canWrite: { get value() { return !context.busy.value; } }, readOnly: { value: false }, imageBusy: { value: false }, modelSupportsImages: { value: true },
    connection: { connected: true, hostId: 'pc', activeThreadId: 'thread', snapshot: { supportsPlanReset: true, supportsExecutionSettings: true, supportsAttachments: true }, pendingCommandId: '' },
    pageHostId: { value: 'pc' }, pageThreadId: { value: 'thread' }, actionsVisible: { value: true }, planEnabled: { value: false }, planResetRequired: { value: false }, choosePlan() {}, consumePlan() {}, confirmDefaultMode() {},
    uni: { getWindowInfo: () => ({ windowHeight: 800 }) }, isCurrentPage: () => context.connection.hostId === 'pc' && context.connection.activeThreadId === 'thread',
    closeComposerMenu: () => { context.composerMenu.value = ''; }, refresh: () => calls.push('刷新'), notify: message => calls.push(message),
    bridge: { request: (method, params, write) => { calls.push({ method, params, write }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
    readDraftFiles: (host, thread) => files.get(host + ':' + thread) ?? [], saveDraftFiles: (host, thread, value) => files.set(host + ':' + thread, value), readDraftImages: () => [],
    readFileBase64: async () => Buffer.from('附件测试内容').toString('base64'), FILE_CHUNK_BYTES: 192 * 1024,
  });
  Object.assign(context, { settingsRetryTimer: 0, settingsRetryCount: 0, setTimeout: () => 1, clearTimeout() {} });
  const helpers = fs.readFileSync('apps/mobile/services/execution-settings.uts', 'utf8').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(helpers + '\n' + methods, { mode: 'transform' }), context);
  return { context, calls, pending, files };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('菜单打开后任务启动也不能切换计划模式，任务结束后恢复选择', async () => {
  for (const mode of ['plan', 'default']) {
    for (const running of [{ activeTurnId: 'active', status: 'idle' }, { activeTurnId: '', status: 'active' }]) {
      const f = fixture();
      f.context.composerMenu.value = 'add';
      f.context.settings.value.mode = mode === 'plan' ? 'default' : 'plan';
      Object.assign(f.context.connection.snapshot, running);
      f.context.selectedMode = mode;
      vm.runInContext("selectSetting('mode', selectedMode)", f.context);
      assert.equal(f.calls.length, 0);
      assert.equal(f.context.settingsBusy.value, false);
      assert.equal(f.context.composerMenu.value, 'add');
      assert.equal(f.context.settings.value.mode, mode === 'plan' ? 'default' : 'plan');
      Object.assign(f.context.connection.snapshot, { activeTurnId: '', status: 'idle' });
      vm.runInContext("selectSetting('mode', selectedMode)", f.context);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].method, 'thread.settings.update');
      assert.equal(f.calls[0].params.changes.mode, mode);
      f.pending.shift().resolve({ settings: { ...f.context.settings.value, mode }, models: [] });
      await tick();
      assert.equal(f.context.settings.value.mode, mode);
    }
  }
});

test('任务运行中选择模型或推理强度即同步电脑，无需发送消息', async () => {
  for (const [key, value] of [['model', 'model-b'], ['effort', 'max']]) {
    const f = fixture();
    f.context.connection.snapshot.activeTurnId = 'active';
    f.context.connection.snapshot.status = 'active';
    f.context.key = key; f.context.selected = value;
    vm.runInContext('selectSetting(key, selected)', f.context);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'thread.settings.update');
    assert.equal(f.calls[0].params.threadId, 'thread');
    assert.deepEqual({ ...f.calls[0].params.changes }, { [key]: value });
    assert.equal(f.calls[0].write, true);
    const confirmed = { ...f.context.settings.value, [key]: value };
    f.pending.shift().resolve({ settings: confirmed, models: [] }); await tick();
    assert.equal(f.context.settings.value[key], value);
    assert.equal(f.calls.some(call => call.method === 'turn.send' || call.method === 'turn.steer'), false);
  }
});

test('设置在成功前保持原值，失败保留原因，未知结果不会自动重试', async () => {
  const f = fixture(); vm.runInContext("selectSetting('mode', 'plan')", f.context);
  assert.equal(f.context.settings.value.mode, 'default'); assert.equal(f.context.settingsBusy.value, true); assert.equal(f.calls[0].write, true);
  f.pending.shift().reject(new Error('设置结果需要核对')); await tick();
  assert.equal(f.context.settings.value.mode, 'default'); assert.equal(f.context.settingsError.value, '设置结果需要核对'); assert.equal(f.context.busy.value, false); assert.equal(f.calls.length, 1);
  vm.runInContext("selectSetting('mode', 'plan')", f.context); f.pending.shift().resolve({ settings: { model: 'model-a', effort: 'high', mode: 'plan', serviceTier: '' }, models: [] }); await tick();
  assert.equal(f.context.settings.value.mode, 'plan'); assert.ok(f.calls.includes('刷新'));
});

test('切换电脑后的迟到设置响应不污染当前页面', async () => {
  const f = fixture(); vm.runInContext('loadSettings()', f.context); f.context.connection.hostId = 'other';
  f.pending.shift().resolve({ settings: { model: 'wrong-model', effort: 'low', mode: 'plan', serviceTier: '' }, models: [] }); await tick();
  assert.equal(f.context.settings.value.model, 'model-a');
});

test('上传断线后保留附件与已读内容，按原编号重试已确认分片', async () => {
  const f = fixture(); const file = { id: 'attachment-test-123456', name: '说明.txt', size: Buffer.byteLength('附件测试内容'), source: '临时文件', data: '', status: 'uploading', progress: 0, error: '' };
  f.files.set('pc:thread', [file]); f.context.file = file;
  const upload = vm.runInContext("uploadFile('pc','thread',file)", f.context); await tick();
  assert.equal(f.calls[0].method, 'attachment.begin'); f.pending.shift().resolve({ getNumber: key => key === 'nextChunk' ? 0 : null }); await tick();
  assert.equal(f.calls[1].method, 'attachment.chunk'); f.context.connection.connected = false; f.pending.shift().reject(new Error('连接中断')); await upload;
  assert.equal(file.status, 'paused'); assert.ok(file.data.length > 0); assert.equal(f.files.get('pc:thread').length, 1);
  f.context.connection.connected = true; const resumed = vm.runInContext("uploadFile('pc','thread',file)", f.context); await tick();
  assert.equal(f.calls[2].params.uploadId, file.id); f.pending.shift().resolve({ getNumber: key => key === 'nextChunk' ? 1 : null }); await tick();
  assert.equal(f.calls[3].method, 'attachment.finish'); f.pending.shift().resolve({ complete: true }); await resumed;
  assert.equal(file.status, 'ready'); assert.equal(file.progress, 100);
});

test('上传期间移除附件后，迟到读取不会重新添加附件或发送上传请求', async () => {
  const f = fixture(); const file = { id: 'attachment-test-123456', name: '说明.txt', size: 10, source: '临时文件', data: '', status: 'uploading', progress: 0, error: '' };
  f.files.set('pc:thread', [file]); f.context.file = file;
  const upload = vm.runInContext("uploadFile('pc','thread',file)", f.context); f.files.set('pc:thread', []); await upload;
  assert.equal(f.calls.length, 0); assert.equal(f.files.get('pc:thread').length, 0);
});

test('文件草稿只随所属提交成功清理，失败、未知和发送后新增附件继续保留', () => {
  const context = componentContext({ reactive: value => value });
  const source = fs.readFileSync('apps/mobile/services/composer.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={readDraftFiles,saveDraftFiles,rememberSubmission,settleSubmission};', context);
  const f = context.subject;
  f.saveDraftFiles('pc', 'thread', [{ id: 'sent' }]); f.saveDraftFiles('other', 'thread', [{ id: 'other' }]); f.rememberSubmission('pc', 'thread', 'command', '');
  f.saveDraftFiles('pc', 'thread', [{ id: 'sent' }, { id: 'new' }]); f.settleSubmission('pc', 'command', true);
  assert.deepEqual(Array.from(f.readDraftFiles('pc', 'thread'), file => file.id), ['new']); assert.equal(f.readDraftFiles('other', 'thread')[0].id, 'other');
  f.rememberSubmission('pc', 'thread', 'failed', ''); f.settleSubmission('pc', 'failed', false); assert.equal(f.readDraftFiles('pc', 'thread')[0].id, 'new');
});
