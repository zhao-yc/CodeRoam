import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** 内核管道拥有权随进程退出释放，不依赖可能残缺或 PID 被复用的锁文件。 */
export function acquireRuntimeLock(identity) {
  const key=createHash('sha256').update(process.platform==='win32'?identity.toLowerCase():identity).digest('hex').slice(0,32);
  const address=process.platform==='win32'?'\\\\.\\pipe\\codex-mobile-'+key:process.platform==='linux'?'\0codex-mobile-'+key:path.join(path.dirname(identity),'.codex-lock-'+key+'.sock');
  const server=net.createServer(socket=>socket.destroy());
  return new Promise((resolve,reject)=>{
    server.once('error',()=>reject(Object.assign(new Error('已有桥接或守护进程正在使用此运行目录'),{code:'BRIDGE_ALREADY_RUNNING'})));
    server.listen(address,()=>{let released=false;resolve(()=>{if(!released){released=true;server.close();}});});
  });
}

/** 在构造账本之前对同一数据目录排他，直接 CLI 和托管启动共用同一道保护。 */
export function acquireBridgeLock(configFile) {
  const config=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
  const directory=path.resolve(config.dataPath??'.local/bridge');fs.mkdirSync(directory,{recursive:true});
  const real=fs.realpathSync.native(directory);
  return acquireRuntimeLock(path.join(process.platform==='win32'?real.toLowerCase():real,'journal.sqlite'));
}
