import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { NativeFileReportRuntime } from '../apps/bridge/native-report-runtime.mjs';
import { nativeReportCurrentLayout } from '../apps/bridge/native-report-current-layout.mjs';

const replace='@@ -1 +1 @@\n-old\n+new\n';
const change=(path,type,diff,move_path)=>({path,kind:{type,move_path},diff});
const pack=(...changes)=>[{cwd:'C:/work/example',changes}];

/** 合成计算器仅检验隔离边界。真实原生算法使用已校验的本机官方资源测试。 */
const fixtureFunctions=`
  if(typeof require!=='undefined'||typeof process!=='undefined'||typeof fetch!=='undefined'||
     typeof Buffer!=='undefined'||typeof encodeUtf8.constructor!=='undefined')throw new Error('宿主对象泄漏');
  let codeGenerationBlocked=false;
  try { Function('return 1')(); } catch { codeGenerationBlocked=true; }
  if(!codeGenerationBlocked)throw new Error('动态代码生成未封闭');
  return {
    convert(changes){return {[changes[0].path]:changes[0].diff};},
    serialize(record){return Object.values(record)[0];},
    parse(diff){return [{additions:diff.length,deletions:0,isBinary:false}];},
    summarize(parts){return {linesAdded:parts.reduce((n,p)=>n+p.additions,0),linesDeleted:0};},
  };
`;

/** 运行与生产相同的隔离器，给验证单独设置超时避免测试悬挂。 */
async function isolatedWorker(source,input) {
  const worker=new Worker(new URL('../apps/bridge/native-report-worker.mjs',import.meta.url),{workerData:{source,input:JSON.stringify(input)}});
  try {
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('测试工作线程未响应')),6000);
      worker.once('message',value=>{clearTimeout(timer);resolve(value);});
      worker.once('error',error=>{clearTimeout(timer);reject(error);});
      worker.once('exit',()=>{clearTimeout(timer);reject(new Error('测试工作线程提前退出'));});
    });
  } finally { await worker.terminate(); }
}

test('隔离器将代码状差异作为普通数据并封闭宿主对象和动态代码',async()=>{
  const code='\n"}); globalThis.process = require("node:fs"); throw new Error("泄漏"); //';
  const result=await isolatedWorker(fixtureFunctions,pack(change('src/demo.uts','update',code)));
  assert.ok(result.output);
  const report=JSON.parse(result.output);
  assert.equal(report.files[0].diffs[0],code);
  assert.equal(report.additions,code.length);
});

test('隔离器中止超时计算，错误响应不带代码或路径',async()=>{
  assert.deepEqual(await isolatedWorker('while (true) {}',[]),{error:true});
  assert.deepEqual(await isolatedWorker('throw new Error("合成私有路径");',[]),{error:true});
});

test('运行时拒绝不受信安装、超量差异及关闭后的调用',async()=>{
  const runtime=new NativeFileReportRuntime();
  const executable='C:/example/ChatGPT.exe';
  try {
    assert.equal(runtime.supports(executable),false);
    await assert.rejects(runtime.calculate(executable,pack(change('demo.uts','update',replace))),{code:'REPORT_UNAVAILABLE'});
    await assert.rejects(runtime.calculate(executable,pack(change('demo.uts','update','x'.repeat(1024*1024)))),{code:'REPORT_TOO_LARGE'});
    await assert.rejects(runtime.calculate(executable,[{changes:[{path:'demo.uts',kind:{type:'unknown'},diff:replace}]}]),{code:'BAD_REPORT'});
  } finally { runtime.close(); }
  assert.equal(runtime.supports(executable),false);
  await assert.rejects(runtime.calculate(executable,[]),{code:'REPORT_UNAVAILABLE',message:/已关闭/});
});

test('未知版本只读一次安装包，安装文件变化后重新核验', {skip:process.platform!=='win32'}, context=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'codex-report-fixture-'));
  const directories=['WindowsApps','OpenAI.Codex_example','app','resources'].map((_,index,parts)=>path.join(root,...parts.slice(0,index+1)));
  for(const directory of directories)fs.mkdirSync(directory);
  const executable=path.join(directories[2],'ChatGPT.exe');
  const archive=path.join(directories[3],'app.asar');
  fs.writeFileSync(executable,'');
  // 合成空索引只用于模拟没有已核验模块的新版本，不包含或执行任何模块。
  const header=Buffer.from('{"files":{}}');
  const prefix=Buffer.alloc(16);
  prefix.writeUInt32LE(header.length+8,4);
  prefix.writeUInt32LE(header.length,12);
  fs.writeFileSync(archive,Buffer.concat([prefix,header]));
  const open=fs.openSync;
  let archiveReads=0;
  const spy=context.mock.method(fs,'openSync',function(file,...args){
    if(file===archive)archiveReads++;
    return open.call(this,file,...args);
  });
  const runtime=new NativeFileReportRuntime();
  try {
    for(let i=0;i<10;i++)assert.equal(runtime.supports(executable),false);
    assert.equal(archiveReads,1);
    fs.appendFileSync(archive,'\n');
    const readsAfterWrite=archiveReads;
    for(let i=0;i<10;i++)assert.equal(runtime.supports(executable),false);
    assert.equal(archiveReads,readsAfterWrite+1);
  } finally {
    runtime.close();
    spy.mock.restore();
    fs.unlinkSync(archive);
    fs.unlinkSync(executable);
    for(const directory of directories.reverse())fs.rmdirSync(directory);
    fs.rmdirSync(root);
  }
});

