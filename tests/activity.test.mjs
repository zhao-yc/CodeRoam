import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {activityHeading,currentActivity} from '../apps/bridge/activity.mjs';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';
import {historicalSnapshot} from '../apps/bridge/history-reader.mjs';
import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';

test('实时动作取公开摘要的最新标题，兼容普通标题并限制长度',()=>{
  assert.equal(activityHeading(['**正在检查历史记录**\n\n摘要正文不会传给手机。']),'正在检查历史记录');
  assert.equal(activityHeading(['## 正在检查\n正文\n\n**正在编译手机界面**\n第二段正文']),'正在编译手机界面');
  assert.equal(activityHeading(['Preparing history-page mocks']),'Preparing history-page mocks');
  assert.equal(activityHeading(['**尚未完成标题']), '');
  assert.equal(activityHeading(['第一段正文\n第二段正文']), '');
  assert.equal(activityHeading([{text:'不能自动信任任意结构'}]),'');
  assert.equal(activityHeading(['**'+'长'.repeat(300)+'**']).length,160);
});

test('仅同步当前运行轮次的动作，结束清空，不传推理正文和工具敏感参数',()=>{
  const old={turnId:'old',status:'completed',items:[{id:'r0',type:'reasoning',summary:['**旧动作**']}]};
  const active={turnId:'turn',status:'inProgress',items:[{id:'r',type:'reasoning',summary:['**正在验证图片预览**\n公开摘要的其他内容'],content:['不能传给手机的私有内容']},{id:'cmd',type:'commandExecution',command:'命令参数',status:'inProgress'}]};
  const result=normalizeConversation({id:'thread',turns:[old,active]});
  assert.equal(result.activity,'正在验证图片预览');assert.equal(JSON.stringify(result).includes('不能传给手机'),false);assert.equal(JSON.stringify(result).includes('公开摘要的其他内容'),false);
  active.status='completed';assert.equal(normalizeConversation({id:'thread',turns:[old,active]}).activity,'');
  active.status='inProgress';active.error={message:'错误'};assert.equal(currentActivity(active),'');
  assert.equal(currentActivity(null),'');
  const history=historicalSnapshot({id:'t'},[{type:'event_msg',payload:{type:'task_started',turn_id:'old'}},{type:'event_msg',payload:{type:'item_completed',item:{id:'cmd',type:'CommandExecution',command:'旧命令',status:'inProgress'}}}]);
  assert.equal(history.activity,'');
});

test('缺少公开标题时根据未完成项目显示具体动作，不拿旧任务和日志猜进度',()=>{
  const turn=(item)=>({status:'inProgress',items:[item]});
  const command={type:'commandExecution',status:'inProgress',command:'不能用命令替代进度',aggregatedOutput:'不能用输出替代进度'};
  assert.equal(currentActivity(turn(command)),'正在执行命令');
  for(const [type,label]of [['read','正在读取文件'],['search','正在搜索代码'],['listFiles','正在查看文件目录']])assert.equal(currentActivity(turn({...command,commandActions:[{type}]})),label);
  assert.equal(currentActivity(turn({...command,status:'completed'})),'');
  assert.equal(currentActivity(turn({type:'fileChange',status:'inProgress'})),'正在修改文件');
  assert.equal(currentActivity(turn({type:'mcpToolCall',status:'inProgress'})),'正在调用工具');
  assert.equal(currentActivity(turn({type:'webSearch',status:'inProgress'})),'正在搜索网页');
  assert.equal(currentActivity(turn({type:'reasoning',content:['隐藏内容']})),'正在分析');
  assert.equal(currentActivity(turn({type:'assistantMessage'})),'正在生成回复');
});

test('没有新增消息时动作仍通过元数据增量更新，任务结束不遗留旧动作',()=>{
  let before={threadId:'t',activity:'正在检查代码',messages:[{id:'history',role:'assistant',text:'历史内容'.repeat(2000)}]};
  for(const activity of ['正在编译手机界面','']){
    const after={...before,activity};
    const delta=conversationUpdate({snapshot:before,seq:1},after);
    assert.equal(delta.kind,'delta');assert.deepEqual(delta.update.upserts,[]);assert.deepEqual(delta.update.appends,[]);
    assert.deepEqual(applyConversationUpdate({snapshot:before,seq:1,epoch:'e'},{...delta,epoch:'e',seq:2}).snapshot,after);
    before=after;
  }
  const uts=fs.readFileSync('apps/mobile/services/bridge.uts','utf8');
  const statement=uts.split(/\r?\n/).find(line=>line.includes('connection.snapshot = { threadId: update.threadId'));
  const context=componentContext({connection:{snapshot:{}},ordered:[],update:{threadId:'t',activity:'正在编译手机界面'}});
  vm.runInContext(stripTypeScriptTypes(statement,{mode:'transform'}),context);assert.equal(context.connection.snapshot.activity,'正在编译手机界面');
  delete context.update.activity;vm.runInContext(stripTypeScriptTypes(statement,{mode:'transform'}),context);assert.equal(context.connection.snapshot.activity,'');
});

test('具体动作只在底部运行态显示，等待、离线和结束时状态优先',()=>{
  const component=fs.readFileSync('apps/mobile/components/task-status/task-status.uvue','utf8');
  const lines=component.split(/\r?\n/).filter(line=>line.startsWith('const showDetail =')||line.startsWith('const label =')).join('\n');
  const props={state:'running',detail:'正在测试接口'};
  const context=componentContext({props,computed:get=>({get value(){return get();}})});
  vm.runInContext(stripTypeScriptTypes(lines)+';globalThis.result={label,showDetail};',context);
  assert.equal(context.result.label.value,'正在测试接口');
  for(const [state,label]of [['question','需要用户输入'],['approval','需要审批'],['offline','状态未同步'],['idle','已空闲'],['unknown','状态未知']]){props.state=state;assert.equal(context.result.label.value,label);assert.equal(context.result.showDetail.value,false);}
  props.state='running';props.detail='';assert.equal(context.result.label.value,'进行中');
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const statuses=page.match(/<task-status\b[^>]*>/g);
  assert.equal(statuses.length,2);assert.equal(statuses[0].includes(':detail='),false);assert.equal(statuses[1].includes(':detail='),true);
});
