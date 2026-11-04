import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceFixture} from './helpers/workspace-fixture.mjs';

/** 用真实工作区逻辑验证返回目标，避免列表外观与刷新入口不一致。 */
async function detail(options = {}) {
  const f = workspaceFixture({...options, props:{detailRoute:true, ...options.props}});
  await f.selectConversation(f.target(), false);
  return f;
}

test('窄屏和宽屏直达详情后关闭，均跳到不带聊天参数的列表地址', async () => {
  for(const windowWidth of [390, 1366]) {
    const f = await detail({props:{windowWidth}, pages:[{route:'pages/conversation/index'}]});
    f.closeConversation();
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'back' || kind === 'relaunch'), [['relaunch', '/pages/index/index']]);
    assert.equal(f.mode.value, 'conversation', '退出期间不在详情路由下挂载列表');
  }
});

test('从列表打开详情后返回复用原列表页，屏幕旋转不改变返回目标', async () => {
  for(const windowWidth of [390, 1366]) {
    const f = await detail({props:{windowWidth}});
    f.closeConversation();
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'back' || kind === 'relaunch'), [['back']]);
    assert.equal(f.handleBack(), false, '允许框架完成 navigateBack，不再次拦截');
  }
});

test('上一页不是列表或返回失败时，仍回到列表路由', async () => {
  const other = await detail({pages:[{route:'pages/settings/index'}, {route:'pages/conversation/index'}]});
  other.closeConversation();
  assert.ok(other.calls.some(([kind, url]) => kind === 'relaunch' && url === '/pages/index/index'));
  const failed = await detail({backFails:true});
  failed.closeConversation();
  assert.deepEqual(failed.calls.filter(([kind]) => kind === 'back' || kind === 'relaunch'), [['back'], ['relaunch', '/pages/index/index']]);
});

test('直达详情的返回键先关闭浮层，再返回列表路由', async () => {
  const f = await detail({pages:[{route:'pages/conversation/index'}]});
  f.detailPane.value = {handleBack:() => true};
  assert.equal(f.handleBack(), true);
  assert.equal(f.calls.some(([kind]) => kind === 'relaunch'), false);
  f.detailPane.value = {handleBack:() => false};
  assert.equal(f.handleBack(), true);
  assert.ok(f.calls.some(([kind, url]) => kind === 'relaunch' && url === '/pages/index/index'));
});

test('列表带聊天参数的旧链接退出时清除参数，普通分栏关闭不重建列表', async () => {
  const initialTarget = {hostId:'host', threadId:'linked', title:'合成聊天', projectName:'项目', cacheNamespace:'pair'};
  const linked = await detail({props:{detailRoute:false, initialTarget}});
  linked.closeConversation();
  assert.ok(linked.calls.some(([kind, url]) => kind === 'relaunch' && url === '/pages/index/index'));
  const embedded = await detail({props:{detailRoute:false}});
  embedded.closeConversation();
  assert.equal(embedded.mode.value, 'list');
  assert.equal(embedded.selected.value, null);
  assert.equal(embedded.calls.some(([kind]) => kind === 'back' || kind === 'relaunch'), false);
});

test('详情内归档或删除后由目标列表页显示提示', async () => {
  for(const kind of ['archive', 'delete']) {
    const f = await detail({pages:[{route:'pages/conversation/index'}]});
    f.onConversationRemoved(kind);
    assert.ok(f.calls.some(([call, url]) => call === 'relaunch' && url === '/pages/index/index'));
    assert.equal(f.calls.some(([call]) => call === kind + '-notice'), false);
  }
});