const nativeExecutable=process.env.CODEX_TEST_NATIVE_REPORT_EXECUTABLE;

test('数字分块入口存在但字节未通过审核时仍拒绝执行', {skip:process.platform!=='win32'}, async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'codex-report-hash-'));
  const app=path.join(root,'WindowsApps','OpenAI.Codex_example','app');
  fs.mkdirSync(path.join(app,'resources'),{recursive:true});
  const executable=path.join(app,'ChatGPT.exe'),archive=path.join(app,'resources','app.asar');
  fs.writeFileSync(executable,'');
  // 仅合成索引和无效字节，验证存在相同入口也不能绕过完整哈希核验。
  const index={files:{}},segments=('webview/assets/'+nativeReportCurrentLayout.modules[0][0]).split('/');
  let cursor=index;
  for(const segment of segments.slice(0,-1))cursor=cursor.files[segment]={files:{}};
  cursor.files[segments.at(-1)]={size:1,offset:'0'};
  const header=Buffer.from(JSON.stringify(index)),prefix=Buffer.alloc(16);
  prefix.writeUInt32LE(header.length+8,4);prefix.writeUInt32LE(header.length,12);
  fs.writeFileSync(archive,Buffer.concat([prefix,header,Buffer.from('x')]));
  const runtime=new NativeFileReportRuntime();
  try {
    assert.equal(runtime.supports(executable),false);
    await assert.rejects(runtime.calculate(executable,pack(change('demo.uts','update',replace))),{code:'REPORT_UNAVAILABLE',message:/尚未适配.*更新连接服务/});
  } finally {
    runtime.close();
    // 只清理本测试刚创建并持有的明确临时路径。
    fs.unlinkSync(archive);fs.unlinkSync(executable);
    for(const directory of [path.join(app,'resources'),app,path.dirname(app),path.dirname(path.dirname(app)),root])fs.rmdirSync(directory);
  }
});
test('固定版本官方安装包可离线生成原生文件汇总', {skip:!nativeExecutable}, async()=>{
  const runtime=new NativeFileReportRuntime();
  try {
    assert.equal(runtime.supports(nativeExecutable),true);
    const changes=pack(change('src/合成.uts','add','一\r\n二\r\n'),change('src/合成.uts','update',replace),
      change('src/旧.uts','delete','旧\n'),change('old.uts','update',replace,'new.uts'),
      change('image.png','update','diff --git a/image.png b/image.png\nindex 1234567..89abcde 100644\nBinary files a/image.png and b/image.png differ\n'));
    const [report,concurrent]=await Promise.all([runtime.calculate(nativeExecutable,changes),runtime.calculate(nativeExecutable,changes)]);
    assert.deepEqual(report,concurrent);
    assert.equal(report.additions,4);
    assert.equal(report.deletions,3);
    assert.deepEqual(report.files.map(({path,kind,additions,deletions,binary})=>({path,kind,additions,deletions,binary})),[
      {path:'src/合成.uts',kind:'add',additions:3,deletions:1,binary:false},
      {path:'src/旧.uts',kind:'delete',additions:0,deletions:1,binary:false},
      {path:'new.uts',kind:'update',additions:1,deletions:1,binary:false},
      {path:'image.png',kind:'update',additions:0,deletions:0,binary:true},
    ]);
    assert.equal(report.files[0].diffs.length,2);
    const quotedPath='"a/src/\\345\\220\\210.txt"';
    const targetPath=quotedPath.replace('a/','b/');
    const quotedDiff=`diff --git ${quotedPath} ${targetPath}\n--- ${quotedPath}\n+++ ${targetPath}\n@@ -1 +1 @@\n-old\n+new\n`;
    const quoted=await runtime.calculate(nativeExecutable,pack(change('src/合.txt','update',quotedDiff)));
    assert.equal(quoted.additions,1);
    assert.equal(quoted.deletions,1);
    const data='"}); globalThis.process = require("node:fs"); //';
    const injection=await runtime.calculate(nativeExecutable,pack(change('safe.uts','update',`@@ -1 +1 @@\n-old\n+${data}\n`)));
    assert.equal(injection.additions,1);
    assert.ok(injection.files[0].diffs[0].includes(data));
    const pending=runtime.calculate(nativeExecutable,pack(change('closing.uts','update',replace)));
    runtime.close();
    await assert.rejects(pending,{code:'REPORT_UNAVAILABLE'});
  } finally { runtime.close(); }
});
