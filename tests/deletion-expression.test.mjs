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
