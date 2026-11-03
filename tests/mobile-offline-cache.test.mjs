import assert from 'node:assert/strict';
import test from 'node:test';
import {workspaceFixture} from './helpers/workspace-fixture.mjs';

// 离线入口迁移到工作区，列表组件仅发出用户选择。
function fixture(connected, online, cached) {
  const f=workspaceFixture({props:{windowWidth:390},connection:{connected,computers:[{id:'host',online}]},cached});
  f.openThread({id:'thread',hostId:'host',online,title:'合成聊天',cwd:'',key:'host:thread'});
  return f.calls;
}
test('电脑或中转离线时，有缓存仍进入详情且不触发桌面导航',()=>{
  for(const [connected,online] of [[true,false],[false,true],[false,false]]) {
    const calls=fixture(connected,online,true);
    assert.ok(calls.some(call=>call[0]==='navigate'));
    assert.ok(!calls.some(call=>call[0]==='open'));
    assert.deepEqual(calls[0],['cache','pair','host','thread']);
  }
});
test('离线未缓存只提示，在线仍正常打开桌面聊天',()=>{
  const missing=fixture(true,false,false);
  assert.ok(missing.some(call=>call[0]==='toast'&&call[1].includes('暂无本地缓存')));
  assert.ok(!missing.some(call=>call[0]==='select'||call[0]==='navigate'));
  assert.ok(fixture(true,true,false).some(call=>call[0]==='open'));
});
