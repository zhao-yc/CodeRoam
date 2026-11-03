import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 执行真实设置与聚焦方法，确认迟到响应不能将焦点带到其他聊天。 */
function fixture(newDraft = false) {
  const source = fs.readFileSync(newDraft ? 'apps/mobile/components/new-conversation/new-conversation.uvue' : 'apps/mobile/pages/conversation/index.uvue', 'utf8');
  const method = name => source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0];
  const pending = [], ticks = [], calls = [], ref = value => ({ value });
  const context = vm.createContext({
    busy: ref(false), nativeReady: ref(true), native: ref({}), alive: true, props: { expanded: true },
    connection: { hostId: 'computer', activeThreadId: 'thread', snapshot: {} },
    pageHostId: ref('computer'), pageThreadId: ref('thread'), projectId: ref('project'), pageVisible: ref(true),
    settings: ref({ model: 'example', effort: 'medium' }), models: ref([]), settingsBusy: ref(false),
    settingsLoading: ref(false), settingsError: ref(''), error: ref(''), settingsRequest: 0, settingsSnapshotRevision: 0,
    canWrite: ref(true), readOnly: ref(false), predictionFocus: ref(false), inputFocused: ref(false), focused: ref(false),
    composerBlurTimer: 0, clearTimeout() {}, nextTick: run => ticks.push(run),
    isCurrentPage: () => context.connection.hostId === 'computer' && context.connection.activeThreadId === 'thread',
    closeComposerMenu: () => calls.push('关闭菜单'), closeMenus: () => calls.push('关闭菜单'), refresh: () => calls.push('刷新'),
    bridge: { request: (method, params) => { calls.push({ method, params }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
    updateNativeDraft: (_state, changes, confirmed) => { calls.push({ changes, confirmed }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
  });
  const methods = newDraft ? ['selectSetting', 'selectPermission', 'changeNativeSettings', 'focusDraftInput'] : ['selectSetting', 'onPermissionApplied', 'focusComposerInput'];
  vm.runInContext(stripTypeScriptTypes(methods.map(method).join('\n'), { mode: 'transform' }) + '\nglobalThis.select = selectSetting;globalThis.permission = ' + (newDraft ? 'selectPermission;' : 'onPermissionApplied;'), context);
  return { context, pending, calls, select: context.select, permission: context.permission, flush: () => { ticks.splice(0).forEach(run => run()); }, focused: () => (newDraft ? context.focused : context.predictionFocus).value };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = { settings: { model: 'example', effort: 'high' }, models: [] };

for (const newDraft of [false, true]) {
  const label = newDraft ? '新建聊天' : '已有聊天';
  for (const [key, value, settingLabel] of [['effort', 'high', '强度'], ['model', 'example-next', '模型'], ['serviceTier', 'fast', '速度']]) {
    test(label + settingLabel + '确认后恢复输入焦点，等待回执时不聚焦且不发送消息', async () => {
      const f = fixture(newDraft);
      const selected = f.select(key, value);
      f.flush(); assert.equal(f.focused(), false);
      f.pending.shift().resolve(response); await selected; await settle(); f.flush();
      assert.equal(f.focused(), true); assert.ok(f.calls.includes('关闭菜单'));
      assert.equal(f.calls.some(call => call.method?.startsWith('turn.')), false);
    });
    test(label + settingLabel + '失败、页面收起或切换目标后不聚焦', async () => {
      for (const change of ['失败', '隐藏', '电脑', '聊天']) {
        const f = fixture(newDraft), selected = f.select(key, value);
        if (change === '隐藏') { f.context.props.expanded = false; f.context.pageVisible.value = false; }
        if (change === '电脑') f.context.connection.hostId = 'other';
        if (change === '聊天') { f.context.connection.activeThreadId = 'other'; f.context.projectId.value = 'other'; }
        if (change === '失败') f.pending.shift().reject(new Error('设置失败')); else f.pending.shift().resolve(response);
        await selected; await settle(); f.flush(); assert.equal(f.focused(), false, change);
        if (change === '失败') assert.equal(f.context.settingsError.value, '设置失败');
      }
    });
  }
  test(label + '禁用状态不额外聚焦或提交设置', async () => {
    const f = fixture(newDraft);
    f.context.busy.value = true; f.context.canWrite.value = false;
    await f.select('effort', 'high'); f.flush(); assert.equal(f.pending.length, 0); assert.equal(f.focused(), false);
  });
}

// 已有聊天由组件的成功事件通知页面，只有同一可编辑目标才恢复输入。
test('已有聊天权限成功事件只聚焦当前可见且可编辑的聊天', () => {
  const f=fixture(); f.permission('computer','thread'); f.flush(); assert.equal(f.focused(),true);
  for(const change of ['隐藏','电脑','聊天','只读']) {
    const other=fixture();
    if(change==='隐藏') other.context.pageVisible.value=false;
    if(change==='电脑') other.context.connection.hostId='other';
    if(change==='聊天') other.context.connection.activeThreadId='other';
    if(change==='只读') other.context.canWrite.value=false;
    other.permission('computer','thread'); other.flush(); assert.equal(other.focused(),false,change);
  }
});
test('新建聊天权限确认成功后聚焦，确认标记原样传递，失败与迟到回执不聚焦', async () => {
  for(const change of ['成功','失败','隐藏','电脑','项目']) {
    const f=fixture(true); f.permission('full-access',true); f.flush(); assert.equal(f.focused(),false);
    assert.deepEqual({...f.calls[0].changes},{permissionMode:'full-access'}); assert.equal(f.calls[0].confirmed,true);
    if(change==='隐藏') f.context.props.expanded=false;
    if(change==='电脑') f.context.connection.hostId='other';
    if(change==='项目') f.context.projectId.value='other';
    if(change==='失败') f.pending.shift().reject(new Error('权限设置失败')); else f.pending.shift().resolve(response);
    await settle(); f.flush(); assert.equal(f.focused(),change==='成功',change);
    if(change==='失败') assert.equal(f.context.settingsError.value,'权限设置失败');
  }
});
