import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {fileReportSource} from '../apps/bridge/file-report-source.mjs';
import {DesktopFileReportReader,desktopDiffModuleNames} from '../apps/bridge/file-reports.mjs';
import {fileReportExpression} from '../apps/bridge/file-report-expression.mjs';
import {validateRequest} from '../packages/protocol/contracts.mjs';
import {EventEmitter} from 'node:events';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';

const change=(id,path='src/demo.uts',status='completed')=>({id,type:'fileChange',status,changes:[{path,kind:{type:'update'},diff:'@@ -1 +1 @@\n-old\n+new\n'}]});
const final=id=>({id,type:'agentMessage',phase:'final_answer',text:'合成报告'});
const state=items=>({cwd:'/workspace/demo',turns:[{turnId:'turn',status:'completed',items}]});

test('桌面资源缺失和重复匹配分别给出明确更新指引',()=>{
  const initial='webview/assets/app-initial-abc.js',summary='webview/assets/diff-summary-def.js';
  assert.deepEqual(desktopDiffModuleNames([initial,summary]),{initial:'app-initial-abc.js',summary:'diff-summary-def.js'});
  for(const files of [[],[initial],['webview/assets/async/123.abc.js']]) {
    assert.throws(()=>desktopDiffModuleNames(files),{code:'REPORT_UNAVAILABLE',message:/未找到兼容.*更新连接服务/});
  }
  assert.throws(()=>desktopDiffModuleNames([initial,'webview/assets/app-initial-def.js',summary]),{code:'REPORT_UNAVAILABLE',message:/多个匹配/});
  assert.throws(()=>desktopDiffModuleNames([initial,summary,'webview/assets/diff-summary-abc.js']),{code:'REPORT_UNAVAILABLE',message:/多个匹配/});
});

test('文件错误展示兼容旧服务提示，保留新服务的具体原因',()=>{
  const source=fs.readFileSync('apps/mobile/services/file-reports.uts','utf8').replace(/\bexport /g,'');
  const context=vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.format=fileReportErrorMessage;',context);
  assert.match(context.format('原生模块不唯一'),/无法识别当前桌面版.*更新连接服务/);
  assert.equal(context.format('报告未完整保留'),'报告未完整保留');
  assert.match(context.format(''),/读取失败/);
});

test('文件汇总绑定每份最终报告，保留重复修改并排除失败、后续和其他轮次',()=>{
  const input=state([change('first'),final('early'),...Array.from({length:100},(_,id)=>({id:'cmd-'+id,type:'commandExecution'})),change('second'),change('third'),change('failed','src/no.uts','failed'),final('report'),change('tail')]);
  input.turns.push({turnId:'other',items:[change('unrelated')]});
  assert.deepEqual(fileReportSource(input,'report').batches.map(batch=>batch.changes[0].path),['src/demo.uts','src/demo.uts']);
  assert.equal(fileReportSource(input,'early').batches.length,1);
  assert.equal(fileReportSource(input,'cmd-1'),null);
  assert.equal(fileReportSource(state([final('empty')]),'empty').batches.length,0);
  assert.throws(()=>fileReportSource({...input,historyTruncated:true},'early'),/未完整保留/);
});

test('汇总接口拒绝路径、脚本、未知参数与非法文件编号',()=>{
  const request={v:1,type:'request',requestId:'synthetic-request-0001',method:'thread.history',params:{threadId:'thread',view:'file-report',reportId:'report'}};
  assert.equal(validateRequest(request),request);
  for(const extra of [{path:'src/demo.uts'},{script:'任意脚本'},{fileId:'../private'},{reportId:''}])assert.throws(()=>validateRequest({...request,params:{...request.params,...extra}}));
  assert.throws(()=>fileReportExpression({initial:'https://example.com/code.js',summary:'diff-summary-abc.js'},[]));
});

