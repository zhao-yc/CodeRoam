import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {stripTypeScriptTypes} from 'node:module';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';
import {historicalSnapshot} from '../apps/bridge/history-reader.mjs';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {BridgeAgent} from '../apps/bridge/agent.mjs';
import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';
import {validateRequest,READ_METHODS,WRITE_METHODS,MAX_MESSAGE_BYTES} from '../packages/protocol/contracts.mjs';
import {MAX_IMAGE_BYTES} from '../packages/protocol/images.mjs';

const image='data:image/png;base64,'+fs.readFileSync('apps/mobile/static/icons/check-dark.png').toString('base64');
const state=()=>({id:'thread',turns:[{turnId:'turn',status:'completed',items:[{id:'picture',type:'userMessage',content:[{type:'text',text:'查看截图'},{type:'image',url:image},{type:'image',url:image}]}]}]});

/** 预览仅按用户消息编号取图，完整快照及事件账本不保存原图。 */
test('指定消息按需返回内嵌图片，日常同步只有数量且纯图片不被过滤',()=>{
  const source=state();source.turns[0].items.push({id:'only',type:'userMessage',content:[{type:'image',url:image}]});
  const normal=normalizeConversation(source);
  assert.deepEqual(normal.messages.map(m=>[m.text,m.imageCount]),[['查看截图',2],['',1]]);
  assert.equal(JSON.stringify(normal).includes(image),false);
  const selected=normalizeConversation(source,{imageMessageId:'picture'});
  assert.deepEqual(selected.messages[0].images,[image,image]);assert.equal(selected.messages[1].images,undefined);
  const context=vm.createContext({});
  const uts=fs.readFileSync('apps/mobile/services/executions.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
  vm.runInContext(stripTypeScriptTypes(uts,{mode:'transform'})+'\nglobalThis.timeline=executionTimeline;',context);
  assert.equal(context.timeline(normal.messages)[1].imageCount,1);
});

test('预览白名单只接受有效PNG/JPEG，不暴露本机路径或抓取远程地址',()=>{
  const source=state();source.turns[0].items[0].content=[{type:'localImage',path:'C:/私人文件.png'},{type:'image',url:'https://example.com/private.png'},{type:'image',url:'data:image/svg+xml;base64,PHN2Zz4='}];
  const result=normalizeConversation(source);
  assert.equal(result.messages[0].imageCount,3);assert.equal(result.messages[0].images,undefined);assert.equal(JSON.stringify(result).includes('私人'),false);
  assert.throws(()=>normalizeConversation(source,{imageMessageId:'picture'}),error=>error.code==='IMAGE_UNAVAILABLE'&&!error.message.includes('私人'));
});

test('图片读取必须属于当前手机订阅和可见消息，历史原图可读且不激活桌面',async()=>{
  const client=new EventEmitter();client.close=()=>{};const adapter=new DesktopAdapter({client});
  try{
    const entry={watchers:new Set(['phone']),state:state()};adapter.conversations.set('thread',entry);
    assert.deepEqual(await adapter.messageImages('thread','picture','phone'),{images:[image,image]});
    await assert.rejects(adapter.messageImages('thread','picture','other'),e=>e.code==='SUBSCRIPTION_REQUIRED');
    await assert.rejects(adapter.messageImages('other','picture','phone'),e=>e.code==='SUBSCRIPTION_REQUIRED');
    await assert.rejects(adapter.messageImages('thread','unknown','phone'),e=>e.code==='IMAGE_UNAVAILABLE');
    entry.state.turns[0].items.push(...Array.from({length:80},(_,i)=>({id:'later'+i,type:'userMessage',content:'后续消息'})));
    await assert.rejects(adapter.messageImages('thread','picture','phone'),e=>e.code==='IMAGE_UNAVAILABLE');
    entry.state=null;let called=0;
    adapter.index={readHistory(threadId,options){called++;assert.equal(threadId,'thread');return historicalSnapshot({id:threadId},[{type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{...state().turns[0].items[0],type:'UserMessage'}}}],options);}};
    assert.deepEqual(await adapter.messageImages('thread','picture','phone'),{images:[image,image]});assert.equal(called,1);
    adapter.index.readHistory=async()=>{entry.watchers.delete('phone');return normalizeConversation(state(),{imageMessageId:'picture'});};
    await assert.rejects(adapter.messageImages('thread','picture','phone'),e=>e.code==='SUBSCRIPTION_CANCELED');
  }finally{adapter.conversations.clear();adapter.close();}
});

