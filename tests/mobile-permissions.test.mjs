import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
/** 执行实际组件脚本，验证确认取消和目标切换不会触发写操作。 */
function fixture({ initialProps = {}, mode = 'default', request: read } = {}){
 const props={threadId:'thread',projectId:'',selectedMode:'',disabled:false,active:true,...initialProps},calls=[],events=[],watchers=[],unmounts=[];
 const connection={hostId:'pc',connected:true,subscriptionRevision:1,computers:[{id:'pc',online:true}],snapshot:{threadId:'thread',supportsPermissionSettings:true,permissionSettings:{mode:'default'},activeTurnId:''}};
 let answer={confirm:false},confirm;
 const data={mode,revision:'a'.repeat(64),options:['default','auto-review','read-only','full-access'].map(id=>({id,enabled:true}))};
 // 保留实际脚本的立即监听与失效逻辑；每次修改测试输入后同步派发监听。
 function watch(source, callback, options = {}) {
  const value = () => typeof source === 'function' ? source() : source.value;
  const watcher = { value, previous: value(), callback }; watchers.push(watcher);
  if (options.immediate) callback(watcher.previous);
 }
 function sync() {
  for (let pass = 0; pass < 10; pass++) {
   let changed = false;
   for (const watcher of watchers) { const value = watcher.value(); if (value !== watcher.previous) { const previous = watcher.previous; watcher.previous = value; watcher.callback(value, previous); changed = true; } }
   if (!changed) return;
  }
  throw Error('测试监听未收敛');
 }
 const ctx=vm.createContext({props,connection,withDefaults:v=>v,defineProps:()=>props,defineEmits:()=>(...args)=>events.push(args),ref:value=>({value}),computed:fn=>({get value(){return fn()}}),watch,onUnmounted:fn=>unmounts.push(fn),permissionLabel:v=>v,uni:{getWindowInfo:()=>({windowWidth:390,windowHeight:844}),getElementById:()=>null,showModal:options=>{if(confirm)confirm.resolve=value=>options.success(value);else options.success(answer)}},bridge:{request:async(method,params)=>{calls.push({method,params});if(read)return read(method,params,data);return method==='thread.permissions.update'?{...data,mode:params.mode}:data}}});
 let source=fs.readFileSync('apps/mobile/components/permissions-control/permissions-control.uvue','utf8').split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\r?\n/gm,'');
 vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.subject={load,choose,state,mode,label,loading,error,opened,openMenu};',ctx);
 return{...ctx.subject,props,connection,calls,events,data,sync,unmount:()=>unmounts.forEach(fn=>fn()),answer:v=>{answer=v},defer:()=>{confirm={};return confirm}};
}
test('完整访问取消不写入，确认后携带权限版本和确认标记',async()=>{const f=fixture();await f.load();await f.choose('full-access');assert.equal(f.calls.length,1);f.answer({confirm:true});await f.choose('full-access');assert.equal(f.calls[1].method,'thread.permissions.update');assert.equal(f.calls[1].params.confirmedFullAccess,true);assert.equal(f.calls[1].params.expectedRevision,'a'.repeat(64));assert.deepEqual(f.events,[['busy',true],['busy',false],['applied','pc','thread']]);});
test('确认期间切换电脑和只读历史均不写入',async()=>{const f=fixture();await f.load();const deferred=f.defer(),pending=f.choose('full-access');f.connection.hostId='other';deferred.resolve({confirm:true});await pending;assert.equal(f.calls.length,1);f.connection.hostId='pc';f.connection.snapshot.readOnly=true;await f.choose('read-only');assert.equal(f.calls.length,1);});
test('新建只修改当前草稿选择，不调用权限写接口',async()=>{const f=fixture();f.props.threadId='';f.props.projectId='project';await f.load();await f.choose('read-only');assert.equal(f.calls[0].method,'thread.create.permissions');assert.equal(f.calls.length,1);assert.deepEqual(f.events,[['select','read-only',false,'a'.repeat(64)]]);});

const newProps = { threadId: '', projectId: 'project' };
/** 释放模拟桥接 Promise 链，观察组件最终读取状态。 */
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

for (const mode of ['default', 'auto-review', 'read-only', 'full-access', 'custom', 'unknown']) {
 test('未打开菜单即自动显示电脑项目默认权限：' + mode, async () => {
  const f = fixture({ initialProps: newProps, mode });
  assert.equal(f.loading.value, true); assert.match(f.label.value, /正在读取/);
  assert.equal(f.opened.value, false); await settle();
  assert.equal(f.mode.value, mode); assert.equal(f.loading.value, false);
  assert.deepEqual(f.calls.map(call => call.method), ['thread.create.permissions']);
  assert.equal(f.calls[0].params.projectId, 'project');
  assert.equal(f.props.selectedMode, ''); assert.deepEqual(f.events, []);
  // 默认完整访问也不打开确认框、不产生主动授权或权限更新事件。
  f.openMenu(); assert.equal(f.calls.length, 1); assert.equal(f.opened.value, true);
 });
}

