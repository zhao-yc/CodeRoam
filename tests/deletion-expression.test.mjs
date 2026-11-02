import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { deletionExpression } from '../apps/bridge/deletion-expression.mjs';

/** 构建最小原生确认框结构，执行实际固定表达式验证编号绑定。 */
function dialogFixture(threadId = 'root', hostId = 'local') {
  const clicked = [], button = text => ({ textContent: text, disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30, left: 1, top: 1, right: 101, bottom: 31 }), click: () => clicked.push(text) });
  const buttons = [button('删除'), button('取消')];
  const dialog = { getBoundingClientRect: buttons[0].getBoundingClientRect, querySelectorAll: () => buttons, __reactFiber$synthetic: { memoizedProps: { conversationId: threadId, hostId } } };
  const context = { innerWidth: 1000, innerHeight: 1000, getComputedStyle: () => ({ visibility: 'visible' }), window: { __codexMobileDeletion: { host: 'local', thread: 'root', commandId: 'command', submitted: false } }, document: { querySelectorAll: selector => selector.includes('role=') ? [dialog] : [] } };
  return { clicked, context };
}

test('确认按钮必须属于目标电脑和会话，标题相同不能替代编号校验', () => {
  for (const [thread, host] of [['other', 'local'], ['root', 'other']]) {
    const f = dialogFixture(thread, host), result = vm.runInNewContext(deletionExpression('commit', 'local', 'root', 'command'), f.context);
    assert.equal(result.state, 'changed'); assert.equal(f.clicked.length, 0);
  }
  const f = dialogFixture();
  assert.equal(vm.runInNewContext(deletionExpression('commit', 'local', 'root', 'command'), f.context).state, 'submitted');
  assert.deepEqual(f.clicked, ['删除']);
  assert.equal(vm.runInNewContext(deletionExpression('commit', 'local', 'root', 'command'), f.context).state, 'changed');
});

test('表达式参数经 JSON 编码，不能注入代码或选择任意交互阶段', () => {
  const f = dialogFixture();
  vm.runInNewContext(deletionExpression('commit', 'local', 'root");globalThis.injected=true;//', 'command'), f.context);
  assert.equal(f.context.injected, undefined); assert.equal(f.clicked.length, 0);
  assert.throws(() => deletionExpression('execute', 'local', 'root', 'command'));
});

test('侧栏多选标记为假时仍按目标编号定位，其他电脑或编号不能匹配', () => {
  const row = { getAttribute: name => ({ 'data-app-action-sidebar-thread-id': 'local:root', 'data-app-action-sidebar-thread-host-id': 'local', 'data-app-action-sidebar-thread-selected': 'false' })[name] ?? null, getBoundingClientRect: () => ({ width: 200, height: 40, left: 0, top: 0, right: 200, bottom: 40 }) };
  const context = { innerWidth: 1000, innerHeight: 1000, getComputedStyle: () => ({ visibility: 'visible' }), window: {}, document: { querySelectorAll: selector => selector.includes('role=') ? [] : [row] } };
  assert.equal(vm.runInNewContext(deletionExpression('inspect', 'local', 'root', 'command'), context).target, true);
  assert.equal(vm.runInNewContext(deletionExpression('inspect', 'other', 'root', 'command'), context).target, false);
  assert.equal(vm.runInNewContext(deletionExpression('inspect', 'local', 'other', 'command'), context).target, false);
});

/** 模拟桌面新建对话：DOM 沿用临时键，行组件已绑定正式会话编号。 */
function sidebarFixture({ alias = true, host = 'local', thread = 'root', top = 20 } = {}) {
  const rowId = alias ? 'local:client-new-thread:00000000-0000-4000-8000-000000000001' : 'local:root';
  const attributes = { 'data-app-action-sidebar-thread-id': rowId, 'data-app-action-sidebar-thread-host-id': 'local' };
  let currentTop = top, scrolls = 0;
  const row = {
    getAttribute: name => attributes[name] ?? null,
    getBoundingClientRect: () => ({ width: 200, height: 40, left: 20, right: 220, top: currentTop, bottom: currentTop + 40 }),
    scrollIntoView: () => { scrolls++; currentTop = 20; },
    contains: element => element === row,
    __reactFiber$synthetic: { memoizedProps: { conversationId: thread, hostId: host, dataAttributes: { ...attributes } } },
  };
  const context = { innerWidth: 1000, innerHeight: 1000, getComputedStyle: () => ({ visibility: 'visible' }), window: {}, document: { querySelectorAll: selector => selector.includes('role=') ? [] : [row], elementFromPoint: () => row } };
  const step = phase => vm.runInNewContext(deletionExpression(phase, 'local', 'root', 'command'), context);
  return { row, attributes, context, step, scrolls: () => scrolls };
}

test('刚新建会话的临时侧栏键通过同一行正式编号定位，不使用标题', () => {
  const f = sidebarFixture();
  const state = f.step('inspect');
  assert.equal(state.target, true); assert.equal(state.aliasCount, 1);
  assert.equal(f.step('open').state, 'ready');
  assert.equal(f.context.window.__codexMobileDeletion.thread, 'root');
});

test('临时键没有明确绑定、属于其他电脑或存在冲突时不能打开删除入口', () => {
  for (const options of [{ host: 'other' }, { thread: 'other' }, {}]) {
    const f = sidebarFixture(options);
    if (!options.host && !options.thread) delete f.row.__reactFiber$synthetic;
    assert.equal(f.step('inspect').target, false); assert.equal(f.step('open').state, 'missing');
    assert.equal(f.scrolls(), 0);
  }
  const f = sidebarFixture();
  f.row.__reactFiber$synthetic.return = { memoizedProps: { conversationId: 'other', hostId: 'local', dataAttributes: { ...f.attributes } } };
  assert.equal(f.step('inspect').target, false);
});

test('不借用共享祖先的会话编号，也不接受复用 DOM 后过期的行绑定', () => {
  const f = sidebarFixture();
  f.row.__reactFiber$synthetic.memoizedProps.dataAttributes['data-app-action-sidebar-thread-id'] = 'local:client-new-thread:00000000-0000-4000-8000-000000000002';
  f.row.__reactFiber$synthetic.return = { memoizedProps: { conversationId: 'root', hostId: 'local' } };
  assert.equal(f.step('inspect').target, false);
  assert.equal(f.step('open').state, 'missing');
});

test('目标行滚出视口时先按编号找到页面，再滚动核对命中位置', () => {
  for (const alias of [false, true]) {
    const f = sidebarFixture({ alias, top: -500 });
    const state = f.step('inspect');
    assert.equal(state.target, true); assert.equal(state.visibleCount, 0);
    assert.equal(f.step('open').state, 'ready'); assert.equal(f.scrolls(), 1);
  }
});

test('滚动期间目标变化或被其他内容遮挡时不能生成菜单坐标', () => {
  const changed = sidebarFixture({ top: -500 });
  changed.row.scrollIntoView = () => { changed.attributes['data-app-action-sidebar-thread-id'] = 'local:other'; };
  assert.equal(changed.step('open').state, 'changed');
  assert.equal(changed.context.window.__codexMobileDeletion, undefined);
  const covered = sidebarFixture(); covered.context.document.elementFromPoint = () => ({});
  assert.equal(covered.step('open').state, 'covered');
  assert.equal(covered.context.window.__codexMobileDeletion, undefined);
});
