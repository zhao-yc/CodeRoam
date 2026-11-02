import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Mac 使用短的用户专属目录，避免项目路径或系统临时目录超过 Unix 套接字长度。 */
function macLockDirectory() {
  const uid=process.getuid(),directory=path.join('/private/tmp','codex-mobile-'+uid);
  try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const info=fs.lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid||(info.mode&0o077)!==0)throw new Error('运行锁目录权限无效');
  return directory;
}

/** 只清理当前用户拥有且确认无监听者的旧套接字，不通过 PID 猜测锁的有效性。 */
async function removeStaleSocket(address) {
  const before=fs.lstatSync(address);
  if(!before.isSocket()||before.uid!==process.getuid())return false;
  const refused=await new Promise(resolve=>{
    const probe=net.createConnection(address),timer=setTimeout(()=>{probe.destroy();resolve(false);},1000);
    probe.once('connect',()=>{clearTimeout(timer);probe.destroy();resolve(false);});
    probe.once('error',error=>{clearTimeout(timer);probe.destroy();resolve(error.code==='ECONNREFUSED');});
  });
  if(!refused)return false;
  const current=fs.lstatSync(address);
  if(current.ino!==before.ino||current.dev!==before.dev||!current.isSocket())return false;
  fs.unlinkSync(address);return true;
}

/** 使用内核通道排他；Mac 异常退出留下的路径须确认失效后再回收。 */
export async function acquireRuntimeLock(identity) {
  const key=createHash('sha256').update(process.platform==='win32'?identity.toLowerCase():identity).digest('hex').slice(0,32);
  const address=process.platform==='win32'?'\\\\.\\pipe\\codex-mobile-'+key:process.platform==='linux'?'\0codex-mobile-'+key:path.join(process.platform==='darwin'?macLockDirectory():path.dirname(identity),'.codex-lock-'+key+'.sock');
  for(let attempt=0;attempt<2;attempt++) {
    const server=net.createServer(socket=>socket.destroy());
    try {
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve);});
      let released=false;return()=>{if(!released){released=true;server.close();}};
    } catch(error) {
      if(error.code==='EADDRINUSE'&&process.platform==='darwin'&&attempt===0&&await removeStaleSocket(address).catch(()=>false))continue;
      const occupied=error.code==='EADDRINUSE';
      throw Object.assign(new Error(occupied?'已有桥接或守护进程正在使用此运行目录':'运行锁不可用，请检查本机目录权限及套接字配置'),{code:occupied?'BRIDGE_ALREADY_RUNNING':'BRIDGE_LOCK_UNAVAILABLE'});
    }
  }
}

/** 在构造账本之前对同一数据目录排他，直接 CLI 和托管启动共用同一道保护。 */
export function acquireBridgeLock(configFile) {
  const config=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
  const directory=path.resolve(config.dataPath??'.local/bridge');fs.mkdirSync(directory,{recursive:true});
  const real=fs.realpathSync.native(directory);
  return acquireRuntimeLock(path.join(process.platform==='win32'?real.toLowerCase():real,'journal.sqlite'));
}