test('直接透传原生统计，差异按文件懒加载且缓存不进入快照',async()=>{
  const entry={watchers:new Set(['phone']),state:state([change('edit'),final('report')])};
  const adapter={conversations:new Map([['thread',entry]])};
  const reader=new DesktopFileReportReader();let reads=0;
  reader.nativeReport=async()=>{reads++;return {additions:700,deletions:900,files:[{path:'src/demo.uts',kind:'update',additions:700,deletions:900,binary:false,diffs:['合成原生差异']}]} };
  try{
    const {report}=await reader.read(adapter,{threadId:'thread',reportId:'report'},'phone');
    assert.equal(report.additions,700);assert.equal(report.deletions,900);assert.equal(report.fileCount,1);assert.equal(report.files[0].diffs,undefined);
    const detail=await reader.read(adapter,{threadId:'thread',reportId:'report',fileId:report.files[0].id},'phone');
    assert.deepEqual(detail.file.diffs,['合成原生差异']);assert.equal(reads,1);
    assert.equal(entry.state.turns[0].items[0].additions,undefined);
    await assert.rejects(reader.read(adapter,{threadId:'thread',reportId:'report'},'other'),/请先打开/);
    await assert.rejects(reader.read(adapter,{threadId:'thread',reportId:'report',fileId:'0'.repeat(24)},'phone'),/没有这个文件/);
  }finally{reader.close();}
});

test('切换会话后丢弃在途原生汇总，不向新订阅返回旧代码',async()=>{
  const entry={watchers:new Set(['phone']),state:state([change('edit'),final('report')])};
  const adapter={conversations:new Map([['thread',entry]])},reader=new DesktopFileReportReader();
  let finish;reader.nativeReport=()=>new Promise(resolve=>{finish=resolve;});
  const pending=reader.read(adapter,{threadId:'thread',reportId:'report'},'phone');
  entry.watchers.clear();finish({additions:1,deletions:1,files:[]});
  await assert.rejects(pending,/已取消/);assert.equal(reader.cache.size,0);reader.close();
});

test('未经验证的普通启动版本不声明原生文件汇总',async()=>{
  const client=new EventEmitter();
  client.instance={directIpc:true}; client.connect=async()=>{}; client.close=()=>{};
  const adapter=new DesktopAdapter({client,index:{readHistory:()=>({threadId:'thread',supportsFileReports:true})}});
  adapter.discoverOwner=async()=>null;
  const reader=new DesktopFileReportReader({discover:async()=>assert.fail('普通启动不扫描页面')});
  try {
    assert.equal((await adapter.watch('thread','phone')).supportsFileReports,false);
    assert.equal(adapter.snapshot({id:'thread',turns:[]}).supportsFileReports,false);
    await assert.rejects(reader.nativeReport(adapter,{}),{code:'REPORT_UNAVAILABLE',message:/更新电脑连接服务/});
  } finally {
    reader.close();
    adapter.close();
  }
});

test('已核验的普通启动实例使用官方离线算法，并向历史与实时快照声明能力',async()=>{
  const executable='C:/Program Files/WindowsApps/OpenAI.Codex_example/app/ChatGPT.exe';
  const instance={directIpc:true,alive:true,ready:true,generation:'first',executable};
  const client=new EventEmitter();client.instance=instance;client.connect=async()=>{};client.close=()=>{};
  const adapter=new DesktopAdapter({client,index:{readHistory:()=>({threadId:'thread'})}});
  adapter.discoverOwner=async()=>null;
  let reads=0,closed=false,supported=true;
  const reader=new DesktopFileReportReader({discover:async()=>assert.fail('普通启动不需要页面端口'),nativeRuntime:{
    supports:value=>supported&&value===executable,
    calculate:async(value,batches)=>{assert.equal(value,executable);assert.equal(batches.length,1);reads++;return {additions:1,deletions:1,files:[{path:'src/demo.uts',kind:'update',additions:1,deletions:1,binary:false,diffs:['合成原生差异']}]};},
    close:()=>{closed=true;},
  }});
  adapter.nativeFileReportAvailable=()=>reader.supports(adapter);
  try {
    assert.equal((await adapter.watch('thread','phone')).supportsFileReports,true);
    assert.equal(adapter.snapshot({id:'thread',turns:[]}).supportsFileReports,true);
    adapter.conversations.set('thread',{watchers:new Set(['phone']),waiters:[],state:state([change('edit'),final('report')])});
    assert.equal((await reader.read(adapter,{threadId:'thread',reportId:'report'},'phone')).report.additions,1);
    assert.equal(reads,1);
    supported=false;
    await assert.rejects(reader.read(adapter,{threadId:'thread',reportId:'report'},'phone'),{code:'REPORT_UNAVAILABLE'});
    supported=true;
    instance.ready=false;
    assert.equal(reader.supports(adapter),false);
    await assert.rejects(reader.read(adapter,{threadId:'thread',reportId:'report'},'phone'),{code:'SUBSCRIPTION_CANCELED'});
  } finally {reader.close();adapter.close();}
  assert.equal(closed,true);
});