test('预览走只读白名单且三张最大图片响应仍小于2MB，不写操作账本',async()=>{
  assert.equal(READ_METHODS.has('thread.images'),true);assert.equal(WRITE_METHODS.has('thread.images'),false);
  const request={v:1,type:'request',requestId:'preview-request-0001',method:'thread.images',deviceId:'phone',params:{threadId:'thread',messageId:'picture'}};
  assert.equal(validateRequest(request),request);assert.throws(()=>validateRequest({...request,params:{threadId:'thread'}}));
  const adapter=new EventEmitter();adapter.messageImages=async(thread,id,device)=>{assert.deepEqual([thread,id,device],['thread','picture','phone']);return {images:[image]};};
  const agent=new BridgeAgent({config:{},adapter,journal:{execute(){assert.fail('预览不能写账本');}}});
  assert.deepEqual((await agent.handleRequest(request)).result,{images:[image]});
  const bytes=Buffer.alloc(MAX_IMAGE_BYTES);bytes.set([255,216,255]);const large='data:image/jpeg;base64,'+bytes.toString('base64');
  const source=state();source.turns[0].items[0].content=Array(3).fill({type:'image',url:large});
  const images=normalizeConversation(source,{imageMessageId:'picture'}).messages[0].images;
  assert.equal(images.length,3);assert.ok(Buffer.byteLength(JSON.stringify({type:'response',result:{images}}))<MAX_MESSAGE_BYTES);
});

test('消息新增和移除图片数量时使用完整替换，后续文本增量不会丢失入口',()=>{
  let before={threadId:'thread',messages:[{id:'history',role:'assistant',text:'历史'.repeat(3000)},{id:'picture',role:'user',text:'文字'}]};
  for(const count of [2,0]){
    const after=structuredClone(before);after.messages[1].imageCount=count;
    const update=conversationUpdate({snapshot:before,seq:1},after);assert.equal(update.kind,'delta');assert.equal(update.update.upserts.length,1);
    assert.deepEqual(applyConversationUpdate({snapshot:before,seq:1,epoch:'e'},{...update,baseSeq:1,seq:2,epoch:'e'}).snapshot,after);
    before=after;
  }
});

/** 执行缩略图组件，验证自动加载、点击预览及迟到回执隔离。 */
test('消息默认加载缩略图，点击才预览，重连可重试且卸载丢弃回执',async()=>{
  const component=fs.readFileSync('apps/mobile/components/message-images/message-images.uvue','utf8');
  const source=component.match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  const calls=[],requests=[],watches=[];let resolve,reject,dispose;
  const props={hostId:'host',threadId:'thread',messageId:'picture',connected:true};
  const context=vm.createContext({connection:{hostId:'host',activeThreadId:'thread',cacheNamespace:''},nextTick:fn=>Promise.resolve().then(fn),defineProps:()=>props,defineEmits:()=>()=>{},ref:value=>({value}),watch:(get,callback,options)=>{watches.push({get,callback});if(options?.immediate)callback(get());},onUnmounted:callback=>dispose=callback,uni:{previewImage:options=>calls.push(options)},bridge:{request:(...args)=>{requests.push(args);return new Promise((yes,no)=>{resolve=yes;reject=no;});}}});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={sources,error,loadImages,preview};',context);
  const f=context.subject;
  await new Promise(setImmediate);
  assert.equal(requests.length,1);f.loadImages();assert.equal(requests.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])),['thread.images',{threadId:'thread',messageId:'picture'}]);
  resolve({images:[image,image]});await new Promise(setImmediate);
  assert.equal(f.sources.value.length,2);assert.equal(calls.length,0);
  f.preview(image);assert.equal(calls[0].urls.length,2);assert.equal(calls[0].current,image);
  props.messageId='other';watches[0].callback();await new Promise(setImmediate);assert.equal(f.sources.value.length,0);
  reject(new Error('无法读取'));await new Promise(setImmediate);assert.equal(f.error.value,'无法读取');
  props.connected=false;watches[1].callback(false);f.loadImages();assert.equal(requests.length,2);
  props.connected=true;watches[1].callback(true);await new Promise(setImmediate);assert.equal(requests.length,3);
  dispose();resolve({images:[image]});await new Promise(setImmediate);assert.equal(f.sources.value.length,0);
  const page=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8');
  assert.match(page,/<message-images v-if=/);assert.doesNotMatch(page,/查看图片|previewedMessageId/);
});

test('助手图片入口不打断正文与用户文字的互斥渲染',()=>{
  const page=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8');
  assert.match(page,/<markdown-body[^\n]+\n\s*<text v-else-if=/);
  assert.match(page,/<text v-else-if=[^\n]+\n\s*<message-images v-if="entry.role == 'assistant'/);
});