test('收起与缺少项目时不读取，展开及重新展开自动刷新', async () => {
 const f = fixture({ initialProps: { ...newProps, active: false, projectId: '' } });
 assert.equal(f.calls.length, 0); f.props.active = true; f.sync(); assert.equal(f.calls.length, 0);
 f.props.projectId = 'project'; f.sync(); await settle(); assert.equal(f.calls.length, 1);
 f.props.active = false; f.sync(); assert.equal(f.state.value, null);
 f.props.active = true; f.sync(); await settle(); assert.equal(f.calls.length, 2);
});

test('菜单及重复读取复用在途请求，不受已有会话订阅变化影响', async () => {
 let resolve;
 const f = fixture({ initialProps: newProps, request: () => new Promise(done => { resolve = done; }) });
 f.openMenu(); await f.load(); f.connection.subscriptionRevision++; f.sync();
 assert.equal(f.calls.length, 1); resolve(f.data); await settle();
 assert.equal(f.mode.value, 'default'); assert.equal(f.loading.value, false);
});

test('切换电脑、项目时丢弃乱序结果，恢复原目标也不接受旧请求', async () => {
 const pending = [];
 const f = fixture({ initialProps: newProps, request: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
 f.props.projectId = 'other'; f.sync();
 pending[1].resolve({ ...f.data, mode: 'read-only' }); await settle();
 pending[0].resolve({ ...f.data, mode: 'full-access' }); await settle();
 assert.equal(f.mode.value, 'read-only');
 f.connection.computers.push({ id: 'other-pc', online: true }); f.connection.hostId = 'other-pc'; f.sync();
 f.connection.hostId = 'pc'; f.sync();
 pending[3].resolve({ ...f.data, mode: 'auto-review' }); await settle();
 pending[2].reject(Error('旧电脑读取失败')); await settle();
 assert.equal(f.mode.value, 'auto-review'); assert.equal(f.error.value, '');
 assert.deepEqual(f.calls.map(call => call.method), Array(4).fill('thread.create.permissions'));
});

for (const transition of ['collapse', 'disconnect', 'offline', 'unmount']) {
 test('生命周期失效后旧响应不能回填：' + transition, async () => {
  const pending = [];
  const f = fixture({ initialProps: newProps, request: () => new Promise(resolve => pending.push(resolve)) });
  if (transition === 'collapse') f.props.active = false;
  if (transition === 'disconnect') f.connection.connected = false;
  if (transition === 'offline') f.connection.computers[0].online = false;
  if (transition === 'unmount') f.unmount(); else f.sync();
  pending[0]({ ...f.data, mode: 'full-access' }); await settle();
  assert.equal(f.state.value, null); assert.equal(f.mode.value, 'unknown');
  if (transition === 'unmount') return;
  f.props.active = true; f.connection.connected = true; f.connection.computers[0].online = true; f.sync();
  assert.equal(f.calls.length, 2); pending[1]({ ...f.data, mode: 'read-only' }); await settle();
  assert.equal(f.mode.value, 'read-only'); assert.equal(f.loading.value, false);
 });
}

test('收起后立即展开，同一目标旧请求不能覆盖新默认值', async () => {
 const pending = [];
 const f = fixture({ initialProps: newProps, request: () => new Promise(resolve => pending.push(resolve)) });
 f.props.active = false; f.sync(); f.props.active = true; f.sync();
 pending[0]({ ...f.data, mode: 'full-access' }); await settle(); assert.equal(f.state.value, null);
 assert.equal(f.loading.value, true);
 pending[1]({ ...f.data, mode: 'auto-review' }); await settle(); assert.equal(f.mode.value, 'auto-review');
});

test('读取失败不伪造默认值，菜单显示错误并可手动重新读取', async () => {
 let failed = true;
 const f = fixture({ initialProps: newProps, request: (_method, _params, data) => { if (failed) throw Error('权限读取失败'); return data; } });
 await settle(); assert.equal(f.mode.value, 'unknown'); assert.equal(f.error.value, '权限读取失败');
 f.openMenu(); assert.equal(f.calls.length, 1); assert.equal(f.error.value, '权限读取失败');
 failed = false; await f.load(); assert.equal(f.mode.value, 'default'); assert.equal(f.error.value, '');
});

test('手动权限选择在默认加载、重新展开及重连后保持优先，不自动写入', async () => {
 const f = fixture({ initialProps: { ...newProps, selectedMode: 'read-only' }, mode: 'full-access' });
 await settle(); assert.equal(f.mode.value, 'read-only');
 f.props.active = false; f.sync(); f.props.active = true; f.sync(); await settle();
 f.connection.connected = false; f.sync(); f.connection.connected = true; f.sync(); await settle();
 assert.equal(f.mode.value, 'read-only'); assert.equal(f.props.selectedMode, 'read-only');
 assert.deepEqual(f.events, []); assert.equal(f.calls.every(call => call.method === 'thread.create.permissions'), true);
});

test('已有会话仍以快照显示权限且菜单每次刷新，不在挂载时额外读取', async () => {
 const f = fixture(); assert.equal(f.calls.length, 0); assert.equal(f.mode.value, 'default');
 f.openMenu(); await settle(); assert.equal(f.calls[0].method, 'thread.permissions.read');
 f.connection.snapshot.permissionSettings.mode = 'auto-review'; assert.equal(f.mode.value, 'auto-review');
 f.openMenu(); await settle(); assert.equal(f.calls.length, 2);
});

test('新建权限读取项目能力，只在用户选择后暂存草稿权限', () => {
 const source = fs.readFileSync('apps/mobile/components/new-conversation/new-conversation.uvue', 'utf8');
 const binding = source.match(/<permissions-control\b[\s\S]*?\/>/)?.[0] ?? '';
 for (const prop of [':active="props.expanded && projectReady"', ':project-id="projectId"', ':selected-mode="draft.choices.permissionMode', '@select="selectPermission"']) assert.ok(binding.includes(prop), prop);
 assert.doesNotMatch(binding, /native-draft|draft-id|native-state/);
 assert.doesNotMatch(source, /@(?:load|loaded|change)="selectPermission"/);
 const f = fixture({ initialProps: { threadId: '', projectId: 'project', nativeDraft: true, draftId: 'native-draft', nativeState: { mode: 'full-access', revision: 'native-permission-1', options: [{ id: 'full-access', enabled: true }] }, nativeStatus: 'ready' } });
 assert.equal(f.mode.value, 'full-access'); assert.equal(f.props.selectedMode, ''); assert.deepEqual(f.calls, []); assert.deepEqual(f.events, []);
 f.props.nativeState = { ...f.props.nativeState, mode: 'read-only', revision: 'native-permission-2' }; f.sync();
 assert.equal(f.mode.value, 'read-only'); assert.equal(f.props.selectedMode, ''); assert.deepEqual(f.calls, []); assert.deepEqual(f.events, []);
});

// 权限写入沿用原确认链，只增加成功通知，不把取消或迟到结果当成成功。
test('已有聊天权限在成功前不通知聚焦，失败保留菜单且不发成功事件', async () => {
  let resolve,reject;
  const f=fixture({request:(method,_params,data)=>method==='thread.permissions.update'?new Promise((yes,no)=>{resolve=yes;reject=no;}):data});
  await f.load(); f.opened.value=true; const pending=f.choose('read-only');
  assert.deepEqual(f.events,[['busy',true]]); reject(new Error('权限更新失败')); await pending;
  assert.equal(f.opened.value,true); assert.equal(f.error.value,'权限更新失败');
  assert.equal(f.events.some(event=>event[0]==='applied'),false);
  const retried=f.choose('read-only'); resolve({...f.data,mode:'read-only'}); await retried;
  assert.deepEqual(f.events.slice(-2),[['busy',false],['applied','pc','thread']]);
});
test('取消完整访问、切换电脑或收起组件后不发权限成功事件', async () => {
  const canceled=fixture(); await canceled.load(); await canceled.choose('full-access');
  assert.equal(canceled.events.some(event=>event[0]==='applied'),false);
  for(const change of ['电脑','聊天','收起','卸载']) {
    let resolve;
    const f=fixture({request:(method,_params,data)=>method==='thread.permissions.update'?new Promise(yes=>{resolve=yes;}):data});
    await f.load(); const pending=f.choose('read-only');
    if(change==='电脑') f.connection.hostId='other';
    if(change==='聊天') f.props.threadId='other';
    if(change==='收起') f.props.active=false;
    if(change==='卸载') f.unmount(); else f.sync();
    resolve({...f.data,mode:'read-only'}); await pending;
    assert.equal(f.events.some(event=>event[0]==='applied'),false,change);
  }
});
