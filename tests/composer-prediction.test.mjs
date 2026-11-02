import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {ComposerPredictionReader} from '../apps/bridge/composer-prediction.mjs';
import {predictionExpression} from '../apps/bridge/prediction-expression.mjs';
import {predictionTurnId} from '../apps/bridge/prediction-turn.mjs';
import {validateRequest} from '../packages/protocol/contracts.mjs';

function adapter(){const entry={owner:{hostId:'local',clientId:'desktop-1'},watchers:new Set(['phone']),state:{turns:[{turnId:'turn-1',status:'completed'}]}};return {entry,conversations:new Map([['thread-1',entry]]),subscribed(id,device){assert.equal(id,'thread-1');assert.ok(entry.watchers.has(device));return entry;},snapshot(state){return {activeTurnId:state.active??'',status:state.active?'active':'idle'};}};}
function reader(evaluate){return new ComposerPredictionReader({discover:async()=>[{port:12345}],fetcher:async()=>({ok:true,text:async()=>JSON.stringify([{type:'page',url:'app://-/index.html',id:'ABC',webSocketDebuggerUrl:'ws://attacker.invalid/'}])}),evaluate});}
const prediction={threadId:'thread-1',sourceTurnId:'turn-1',text:'中文“原文”  保留\n下一行'};
test('原文无损读取，忽略目标返回的任意调试URL',async()=>{const r=reader(async(url,expression)=>{assert.equal(url,'ws://127.0.0.1:12345/devtools/page/ABC');assert.ok(expression.includes('thread-1'));return [prediction];});assert.deepEqual(await r.read(adapter(),'thread-1','phone'),{prediction});});
test('读取期间换轮次、取消订阅或更换所有者均丢弃回执',async()=>{for(const change of [a=>a.entry.state.turns[0].turnId='turn-2',a=>a.entry.watchers.clear(),a=>a.entry.owner={hostId:'local',clientId:'desktop-2'}]){const a=adapter();const r=reader(async()=>{change(a);return [prediction];});assert.deepEqual(await r.read(a,'thread-1','phone'),{prediction:null});}});
test('桌面真实历史分片只读取最新端已完成轮次，分页缺口与新轮次不回退旧预测',()=>{
  const latest={turnId:'turn-1',status:'completed'},history={entitiesByKey:{latest},islands:[{entries:[{value:'latest'}],newerBoundary:{status:'exhausted'}}]},state={turnHistory:{history},turns:[]};
  assert.equal(predictionTurnId(state),'turn-1');latest.status='inProgress';assert.equal(predictionTurnId(state),'');latest.status='completed';history.islands[0].newerBoundary.status='unknown';assert.equal(predictionTurnId(state),'');history.islands[0].newerBoundary.status='exhausted';history.islands.push(history.islands[0]);assert.equal(predictionTurnId(state),'');
});
test('运行中、重复窗口、错误会话、过长正文均不展示',async()=>{const a=adapter();a.entry.state.active='running';assert.deepEqual(await reader(()=>{throw Error('不应读取');}).read(a,'thread-1','phone'),{prediction:null});for(const values of [[prediction,prediction],[{...prediction,threadId:'other'}],[{...prediction,sourceTurnId:'old'}],[{...prediction,text:'x'.repeat(32001)}]])assert.deepEqual(await reader(async()=>values).read(adapter(),'thread-1','phone'),{prediction:null});});
test('预测接口拒绝手机传入脚本、地址或轮次覆盖',()=>{for(const params of [{threadId:'t',expression:'x'},{threadId:'t',port:1},{threadId:'t',sourceTurnId:'old'}])assert.throws(()=>validateRequest({v:1,type:'request',requestId:'a'.repeat(20),method:'thread.prediction.read',params}));assert.doesNotThrow(()=>validateRequest({v:1,type:'request',requestId:'a'.repeat(20),method:'thread.prediction.read',params:{threadId:'t'}}));});
test('固定表达式按所选标签和目标会话过滤，内容使用内存原文',()=>{
  let selected='true',hidden=false;const doc={visibilityState:'visible'};
  const view={state:{doc:{content:{content:[{type:{name:'paragraph'},content:{size:0}}]}}},input:{composing:false}};
  view.state['cumberbatch$']={prediction,hiddenForComposition:false};
  const panel={id:'panel',getAttribute:name=>name==='role'?'tabpanel':name==='hidden'&&hidden?'':null,parentElement:null};
  const host={__reactFiber$1:{memoizedProps:{conversationId:'thread-1',hostId:'local',composerController:{view}},return:null},parentElement:panel,getAttribute:()=>null};
  const editor={parentElement:host,getAttribute:()=>null,querySelector:()=>({textContent:'格式化后的文字'})};view.dom=editor;
  doc.querySelectorAll=()=>[editor];doc.querySelector=()=>({getAttribute:()=>selected});
  const read=()=>JSON.parse(JSON.stringify(vm.runInNewContext(predictionExpression('local','thread-1','turn-1'),{document:doc})));
  assert.deepEqual(read(),[prediction]);
  // 浏览器置前导致桌面文档 hidden，不能把仍存在的当前会话预测误判为空。
  doc.visibilityState='hidden';assert.deepEqual(read(),[prediction]);
  selected='false';assert.deepEqual(read(),[]);selected='true';hidden=true;assert.deepEqual(read(),[]);
  hidden=false;view.state.doc.content.content[0].content.size=1;assert.deepEqual(read(),[]);
  view.state.doc.content.content[0].content.size=0;view.state['cumberbatch$'].prediction={...prediction,sourceTurnId:'old'};assert.deepEqual(read(),[]);
});

