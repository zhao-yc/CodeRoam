import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const source=name=>fs.readFileSync('apps/mobile/services/'+name+'.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
const file={id:'file-a',path:'src/example.uts',kind:'update',additions:1,deletions:1,binary:false};
const report=(revision='one')=>({reportId:'report',revision,fileCount:1,additions:1,deletions:1,files:[{...file}]});
const detail=(text='new')=>({...file,diffs:['@@ -1 +1 @@\n-old\n+'+text+'\n']});
const object=value=>({...value,getString(key){return this[key]??null;}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

/** 使用真实存储逻辑和合成差异，重新建 VM 模拟应用重启。 */
function fixture(storage=new Map()) {
  let time=0;
  const uni={getStorageSync:key=>storage.get(key)??'',setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key)};
  const context=vm.createContext({uni,reactive:value=>value,Date:{now:()=>++time},setTimeout,clearTimeout});
  vm.runInContext(stripTypeScriptTypes(source('file-report-cache'),{mode:'transform'})+';globalThis.api={readFileReportCache,saveFileReportCache,saveFileReportDetailCache,clearFileReportCache,retainFileReportCacheHosts};',context);
  vm.runInContext(stripTypeScriptTypes(source('file-change-preferences'),{mode:'transform'})+';globalThis.preferences={fileChangePreferences,setFileChangesExpanded};',context);
  return {context,storage,uni,...context.api,...context.preferences};
}

test('已读取的汇总和完整代码差异在重启后恢复，未读取文件不预取',()=>{
  const f=fixture();assert.equal(f.saveFileReportCache('pair','pc','thread','report',report()),true);assert.equal(f.saveFileReportDetailCache('pair','pc','thread',report(),detail()),true);
  const reopened=fixture(f.storage).readFileReportCache('pair','pc','thread','report');assert.equal(reopened.report.revision,'one');assert.equal(reopened.details[0].diffs[0],detail().diffs[0]);assert.equal(reopened.details.length,1);
});

test('报告换代立即清除旧差异，迟到的旧详情和未列出的文件不能覆盖新报告',()=>{
  const f=fixture();f.saveFileReportCache('pair','pc','thread','report',report());f.saveFileReportDetailCache('pair','pc','thread',report(),detail());
  f.saveFileReportCache('pair','pc','thread','report',report('two'));assert.equal(f.readFileReportCache('pair','pc','thread','report').details.length,0);
  assert.equal(f.saveFileReportDetailCache('pair','pc','thread',report(),detail()),false);assert.equal(f.saveFileReportDetailCache('pair','pc','thread',report('two'),{...detail(),id:'other'}),false);
  f.saveFileReportCache('pair','pc','thread','report',null);assert.equal(f.readFileReportCache('pair','pc','thread','report').report,null);assert.equal(f.saveFileReportDetailCache('pair','pc','thread',report('two'),detail()),false);
});

test('配对、电脑、聊天和报告隔离，归档删除与撤回授权清理相应内容',()=>{
  const f=fixture();for(const host of ['pc','other'])for(const thread of ['thread','other'])f.saveFileReportCache('pair',host,thread,'report',report());
  assert.equal(f.readFileReportCache('new','pc','thread','report'),null);assert.equal(f.readFileReportCache('pair','pc','thread','other'),null);
  f.clearFileReportCache('pair','pc',['thread']);assert.equal(f.readFileReportCache('pair','pc','thread','report'),null);assert.ok(f.readFileReportCache('pair','pc','other','report'));assert.ok(f.readFileReportCache('pair','other','thread','report'));
  f.retainFileReportCacheHosts('pair',['pc']);assert.equal(f.readFileReportCache('pair','other','thread','report'),null);
  f.saveFileReportCache('new','pc','thread','report',report());f.clearFileReportCache('pair');assert.ok(f.readFileReportCache('new','pc','thread','report'));f.clearFileReportCache('new');assert.equal(f.storage.size,0);
});

test('缓存容量有界，完整差异过大时放弃缓存而非截断，仍保留汇总',()=>{
  const f=fixture();f.saveFileReportCache('pair','pc','thread','report',report());f.saveFileReportDetailCache('pair','pc','thread',report(),detail('长'.repeat(160000)));
  const cached=f.readFileReportCache('pair','pc','thread','report');assert.equal(cached.report.fileCount,1);assert.equal(cached.details.length,0);
  for(let i=0;i<42;i++)f.saveFileReportCache('pair','pc','thread-'+i,'report',report());assert.equal(f.readFileReportCache('pair','pc','thread-0','report'),null);assert.ok(f.readFileReportCache('pair','pc','thread-41','report'));
  assert.ok([...f.storage.values()][0].length*2<=1024*1024);
});

test('损坏、旧格式、禁用存储与实际配额不足均不抛出原始异常',()=>{
  for(const raw of ['{损坏',JSON.stringify({version:2,namespace:'pair',entries:[]}),JSON.stringify({version:1,namespace:'pair',entries:[{}]})]){const f=fixture(new Map([['codex-mobile-file-reports-v1',raw]]));assert.equal(f.readFileReportCache('pair','pc','thread','report'),null);}
  const f=fixture();f.uni.getStorageSync=()=>{throw Error('私有读取错误');};assert.equal(f.readFileReportCache('pair','pc','thread','report'),null);f.uni.setStorageSync=()=>{throw Error('配额不足');};assert.equal(f.saveFileReportCache('pair','pc','thread','report',report()),false);
});

/** 执行实际组件脚本，单独控制 PC 回执；缓存先显示且旧请求不能串到新配对。 */
function component(kind,storage=new Map(),connected=true) {
  const f=fixture(storage),watches=[],mounts=[],requests=[];let unload;
  const props={hostId:'pc',threadId:'thread',reportId:'report',report:report(),fileId:'file-a',connected};
  const connection={cacheNamespace:'pair'};
  Object.assign(f.context,{connection,defineProps:()=>props,defineEmits:()=>()=>{},ref:value=>({value}),computed:fn=>({get value(){return fn();}}),nextTick:fn=>fn(),onMounted:fn=>mounts.push(fn),onUnmounted:fn=>{unload=fn;},watch:(read,callback,options)=>{watches.push({read,callback});if(options?.immediate)callback();},bridge:{request:(method,params)=>new Promise((resolve,reject)=>requests.push({method,params,resolve,reject}))}});
  vm.runInContext(stripTypeScriptTypes(source('file-reports'),{mode:'transform'}),f.context);
  const name=kind==='summary'?'file-change-summary':'file-change-sheet';
  const code=fs.readFileSync('apps/mobile/components/'+name+'/'+name+'.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  vm.runInContext(stripTypeScriptTypes(code,{mode:'transform'})+';globalThis.ui='+ (kind==='summary'?'{report,error,load,expanded,toggleSummary}':'{detailFor,errorFor,loadFile,loaded}')+';',f.context);mounts.forEach(fn=>fn());
  return {...f,ui:f.context.ui,props,connection,watches,requests,unload:()=>unload()};
}

test('文件汇总沿用已保存的默认状态，手动展开不改偏好，换报告后恢复默认', async () => {
  const f = fixture();
  assert.equal(f.fileChangePreferences.expanded, true);
  f.setFileChangesExpanded(false);
  const card = component('summary', f.storage);
  assert.equal(card.ui.expanded.value, false);
  card.ui.toggleSummary();
  card.requests[0].resolve(object({ report: report('updated') }));
  await tick();
  assert.equal(card.ui.expanded.value, true);
  assert.equal(card.fileChangePreferences.expanded, false);

  card.props.reportId = 'other-report';
  card.watches[0].callback();
  assert.equal(card.ui.expanded.value, false);
  card.setFileChangesExpanded(true);
  const preferenceWatch = card.watches.find(watch => watch.read.toString().includes('fileChangePreferences'));
  preferenceWatch.callback(preferenceWatch.read());
  assert.equal(card.ui.expanded.value, true);
  assert.equal(component('summary', f.storage, false).ui.expanded.value, true);
});

test('卡片先恢复本地汇总，随后 PC 新版覆盖缓存；失败和断线不清空可读汇总',async()=>{
  const f=fixture();f.saveFileReportCache('pair','pc','thread','report',report());const c=component('summary',f.storage);
  assert.equal(c.ui.report.value.revision,'one');assert.equal(c.requests.length,1);c.requests[0].resolve(object({report:report('two')}));await tick();assert.equal(c.ui.report.value.revision,'two');assert.equal(c.readFileReportCache('pair','pc','thread','report').report.revision,'two');
  const failed=component('summary',f.storage);failed.requests[0].reject(Error('合成超时'));await tick();assert.equal(failed.ui.report.value.revision,'two');
  const offline=component('summary',f.storage,false);assert.equal(offline.requests.length,0);assert.equal(offline.ui.report.value.revision,'two');offline.props.connected=true;offline.watches[1].callback(true);assert.equal(offline.requests.length,1);
});

test('汇总确认无修改后清空卡片及旧差异，配对变化或卸载后的回执不写缓存',async()=>{
  const f=fixture();f.saveFileReportCache('pair','pc','thread','report',report());const c=component('summary',f.storage);c.connection.cacheNamespace='new';c.requests[0].resolve(object({report:report('two')}));await tick();assert.equal(c.readFileReportCache('new','pc','thread','report'),null);assert.equal(c.readFileReportCache('pair','pc','thread','report').report.revision,'one');
  const gone=component('summary',f.storage);gone.unload();gone.requests[0].resolve(object({report:report('two')}));await tick();assert.equal(gone.readFileReportCache('pair','pc','thread','report').report.revision,'one');
  const empty=component('summary',f.storage);empty.requests[0].resolve(object({report:null}));await tick();assert.equal(empty.ui.report.value,null);assert.equal(empty.readFileReportCache('pair','pc','thread','report').report,null);
});

test('重新打开差异面板先显示已缓存代码，再更新 PC 正文；断线也可查看已读差异',async()=>{
  const f=fixture();f.saveFileReportCache('pair','pc','thread','report',report());f.saveFileReportDetailCache('pair','pc','thread',report(),detail('cached'));
  const c=component('sheet',f.storage);assert.ok(c.ui.detailFor('file-a').diffs[0].includes('cached'));assert.equal(c.requests.length,1);c.requests[0].resolve(object({revision:'one',file:detail('updated')}));await tick();assert.ok(c.ui.detailFor('file-a').diffs[0].includes('updated'));assert.equal(c.ui.loaded.value.length,1);
  const offline=component('sheet',f.storage,false);assert.equal(offline.requests.length,0);assert.ok(offline.ui.detailFor('file-a').diffs[0].includes('updated'));
  const stale=component('sheet',f.storage);stale.requests[0].resolve(object({revision:'two',file:detail('wrong revision')}));await tick();assert.equal(stale.ui.detailFor('file-a'),null);assert.match(stale.ui.errorFor('file-a'),/已更新/);
});

test('应用级清理在明确撤权和换配对后删除已读差异，普通离线保留内容',()=>{
  const f=fixture(),watchers=[],connection={cacheNamespace:'pair',connected:false,computers:[]};
  Object.assign(f.context,{connection,watch:(read,callback)=>watchers.push({read,callback})});
  vm.runInContext(stripTypeScriptTypes(source('conversation-cache-lifecycle'),{mode:'transform'})+';startConversationCacheLifecycle();',f.context);
  f.saveFileReportCache('pair','pc','thread','report',report());f.saveFileReportCache('pair','other','thread','report',report());
  watchers[1].callback();assert.ok(f.readFileReportCache('pair','other','thread','report'));
  connection.connected=true;connection.computers=[{id:'pc',online:false}];watchers[1].callback();
  assert.ok(f.readFileReportCache('pair','pc','thread','report'));assert.equal(f.readFileReportCache('pair','other','thread','report'),null);
  watchers[0].callback('new','pair');assert.equal(f.readFileReportCache('pair','pc','thread','report'),null);
});
