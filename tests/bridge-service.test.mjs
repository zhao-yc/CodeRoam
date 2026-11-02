import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {acquireBridgeLock} from '../apps/bridge/runtime-lock.mjs';

/** 在隔离目录启动真实子进程，绝不终止项目正在使用的桥接。 */
function fixture(t,body) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-service-test-'));
  const logs=path.join(root,'logs'),run=path.join(root,'run');fs.mkdirSync(logs);fs.mkdirSync(run);
  const entry=path.join(root,'fixture.mjs'),configFile=path.join(root,'worker.json');fs.writeFileSync(entry,body);fs.writeFileSync(path.join(root,'bridge.json'),'{}');
  const config={entry,bridgeConfig:path.join(root,'bridge.json'),projectRoot:root,runDirectory:run,statusFile:path.join(root,'runtime-status.json'),logDirectory:logs};fs.writeFileSync(configFile,JSON.stringify(config));
  const state=()=>{try{return JSON.parse(fs.readFileSync(path.join(logs,'supervisor.json'),'utf8'))}catch{return null}};
  const records=()=>{try{return fs.readFileSync(path.join(logs,'lifecycle.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};
  const processes=[];
  function launch() {
    const code=`import fs from 'node:fs';import {supervise} from ${JSON.stringify(pathToFileURL(path.resolve('apps/bridge/service-supervisor.mjs')).href)};supervise(JSON.parse(fs.readFileSync(process.argv[1],'utf8')),{restartMs:100});`;
    const child=spawn(process.execPath,['--input-type=module','-e',code,configFile],{windowsHide:true,stdio:'ignore'});processes.push(child);return child;
  }
  t.after(async()=>{
    const childPid=state()?.childPid;
    for(const p of processes)if(p.exitCode===null){p.kill();await new Promise(resolve=>{p.once('close',resolve);setTimeout(resolve,1000).unref();});}
    // 子进程编号只来自本测试创建的隔离状态；Windows 强制结束父进程不会自动结束子进程。
    if(childPid)try{process.kill(childPid)}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  return {root,logs,run,state,records,launch};
}
async function until(check) {const deadline=Date.now()+8000;while(Date.now()<deadline){if(check())return;await new Promise(resolve=>setTimeout(resolve,40));}assert.fail('隔离守护进程未在截止时间达到预期状态');}

test('桥接非零退出自动重启，记录退出码，真实旧状态同步改为离线',async t=>{
  const f=fixture(t,`import fs from 'node:fs';const countFile='count';const count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile)):0;fs.writeFileSync(countFile,String(count+1));if(count===0){fs.writeFileSync('runtime-status.json',JSON.stringify({pid:process.pid,connected:true}));process.exit(42)}setInterval(()=>{},1000);`);
  f.launch();await until(()=>f.records().some(e=>e.event==='bridge_observed_exit'&&e.exitCode===42)&&f.records().filter(e=>e.event==='bridge_spawned').length===2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'runtime-status.json'))).connected,false);
  assert.ok(f.state().childPid);assert.equal(JSON.parse(fs.readFileSync(path.join(f.run,'bridge.json'))).supervised,true);
  assert.ok(f.records().some(e=>e.event==='bridge_restart_scheduled'&&e.delayMs===100));
});

test('意外零退出同样恢复，停止消息不被当成重发手机指令',async t=>{
  const f=fixture(t,`import fs from 'node:fs';if(!fs.existsSync('once')){fs.writeFileSync('once','1');process.exit(0)}setInterval(()=>{},1000);`);
  f.launch();await until(()=>f.records().filter(e=>e.event==='bridge_spawned').length===2);
  assert.ok(f.records().some(e=>e.event==='bridge_observed_exit'&&e.exitCode===0&&!e.planned));
});

test('异常预加载保留异常类型，生命周期日志不记录异常正文或敏感值',async t=>{
  const f=fixture(t,`throw Object.assign(new Error('不可记录的测试私密文本'),{code:'TEST_FAILURE'});`);
  f.launch();await until(()=>f.records().some(e=>e.event==='bridge_fatal'));
  const event=f.records().find(e=>e.event==='bridge_fatal');assert.equal(event.errorType,'Error');assert.equal(event.errorCode,'TEST_FAILURE');
  assert.equal(fs.readFileSync(path.join(f.logs,'lifecycle.jsonl'),'utf8').includes('不可记录的测试私密文本'),false);
});

test('第二个守护拒绝抢占已有实例，原桥接和进程登记保持不变',async t=>{
  const f=fixture(t,'setInterval(()=>{},1000);');f.launch();await until(()=>f.state()?.childPid);
  const before=f.state();const duplicate=f.launch();await new Promise(resolve=>duplicate.once('close',resolve));
  assert.notEqual(duplicate.exitCode,0);assert.equal(f.state().childPid,before.childPid);assert.equal(f.records().filter(e=>e.event==='supervisor_started').length,1);
});

test('直接CLI在打开账本前拒绝第二实例，原账本内容保持不变',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-cli-lock-')),config=path.join(root,'bridge.json'),database=path.join(root,'journal.sqlite');
  fs.writeFileSync(config,JSON.stringify({dataPath:root}));fs.writeFileSync(database,'原账本不可修改');
  const release=await acquireBridgeLock(config);
  t.after(()=>{release();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  const child=spawn(process.execPath,['apps/bridge/cli.mjs','--config',config],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',data=>output+=data);
  await new Promise(resolve=>child.once('close',resolve));assert.equal(child.exitCode,1);assert.match(output,/已有桥接/);assert.equal(fs.readFileSync(database,'utf8'),'原账本不可修改');
});
