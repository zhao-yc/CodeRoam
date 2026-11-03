import {workspaceFixture} from './helpers/workspace-fixture.mjs';
import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../apps/mobile/services/conversation-opening.uts',import.meta.url),'utf8');
const context=componentContext({});
vm.runInContext(stripTypeScriptTypes(source.replace(/\bexport /g,''),{mode:'transform'})+'\nglobalThis.title=conversationOpeningTitle;globalThis.displayTitle=conversationDisplayTitle;globalThis.projectName=conversationProjectName;',context);

test('打开失败后结束加载提示，重试与连接恢复后可重新显示加载状态',()=>{
  const title=context.title;
  assert.equal(title(false,'',true),'正在打开聊天');
  assert.equal(title(false,'历史读取失败',true),'聊天打开失败');
  assert.equal(title(false,'历史读取失败',false),'聊天打开失败');
  assert.equal(title(false,'',false),'等待连接电脑');
  assert.equal(title(false,'',true),'正在打开聊天');
  assert.equal(title(true,'后续同步失败',true),'');
});

test('详情加载、失败或断线期间沿用列表名称，取得新名称后更新',()=>{
  for(const status of ['正在打开聊天','聊天打开失败','等待连接电脑','']) {
    for(const snapshotTitle of ['', '   ', '列表中的会话']) {
      assert.equal(context.displayTitle('列表中的会话',snapshotTitle,status),'列表中的会话');
    }
    assert.equal(context.displayTitle('列表中的会话','桌面更新后的名称',status),'桌面更新后的名称');
    assert.equal(context.displayTitle('','',status),status);
  }
});

test('项目加载期间沿用列表名称，快照支持两种路径分隔符和末尾斜杠',()=>{
  assert.equal(context.projectName('列表项目',''),'列表项目');
  assert.equal(context.projectName('列表项目','   '),'列表项目');
  assert.equal(context.projectName('未指定项目',''),'未指定项目');
  assert.equal(context.projectName('',''),'聊天');
  for(const cwd of ['C:\\workspace\\新项目\\','/workspace/新项目/','/workspace/新项目']) {
    assert.equal(context.projectName('列表项目',cwd),'新项目');
  }
});

test('列表跳转携带完整标题和项目名，中文和查询分隔符不会破坏详情参数',()=>{
  const f=workspaceFixture({props:{windowWidth:390}});
  const title='中文会话 & 标题=100% + # ? / 😀 %2F',project='中文项目 & 名称=100% + # ? 😀 %20';
  f.openThread({id:'thread',hostId:'host',online:true,title,cwd:'/workspace/'+project+'/'});
  const url=f.calls.find(row=>row[0]==='navigate')[1];
  const options=Object.fromEntries(url.split('?')[1].split('&').map(pair=>pair.split('=').map(decodeURIComponent)));
  const route=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8');
  const target={value:null};
  const page=componentContext({initialTarget:target,workspaceTarget:(hostId,threadId,title,projectName,cacheNamespace)=>({hostId,threadId,title,projectName,cacheNamespace}),connection:{configured:true,hostId:'host',cacheNamespace:'pair'},pendingTaskNotice:()=>null,onLoad:callback=>callback(options)});
  const onLoad=route.match(/onLoad\(\(options: OnLoadOptions\) => \{[\s\S]*?\n\}\)/)[0];
  vm.runInContext(stripTypeScriptTypes(onLoad,{mode:'transform'}),page);
  assert.equal(target.value.title,title);assert.equal(target.value.projectName,project);assert.equal(target.value.threadId,'thread');assert.equal(target.value.hostId,'host');
});

test('旧会话或其他电脑的快照不能覆盖列表项目名',()=>{
  const detail=fs.readFileSync(new URL('../apps/mobile/components/chat-detail/chat-detail.uvue',import.meta.url),'utf8');
  const declaration=detail.match(/^const projectName = computed\(.*$/m)[0];
  const page={cacheOnly:false,cachedDetail:{value:null},computed:read=>({get value(){return read();}}),conversationProjectName:context.projectName,listProjectName:{value:'列表项目'},pageHostId:{value:'pc'},pageThreadId:{value:'thread'},connection:{hostId:'other',snapshot:{threadId:'thread',cwd:'/workspace/其他项目'}}};
  const reading=componentContext(page);
  vm.runInContext(stripTypeScriptTypes(declaration,{mode:'transform'})+';globalThis.project=projectName;',reading);
  assert.equal(reading.project.value,'列表项目');
  page.connection.hostId='pc';page.connection.snapshot.threadId='old-thread';
  assert.equal(reading.project.value,'列表项目');
  page.connection.snapshot.threadId='thread';
  assert.equal(reading.project.value,'其他项目');
  page.connection.snapshot=null;
  assert.equal(reading.project.value,'列表项目');
});
