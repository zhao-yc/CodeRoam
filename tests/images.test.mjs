import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
import {validateImages,MAX_IMAGE_BYTES} from '../packages/protocol/images.mjs';import {MAX_MESSAGE_BYTES,validateRequest} from '../packages/protocol/contracts.mjs';import {normalizeConversation} from '../apps/bridge/conversation.mjs';
const image='data:image/png;base64,'+fs.readFileSync('apps/mobile/static/icons/check-dark.png').toString('base64');

test('图片验证限制类型、数量、内容和体积，保持2MB传输上限',()=>{
  assert.deepEqual(validateImages(undefined),[]);assert.deepEqual(validateImages([image]),[image]);
  for(const images of [null,{},Array(4).fill(image),['data:image/jpeg;base64,AAAA'],['data:image/png;base64,a==='],['https://example.com/image.png'],['C:/图片.png']])assert.throws(()=>validateImages(images));
  const jpeg=Buffer.alloc(MAX_IMAGE_BYTES,0);jpeg.set([255,216,255]);const source='data:image/jpeg;base64,'+jpeg.toString('base64');
  assert.equal(validateImages([source,source,source]).length,3);
  const request={v:1,type:'request',requestId:'image-request-0001',method:'turn.send',params:{threadId:'thread',text:'字'.repeat(32000),images:[source,source,source]}};
  assert.ok(Buffer.byteLength(JSON.stringify(request))<MAX_MESSAGE_BYTES);assert.equal(validateRequest(request),request);
  request.method='turn.stop';assert.throws(()=>validateRequest(request));
  assert.throws(()=>validateImages(['data:image/jpeg;base64,'+Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')]));
});

test('图片消息同步可点击数量，不把图片内容或电脑文件路径传回手机日志',()=>{
  const result=normalizeConversation({id:'t',turns:[{turnId:'turn',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'image',url:image}]},{id:'local',type:'userMessage',content:[{type:'text',text:'看这张'},{type:'localImage',path:'C:/私人文件/image.png'}]}]}]});
  assert.equal(result.messages.length,2);assert.equal(result.messages[0].text,'');assert.equal(result.messages[0].imageCount,1);assert.match(result.messages[1].text,/看这张/);assert.equal(result.messages[1].imageCount,1);assert.equal(JSON.stringify(result).includes('私人文件'),false);assert.equal(JSON.stringify(result).includes(image),false);
  assert.equal(result.supportsImages,true);
});

test('旧电脑没有图片能力标记时，页面发送保护保留草稿且不调用请求',()=>{
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const method=page.slice(page.indexOf('function send() {'),page.indexOf('\nfunction stop() {'));
  const calls=[],context={draft:{value:'消息'},draftImages:{value:[{id:'i',src:image}]},canWrite:{value:true},planResetRequired:{value:false},settings:{value:null},imageBusy:{value:false},filesReady:{value:true},draftFiles:{value:[]},modelSupportsImages:{value:true},connection:{snapshot:{}},notify:message=>calls.push(message),bridge:{request:()=>{throw new Error('不应调用');}}};
  vm.runInNewContext(stripTypeScriptTypes(method,{mode:'transform'})+'\nsend();', componentScope(context));assert.match(calls[0],/更新电脑连接服务/);assert.equal(context.draftImages.value.length,1);
});

test('Web实际图片模块等比压缩并在过大或读取失败时给出明确错误',async()=>{
  const draws=[];let oversized=false;
  class Image {naturalWidth=3200;naturalHeight=2400;set src(value){queueMicrotask(()=>value==='bad'?this.onerror():this.onload());}}
  const canvas={width:0,height:0,getContext(){return {fillRect(){},drawImage(_image,_x,_y,width,height){draws.push([width,height]);}};},toDataURL(){return oversized?'x'.repeat(500000):image;}};
  const context=componentContext({Image,document:{createElement:()=>canvas},queueMicrotask});
  let source=fs.readFileSync('apps/mobile/services/images.uts','utf8').replace(/\/\/ #ifndef WEB[\s\S]*?\/\/ #endif/g,'').replace(/\bexport /g,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={prepareImage};',context);
  assert.equal(await context.subject.prepareImage('valid'),image);assert.deepEqual(draws[0],[1600,1200]);
  await assert.rejects(context.subject.prepareImage('bad'),/无法读取图片/);oversized=true;await assert.rejects(context.subject.prepareImage('valid'),/图片仍然过大/);
});
