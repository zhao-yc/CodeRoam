import fs from 'node:fs';

/** 只记录结构化退出信息，不把错误正文、命令参数或配对令牌写入生命周期日志。 */
export function lifecycleEvent(file, event, details = {}) {
  const record={time:new Date().toISOString(),event,pid:process.pid,...details};
  try { fs.appendFileSync(file,JSON.stringify(record)+'\n'); } catch { /* 诊断写入失败不改变原桥接行为。 */ }
}

// 仅由独立守护进程通过预加载启用，普通开发启动保持原行为。
const log=process.env.CODEX_BRIDGE_LIFECYCLE_LOG;
if(log) {
  lifecycleEvent(log,'bridge_started',{parentPid:process.ppid});
  process.on('uncaughtExceptionMonitor',(error,origin)=>lifecycleEvent(log,'bridge_fatal',{
    origin:origin==='unhandledRejection'?'unhandledRejection':'uncaughtException',
    errorType:typeof error?.name==='string'&&/^[A-Za-z]+$/.test(error.name)?error.name:'Error',
    errorCode:typeof error?.code==='string'&&/^[A-Z0-9_]{1,60}$/.test(error.code)?error.code:null,
  }));
  process.on('exit',code=>lifecycleEvent(log,'bridge_exit',{exitCode:code}));
}