test('普通启动实例换代时丢弃在途本地原生差异',async()=>{
  const instance={directIpc:true,alive:true,ready:true,generation:'first',executable:'已核验安装'};
  const entry={watchers:new Set(['phone']),state:state([change('edit'),final('report')])};
  const adapter={client:{instance},conversations:new Map([['thread',entry]])};
  let finish;
  const reader=new DesktopFileReportReader({nativeRuntime:{supports:()=>true,calculate:()=>new Promise(resolve=>{finish=resolve;}),close(){}}});
  try {
    const pending=reader.read(adapter,{threadId:'thread',reportId:'report'},'phone');
    instance.generation='second';finish({additions:1,deletions:1,files:[]});
    await assert.rejects(pending,{code:'SUBSCRIPTION_CANCELED'});
    assert.equal(reader.cache.size,0);
  }finally{reader.close();}
});

/** 执行实际 UTS 展示代码，增删行数不由展示解析器生成。 */
test('差异展示正确还原双侧行号、代码中的头部字符和多次修改顺序',()=>{
  const source=fs.readFileSync('apps/mobile/services/file-reports.uts','utf8').replace(/\bexport /g,'');
  const context=vm.createContext({});vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.rows=fileDiffRows;',context);
  const rows=JSON.parse(JSON.stringify(context.rows(['diff --git a/demo b/demo\n--- a/demo\n+++ b/demo\n@@ -3,2 +5,2 @@\n---old\n+++new\n same\n\\ No newline at end of file\n','@@ -1 +1 @@\n-x\n+y\n'])));
  assert.deepEqual(rows.slice(1,4).map(({kind,oldLine,newLine,text})=>({kind,oldLine,newLine,text})),[{kind:'delete',oldLine:'3',newLine:'',text:'--old'},{kind:'add',oldLine:'',newLine:'5',text:'++new'},{kind:'context',oldLine:'4',newLine:'6',text:'same'}]);
  assert.match(rows[0].text,/修改 1/);assert.match(rows[5].text,/修改 2/);assert.equal(rows.some(row=>'additions'in row),false);
});

/** 执行卡片真实异步回调，旧报告回执不能覆盖后打开的报告。 */
test('卡片按报告隔离异步加载，无修改隐藏，断线和卸载后不接收迟到结果',async()=>{
  const code=fs.readFileSync('apps/mobile/components/file-change-summary/file-change-summary.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  const props={hostId:'host',threadId:'thread',reportId:'report',connected:true},watches=[],requests=[];let unmount;
  const context=vm.createContext({connection:{cacheNamespace:'pair'},readFileReportCache:()=>null,saveFileReportCache(){},nextTick:fn=>fn(),defineProps:()=>props,defineEmits:()=>()=>{},ref:value=>({value}),computed:fn=>({get value(){return fn();}}),watch:(source,callback,options)=>{watches.push({source,callback});if(options?.immediate)callback();},onUnmounted:fn=>{unmount=fn;},bridge:{request:()=>new Promise(resolve=>requests.push(resolve))}});
  context.fileChangePreferences = { expanded: true };
  vm.runInContext(stripTypeScriptTypes(code,{mode:'transform'})+';globalThis.ui={report,error,load};',context);
  props.reportId='new-report';watches[0].callback();requests[0]({report:{reportId:'report',files:[]}});await Promise.resolve();assert.equal(context.ui.report.value,null);
  requests[1]({report:null});await Promise.resolve();assert.equal(context.ui.report.value,null);
  context.ui.load();unmount();requests[2]({report:{reportId:'new-report',files:[]}});await Promise.resolve();assert.equal(context.ui.report.value,null);
});
