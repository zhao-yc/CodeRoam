import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const settle=()=>new Promise(setImmediate);
/** 运行真实组件并手动推进响应式侦听，稳定复现缓存先出现、订阅回执后到的时序。 */
function fixture(options={}){
  const props={hostId:'host',threadId:'thread',messageId:'image',connected:true,ready:false,subscriptionRevision:0,scopeId:'pairing-a',count:1,...options};
  const connection={hostId:'host',activeThreadId:'thread',cacheNamespace:'pairing-a'},requests=[],watches=[],previews=[];let dispose;
  const context=vm.createContext({connection,defineProps:()=>props,defineEmits:()=>()=>{},ref:value=>({value}),nextTick:fn=>Promise.resolve().then(fn),watch(get,callback,config){if(typeof get!=='function')return;const entry={get,callback,value:get()};watches.push(entry);if(config?.immediate)callback(entry.value);},onUnmounted:fn=>dispose=fn,uni:{previewImage:params=>previews.push(params)},bridge:{request(method,params){return new Promise((resolve,reject)=>requests.push({method,params,resolve,reject}));}}});
  const component=fs.readFileSync('apps/mobile/components/message-images/message-images.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  vm.runInContext(stripTypeScriptTypes(component,{mode:'transform'})+'\nglobalThis.api={sources,error,loadImages,preview};',context);
  const flush=()=>{for(const entry of watches){const value=entry.get();if(value!==entry.value){entry.value=value;entry.callback(value);}}};
  return {props,connection,requests,previews,flush,dispose:()=>dispose(),...context.api};
}

test('缓存图片等聊天订阅就绪后自动加载，不提前请求或要求手动点击',async()=>{
  const f=fixture();assert.equal(f.requests.length,0);f.loadImages();assert.equal(f.requests.length,0);
  f.props.ready=true;f.props.subscriptionRevision=1;f.flush();await settle();assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'thread.images');
  f.requests[0].resolve({images:['synthetic-image']});await settle();assert.equal(f.sources.value[0],'synthetic-image');assert.equal(f.previews.length,0);
  f.props.subscriptionRevision=2;f.flush();assert.equal(f.requests.length,1,'已有图片不重复下载');
});

test('旧订阅失败后，新订阅回执自动重试并清除旧错误',async()=>{
  const f=fixture({ready:true});await settle();f.requests[0].reject(Error('请先打开这条聊天再查看图片'));await settle();assert.match(f.error.value,/请先打开/);
  f.props.subscriptionRevision++;f.flush();await settle();assert.equal(f.error.value,'');assert.equal(f.requests.length,2);
  f.requests[1].resolve({images:['recovered-image']});await settle();assert.equal(f.sources.value[0],'recovered-image');
});

test('断线重连保留旧快照也不会提前加载，重新订阅后恢复，不重放手动操作',async()=>{
  const f=fixture({ready:true});await settle();f.props.connected=false;f.props.ready=false;f.flush();
  f.requests[0].resolve({images:['late-old-image']});await settle();assert.equal(f.sources.value.length,0);
  f.props.connected=true;f.flush();assert.equal(f.requests.length,1);
  f.props.ready=true;f.props.subscriptionRevision++;f.flush();await settle();assert.equal(f.requests.length,2);
  f.requests[1].resolve({images:['new-image']});await settle();assert.equal(f.sources.value[0],'new-image');assert.equal(f.previews.length,0);
});

test('同编号消息切换配对后废弃旧回执，不能串图或保留旧配对图片',async()=>{
  const f=fixture({ready:true});await settle();f.connection.cacheNamespace='pairing-b';f.props.scopeId='pairing-b';f.flush();await settle();assert.equal(f.requests.length,2);
  f.requests[0].resolve({images:['private-old-image']});await settle();assert.equal(f.sources.value.length,0);
  f.requests[1].resolve({images:['current-image']});await settle();assert.equal(f.sources.value[0],'current-image');
});

test('切换电脑立即停止大图后续分片，旧回执不能请求到新电脑或写入页面',async()=>{
  const f=fixture({ready:true,large:true});await settle();assert.equal(f.requests.length,1);assert.equal(f.requests[0].params.chunkIndex,0);
  f.connection.hostId='other-host';f.requests[0].resolve({chunkCount:2,data:'old-part'});await settle();assert.equal(f.requests.length,1);assert.equal(f.sources.value.length,0);
});

test('助手大图订阅后自动读取全部分片，卸载后丢弃后续回执',async()=>{
  const f=fixture({large:true});f.props.ready=true;f.flush();await settle();f.requests[0].resolve({chunkCount:2,data:'first-'});await settle();assert.equal(f.requests[1].params.chunkIndex,1);
  f.requests[1].resolve({chunkCount:2,data:'second'});await settle();assert.equal(f.sources.value[0],'first-second');
  const removed=fixture({ready:true,large:true});await settle();removed.dispose();removed.requests[0].resolve({chunkCount:2,data:'late'});await settle();assert.equal(removed.requests.length,1);assert.equal(removed.sources.value.length,0);
});

test('父页分别同步就绪与订阅代次时，下一次渲染只发送一份图片请求',async()=>{
  const f=fixture();await settle();f.props.ready=true;f.flush();f.props.subscriptionRevision=1;f.flush();assert.equal(f.requests.length,0);
  await settle();assert.equal(f.requests.length,1);f.requests[0].resolve({images:['single-image']});await settle();assert.equal(f.sources.value[0],'single-image');
});

test('当前聊天已订阅才允许图片读取，缓存、后台页面和其他电脑同编号快照均不能冒充',()=>{
  const page=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8'),line=page.match(/const imagesReady = computed\([^\n]+/)[0];
  const context=vm.createContext({computed:get=>({get value(){return get();}}),pageVisible:{value:true},pageHostId:{value:'host'},pageThreadId:{value:'thread'},liveConversation:{value:{readOnly:true}},connection:{connected:true,hostId:'host',activeThreadId:'thread',subscribedHostId:'',subscribedThreadId:''}});
  vm.runInContext(stripTypeScriptTypes(line,{mode:'transform'})+'\nglobalThis.ready=imagesReady',context);assert.equal(context.ready.value,false);
  context.connection.subscribedHostId='host';context.connection.subscribedThreadId='thread';assert.equal(context.ready.value,true,'已订阅的历史浏览也允许查看图片');
  context.liveConversation.value=null;assert.equal(context.ready.value,false);context.liveConversation.value={};context.connection.subscribedHostId='other-host';assert.equal(context.ready.value,false);
  context.connection.subscribedHostId='host';context.pageVisible.value=false;assert.equal(context.ready.value,false);
});
