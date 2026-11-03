import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceFixture} from './helpers/workspace-fixture.mjs';

test('900 逻辑像素启用固定列表分栏，缩窄和恢复不切换聊天或重新导航电脑',async()=>{
  const f=workspaceFixture();assert.equal(f.mode.value,'list');assert.equal(f.selected.value,null);
  await f.selectConversation(f.target(),true);const target=f.selected.value;
  for(const width of [320,390,820,899,900,1024,1366,1600]) { f.props.windowWidth=width;assert.equal(f.wide.value,width>=900);assert.equal(f.detailWidth.value,width>=900?width-341:width);assert.equal(f.selected.value,target);assert.equal(f.detailMounted.value,true); }
  assert.equal(f.calls.filter(row=>row[0]==='open').length,1);
});
test('重复选择当前聊天不重开；快速切换只挂载最后目标，电脑与配对属于身份',async()=>{
  const f=workspaceFixture({manualTicks:true}),first=f.selectConversation(f.target('first'),true),second=f.selectConversation(f.target('last','other'),true);
  await f.flush();assert.equal(await first,false);assert.equal(await second,true);assert.equal(f.selected.value.threadId,'last');assert.equal(f.selected.value.hostId,'other');
  await f.selectConversation(f.target('last','other'),true);assert.equal(f.calls.filter(row=>row[0]==='open').length,1);
  assert.equal(await f.selectConversation({...f.target(),cacheNamespace:'old-pair'},true),false);assert.equal(f.selected.value.threadId,'last');
});
test('切换前卸载旧面板，下一帧后才打开目标；离开工作区阻止迟到的打开',async()=>{
  const f=workspaceFixture({manualTicks:true});f.detailMounted.value=true;f.selected.value=f.target('old');f.mode.value='conversation';
  const pending=f.selectConversation(f.target('new'),true);assert.equal(f.detailMounted.value,false);assert.equal(f.calls.some(row=>row[0]==='open'),false);
  f.unmount();await f.flush();assert.equal(await pending,false);assert.equal(f.calls.some(row=>row[0]==='open'),false);
});
test('新聊天在右侧，取消恢复原聊天，提交期间阻止切换并保留当前编辑区',async()=>{
  const f=workspaceFixture();await f.selectConversation(f.target(),true);await f.openNewConversation();assert.equal(f.mode.value,'new');assert.equal(f.newReady.value,true);assert.equal(f.detailMounted.value,true);
  f.creating.value=true;assert.equal(await f.selectConversation(f.target('another'),true),false);f.closeNewConversation();assert.equal(f.mode.value,'new');
  f.creating.value=false;f.closeNewConversation();assert.equal(f.mode.value,'conversation');assert.equal(f.selected.value.threadId,'thread');assert.ok(f.calls.some(row=>row[0]==='watch'));
});
test('新聊天成功后挂载正式聊天，归档或删除清空详情并消费一次列表提示',async()=>{
  for(const kind of ['archive','delete']) {
    const f=workspaceFixture();await f.openNewConversation();await f.onConversationCreated('created');assert.equal(f.selected.value.threadId,'created');assert.equal(f.mode.value,'conversation');assert.equal(f.calls.some(row=>row[0]==='open'),false);
    f.onConversationRemoved(kind);assert.equal(f.mode.value,'list');assert.equal(f.selected.value,null);assert.equal(f.detailMounted.value,false);assert.equal(f.calls.filter(row=>row[0]===kind+'-notice').length,1);
  }
});
test('宽屏通知使用同一工作区，关闭优先处理浮层；窄屏独立路由保留返回导航',async()=>{
  const f=workspaceFixture();f.syncNoticeNavigation();assert.ok(f.context.notice);await f.context.notice({hostId:'other',threadId:'notice',threadTitle:'通知聊天'});assert.equal(f.selected.value.threadId,'notice');assert.equal(f.calls.some(row=>row[0]==='navigate'),false);
  f.detailPane.value={handleBack:()=>true};assert.equal(f.handleBack(),true);assert.equal(f.mode.value,'conversation');
  f.detailPane.value={handleBack:()=>false};assert.equal(f.handleBack(),true);assert.equal(f.mode.value,'list');
  const narrow=workspaceFixture({props:{windowWidth:390,detailRoute:true}});await narrow.selectConversation(narrow.target(),false);narrow.closeConversation();assert.ok(narrow.calls.some(row=>row[0]==='back'));
  narrow.onConversationRemoved('archive');assert.equal(narrow.calls.some(row=>row[0]==='archive-notice'),false);
});

// 模拟刷新后直达详情，首个握手回包到达前客户端还没有授权列表。
function refreshedRoute() {
  const initialTarget={hostId:'host',threadId:'route-thread',title:'合成聊天',projectName:'项目',cacheNamespace:'pair'};
  const f=workspaceFixture({props:{initialTarget},connection:{connected:false,computers:[]}});
  const readings=f.watchers.map(watcher=>watcher.read());
  const update=async values=>{
    Object.assign(f.connection,values);
    f.watchers.forEach((watcher,index)=>{
      const value=watcher.read();
      if(value!==readings[index]) { const previous=readings[index];readings[index]=value;watcher.callback(value,previous); }
    });
    await f.flush();
  };
  return {f,update};
}

test('刷新直达聊天等待握手，目标在授权列表时自动打开一次',async()=>{
  const {f,update}=refreshedRoute();
  assert.deepEqual(f.calls,[]);
  const computers=[{id:'host',online:true}];
  await update({connected:true,computers});
  assert.equal(f.selected.value?.threadId,'route-thread');
  assert.deepEqual(f.calls.filter(([kind])=>kind==='toast'||kind==='select'),[['select','host']]);
  f.closeConversation();
  await update({connected:false});await update({connected:true,computers});
  assert.equal(f.selected.value,null);
});

test('握手确认电脑不在授权列表后才拒绝打开，等待期间换配对则丢弃旧路由',async()=>{
  const {f,update}=refreshedRoute();
  await update({connected:true,computers:[{id:'other',online:true}]});
  assert.deepEqual(f.calls,[['toast','这台电脑不在当前授权范围内']]);
  assert.equal(f.selected.value,null);

  const changed=refreshedRoute();
  await changed.update({cacheNamespace:'new-pair'});
  await changed.update({connected:true,computers:[{id:'host',online:true}]});
  assert.deepEqual(changed.f.calls,[]);
  assert.equal(changed.f.selected.value,null);
});
