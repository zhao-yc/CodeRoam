import test from 'node:test';
import assert from 'node:assert/strict';
import {selectNativeEndpoint} from '../apps/bridge/native-endpoint.mjs';
const first={path:'\\\\.\\pipe\\codex-app-tools-00000000-0000-4000-8000-000000000001',pid:100,hasWindow:true};
const second={path:'\\\\.\\pipe\\codex-app-tools-00000000-0000-4000-8000-000000000002',pid:200,hasWindow:true};

test('后台没有聊天环境变量时，多桌面实例按会话 IPC 进程同步未读',()=>{
  assert.equal(selectNativeEndpoint({candidates:[second,first],ipcProcessId:100}),first);
  assert.equal(selectNativeEndpoint({candidates:[second,first],ipcProcessId:100},second.path),first);
});
test('会话 IPC 对应的原生实例缺失或重复时拒绝选用其他桌面',()=>{
  for(const candidates of [[second],[first,first],[]])assert.throws(()=>selectNativeEndpoint({candidates,ipcProcessId:100},second.path),{code:'DESKTOP_NATIVE_UNAVAILABLE'});
});
test('IPC 暂不可用时保留显式管道及单实例兼容，多实例仍拒绝猜测',()=>{
  assert.equal(selectNativeEndpoint({candidates:[first,second]},second.path),second);
  assert.equal(selectNativeEndpoint({candidates:[first]}),first);
  assert.throws(()=>selectNativeEndpoint({candidates:[first,second]}),{code:'DESKTOP_NATIVE_UNAVAILABLE'});
  assert.throws(()=>selectNativeEndpoint({candidates:[{...first,path:'\\\\other\\pipe\\codex-app-tools-123'}]}),{code:'DESKTOP_NATIVE_UNAVAILABLE'});
});
