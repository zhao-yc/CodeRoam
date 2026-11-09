import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const failure = message => Object.assign(new Error(message), {code: 'MANAGEMENT_UNAVAILABLE'});

async function waitFor(check, message, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw failure(message);
}

/** 单个托盘拥有一条守护 IPC。只控制自己启动且经管理接口确认的进程。 */
export function createServiceSession({connect, node, supervisor, entry, trayReady, beforeStart = async () => {}}) {
  let active = null, starting = null;
  const request = (worker, method, params) => connect(worker).request(method, params);

  async function launch(worker) {
    if (!trayReady()) throw failure('托盘未就绪，连接服务未启动');
    await beforeStart(worker);
    if (!trayReady()) throw failure('托盘已关闭，连接服务未启动');
    const child = spawn(node, [supervisor, '--desktop-owned', '--config', worker, ...(entry ? ['--entry', entry] : [])], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const owned = {child, worker, closed: false};
    active = owned;
    child.on('error', () => { /* 启动与关闭统一通过 close 和状态核验。 */ });
    child.once('close', () => {
      owned.closed = true;
      if (active === owned) active = null;
    });
    try {
      return await waitFor(async () => {
        if (owned.closed) throw failure('守护启动失败，请检查托管配置或运行目录占用');
        const status = await request(worker, 'status').catch(() => null);
        return status?.supervisorPid === child.pid && status.serviceState === 'running' ? status : null;
      }, '守护启动尚未确认，请查看运行日志');
    } catch (error) {
      if (child.connected) child.disconnect();
      try { await waitFor(() => owned.closed, '守护尚未退出'); }
      catch { child.kill('SIGKILL'); }
      throw error;
    }
  }

  return {
    owns: worker => active?.worker === worker,
    starting: () => Boolean(starting),
    async start(worker) {
      if (!worker) throw failure('请先选择本机服务托管配置');
      if (starting) return starting;
      if (active) {
        if (active.worker !== worker) throw failure('请先停止当前守护');
        const status = await request(worker, 'status');
        if (status.supervisorPid !== active?.child.pid) throw failure('守护进程归属已经变化');
        if (status.serviceState === 'stopped') await request(worker, 'service.start');
        return status;
      }
      starting = launch(worker);
      try { return await starting; }
      finally { starting = null; }
    },
    async close(worker, confirmed = false) {
      await starting?.catch(() => {});
      const owned = active;
      if (!owned) return;
      if (owned.worker !== worker) throw failure('守护进程归属已经变化');
      const status = await request(worker, 'status');
      if (status.supervisorPid !== owned.child.pid) throw failure('守护进程归属已经变化');
      const prepared = await request(worker, 'service.prepareQuit', {confirmed});
      try {
        if (prepared.pid !== owned.child.pid) throw failure('守护进程归属已经变化');
        await request(worker, 'service.quit');
        await waitFor(() => owned.closed, '仍在等待守护退出，请稍后重试');
      } catch (error) {
        if (owned.closed) return;
        await request(worker, 'service.cancelQuit').catch(() => {});
        if (prepared.wasRunning) await request(worker, 'service.start').catch(() => {});
        throw error;
      }
    },
  };
}
