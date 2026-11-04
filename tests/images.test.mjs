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
  const method=page.slice(page.indexOf('function send() {'),page.indexOf('\nfunction stop('));
  const calls=[],context={draft:{value:'消息'},draftImages:{value:[{id:'i',src:image}]},canWrite:{value:true},planResetRequired:{value:false},settings:{value:null},imageBusy:{value:false},filesReady:{value:true},draftFiles:{value:[]},modelSupportsImages:{value:true},connection:{snapshot:{}},notify:message=>calls.push(message),bridge:{request:()=>{throw new Error('不应调用');}}};
  vm.runInNewContext(stripTypeScriptTypes(method,{mode:'transform'})+'\nsend();', componentScope(context));assert.match(calls[0],/更新电脑连接服务/);assert.equal(context.draftImages.value.length,1);
});

test('Web实际图片模块等比压缩并在过大或读取失败时给出明确错误',async()=>{
  const draws=[];let oversized=false;
  class Image {naturalWidth=3200;naturalHeight=2400;set src(value){queueMicrotask(()=>value==='bad'?this.onerror():this.onload());}}
  const canvas={width:0,height:0,getContext(){return {fillRect(){},drawImage(_image,_x,_y,width,height){draws.push([width,height]);}};},toDataURL(){return oversized?syntheticJpeg(MAX_IMAGE_BYTES+1):image;}};
  const context=componentContext({Image,document:{createElement:()=>canvas},queueMicrotask,window:{fetch:()=>Promise.reject(new Error('模拟读取失败'))}});
  let source=fs.readFileSync('apps/mobile/services/images.uts','utf8').replace(/\/\/ #ifndef WEB[\s\S]*?\/\/ #endif/g,'').replace(/\bexport /g,'');
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={prepareImage};',context);
  assert.equal(await context.subject.prepareImage('valid'),image);assert.deepEqual(draws[0],[1600,1200]);
  await assert.rejects(context.subject.prepareImage('bad'),/无法读取图片/);oversized=true;await assert.rejects(context.subject.prepareImage('valid'),/图片仍然过大/);
});

// 分别执行条件编译后的真实模块，模拟图像编码与系统接口，不读取个人图片。
function loadImageModule(platform, environment) {
  let source=fs.readFileSync('apps/mobile/services/images.uts','utf8');
  source=source.replace(platform==='web'?/\/\/ #ifndef WEB[\s\S]*?\/\/ #endif/g:/\/\/ #ifdef WEB[\s\S]*?\/\/ #endif/g,'').replace(/\bexport /g,'');
  const context=componentContext({...environment,window:{fetch:environment.fetch}});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={prepareImage};',context);
  return context.subject;
}

function syntheticJpeg(bytes) {
  const data=Buffer.alloc(bytes);data.set([255,216,255]);
  return 'data:image/jpeg;base64,'+data.toString('base64');
}

test('Web预算内原图保持透明PNG，精确字节边界不重编码',async()=>{
  let encoded=0;
  class Image {naturalWidth=800;naturalHeight=600;set src(_value){queueMicrotask(()=>this.onload());}}
  const subject=loadImageModule('web',{Image,queueMicrotask,document:{createElement(){encoded++;throw new Error('不应重编码');}}});
  assert.equal(await subject.prepareImage(image),image);
  const boundary=syntheticJpeg(MAX_IMAGE_BYTES);
  assert.equal(await subject.prepareImage(boundary),boundary);
  assert.equal(encoded,0);
});

test('Web先在相同尺寸降低质量，缩图后恢复高质量，原图读取失败仍可压缩',async()=>{
  const draws=[],qualities=[];
  class Image {naturalWidth=1600;naturalHeight=1200;set src(_value){queueMicrotask(()=>this.onload());}}
  const oversized=syntheticJpeg(MAX_IMAGE_BYTES+1);
  const canvas={width:0,height:0,getContext(){return {fillRect(){},drawImage(_image,_x,_y,width,height){draws.push([width,height]);}};},toDataURL(_type,quality){qualities.push([this.width,quality]);return qualities.length<5?oversized:image;}};
  const subject=loadImageModule('web',{Image,queueMicrotask,fetch:()=>Promise.reject(new Error('读取失败')),document:{createElement:()=>canvas}});
  assert.equal(await subject.prepareImage('blob:synthetic'),image);
  assert.deepEqual(qualities,[[1600,0.92],[1600,0.85],[1600,0.75],[1600,0.65],[1280,0.92]]);
  assert.deepEqual(draws,[[1600,1200],[1280,960]]);
});

function appImageModule({original=image,readFailure=false,width=800,height=600,output=()=>image}={}) {
  const calls=[];
  const uni={getImageInfo({success}){success({width,height});},compressImage(options){calls.push(options);options.success({tempFilePath:'compressed'});},getFileSystemManager(){return {readFile({filePath,success,fail}){if(filePath==='original'&&readFailure){fail({});return;}const value=filePath==='original'?original:output(calls.length);success({data:value.split(',')[1]});}};}};
  return {calls,subject:loadImageModule('app',{uni})};
}

test('App预算内PNG与精确边界JPEG原样保留，其他原图尝试转换',async()=>{
  const png=appImageModule();assert.equal(await png.subject.prepareImage('original'),image);assert.equal(png.calls.length,0);
  const boundary=syntheticJpeg(MAX_IMAGE_BYTES),jpeg=appImageModule({original:boundary});
  assert.equal(await jpeg.subject.prepareImage('original'),boundary);assert.equal(jpeg.calls.length,0);
  const source='data:image/heic;base64,AAAAAGZ0eXBoZWlj';
  const converted=appImageModule({original:source,output:()=>syntheticJpeg(32)});
  assert.equal(await converted.subject.prepareImage('original'),syntheticJpeg(32));assert.equal(converted.calls.length,1);
  const invalid=appImageModule({original:source,output:()=>source});
  await assert.rejects(invalid.subject.prepareImage('original'),/请选择JPEG或PNG/);
});

test('App原图读取失败可回退，先降质量再缩图且每次使用原图',async()=>{
  const oversized=syntheticJpeg(MAX_IMAGE_BYTES+1);
  const {subject,calls}=appImageModule({readFailure:true,width:3200,height:2400,output:count=>count<4?oversized:image});
  assert.equal(await subject.prepareImage('original'),image);
  assert.deepEqual(calls.map(call=>[call.src,call.quality,call.compressedWidth,call.compressedHeight]),[['original',90,1600,1200],['original',80,1600,1200],['original',70,1600,1200],['original',90,1280,960]]);
  const excessive=appImageModule({original:oversized,output:()=>oversized});
  await assert.rejects(excessive.subject.prepareImage('original'),/图片仍然过大/);assert.equal(excessive.calls.length,15);
});

test('Web可解码的GIF原图转换JPEG，编码结果仍限制JPEG或PNG',async()=>{
  const original='data:image/gif;base64,R0lGODlh';let output=syntheticJpeg(32);
  class Image {naturalWidth=800;naturalHeight=600;set src(_value){queueMicrotask(()=>this.onload());}}
  const canvas={width:0,height:0,getContext(){return {fillRect(){},drawImage(){}};},toDataURL(){return output;}};
  const subject=loadImageModule('web',{Image,queueMicrotask,document:{createElement:()=>canvas}});
  assert.equal(await subject.prepareImage(original),syntheticJpeg(32));
  output=original;await assert.rejects(subject.prepareImage(original),/请选择JPEG或PNG/);
});
