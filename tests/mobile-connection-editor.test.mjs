import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 直接执行编辑面板的 UTS，检查草稿、重复保存、错误和远端推送竞争。 */
function editorFixture() {
  const props = { computer: { id: 'pc', label: '原名', icon: 'laptop', hostname: 'example-pc', profileRevision: 2 }, anchorLeft: 290, anchorTop: 100, releaseAt: Date.now() - 1000 };
  const events = [], requests = [], lifecycle = [];
  const connection = { connected: true, supportsHostProfiles: true };
  const context = componentContext({ defineProps: () => props, defineEmits: () => (...event) => events.push(event), ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }), onUnmounted: fn => lifecycle.push(fn), connection, computerIcon: computer => computer?.icon ?? 'laptop', bridge: { updateComputerProfile(...args) { return new Promise((resolve, reject) => requests.push({ args, resolve, reject })); } }, uni: { getWindowInfo: () => ({ windowWidth: 320, windowHeight: 600 }), hideKeyboard() {}, showToast() {} } });
  const source = fs.readFileSync('apps/mobile/components/connection-editor/connection-editor.uvue', 'utf8').split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\r?\n/gm, '');
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + ';globalThis.subject={beginEditing,displayName,icon,canSave,save,dismiss,saving,error,menuLeft,menuWidth,onKeyboardChange,sheetHeight};', context);
  return { ...context.subject, props, events, requests, connection, unmount: () => lifecycle.forEach(fn => fn()) };
}

test('长名称与图标草稿只在打开时初始化，未修改和空白名称禁用保存', () => {
  const f = editorFixture(); f.beginEditing(); assert.equal(f.canSave.value, false);
  assert.ok(f.menuLeft.value + f.menuWidth <= 308);
  f.displayName.value = '  '; assert.equal(f.canSave.value, false);
  f.displayName.value = ' 原名 '; assert.equal(f.canSave.value, false);
  f.displayName.value = '修改名称'; assert.equal(f.canSave.value, true);
  f.props.computer = { ...f.props.computer, label: '远端新名称', profileRevision: 3 }; assert.equal(f.displayName.value, '修改名称');
  f.onKeyboardChange({ detail: { height: 330 } }); assert.equal(f.sheetHeight.value, 242);
  f.dismiss(); assert.deepEqual(f.events.at(-1), ['dismiss']); assert.equal(f.requests.length, 0);
});

test('保存固定目标与打开时版本，防重复提交，失败保留草稿，成功才退出', async () => {
  const f = editorFixture(); f.beginEditing(); f.displayName.value = ' 修改名称 '; f.icon.value = 'desktop'; f.save(); f.save(); f.dismiss();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].args, ['pc', '修改名称', 'desktop', 2]); assert.equal(f.events.some(event => event[0] === 'dismiss'), false);
  f.requests[0].reject(new Error('连接已在其他客户端修改')); await Promise.resolve(); assert.equal(f.saving.value, false); assert.equal(f.displayName.value, ' 修改名称 '); assert.match(f.error.value, /其他客户端/);
  f.save(); f.requests[1].resolve({}); await Promise.resolve(); assert.equal(f.events.at(-1)[0], 'dismiss');
});

test('旧中转及断网禁用保存，卸载后的回执不再触发提示或关闭', async () => {
  const f = editorFixture(); f.beginEditing(); f.icon.value = 'code'; f.connection.supportsHostProfiles = false; f.save(); assert.equal(f.requests.length, 0);
  f.connection.supportsHostProfiles = true; f.connection.connected = false; assert.equal(f.canSave.value, false);
  f.connection.connected = true; f.save(); f.unmount(); f.requests[0].resolve({}); await Promise.resolve(); assert.equal(f.events.some(event => event[0] === 'dismiss'), false);
});

test('首页长按及关闭后的释放点击不筛选，正常点击保持原筛选行为', () => {
  const source = fs.readFileSync('apps/mobile/components/chat-list/chat-list.uvue', 'utf8');
  const methods = source.split(/\r?\n/).filter(line => line.startsWith('function chooseComputerFilter(')).join('\n');
  let refreshes = 0;
  const context = { editingComputerId: { value: 'pc' }, suppressComputerClickUntil: 0, Date, displayComputers: { value: [{ id: 'pc' }, { id: 'cached-pc' }] }, selectedComputerId: { value: '' }, resetThreadScroll() {}, refreshComputerThreads() { refreshes++; } };
  vm.runInNewContext(stripTypeScriptTypes(methods) + ";chooseComputerFilter('pc');", componentScope(context)); assert.equal(refreshes, 0);
  context.editingComputerId.value = ''; context.suppressComputerClickUntil = Date.now() + 500;
  vm.runInNewContext("chooseComputerFilter('pc');", componentScope(context)); assert.equal(refreshes, 0);
  context.suppressComputerClickUntil = 0; vm.runInNewContext("chooseComputerFilter('pc');", componentScope(context)); assert.equal(refreshes, 1); assert.equal(context.selectedComputerId.value, 'pc');
  vm.runInNewContext("chooseComputerFilter('cached-pc');", componentScope(context)); assert.equal(refreshes, 2); assert.equal(context.selectedComputerId.value, 'cached-pc');
});

test('长按尚未松手和松手后的合成点击不会关闭菜单，后续遮罩点击正常关闭', () => {
  const f = editorFixture(); f.props.releaseAt = 0; f.dismiss(); assert.equal(f.events.length, 0);
  f.props.releaseAt = Date.now(); f.dismiss(); assert.equal(f.events.length, 0);
  f.props.releaseAt = Date.now() - 1000; f.dismiss(); assert.equal(f.events.at(-1)[0], 'dismiss');
});

test('含实例分隔符的设备长按使用可查询且无碰撞的元素编号，编辑目标仍为原设备', () => {
  const source = fs.readFileSync('apps/mobile/components/chat-list/chat-list.uvue', 'utf8');
  const methods = ['computerTabElementId', 'openComputerMenu'].map(name => source.match(new RegExp('function ' + name + '\\([^]*?\\n}'))?.[0]).join('\n');
  const ids = ['pc', 'pc~00000000-0000-4000-8000-000000000001', 'pc_7e_', 'pc~', 'pc.1:second', '合成设备'];
  const queries = [], target = ids[1];
  const context = componentContext({ connection: { computers: [{ id: target }] }, editingNewConversation: { value: false }, editingComputerId: { value: '' }, connectionMenuLeft: { value: 0 }, connectionMenuTop: { value: 0 }, connectionReleaseAt: { value: 1 }, suppressComputerClickUntil: 0, Date, uni: { getElementById(id) {
    assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/); queries.push(id);
    return { getBoundingClientRect: () => id === 'home-page' ? { top: 20 } : { left: 180, bottom: 120 } };
  } } });
  vm.runInContext(stripTypeScriptTypes(methods, { mode: 'transform' }) + ';globalThis.subject={computerTabElementId,openComputerMenu}', context);
  const encoded = ids.map(id => context.subject.computerTabElementId(id)); assert.equal(new Set(encoded).size, ids.length);
  context.subject.openComputerMenu('cached-pc'); assert.equal(queries.length, 0);
  context.subject.openComputerMenu(target); assert.equal(queries[0], encoded[1]); assert.equal(context.editingComputerId.value, target); assert.equal(context.connectionMenuLeft.value, 180); assert.equal(context.connectionMenuTop.value, 104);
  assert.match(source, /:id="computerTabElementId\(computer\.id\)"/);
});
