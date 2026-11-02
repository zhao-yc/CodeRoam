import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {currentActivity} from '../apps/bridge/activity.mjs';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';
import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';

const label='正在压缩上下文 · 可能需要几分钟';
const reasoning={id:'before',type:'reasoning',summary:['**正在读取文件**']};
const active=items=>({turnId:'turn',status:'inProgress',items});

test('自动和手动压缩优先显示明确状态，不传播内部压缩内容',()=>{
  for(const source of ['automatic','manual']) {
    const item={id:'compact',type:'contextCompaction',completed:false,source,startedAtMs:100,content:'内部压缩内容'};
    const snapshot=normalizeConversation({id:'thread',turns:[active([reasoning,item])]});
    assert.equal(snapshot.activity,label);
    assert.deepEqual(snapshot.messages,[]);
    assert.equal(JSON.stringify(snapshot).includes('内部压缩内容'),false);
  }
});

test('压缩结束不复活旧标题或命令，只展示压缩之后的新动作',()=>{
  const compact={id:'compact',type:'contextCompaction',completed:true};
  const before=[reasoning,{id:'old-command',type:'commandExecution',status:'inProgress'}];
  assert.equal(currentActivity(active([...before,compact])), '');
  assert.equal(currentActivity(active([...before,compact,{id:'next',type:'commandExecution',status:'inProgress'}])), '正在执行命令');
  assert.equal(currentActivity(active([...before,compact,{id:'next',type:'reasoning',summary:['**正在验证结果**']}])), '正在验证结果');
  assert.equal(currentActivity(active([{type:'contextCompaction',completed:false},compact])), '');
  assert.equal(currentActivity(active([compact,{type:'contextCompaction',completed:false}])),label);
});

test('完成、中断、失败和没有实时标记的历史压缩都不继续显示压缩中',()=>{
  for(const item of [
    {completed:true}, {}, {completed:false,completedAtMs:0},
    ...['completed','interrupted','failed','declined'].map(status=>({completed:false,status})),
  ])assert.equal(currentActivity(active([{type:'contextCompaction',...item}])), '');
  assert.equal(currentActivity(active([{type:'contextCompaction',status:'inProgress'}])),label);
  for(const status of ['completed','interrupted','failed'])assert.equal(currentActivity({...active([{type:'contextCompaction',completed:false}]),status}), '');
  assert.equal(currentActivity({...active([{type:'contextCompaction',completed:false}]),error:{message:'失败'}}), '');
});

test('没有新增正文时，压缩开始、完成和恢复仍通过增量更新抵达手机',()=>{
  const turn=active([{id:'message',type:'agentMessage',text:'合成历史内容'.repeat(1000)},reasoning]);
  let current={snapshot:normalizeConversation({id:'thread',turns:[turn]}),seq:1,epoch:'epoch'};
  const compact={id:'compact',type:'contextCompaction',completed:false};
  turn.items.push(compact);
  for(const [action,expected] of [
    [()=>{},label],
    [()=>{compact.completed=true;},''],
    [()=>{turn.items.push({id:'after',type:'reasoning',summary:['**正在继续处理**']});},'正在继续处理'],
    [()=>{turn.status='completed';},''],
  ]) {
    action();
    const snapshot=normalizeConversation({id:'thread',turns:[turn]});
    const update=conversationUpdate(current,snapshot);
    assert.equal(update.kind,'delta');
    assert.equal(update.update.upserts.length,0);
    assert.equal(update.update.appends.some(append=>append.text.length>0),false);
    current=applyConversationUpdate(current,{...update,seq:current.seq+1,epoch:current.epoch});
    assert.equal(current.snapshot.activity,expected);
    assert.deepEqual(current.snapshot,snapshot);
  }
});

test('手机只在运行时展示压缩提示，审批、提问和断线仍优先',()=>{
  const component=fs.readFileSync('apps/mobile/components/task-status/task-status.uvue','utf8');
  const lines=component.split(/\r?\n/).filter(line=>line.startsWith('const showDetail =')||line.startsWith('const label =')).join('\n');
  const props={state:'running',detail:label};
  const context=vm.createContext({props,computed:get=>({get value(){return get();}})});
  vm.runInContext(stripTypeScriptTypes(lines)+';globalThis.result={label,showDetail};',context);
  assert.equal(context.result.label.value,label);
  for(const [state,expected] of [['approval','需要审批'],['question','需要用户输入'],['offline','状态未同步'],['idle','已空闲'],['failed','任务失败']]) {
    props.state=state;
    assert.equal(context.result.showDetail.value,false);
    assert.equal(context.result.label.value,expected);
  }
  props.state='running';props.detail='';
  assert.equal(context.result.label.value,'进行中');
});
