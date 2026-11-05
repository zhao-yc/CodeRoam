/** 只响应父进程的独立 IPC；手机协议与本机管理协议保持分离。 */
export function installManagementChild({agents, drain, status, close, setBackgroundSync, channel = process, exit = code => process.exit(code ?? 0)}) {
  if (typeof channel.send !== 'function') return () => {};
  let prepared = false, quitting = false, confirmedQuit = false, shuttingDown = false;
  const setDraining = value => { drain(value); for (const agent of agents()) agent.setManagementDraining(value); };
  const idle = () => { try { return agents().every(agent => agent.managementIdle()); } catch { return false; } };
  const reply = (requestId, result, error, callback) => {
    if (!channel.connected) { callback?.(); return; }
    channel.send({type: 'codex-mobile-management', requestId, ...(error ? {error} : {result})}, callback);
  };
  const listener = async message => {
    if (message?.type !== 'codex-mobile-management' || typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.requestId) || !['status', 'prepare-restart', 'prepare-quit', 'cancel-restart', 'shutdown', 'set-sync'].includes(message.action)) return;
    if (message.action === 'set-sync') {
      if (!setBackgroundSync || typeof message.enabled !== 'boolean') {
        reply(message.requestId, null, {code: 'MANAGEMENT_METHOD_INVALID', message: '此桥接版本暂不支持切换后台数据同步'});
      } else if (prepared || shuttingDown) {
        reply(message.requestId, null, {code: 'MANAGEMENT_BUSY', message: '服务正在重启，请稍后切换后台数据同步'});
      } else {
        try { reply(message.requestId, setBackgroundSync(message.enabled)); }
        catch { reply(message.requestId, null, {code: 'MANAGEMENT_SYNC_FAILED', message: '后台数据同步设置未能确认，请刷新状态后重试'}); }
      }
      return;
    }
    try {
      if (message.action === 'status') { reply(message.requestId, status()); return; }
      if (message.action === 'cancel-restart') {
        if (!shuttingDown) { prepared = false; setDraining(false); }
        reply(message.requestId, {canceled: !shuttingDown}); return;
      }
      if (message.action === 'prepare-restart' || message.action === 'prepare-quit') {
        if (shuttingDown) throw new Error();
        quitting = message.action === 'prepare-quit';
        confirmedQuit = quitting && message.confirmed === true;
        setDraining(true);
        if (!confirmedQuit && !idle()) {
          prepared = false; setDraining(false);
          if (quitting) {
            reply(message.requestId, null, {code: 'MANAGEMENT_IN_FLIGHT', message: '手机仍有操作未完成'});
            return;
          }
          throw new Error();
        }
        prepared = true; reply(message.requestId, {ready: true}); return;
      }
      if (!prepared || shuttingDown) {
        if (!shuttingDown) setDraining(false);
        throw new Error();
      }
      if (!confirmedQuit && !idle()) {
        prepared = false; setDraining(false);
        if (quitting) {
          reply(message.requestId, null, {code: 'MANAGEMENT_IN_FLIGHT', message: '手机仍有操作未完成'});
          return;
        }
        throw new Error();
      }
      shuttingDown = true;
      await close();
      reply(message.requestId, {closed: true}, null, () => exit(0));
    } catch {
      // 关闭已经开始后不能恢复部分失效的实例；退出交给原守护恢复，避免永久锁写。
      if(shuttingDown)reply(message.requestId,null,{code:'MANAGEMENT_RESTARTING',message:'关闭过程未完整确认，连接服务正在重新启动'},()=>exit(1));
      else reply(message.requestId, null, {code: 'MANAGEMENT_BUSY', message: '手机仍有操作未完成，或服务尚未就绪，请稍后重试'});
    }
  };
  channel.on('message', listener);
  channel.send({type: 'codex-mobile-management', action: 'ready'});
  return () => channel.off('message', listener);
}
