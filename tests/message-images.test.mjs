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

test('手机保留明确的图片错误原因，重试时清除旧错误，离页回执不写入图片',async()=>{
  const source=fs.readFileSync('apps/mobile/components/message-images/message-images.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  const pending=[],unmount=[];const context=vm.createContext({ref:value=>({value}),defineProps:()=>({hostId:'host',threadId:'thread',messageId:'message',connected:true}),watch(){},onUnmounted:cb=>unmount.push(cb),bridge:{request:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))}});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.ui={loadImages,sources,error};',context);const ui=context.ui;
  ui.loadImages();pending.shift().reject(Error('电脑上的原图已不存在，请重新发送'));await Promise.resolve();assert.match(ui.error.value,/原图已不存在/);
  ui.loadImages();assert.equal(ui.error.value,'');unmount[0]();pending.shift().resolve({images:['synthetic-image']});await Promise.resolve();assert.equal(ui.sources.value.length,0);
});
