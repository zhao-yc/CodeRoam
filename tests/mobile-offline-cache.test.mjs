import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {stripTypeScriptTypes} from 'node:module';

// 执行真实首页点击方法，用合成电脑和缓存验证离线入口。
function fixture(connected, online, cached) {
  const source=fs.readFileSync('apps/mobile/pages/index/index.uvue','utf8');
  const method=source.slice(source.indexOf('function openThread(thread:'),source.indexOf('\n',source.indexOf('function openThread(thread:')));
  const calls=[];
  const context=vm.createContext({connection:{connected,cacheNamespace:'pair'},readConversationCache:(...args)=>{calls.push(['cache',...args]);return cached?{}:null;},bridge:{selectComputer:id=>calls.push(['select',id]),openThread:id=>{calls.push(['open',id]);return Promise.resolve({});}},uni:{showToast:value=>calls.push(['toast',value.title]),navigateTo:value=>calls.push(['navigate',value.url])},encodeURIComponent,projectName:()=> '合成项目'});
  vm.runInContext(stripTypeScriptTypes(method,{mode:'transform'})+`;openThread({id:'thread',hostId:'host',online:${online},title:'合成聊天',cwd:'',key:'host:thread'});`,context);
  return calls;
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