/** 执行手机页面实际预测方法，验证异步回执、过期状态与采纳行为。 */
function mobile(){
  const source=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8');
  const code=source.slice(source.indexOf('const predictionAllowed ='),source.indexOf('function notify(message: string)'));
  const ref=value=>({value});const pending=[],saved=[],timers=[];
  const c={computed:fn=>({get value(){return fn();}}),pageVisible:ref(true),canWrite:ref(true),goalHostOnline:ref(true),connection:{epoch:'e',subscriptionRevision:1,snapshot:{supportsComposerPrediction:true,predictionTurnId:'turn-1'}},activeTurnId:ref(''),currentTaskState:ref('idle'),draft:ref(''),draftImages:ref([]),draftFiles:ref([]),pendingQuestionCount:ref(0),approvalCount:ref(0),pageHostId:ref('host'),pageThreadId:ref('thread-1'),predictionText:ref(''),predictionFocus:ref(false),inputFocused:ref(false),pageAlive:true,predictionRevision:0,predictionTimer:0,predictionExpiryTimer:0,predictionDeadline:0,Date,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},watch(){},onUnload(){},nextTick:fn=>fn(),saveDraft:(host,thread,text)=>{saved.push({host,thread,text});c.draft.value=text;},bridge:{request:(method,params)=>{assert.equal(method,'thread.prediction.read');return new Promise(resolve=>pending.push(resolve));}}};
  vm.runInNewContext(stripTypeScriptTypes(code+';globalThis.ui={pollPrediction,acceptPrediction,resetPrediction};'),c);
  const result=p=>({getString:k=>p?.[k]??null});
  return {c,pending,saved,resolve:p=>pending.shift()({prediction:result(p)}),ui:c.ui};
}
test('手机采纳仅填入草稿，保留空格换行且不自动发送',async()=>{const m=mobile();m.ui.pollPrediction(0);m.resolve(prediction);await Promise.resolve();m.ui.acceptPrediction();assert.equal(m.saved[0].text,prediction.text);assert.equal(m.c.predictionText.value,'');assert.equal(m.pending.length,0);});
test('手机旧回执、已输入草稿和过期预测均不覆盖草稿',async()=>{const m=mobile();m.ui.pollPrediction(0);m.ui.resetPrediction();m.resolve(prediction);await Promise.resolve();assert.equal(m.c.predictionText.value,'');m.c.predictionText.value='旧预测';m.c.draft.value='用户草稿';m.ui.acceptPrediction();assert.equal(m.saved.length,0);m.c.draft.value='';m.c.predictionDeadline=0;m.ui.acceptPrediction();assert.equal(m.saved.length,0);});
