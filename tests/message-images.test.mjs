import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {MAX_IMAGE_BYTES} from '../packages/protocol/images.mjs';
import {validateRequest} from '../packages/protocol/contracts.mjs';

/** 使用独立合成图片，不读取或提交真实截图与个人文件。 */
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'message-images-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'attached.png'),data=fs.readFileSync('apps/mobile/static/icons/check-dark.png');
  fs.writeFileSync(file,data);
  const state={id:'thread',turns:[{turnId:'turn',status:'completed',items:[{id:'message',type:'userMessage',content:[{type:'localImage',path:file}]}]}]};
  return {root,file,data,state};
}

test('助手本地设计稿提供数量和按需预览，快照不泄露路径',t=>{
  const {state,file,data}=fixture(t);
  state.turns[0].items=[{id:'design',type:'agentMessage',text:`设计说明\n![设计稿](<${file}>)`}];
  const normal=normalizeConversation(state).messages[0];
  assert.equal(normal.role,'assistant');assert.equal(normal.imageCount,1);
  assert.equal(normal.text.includes(file),false);assert.equal(normal.images,undefined);
  assert.deepEqual(Buffer.from(normalizeConversation(state,{imageMessageId:'design'}).messages[0].images[0].split(',')[1],'base64'),data);
  state.turns[0].items[0].text='```markdown\n![示例]('+file+')\n```';
  assert.equal(normalizeConversation(state).messages[0].imageCount,undefined);
});

test('独立生成图片不泄露提示词，大图按片返回并保持原图字节',async t=>{
  const {state,file,data}=fixture(t);
  const large=Buffer.concat([data,Buffer.alloc(1400000)]);fs.writeFileSync(file,large);
  state.turns[0].items=[{id:'generated',type:'imageGeneration',status:'completed',savedPath:file,revisedPrompt:'不可公开的合成提示词'}];
  const normal=normalizeConversation(state).messages[0];
  assert.equal(normal.role,'assistant');assert.equal(normal.imageCount,1);assert.equal(normal.text,'');
  assert.equal(JSON.stringify(normal).includes(file),false);assert.equal(JSON.stringify(normal).includes('合成提示词'),false);
  const client=Object.assign(new EventEmitter(),{close(){}}),adapter=new DesktopAdapter({client});t.after(()=>adapter.close());
  adapter.conversations.set('thread',{state,watchers:new Set(['phone']),waiters:[]});
  let source='';let chunks=1;
  for(let index=0;index<chunks;index++) {
    const result=await adapter.messageImages('thread','generated','phone',{imageIndex:0,chunkIndex:index});
    chunks=result.chunkCount;assert.ok(Buffer.byteLength(JSON.stringify(result))<2*1024*1024);source+=result.data;
  }
  assert.ok(chunks>1);assert.deepEqual(Buffer.from(source.split(',')[1],'base64'),large);
  await assert.rejects(adapter.messageImages('thread','generated','phone',{imageIndex:0,chunkIndex:chunks}),{code:'BAD_PARAMS'});
  const request={v:1,type:'request',requestId:'synthetic-image-chunk',method:'thread.images',params:{threadId:'thread',messageId:'generated',imageIndex:0,chunkIndex:0}};
  assert.doesNotThrow(()=>validateRequest(request));
  for(const params of [{imageIndex:-1,chunkIndex:0},{imageIndex:0,chunkIndex:17},{imageIndex:0},{imageIndex:0,chunkIndex:0,path:file}])assert.throws(()=>validateRequest({...request,params:{threadId:'thread',messageId:'generated',...params}}),{code:'BAD_PARAMS'});
});

test('用户原图通过分片预览支持12 MiB，超限拒绝且不改变上传限制',async t=>{
  const {state,file,data}=fixture(t);
  const limit=12*1024*1024;
  const original=Buffer.alloc(limit);data.copy(original);fs.writeFileSync(file,original);
  const adapter=new DesktopAdapter({client:Object.assign(new EventEmitter(),{close(){}})});t.after(()=>adapter.close());
  adapter.conversations.set('thread',{state,watchers:new Set(['phone']),waiters:[]});
  const parts=[];let chunks=1;
  for(let chunkIndex=0;chunkIndex<chunks;chunkIndex++) {
    const result=await adapter.messageImages('thread','message','phone',{imageIndex:0,chunkIndex});
    chunks=result.chunkCount;parts.push(result.data);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<2*1024*1024);
  }
  assert.equal(chunks,17);assert.deepEqual(Buffer.from(parts.join('').split(',')[1],'base64'),original);
  await assert.rejects(adapter.messageImages('thread','message','phone'),{code:'IMAGE_TOO_LARGE'});
  fs.appendFileSync(file,Buffer.from([0]));
  await assert.rejects(adapter.messageImages('thread','message','phone',{imageIndex:0,chunkIndex:0}),{code:'IMAGE_TOO_LARGE'});
});

test('桌面本地图片按需读取，普通快照只包含数量，不暴露文件路径或正文',t=>{
  const {state,file,data}=fixture(t),normal=normalizeConversation(state);
  assert.equal(normal.messages[0].imageCount,1);assert.equal(normal.messages[0].images,undefined);assert.equal(JSON.stringify(normal).includes(file),false);
  const preview=normalizeConversation(state,{imageMessageId:'message'}).messages[0].images;
  assert.equal(preview.length,1);assert.deepEqual(Buffer.from(preview[0].split(',')[1],'base64'),data);
  fs.unlinkSync(file);assert.doesNotThrow(()=>normalizeConversation(state));
  assert.throws(()=>normalizeConversation(state,{imageMessageId:'message'}),e=>e.code==='IMAGE_UNAVAILABLE'&&!e.message.includes(file)&&e.message.includes('原图已不存在'));
});

