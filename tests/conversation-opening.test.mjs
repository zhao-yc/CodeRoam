import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../apps/mobile/services/conversation-opening.uts',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source.replace(/\bexport /g,''),{mode:'transform'})+'\nglobalThis.title=conversationOpeningTitle;globalThis.displayTitle=conversationDisplayTitle;',context);

test('打开失败后结束加载提示，重试与连接恢复后可重新显示加载状态',()=>{
  const title=context.title;
  assert.equal(title(false,'',true),'正在打开会话');
  assert.equal(title(false,'历史读取失败',true),'会话打开失败');
  assert.equal(title(false,'历史读取失败',false),'会话打开失败');
  assert.equal(title(false,'',false),'等待连接电脑');
  assert.equal(title(false,'',true),'正在打开会话');
  assert.equal(title(true,'后续同步失败',true),'');
});

test('详情加载、失败或断线期间沿用列表名称，取得新名称后更新',()=>{
  for(const status of ['正在打开会话','会话打开失败','等待连接电脑','']) {
    for(const snapshotTitle of ['', '   ', '列表中的会话']) {
      assert.equal(context.displayTitle('列表中的会话',snapshotTitle,status),'列表中的会话');
    }
    assert.equal(context.displayTitle('列表中的会话','桌面更新后的名称',status),'桌面更新后的名称');
    assert.equal(context.displayTitle('','',status),status);
  }
});

test('列表跳转携带完整名称，中文和查询分隔符不会破坏详情参数',()=>{
  const list=fs.readFileSync(new URL('../apps/mobile/pages/index/index.uvue',import.meta.url),'utf8');
  const detail=fs.readFileSync(new URL('../apps/mobile/pages/conversation/index.uvue',import.meta.url),'utf8');
  let url='';
  const navigation=vm.createContext({encodeURIComponent,uni:{navigateTo:options=>{url=options.url;}},bridge:{selectComputer(){},openThread(){return Promise.resolve({});}}});
  const openThread=list.match(/^function openThread\(thread: ComputerThread\).*$/m)[0];
  vm.runInContext(stripTypeScriptTypes(openThread,{mode:'transform'})+';globalThis.open=openThread;',navigation);
  const title='中文会话 & 标题=100% + # ? / 😀';
  navigation.open({id:'thread',hostId:'pc',online:true,title});
  const options=Object.fromEntries(url.split('?')[1].split('&').map(pair=>pair.split('=')));
  const page={connection:{configured:true,hostId:'pc'},pageHostId:{value:''},pageThreadId:{value:''},listTitle:{value:''},uni:{getWindowInfo:()=>({windowHeight:800})},bridge:{watch(){}},decodeURIComponent};
  const loading=vm.createContext({...page,onLoad:callback=>callback(options)});
  const onLoad=detail.match(/onLoad\(\(options: OnLoadOptions\) => \{[\s\S]*?\n\}\)/)[0];
  vm.runInContext(stripTypeScriptTypes('let baseWindowHeight=0;'+onLoad,{mode:'transform'}),loading);
  assert.equal(page.listTitle.value,title);
  assert.equal(page.pageThreadId.value,'thread');
});
