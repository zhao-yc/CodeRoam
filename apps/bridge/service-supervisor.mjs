import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {lifecycleEvent} from './service-lifecycle.mjs';
import {acquireRuntimeLock} from './runtime-lock.mjs';
import {readManagedConfig} from './management-config.mjs';
import {startManagementServer} from './management-server.mjs';
import {randomUUID} from 'node:crypto';

/** 原账号下的单实例守护进程；只启动固定 Node 入口，不重放任何手机请求。 */
export async function supervise(config,{restartMs=5000,workerConfigPath=null}={}) {
  const {entry,bridgeConfig,projectRoot,runDirectory,statusFile,logDirectory}=config;
  for(const file of [entry,bridgeConfig])if(!path.isAbsolute(file)||!fs.existsSync(file))throw new Error('固定桥接入口或配置不存在');
  fs.mkdirSync(logDirectory,{recursive:true});fs.mkdirSync(runDirectory,{recursive:true});
  const log=path.join(logDirectory,'lifecycle.jsonl'),stateFile=path.join(logDirectory,'supervisor.json');
  const release=await acquireRuntimeLock(path.join(fs.realpathSync.native(logDirectory),'supervisor'));
  let child=null,timer=null,stopping=false,attempt=0,startedAt=0,activeRevision='',management=null,restarting=false,manualRestart=false,changingSync=false;
  const pending=new Map();
  const save=extra=>fs.writeFileSync(stateFile,JSON.stringify({supervisorPid:process.pid,childPid:child?.pid??null,entry,updatedAt:Date.now(),...extra}));
  const event=(name,data={})=>lifecycleEvent(log,name,data);
  /** 父子 IPC 只接受本次随机编号的响应，不把手机协议映射成本机管理操作。 */
  function askChild(action,timeoutMs=5000,params={}) {
    const target=child;
    if(!target?.connected||!target.managementReady)return Promise.reject(Object.assign(new Error('桥接尚未准备好接受管理操作'),{code:'MANAGEMENT_NOT_READY'}));
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(requestId);reject(Object.assign(new Error('桥接管理操作响应超时'),{code:'MANAGEMENT_TIMEOUT'}));},timeoutMs);
      pending.set(requestId,{resolve,reject,timer,target});
      target.send({type:'codex-mobile-management',requestId,action,...params},error=>{if(error){const item=pending.get(requestId);if(item){clearTimeout(item.timer);pending.delete(requestId);reject(Object.assign(new Error('桥接管理通道不可用'),{code:'MANAGEMENT_NOT_READY'}));}}});
    });
  }
  /** 只展示结构化状态，不能把原运行文件里的未知字段或凭据透传界面。 */
  async function status() {
    const saved=readManagedConfig(bridgeConfig);let runtime={},childConfirmed=false;
    try {runtime=JSON.parse(fs.readFileSync(statusFile,'utf8'));}catch{}
    if(child?.managementReady)try{runtime=await askChild('status',2000);childConfirmed=true;}catch{}
    const valid=runtime.pid===child?.pid;
    return {running:!!child&&child.exitCode===null,connected:valid&&runtime.connected===true,pid:child?.pid??null,supervisorPid:process.pid,version:valid&&typeof runtime.version==='string'?runtime.version:'0.1.0',activeRevision,savedRevision:saved.revision,restartRequired:activeRevision!==saved.revision,maintenance:valid&&runtime.maintenance&&typeof runtime.maintenance==='object'?Object.fromEntries(Object.entries(runtime.maintenance).filter(([key,value])=>['online','grace','light','legacy'].includes(key)&&Number.isSafeInteger(value)&&value>=0)):{},instances:valid&&Array.isArray(runtime.instances)?runtime.instances.slice(0,50).filter(item=>item&&typeof item.label==='string').map(item=>({label:item.label.slice(0,100),ready:item.ready===true})):[],configPath:bridgeConfig,
      ...(childConfirmed&&valid&&typeof runtime.backgroundSyncEnabled==='boolean'?{backgroundSyncEnabled:runtime.backgroundSyncEnabled}:{})};
  }
  /** 开关与受控重启互斥，确认以当前桥接进程的回执为准。 */
  async function setBackgroundSync(enabled) {
    if (changingSync || restarting || manualRestart || stopping) {
      throw Object.assign(new Error('后台服务正在处理管理操作，请稍后重试'), {code:'MANAGEMENT_BUSY'});
    }
    changingSync = true;
    try { return await askChild('set-sync', 12000, {enabled}); }
    finally { changingSync = false; }
  }
  /** 有在途操作时取消排空；仅收到子进程明确可退出的确认后请求正常关闭。 */
  async function restart() {
    if(restarting||changingSync||stopping)throw Object.assign(new Error('服务正在处理管理操作，请稍后再试'),{code:'MANAGEMENT_BUSY'});
    restarting=true;
    try {
      event('management_restart_requested');
      await askChild('prepare-restart');manualRestart=true;
      await askChild('shutdown',10000);
      return {accepted:true,restarting:true};
    }catch(error){if(error.code==='MANAGEMENT_RESTARTING')return {accepted:true,restarting:true,warning:'关闭过程未完整确认，服务正在恢复'};manualRestart=false;try{await askChild('cancel-restart',2000);}catch{}event('management_restart_rejected');throw error;}
    finally{restarting=false;}
  }
  /** 只在下次启动时轮换本项目日志，防止长期运行无限增长。 */
  function rotate(file) {if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024){if(fs.existsSync(file+'.2'))fs.unlinkSync(file+'.2');if(fs.existsSync(file+'.1'))fs.renameSync(file+'.1',file+'.2');fs.renameSync(file,file+'.1');}}
  function start() {
    if(stopping)return;
    activeRevision=readManagedConfig(bridgeConfig).revision;
    rotate(log);const stdout=path.join(runDirectory,'bridge.stdout.log'),stderr=path.join(runDirectory,'bridge.stderr.log');rotate(stdout);rotate(stderr);
    const out=fs.openSync(stdout,'a'),err=fs.openSync(stderr,'a');
    startedAt=Date.now();
    const launched=spawn(process.execPath,['--import',pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),'service-lifecycle.mjs')).href,entry,'--config',bridgeConfig],{
      cwd:projectRoot,windowsHide:true,stdio:['ignore',out,err,'ipc'],env:{...process.env,CODEX_BRIDGE_LIFECYCLE_LOG:log},
    });
    fs.closeSync(out);fs.closeSync(err);child=launched;
    launched.on('message',message=>{
      if(message?.type!=='codex-mobile-management')return;
      if(message.action==='ready'){launched.managementReady=true;return;}
      const item=pending.get(message.requestId);if(!item||item.target!==launched)return;
      clearTimeout(item.timer);pending.delete(message.requestId);
      message.error?item.reject(Object.assign(new Error(message.error.message??'桥接尚未结束在途操作'),{code:message.error.code??'MANAGEMENT_BUSY'})):item.resolve(message.result);
    });
    launched.once('spawn',()=>{fs.writeFileSync(path.join(runDirectory,'bridge.json'),JSON.stringify({pid:launched.pid,marker:entry,supervised:true,supervisorPid:process.pid}));event('bridge_spawned',{childPid:launched.pid,attempt});save({state:'running'});});
    launched.once('error',error=>event('bridge_spawn_failed',{errorCode:/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'SPAWN_ERROR'}));
    launched.once('close',(code,signal)=>{
      for(const[id,item]of pending)if(item.target===launched){clearTimeout(item.timer);pending.delete(id);item.reject(Object.assign(new Error('桥接进程已经退出'),{code:'MANAGEMENT_NOT_READY'}));}
      event('bridge_observed_exit',{childPid:launched.pid??null,exitCode:code,signal:signal??null,planned:stopping,uptimeMs:Date.now()-startedAt});
      try {const status=JSON.parse(fs.readFileSync(statusFile,'utf8'));if(status.pid===launched.pid)fs.writeFileSync(statusFile,JSON.stringify({...status,connected:false,updatedAt:Date.now(),exitCode:code,signal:signal??null}));}catch{}
      child=null;if(stopping){save({state:'stopped'});release();return;}
      attempt=Date.now()-startedAt>60000?0:attempt+1;
      const delay=manualRestart?0:Math.min(30000,restartMs*Math.max(1,Math.min(attempt,6)));manualRestart=false;
      save({state:'restarting',exitCode:code,nextRestartAt:Date.now()+delay});event('bridge_restart_scheduled',{delayMs:delay});timer=setTimeout(start,delay);
    });
  }
  /** 停止守护时仅终止其子桥接；系统服务的 Job Object 另保证无孤儿进程。 */
  function stop() {if(stopping)return;stopping=true;management?.close();clearTimeout(timer);event('supervisor_stopping');if(child)child.kill();else{save({state:'stopped'});release();}}
  process.once('SIGTERM',stop);process.once('SIGINT',stop);process.once('exit',release);
  try{management=await startManagementServer({worker:config,workerConfigPath,status,restart,setBackgroundSync});}
  catch(error){release();throw error;}
  try{event('supervisor_started',{parentPid:process.ppid});start();}
  catch(error){management.close();release();throw error;}
  return{stop};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{config:{type:'string'}}});
  if(!values.config)throw new Error('缺少守护配置');
  await supervise(JSON.parse(fs.readFileSync(values.config,'utf8').replace(/^\uFEFF/,'')),{workerConfigPath:path.resolve(values.config)});
}