test('本地图片和内嵌图片混排保持顺序，不能读取其他消息的图片',t=>{
  const {state,data}=fixture(t),inline='data:image/png;base64,'+data.toString('base64');
  state.turns[0].items[0].content.push({type:'image',url:inline});
  state.turns[0].items.push({id:'other',type:'userMessage',content:[{type:'localImage',path:path.join('missing','unrelated.png')}]});
  assert.deepEqual(normalizeConversation(state,{imageMessageId:'message'}).messages[0].images,[inline,inline]);
});

test('拒绝伪装图片、超限图片、目录、远程与相对路径，错误不包含个人路径',t=>{
  const {file,state}=fixture(t);
  fs.writeFileSync(file,'合成的非图片内容');assert.throws(()=>normalizeConversation(state,{imageMessageId:'message'}),e=>e.code==='BAD_IMAGES'&&!e.message.includes(file));
  fs.writeFileSync(file,Buffer.alloc(MAX_IMAGE_BYTES+1));assert.throws(()=>normalizeConversation(state,{imageMessageId:'message'}),{code:'IMAGE_TOO_LARGE'});
  for(const invalid of ['relative.png','https://example.com/image.png','//example.com/image.png','\\\\example.com\\image.png',path.dirname(file)]) {
    state.turns[0].items[0].content[0].path=invalid;
    assert.throws(()=>normalizeConversation(state,{imageMessageId:'message'}),{code:'IMAGE_UNAVAILABLE'});
  }
});

test('读取图片必须已订阅对应会话，手机不能传文件路径或替换图片地址',async t=>{
  const {state}=fixture(t),client=Object.assign(new EventEmitter(),{close(){}}),adapter=new DesktopAdapter({client});t.after(()=>adapter.close());
  adapter.conversations.set('thread',{state,watchers:new Set(['phone']),waiters:[]});
  await assert.rejects(adapter.messageImages('thread','message','other'),{code:'SUBSCRIPTION_REQUIRED'});
  assert.equal((await adapter.messageImages('thread','message','phone')).images.length,1);
  await assert.rejects(adapter.messageImages('thread','missing','phone'),{code:'IMAGE_UNAVAILABLE'});
  const request={v:1,type:'request',requestId:'image-preview-request',method:'thread.images',params:{threadId:'thread',messageId:'message'}};
  assert.doesNotThrow(()=>validateRequest(request));
  for(const key of ['path','url'])assert.throws(()=>validateRequest({...request,params:{...request.params,[key]:'synthetic.png'}}),{code:'BAD_PARAMS'});
});

test('实时快照缺少历史助手图片时按编号回查，退订后不返回图片',async t=>{
  const {state,file,data}=fixture(t);
  const saved={id:'thread',turns:[{turnId:'older',items:[{id:'design',type:'imageGeneration',status:'completed',savedPath:file}]}]};
  let finishRead;
  const index={readHistory:(threadId,selection)=>{
    assert.equal(threadId,'thread');
    assert.deepEqual(selection,{imageMessageId:'design',imageIndex:0});
    return new Promise(resolve=>{finishRead=()=>resolve(normalizeConversation(saved,selection));});
  }};
  const adapter=new DesktopAdapter({index,client:Object.assign(new EventEmitter(),{close(){}})});t.after(()=>adapter.close());
  const watchers=new Set(['phone']);
  adapter.conversations.set('thread',{state,watchers,waiters:[]});
  const read=()=>adapter.messageImages('thread','design','phone',{imageIndex:0,chunkIndex:0});
  const preview=read();finishRead();
  assert.deepEqual(Buffer.from((await preview).data.split(',')[1],'base64'),data);
  const canceled=read();watchers.delete('phone');finishRead();
  await assert.rejects(canceled,{code:'SUBSCRIPTION_CANCELED'});
});

test('手机保留明确的图片错误原因，重试时清除旧错误，离页回执不写入图片',async()=>{
  const source=fs.readFileSync('apps/mobile/components/message-images/message-images.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  const props={hostId:'host',threadId:'thread',messageId:'message',connected:true,assistant:false};
  const pending=[],unmount=[];const context=vm.createContext({connection:{hostId:'host',activeThreadId:'thread',cacheNamespace:''},ref:value=>({value}),defineProps:()=>props,defineEmits:()=>()=>{},watch(){},onUnmounted:cb=>unmount.push(cb),bridge:{request:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))}});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.ui={loadImages,sources,error};',context);const ui=context.ui;
  ui.loadImages();pending.shift().reject(Error('电脑上的原图已不存在，请重新发送'));await new Promise(setImmediate);assert.match(ui.error.value,/原图已不存在/);
  props.assistant=true;
  ui.loadImages();pending.shift().reject(Error('这条记录没有保留可预览的图片，请重新发送原图'));await new Promise(setImmediate);assert.equal(ui.error.value,'暂时无法预览这张图片');
  ui.loadImages();pending.shift().reject(Error('电脑上的原图已不存在，请重新发送'));await new Promise(setImmediate);assert.equal(ui.error.value,'电脑上的原图已不存在');
  ui.loadImages();assert.equal(ui.error.value,'');unmount[0]();pending.shift().resolve({chunkCount:1,data:'synthetic-image'});await new Promise(setImmediate);assert.equal(ui.sources.value.length,0);
});
