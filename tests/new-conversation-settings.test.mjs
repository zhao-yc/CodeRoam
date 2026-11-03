import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { NativeDraftService } from '../apps/bridge/native-draft-service.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';
import { MAX_IMAGE_BYTES } from '../packages/protocol/images.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const selected = { model: 'model-a', effort: 'medium', serviceTier: '', mode: 'default' };
const models = [{ id: 'model-a', label: '模型 A', defaultEffort: 'medium', efforts: ['medium', 'high'], speeds: [{ id: '', label: '常速' }, { id: 'fast', label: '快速' }], supportsImages: true }, { id: 'model-b', label: '模型 B', defaultEffort: 'high', efforts: ['high'], speeds: [{ id: '', label: '常速' }, { id: 'fast', label: '快速' }], supportsImages: true }];

/** 原生桌面替身只提供草稿入口，任何旧会话创建或补设置调用都会失败。 */
class NativeSettingsDesktop {
  constructor(effort = 'medium') {
    this.calls = [];
    this.state = { revision: 1, status: 'ready', settings: { ...selected, effort }, models, permissions: { mode: 'default', revision: 'permission-1', options: ['default', 'read-only', 'full-access'].map(id => ({ id, label: id, enabled: true })) }, hasDesktopText: false };
  }
  async capabilities() { return true; }
  async open(project) { this.calls.push({ action: 'open', projectId: project.id }); return { binding: {}, snapshot: plain(this.state) }; }
  async read() { return plain(this.state); }
  async update(_binding, changes, options) {
    this.calls.push({ action: 'update', changes: plain(changes), options });
    if (options.expectedRevision !== this.state.revision) throw new BridgeError('DRAFT_CHANGED', '电脑设置已变化');
    if (changes.permissionMode === 'full-access' && options.confirmedFullAccess !== true) throw new BridgeError('BAD_PERMISSIONS', '请先确认完整访问');
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'permissionMode') { this.state.permissions.mode = value; this.state.permissions.revision += '-next'; }
      else this.state.settings[key] = value;
    }
    this.state.revision++;
    return plain(this.state);
  }
  async send(_binding, input, options) {
    this.calls.push({ action: 'send', input: plain(input), options: { expectedRevision: options.expectedRevision } });
    this.state.status = 'promoted'; this.state.threadId = '00000000-0000-4000-8000-000000000001'; this.state.revision++;
    await options.onCreated({ threadId: this.state.threadId });
    return { threadId: this.state.threadId, snapshot: plain(this.state) };
  }
  async close() {}
}

/** 手机实际 UTS 接入真实 NativeDraftService 与 Journal，只有桌面传输使用合成状态。 */
async function fixture(t, effort) {
  const desktop = new NativeSettingsDesktop(effort), journal = new Journal(), calls = [], storage = new Map();
  const service = new NativeDraftService({ controller: desktop, projects: { async project(id) { return { id, cwd: '/example' }; } }, attachments: { materialize() { return []; } } });
  t.after(async () => { await service.close(); journal.close(); });
  const connection = { hostId: 'pc', cacheNamespace: 'example', connected: true, computers: [{ id: 'pc', online: true }], snapshot: null };
  let serial = 0, pending = '';
  const json = value => {
    if (value == null || typeof value !== 'object') return value;
    for (const nested of Object.values(value)) json(nested);
    for (const suffix of ['String', 'Number', 'Boolean']) Object.defineProperty(value, 'get' + suffix, { configurable: true, value(key) { return this[key] ?? null; } });
    return value;
  };
  const bridge = {
    pendingCommand: () => pending, clearCommand: () => { pending = ''; },
    request(method, params, write = false) {
      calls.push({ method, params: plain(params), write });
      const id = write ? 'settings-command-' + ++serial : '';
      if (write) pending = id;
      const action = method.slice('thread.draft.'.length);
      const invoke = () => method === 'command.status' ? journal.status('phone', params.commandId) : service[action](params, 'phone', id, result => journal.checkpoint('phone', id, result));
      return Promise.resolve().then(() => write ? journal.execute('phone', id, method, params, invoke) : invoke()).then(result => { if (write) pending = ''; return json(plain(result)); }, error => { if (write && !error.outcomeUnknown) pending = ''; throw error; });
    },
    async openThread(threadId) { calls.push({ method: 'thread.watch', params: { threadId } }); },
  };
  const c = vm.createContext({ connection, bridge, reactive: value => value, uni: { getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) } });
  const source = ['composer', 'native-draft', 'new-conversation'].map(name => fs.readFileSync('apps/mobile/services/' + name + '.uts', 'utf8')).join('\n').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={newDraft,nativeDraftState,watchNativeDraft,updateNativeDraft,checkNativeDraftCommand,sendNewConversation,readNativeDraft,applyNativeDraftSnapshot};', c);
  service.on('changed', ({ snapshot }) => c.subject.applyNativeDraftSnapshot(json(plain(snapshot)), 'pc'));
  await c.subject.watchNativeDraft('pc', 'project');
  const state = c.subject.nativeDraftState('pc', 'project'), draft = c.subject.newDraft('pc', 'project'); draft.text = '合成的新任务';
  return { ...c.subject, desktop, journal, service, state, draft, calls, send: () => c.subject.sendNewConversation(draft, () => {}) };
}

test('原生草稿空强度与明确强度均按电脑回读展示，首条发送不补写默认设置或另建空线程', async t => {
  for (const effort of ['', 'medium']) {
    const f = await fixture(t, effort);
    assert.equal(f.state.snapshot.settings.effort, effort);
    assert.equal(await f.send(), '00000000-0000-4000-8000-000000000001');
    assert.deepEqual(f.desktop.calls.map(call => call.action), ['open', 'send']);
    assert.deepEqual(f.desktop.calls.find(call => call.action === 'send').input, { text: '合成的新任务', images: [], attachments: [] });
    assert.equal(f.draft.text, ''); assert.equal(f.calls.some(call => ['thread.create', 'thread.settings.update', 'turn.send'].includes(call.method)), false);
  }
});

