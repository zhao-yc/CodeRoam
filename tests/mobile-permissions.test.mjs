import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
/** 执行实际组件脚本，验证确认取消和目标切换不会触发写操作。 */
function fixture(){
 const props={threadId:'thread',projectId:'',selectedMode:'',disabled:false},calls=[],events=[];
 const connection={hostId:'pc',connected:true,subscriptionRevision:1,computers:[{id:'pc',online:true}],snapshot:{threadId:'thread',supportsPermissionSettings:true,permissionSettings:{mode:'default'},activeTurnId:''}};
 let answer={confirm:false},confirm;
 const data={mode:'default',revision:'a'.repeat(64),options:['default','auto-review','read-only','full-access'].map(id=>({id,enabled:true}))};
 const ctx=vm.createContext({props,connection,withDefaults:v=>v,defineProps:()=>props,defineEmits:()=>(...args)=>events.push(args),ref:value=>({value}),computed:fn=>({get value(){return fn()}}),watch(){},onUnmounted(){},permissionLabel:v=>v,uni:{showModal:options=>{if(confirm)confirm.resolve=value=>options.success(value);else options.success(answer)}},bridge:{request:async(method,params)=>{calls.push({method,params});return method.endsWith('.read')?data:{...data,mode:params.mode}}}});
 let source=fs.readFileSync('apps/mobile/components/permissions-control/permissions-control.uvue','utf8').split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\r?\n/gm,'');
 vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.subject={load,choose,state,mode};',ctx);
 return{...ctx.subject,props,connection,calls,events,answer:v=>{answer=v},defer:()=>{confirm={};return confirm}};
}
test('完整访问取消不写入，确认后携带权限版本和确认标记',async()=>{const f=fixture();await f.load();await f.choose('full-access');assert.equal(f.calls.length,1);f.answer({confirm:true});await f.choose('full-access');assert.equal(f.calls[1].method,'thread.permissions.update');assert.equal(f.calls[1].params.confirmedFullAccess,true);assert.equal(f.calls[1].params.expectedRevision,'a'.repeat(64));assert.deepEqual(f.events,[['busy',true],['busy',false]]);});
test('确认期间切换电脑和只读历史均不写入',async()=>{const f=fixture();await f.load();const deferred=f.defer(),pending=f.choose('full-access');f.connection.hostId='other';deferred.resolve({confirm:true});await pending;assert.equal(f.calls.length,1);f.connection.hostId='pc';f.connection.snapshot.readOnly=true;await f.choose('read-only');assert.equal(f.calls.length,1);});
test('新建只修改当前草稿选择，不调用权限写接口',async()=>{const f=fixture();f.props.threadId='';f.props.projectId='project';await f.load();await f.choose('read-only');assert.equal(f.calls[0].method,'thread.create.permissions');assert.equal(f.calls.length,1);assert.deepEqual(f.events,[['select','read-only',false]]);});
