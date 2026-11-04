import assert from 'node:assert/strict';
import test from 'node:test';
import {workspaceFixture} from './helpers/workspace-fixture.mjs';

// 本地列表只提供摘要入口，每次打开正文均需要已连接的授权电脑。
test('电脑或中转离线时仅提示连接，不读取正文或进入详情',async()=>{
  for(const [connected,online] of [[true,false],[false,true],[false,false]]) {
    const f=workspaceFixture({props:{windowWidth:390},connection:{connected,computers:[{id:'host',online}]},cached:true});
    await f.openThread({id:'thread',hostId:'host',online,title:'合成聊天',cwd:'',key:'host:thread'});
    assert.deepEqual(f.calls,[['toast','请连接电脑后查看聊天']]);
  }
});

test('电脑恢复在线后每次重新打开聊天均请求当前订阅',async()=>{
  const f=workspaceFixture({props:{windowWidth:390},connection:{connected:false,computers:[{id:'host',online:true}]},cached:true});
  const row={id:'thread',hostId:'host',online:true,title:'合成聊天',cwd:'',key:'host:thread'};
  await f.openThread(row);
  f.connection.connected=true;
  await f.openThread(row);
  await f.openThread(row);
  assert.equal(f.calls.filter(([kind])=>kind==='open').length,2);
  assert.equal(f.calls.some(([kind])=>kind==='cache'),false);
  assert.ok(f.calls.filter(([kind])=>kind==='navigate').every(([,url])=>!url.includes('cacheOnly')));
});