test('PNG data URI 通过真实原生服务直达原生输入，不经文档上传且Journal不记录图片参数', async t => {
  const f = await fixture(t), image = 'data:image/png;base64,' + fs.readFileSync('apps/mobile/static/icons/check-dark.png').toString('base64');
  f.draft.images = [{ id: 'example-image', src: image }];
  await f.send();
  assert.deepEqual(f.desktop.calls.find(call => call.action === 'send').input.images, [image]);
  assert.equal(f.calls.some(call => call.method.startsWith('attachment.')), false);
  const receipt = f.journal.status('phone', 'settings-command-2');
  assert.equal(receipt.state, 'done'); assert.equal(JSON.stringify(receipt).includes(image), false);
});

test('JPEG data URI 遵守现有320KiB单张上限，超限保留手机图片且不触发原生提交', async t => {
  for (const bytes of [MAX_IMAGE_BYTES, MAX_IMAGE_BYTES + 1]) {
    const f = await fixture(t), data = Buffer.alloc(bytes); data.set([255, 216, 255]);
    const image = 'data:image/jpeg;base64,' + data.toString('base64'); f.draft.images = [{ id: 'example-image', src: image }];
    if (bytes === MAX_IMAGE_BYTES) {
      await f.send(); assert.deepEqual(f.desktop.calls.find(call => call.action === 'send').input.images, [image]);
    } else {
      await assert.rejects(f.send(), /图片过大|超出大小限制/);
      assert.equal(f.desktop.calls.some(call => call.action === 'send'), false); assert.equal(f.draft.images[0].src, image);
    }
    assert.equal(f.calls.some(call => call.method.startsWith('attachment.')), false);
  }
});

test('模型、强度、速度和计划模式通过真实原生服务 UPDATE 后回读，send 不携带补设置参数', async t => {
  const f = await fixture(t), changes = { model: 'model-b', effort: 'high', serviceTier: 'fast', mode: 'plan' };
  await f.updateNativeDraft(f.state, changes);
  assert.deepEqual(plain(f.state.snapshot.settings), changes);
  assert.equal(f.desktop.calls.filter(call => call.action === 'update').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.read').length, 2);
  await f.send();
  const sent = f.desktop.calls.find(call => call.action === 'send');
  assert.deepEqual(sent.input, { text: '合成的新任务', images: [], attachments: [] });
  assert.equal(sent.options.expectedRevision, 2); assert.equal(f.desktop.calls.filter(call => call.action === 'send').length, 1);
});

test('真实原生修订冲突保留手机草稿，Journal done+error 核对后回读电脑新值且不自动重试', async t => {
  const f = await fixture(t);
  f.desktop.state.settings.effort = 'high'; f.desktop.state.revision++;
  await assert.rejects(f.updateNativeDraft(f.state, { effort: 'medium' }), /已经变化|已变化/);
  assert.equal(f.draft.text, '合成的新任务'); assert.equal(f.state.snapshot.settings.effort, 'medium');
  const commandId = f.state.pendingCommandId, status = f.journal.status('phone', commandId);
  assert.equal(status.state, 'done'); assert.equal(status.error.code, 'DRAFT_CHANGED');
  assert.equal(f.desktop.calls.some(call => call.action === 'send' || call.action === 'update'), false);
  await f.checkNativeDraftCommand(f.state);
  assert.equal(f.state.outcomeUnknown, false); assert.equal(f.state.snapshot.settings.effort, 'high');
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.update').length, 1);
  await f.updateNativeDraft(f.state, { effort: 'medium' }); await f.send();
  assert.equal(f.desktop.calls.filter(call => call.action === 'open').length, 1); assert.equal(f.desktop.calls.filter(call => call.action === 'send').length, 1);
});

test('电脑更新设置由服务 changed 快照驱动手机，回读不覆盖更晚事件、不写回旧设置', async t => {
  const f = await fixture(t);
  f.desktop.state.settings = { model: 'model-b', effort: 'high', serviceTier: 'fast', mode: 'plan' }; f.desktop.state.revision++;
  await f.service.read({ draftId: f.state.draftId }, 'phone');
  assert.deepEqual(plain(f.state.snapshot.settings), f.desktop.state.settings);
  assert.equal(f.desktop.calls.some(call => call.action === 'update'), false);
  await f.send(); assert.equal(f.desktop.calls.filter(call => call.action === 'update').length, 0);
});

test('原生权限完整访问在手机确认后写入真实服务，权限与执行设置共享同一草稿修订', async t => {
  const f = await fixture(t);
  await assert.rejects(f.updateNativeDraft(f.state, { permissionMode: 'full-access' }), /先确认/);
  assert.equal(f.desktop.calls.some(call => call.action === 'update'), false);
  await f.updateNativeDraft(f.state, { permissionMode: 'full-access' }, true);
  assert.equal(f.state.snapshot.permissions.mode, 'full-access'); assert.equal(f.state.snapshot.revision, 2);
  const update = f.desktop.calls.find(call => call.action === 'update'); assert.equal(update.options.confirmedFullAccess, true); assert.equal(update.options.expectedRevision, 1);
  f.draft.choices = { permissionMode: 'full-access', confirmedFullAccess: true };
  await f.send(); assert.equal(f.desktop.calls.find(call => call.action === 'send').options.expectedRevision, 2);
});
