import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const component = fs.readFileSync('apps/mobile/components/submission-task-list/submission-task-list.uvue', 'utf8');
const source = component.match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm, '');

// 运行实际组件脚本，以合成窗格、触摸和鼠标事件验证位置与导航副作用。
function fixture({ stored = '', glass = false, hostId = '', mode = 'ordinary', storageFails = false } = {}) {
  const watchers = [], navigations = [], saved = [], listeners = new Map();
  let mount, unmount, now = 1000;
  const rects = {
    'submission-task-area': { width: 390, height: 600 },
    'submission-dock-capsule': { width: 110, height: 44 },
    'submission-dock-panel': { width: 358, height: 300 },
  };
  const props = { active: true, obscured: false, glass, hostId, layoutKey: '390:700' };
  const target = name => ({
    addEventListener: (type, callback) => listeners.set(name + ':' + type, callback),
    removeEventListener: type => listeners.delete(name + ':' + type),
  });
  const scope = vm.createContext({
    ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
    watch: (read, changed) => watchers.push(changed), nextTick: callback => callback(),
    onMounted: callback => { mount = callback; }, onUnmounted: callback => { unmount = callback; },
    defineProps: () => props, withDefaults: (actual, defaults) => Object.assign(actual, { ...defaults, ...actual }), defineEmits: () => () => {},
    Date: { now: () => now }, document: target('document'), window: target('window'),
    JSON: Object.assign(Object.create(JSON), { parse: raw => {
      const value = JSON.parse(raw);
      if (value != null && typeof value === 'object') Object.defineProperty(value, 'getNumber', { value: key => typeof value[key] === 'number' ? value[key] : null });
      return value;
    } }),
    connection: { computers: [] },
    submissionTasks: { namespace: 'synthetic', clock: now, pending: [], instances: [{ hostId: 'synthetic-' + mode, supported: true, snapshot: { tasks: [], paused: false } }] },
    submissionNeedsPauseNotice: () => false, submissionFloatingState: () => 'idle', submissionFloatingLabel: () => '执行记录',
    uni: {
      getElementById: id => rects[id] == null ? null : { getBoundingClientRect: () => rects[id] },
      getStorageSync: () => { if (storageFails) throw Error('合成本地存储失败'); return stored; },
      setStorageSync: (key, raw) => { if (storageFails) throw Error('合成本地存储失败'); saved.push({ key, position: JSON.parse(raw) }); },
      navigateTo: value => navigations.push(value),
    },
  });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + `
    globalThis.subject = { positionX, positionY, horizontalRange, verticalRange, capsuleOffset, dockStyle, opened,
      beginTouch, moveTouch, finishTouch, beginMouse, moveMouse, finishMouse, cancelDrag, openPanel, closePanel, measureDock };
  `, scope);
  mount();
  return { ...scope.subject, scope, props, rects, watchers, navigations, saved, listeners, unmount, advance: () => { now += 1000; } };
}

const touch = (x, y, id = 1) => ({ identifier: id, clientX: x, clientY: y });
const begin = (f, x = 300, y = 500) => f.beginTouch({ touches: [touch(x, y)] });
const move = (f, x, y) => f.moveTouch({ touches: [touch(x, y)] });
const finish = (f, x, y) => f.finishTouch({ touches: [], changedTouches: [touch(x, y)] });
const mouse = (x, y, extra = {}) => ({ button: 0, buttons: 1, clientX: x, clientY: y, target: { closest: () => ({}) }, ...extra });

test('首次位于右下角，轻点与小于 8px 的移动只打开历史', () => {
  const f = fixture({ hostId: 'synthetic-ordinary' });
  assert.equal(f.positionX.value, 1); assert.equal(f.positionY.value, 1);
  assert.equal(f.dockStyle.value.bottom, '12px'); assert.ok(Math.abs(f.capsuleOffset.value) < 0.001);
  begin(f); move(f, 294, 496); finish(f, 294, 496); f.openPanel();
  assert.equal(f.saved.length, 0); assert.equal(f.navigations.length, 1);
  assert.equal(f.navigations[0].url, '/pages/task-history/index?hostId=synthetic-ordinary');
});

test('达到 8px 后自由拖动并保存，合成点击被屏蔽，后续轻点可用', () => {
  const f = fixture();
  begin(f); move(f, 292, 500);
  assert.ok(Math.abs(f.capsuleOffset.value + 8) < 0.001); assert.equal(f.saved.length, 0);
  move(f, 220, 400); finish(f, 220, 400); f.openPanel();
  assert.ok(Math.abs(f.capsuleOffset.value + 80) < 0.001);
  assert.equal(f.saved.length, 1); assert.match(f.saved[0].key, /position-v1$/);
  assert.equal(f.saved[0].position.x, 1 - 80 / 248);
  assert.equal(f.saved[0].position.y, 1 - 100 / 532);
  assert.equal(f.navigations.length, 0);
  f.advance(); begin(f); finish(f, 300, 500); f.openPanel();
  assert.equal(f.navigations.length, 1);
});

