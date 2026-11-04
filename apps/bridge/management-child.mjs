/** 只响应父进程的独立 IPC；手机协议与本机管理协议保持分离。 */
export function installManagementChild({agents, drain, status, close, channel = process, exit = code => process.exit(code ?? 0)}) {
  if (typeof channel.send !== 'function') return () => {};
  let prepared = false, shuttingDown = false;
  const setDraining = value => { drain(value); for (const agent of agents()) agent.setManagementDraining(value); };
  const idle = () => { try { return agents().every(agent => agent.managementIdle()); } catch { return false; } };
  const reply = (requestId, result, error, callback) => {
    if (!channel.connected) { callback?.(); return; }
    channel.send({type: 'codex-mobile-management', requestId, ...(error ? {error} : {result})}, callback);
  };
  const listener = async message => {
    if (message?.type !== 'codex-mobile-management' || typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.requestId) || !['status', 'prepare-restart', 'cancel-restart', 'shutdown'].includes(message.action)) return;
    try {
      if (message.action === 'status') { reply(message.requestId, status()); return; }
      if (message.action === 'cancel-restart') {
        if (!shuttingDown) { prepared = false; setDraining(false); }
        reply(message.requestId, {canceled: !shuttingDown}); return;
      }
      if (message.action === 'prepare-restart') {
        setDraining(true);
        if (shuttingDown || !idle()) { setDraining(false); throw new Error(); }
        prepared = true; reply(message.requestId, {ready: true}); return;
      }
      if (!prepared || shuttingDown || !idle()) { if (!shuttingDown) { prepared = false; setDraining(false); } throw new Error(); }
      shuttingDown = true;
      await close();
      reply(message.requestId, {closed: true}, null, () => exit(0));
    } catch {
      // 关闭已经开始后不能恢复部分失效的实例；退出交给原守护恢复，避免永久锁写。
      if(shuttingDown)reply(message.requestId,null,{code:'MANAGEMENT_RESTARTING',message:'关闭过程未完整确认，连接服务正在重新启动'},()=>exit(1));
      else reply(message.requestId, null, {code: 'MANAGEMENT_BUSY', message: '手机仍有操作未完成，或服务尚未就绪；本次没有重启'});
    }
  };
  channel.on('message', listener);
  channel.send({type: 'codex-mobile-management', action: 'ready'});
  return () => channel.off('message', listener);
}
