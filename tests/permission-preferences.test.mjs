import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { installPermissionPreferences } from './helpers/permission-preferences-context.mjs';

function fixture(storage = new Map()) {
  const scope = { uni: { getStorageSync: key => storage.get(key), setStorageSync: (key, mode) => storage.set(key, mode) } };
  installPermissionPreferences(scope);
  return { ...scope, storage };
}

test('三档权限按电脑和配对空间保存，重开页面恢复，不保存确认与权限版本', () => {
  const f = fixture();
  for (const mode of ['default', 'auto-review', 'full-access']) {
    f.savePermissionPreference('pair', 'pc', mode);
    assert.equal(f.readPermissionPreference('pair', 'pc'), mode);
    assert.equal(fixture(f.storage).readPermissionPreference('pair', 'pc'), mode);
  }
  assert.equal(f.readPermissionPreference('pair', 'other-pc'), '');
  assert.equal(f.readPermissionPreference('other-pair', 'pc'), '');
  assert.deepEqual([...f.storage.values()], ['full-access']);
});

test('旧版无偏好、损坏值和存储失败均保留原权限边界', () => {
  const f = fixture();
  assert.equal(f.readPermissionPreference('pair', 'pc'), '');
  f.savePermissionPreference('pair', 'pc', 'auto-review');
  f.uni.setStorageSync = () => { throw Error('合成存储失败'); };
  assert.throws(() => f.savePermissionPreference('pair', 'pc', 'full-access'), /无法保存权限偏好/);
  assert.equal(f.readPermissionPreference('pair', 'pc'), 'auto-review');
  f.savePermissionPreference('pair', 'pc', 'custom');
  assert.equal(f.readPermissionPreference('pair', 'pc'), 'auto-review');
  const corrupted = new Map([['coderoam-permission-v1-["pair","pc"]', '{"confirmedFullAccess":true}']]);
  assert.equal(fixture(corrupted).readPermissionPreference('pair', 'pc'), '');
});

const component = fs.readFileSync('apps/mobile/components/new-conversation/new-conversation.uvue', 'utf8');
const send = component.slice(component.indexOf('async function send()'), component.indexOf('// 为 200ms'));

function sender(mode = 'desktopIpc', permission = 'auto-review') {
  const f = fixture(), submissions = [], draft = { choices: {}, hostId: 'pc' };
  f.savePermissionPreference('pair', 'pc', permission);
  const ref = value => ({ value });
  let answer = false, modal;
  const c = vm.createContext({ ...f, canSend: ref(true), draft: ref(draft), newConversationMode: ref(mode),
    rememberedPermission: { get value() { return f.readPermissionPreference('pair', 'pc') || 'default'; } },
    connection: { configurationRevision: 1 }, supportsDirectChoices: ref(true), supportsSubmissionTasks: () => true,
    props: { expanded: true }, alive: true, projectReady: ref(true), settings: ref(null), busy: ref(false), pendingNewAction: ref(''), error: ref(''), progress: ref(''),
    closeMenus() {}, emit() {}, submitNewConversationTask: async (target, selectedMode) => { submissions.push({ mode: selectedMode, choices: { ...target.choices } }); target.choices = {}; },
    uni: { hideKeyboard() {}, showModal(options) { if (modal) modal.resolve = confirm => options.success({ confirm }); else options.success({ confirm: answer }); } },
  });
  vm.runInContext(stripTypeScriptTypes(send, { mode: 'transform' }) + '\nglobalThis.send = send;', c);
  return { ...f, c, draft, submissions, answer(value) { answer = value; }, defer() { modal = {}; return modal; } };
}

for (const mode of ['desktopIpc', 'nativeDraft']) {
  test('普通启动与多实例新建链路沿用同一电脑偏好，清稿后继续沿用并尊重草稿选择 ' + mode, async () => {
    const f = sender(mode);
    await f.c.send();await f.c.send();
    assert.equal(f.submissions.length, 2);
    assert.equal(f.submissions.every(entry => entry.mode === mode && entry.choices.permissionMode === 'auto-review'), true);
    f.draft.choices = { permissionMode: 'default' };await f.c.send();
    assert.equal(f.submissions[2].choices.permissionMode, 'default');
  });
  test('记住完全访问档位后每条新聊天独立确认，取消及确认期间切换目标均不提交 ' + mode, async () => {
    const f = sender(mode, 'full-access');
    await f.c.send();assert.equal(f.submissions.length, 0);assert.deepEqual(f.draft.choices, {});
    f.answer(true);await f.c.send();
    assert.equal(f.submissions[0].choices.confirmedFullAccess, true);
    f.answer(false);await f.c.send();assert.equal(f.submissions.length, 1);
    const modal = f.defer(), pending = f.c.send();f.c.connection.configurationRevision++;modal.resolve(true);await pending;
    assert.equal(f.submissions.length, 1);assert.equal(f.c.busy.value, false);
  });
}