test('四边限位，宽屏缩窄及胶囊变宽时依归一化坐标重新布局', () => {
  const f = fixture();
  begin(f); move(f, -2000, -2000); finish(f, -2000, -2000);
  assert.equal(f.positionX.value, 0); assert.equal(f.positionY.value, 0);
  assert.equal(f.capsuleOffset.value, -248); assert.equal(f.dockStyle.value.bottom, '544px');
  f.advance(); begin(f); move(f, 2000, 2000); finish(f, 2000, 2000);
  assert.equal(f.positionX.value, 1); assert.equal(f.positionY.value, 1);
  assert.equal(f.dockStyle.value.bottom, '12px');
  f.positionX.value = 0.5; f.positionY.value = 0.5;
  f.rects['submission-task-area'] = { width: 340, height: 350 };
  f.rects['submission-dock-capsule'].width = 180; f.watchers[0]();
  assert.equal(f.capsuleOffset.value, -64); assert.equal(f.dockStyle.value.bottom, '153px');
  assert.equal(f.saved.length, 2);
});

test('玻璃模式保留底部按钮空间，顶部展开面板后收起恢复胶囊位置', () => {
  const f = fixture({ glass: true });
  assert.equal(f.dockStyle.value.bottom, '70px'); assert.equal(f.verticalRange.value, 474);
  f.positionY.value = 0;
  f.scope.submissionTasks.instances[0].snapshot.paused = true;
  f.openPanel(); f.measureDock();
  assert.equal(f.opened.value, true); assert.equal(f.dockStyle.value.bottom, '288px');
  f.closePanel(); assert.equal(f.dockStyle.value.bottom, '544px'); assert.equal(f.positionY.value, 0);
});

test('页面重建恢复长期保存的位置，无效值与存储不可用回退到默认位置', () => {
  const f = fixture({ stored: '{"x":0.25,"y":0.75}' });
  assert.equal(f.positionX.value, 0.25); assert.equal(f.positionY.value, 0.75);
  for (const stored of ['invalid', '{}', 'null', '{"x":-1,"y":1}', '{"x":1,"y":2}', '{"x":"0.5","y":1}', '{"x":1e999,"y":0}']) {
    const invalid = fixture({ stored });
    assert.equal(invalid.positionX.value, 1); assert.equal(invalid.positionY.value, 1);
  }
  const unavailable = fixture({ storageFails: true });
  begin(unavailable); finish(unavailable, 200, 400);
  assert.ok(unavailable.positionX.value < 1); assert.ok(unavailable.positionY.value < 1);
  assert.equal(unavailable.saved.length, 0);
});

test('多指、触点变化与系统取消撤销未完成手势，并屏蔽后续点击', () => {
  for (const cancel of [
    f => f.beginTouch({ touches: [touch(200, 400), touch(210, 410, 2)] }),
    f => f.moveTouch({ touches: [touch(200, 400, 2)] }),
    f => f.finishTouch({ touches: [touch(200, 400, 2)], changedTouches: [touch(200, 400)] }),
    f => f.cancelDrag(),
  ]) {
    const f = fixture(); begin(f); move(f, 200, 400); cancel(f); f.openPanel();
    assert.equal(f.positionX.value, 1); assert.equal(f.positionY.value, 1);
    assert.equal(f.saved.length, 0); assert.equal(f.navigations.length, 0);
  }
});

test('鼠标移出胶囊后继续跟随，松手保存并移除全局监听', () => {
  const f = fixture(); f.beginMouse(mouse(300, 500));
  assert.equal(f.listeners.size, 4);
  f.listeners.get('document:mousemove')(mouse(100, 300));
  f.listeners.get('document:mouseup')(mouse(100, 300)); f.openPanel();
  assert.equal(f.capsuleOffset.value, -200); assert.equal(f.saved.length, 1);
  assert.equal(f.listeners.size, 1); assert.equal(f.navigations.length, 0);
});

test('触摸后的兼容鼠标事件和右键不启动拖拽，失焦与卸载清理监听', () => {
  const f = fixture(); f.beginMouse(mouse(300, 500, { button: 2 })); assert.equal(f.listeners.size, 1);
  f.beginMouse(mouse(300, 500, { target: null })); assert.equal(f.listeners.size, 1);
  begin(f); finish(f, 200, 400); f.beginMouse(mouse(200, 400)); assert.equal(f.listeners.size, 1);
  f.advance(); f.beginMouse(mouse(300, 500)); f.moveMouse(mouse(100, 300));
  f.listeners.get('window:blur')(); assert.equal(f.listeners.size, 1);
  f.advance(); f.beginMouse(mouse(300, 500)); f.unmount(); assert.equal(f.listeners.size, 0);
});

for (const mode of ['ordinary', 'multi-instance']) {
  test(`${mode} 的实例筛选、展开与返回后的位置保持正确`, () => {
    const f = fixture({ mode, hostId: 'synthetic-' + mode });
    begin(f); finish(f, 200, 400);
    const savedX = f.positionX.value;
    f.props.active = false; f.watchers[2]();
    f.props.active = true; f.watchers[2](); f.watchers[1]();
    assert.equal(f.positionX.value, savedX);
    f.advance(); f.scope.submissionTasks.instances[0].snapshot.paused = true;
    f.openPanel(); assert.equal(f.opened.value, true); f.closePanel();
    f.scope.submissionTasks.instances[0].snapshot.paused = false;
    f.openPanel(); assert.equal(f.navigations[0].url, '/pages/task-history/index?hostId=synthetic-' + mode);
  });
}

test('模板为胶囊接入触摸与鼠标事件，空白浮层允许 Web 列表继续滚动', () => {
  assert.match(component, /@touchcancel\.stop="cancelDrag"/);
  assert.match(component, /document.addEventListener\('mousedown', beginMouse\)/);
  assert.match(component, /touch-action: none/);
  assert.match(component, /\.submission-dock \{ pointer-events: none/);
});
