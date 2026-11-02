import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {lifecycleEvent} from './service-lifecycle.mjs';
import {acquireRuntimeLock} from './runtime-lock.mjs';

/** 原账号下的单实例守护进程；只启动固定 Node 入口，不重放任何手机请求。 */
export async function supervise(config,{restartMs=5000}={}) {
  const {entry,bridgeConfig,projectRoot,runDirectory,statusFile,logDirectory}=config;
  for(const file of [entry,bridgeConfig])if(!path.isAbsolute(file)||!fs.existsSync(file))throw new Error('固定桥接入口或配置不存在');
  fs.mkdirSync(logDirectory,{recursive:true});fs.mkdirSync(runDirectory,{recursive:true});
  const log=path.join(logDirectory,'lifecycle.jsonl'),stateFile=path.join(logDirectory,'supervisor.json');
  const release=await acquireRuntimeLock(path.join(fs.realpathSync.native(logDirectory),'supervisor'));
  let child=null,timer=null,stopping=false,attempt=0,startedAt=0;
  const save=extra=>fs.writeFileSync(stateFile,JSON.stringify({supervisorPid:process.pid,childPid:child?.pid??null,entry,updatedAt:Date.now(),...extra}));
  const event=(name,data={})=>lifecycleEvent(log,name,data);
  /** 只在下次启动时轮换本项目日志，防止长期运行无限增长。 */
  function rotate(file) {if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024){if(fs.existsSync(file+'.2'))fs.unlinkSync(file+'.2');if(fs.existsSync(file+'.1'))fs.renameSync(file+'.1',file+'.2');fs.renameSync(file,file+'.1');}}
  function start() {
    if(stopping)return;
    rotate(log);const stdout=path.join(runDirectory,'bridge.stdout.log'),stderr=path.join(runDirectory,'bridge.stderr.log');rotate(stdout);rotate(stderr);
    const out=fs.openSync(stdout,'a'),err=fs.openSync(stderr,'a');
    startedAt=Date.now();
    const launched=spawn(process.execPath,['--import',pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),'service-lifecycle.mjs')).href,entry,'--config',bridgeConfig],{
      cwd:projectRoot,windowsHide:true,stdio:['ignore',out,err,'ipc'],env:{...process.env,CODEX_BRIDGE_LIFECYCLE_LOG:log},
    });
    fs.closeSync(out);fs.closeSync(err);child=launched;
    launched.once('spawn',()=>{fs.writeFileSync(path.join(runDirectory,'bridge.json'),JSON.stringify({pid:launched.pid,marker:entry,supervised:true,supervisorPid:process.pid}));event('bridge_spawned',{childPid:launched.pid,attempt});save({state:'running'});});
    launched.once('error',error=>event('bridge_spawn_failed',{errorCode:/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'SPAWN_ERROR'}));
    launched.once('close',(code,signal)=>{
      event('bridge_observed_exit',{childPid:launched.pid??null,exitCode:code,signal:signal??null,planned:stopping,uptimeMs:Date.now()-startedAt});
      try {const status=JSON.parse(fs.readFileSync(statusFile,'utf8'));if(status.pid===launched.pid)fs.writeFileSync(statusFile,JSON.stringify({...status,connected:false,updatedAt:Date.now(),exitCode:code,signal:signal??null}));}catch{}
      child=null;if(stopping){save({state:'stopped'});release();return;}
      attempt=Date.now()-startedAt>60000?0:attempt+1;
      const delay=Math.min(30000,restartMs*Math.max(1,Math.min(attempt,6)));
      save({state:'restarting',exitCode:code,nextRestartAt:Date.now()+delay});event('bridge_restart_scheduled',{delayMs:delay});timer=setTimeout(start,delay);
    });
  }
  /** 停止守护时仅终止其子桥接；系统服务的 Job Object 另保证无孤儿进程。 */
  function stop() {if(stopping)return;stopping=true;clearTimeout(timer);event('supervisor_stopping');if(child)child.kill();else{save({state:'stopped'});release();}}
  process.once('SIGTERM',stop);process.once('SIGINT',stop);process.once('exit',release);
  event('supervisor_started',{parentPid:process.ppid});start();return{stop};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{config:{type:'string'}}});
  if(!values.config)throw new Error('缺少守护配置');
  await supervise(JSON.parse(fs.readFileSync(values.config,'utf8').replace(/^\uFEFF/,'')));
}
