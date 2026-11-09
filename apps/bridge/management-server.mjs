import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {readManagedConfig, saveManagedConfig} from './management-config.mjs';
import {managementWorkerIdentity} from './management-client.mjs';
import {writePrivateJson} from './management-files.mjs';

const fail = (message, code = 'MANAGEMENT_UNAVAILABLE') => Object.assign(new Error(message), {code});
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** 日志只投影已知生命周期事件，不读取 stdout、会话、错误正文或命令参数。 */
export function readManagementLogs(file, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail('日志条数须为 1 到 200', 'MANAGEMENT_REQUEST_INVALID');
  const names = {supervisor_started: '守护进程已启动', supervisor_stopping: '守护进程正在停止', bridge_spawned: '桥接进程已启动', bridge_started: '桥接程序开始运行', bridge_observed_exit: '桥接进程已退出', bridge_exit: '桥接程序已退出', bridge_restart_scheduled: '已安排恢复桥接', bridge_spawn_failed: '桥接进程启动失败', bridge_fatal: '桥接进程出现异常', management_restart_requested: '已接收管理端重启请求', management_restart_rejected: '管理端重启请求未执行'};
  names.management_start_requested = '已接收管理端启动请求';
  names.management_stop_requested = '已接收管理端停止请求';
  names.management_stop_rejected = '管理端停止请求未执行';
  let descriptor;
  try {
    const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink()) return {entries: []};
    descriptor = fs.openSync(file, 'r');
    const size = Math.min(info.size, 131072), buffer = Buffer.alloc(size);
    fs.readSync(descriptor, buffer, 0, size, info.size - size);
    const lines = buffer.toString('utf8').split('\n'); if (info.size > size) lines.shift();
    return {entries: lines.flatMap(line => {
      try {
        const record = JSON.parse(line), message = names[record.event];
        if (!message || typeof record.time !== 'string' || !Number.isFinite(Date.parse(record.time))) return [];
        const suffix = Number.isSafeInteger(record.exitCode) ? '（退出码 ' + record.exitCode + '）' : '';
        return [{time: new Date(record.time).toISOString(), level: ['bridge_fatal', 'bridge_spawn_failed'].includes(record.event) ? 'error' : 'info', message: message + suffix}];
      } catch { return []; }
    }).slice(-limit)};
  } catch { return {entries: []}; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Unix 管理套接字放在短的当前用户专属目录；不能复用其他用户或链接目录。 */
function localAddress() {
  const id = randomUUID();
  if (process.platform === 'win32') return '\\\\.\\pipe\\codex-mobile-manager-' + id;
  const directory = path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'codex-mobile-manager-' + process.getuid());
  try { fs.mkdirSync(directory, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw fail('本机管理目录权限无效');
  return path.join(directory, id + '.sock');
}

/** 固定 worker 的本机能力接口，短连接一条请求，令牌仅在私有端点文件中存放。 */
export async function startManagementServer({worker, workerConfigPath = null, status, restart, startBridge, stopBridge, setBackgroundSync, prepareQuit, cancelQuit, confirmQuit, onQuit}) {
  const address = localAddress(), token = randomBytes(32).toString('hex'), identity = managementWorkerIdentity(worker);
  const revision = workerConfigPath ? createHash('sha256').update(fs.readFileSync(workerConfigPath)).digest('hex') : null;
  const file = path.join(worker.runDirectory, 'management.json'), sockets = new Set(); let closed = false;
  const current = () => {
    if (workerConfigPath && createHash('sha256').update(fs.readFileSync(workerConfigPath)).digest('hex') !== revision) throw fail('托管配置已经变化，请重新连接管理服务', 'MANAGEMENT_CONFIG_CHANGED');
  };
  const dispatch = async (method, params, socket) => {
    current();
    if (!object(params)) throw fail('管理操作参数无效', 'MANAGEMENT_REQUEST_INVALID');
    if (['status', 'config.read', 'service.restart', 'service.start', 'service.stop', 'service.cancelQuit', 'service.quit'].includes(method) && Object.keys(params).length) throw fail('管理操作包含不支持的参数', 'MANAGEMENT_REQUEST_INVALID');
    if (method === 'status') return status();
    if (method === 'config.read') return readManagedConfig(worker.bridgeConfig);
    if (method === 'config.save') {
      if (Object.keys(params).some(key => !['expectedRevision', 'values'].includes(key))) throw fail('配置保存参数无效', 'MANAGEMENT_REQUEST_INVALID');
      return saveManagedConfig(worker.bridgeConfig, params);
    }
    if (method === 'logs.read') {
      if (Object.keys(params).some(key => key !== 'limit')) throw fail('日志读取参数无效', 'MANAGEMENT_REQUEST_INVALID');
      return readManagementLogs(path.join(worker.logDirectory, 'lifecycle.jsonl'), params.limit ?? 100);
    }
    if (method === 'service.restart') return restart();
    if (method === 'service.start' && startBridge) return startBridge();
    if (method === 'service.stop' && stopBridge) return stopBridge();
    if (method === 'service.prepareQuit' && prepareQuit) {
      if (Object.keys(params).some(key => key !== 'confirmed') ||
          (Object.hasOwn(params, 'confirmed') && typeof params.confirmed !== 'boolean')) {
        throw fail('退出确认参数无效', 'MANAGEMENT_REQUEST_INVALID');
      }
      socket.setTimeout(25000);
      return prepareQuit(params.confirmed === true);
    }
    if (method === 'service.cancelQuit' && cancelQuit) return cancelQuit();
    if (method === 'service.quit' && confirmQuit) return confirmQuit();
    if (method === 'sync.set') {
      if (Object.keys(params).length !== 1 || typeof params.enabled !== 'boolean') {
        throw fail('后台数据同步开关必须是布尔值', 'MANAGEMENT_REQUEST_INVALID');
      }
      if (!setBackgroundSync) throw fail('此守护版本暂不支持切换后台数据同步', 'MANAGEMENT_METHOD_INVALID');
      return setBackgroundSync(params.enabled);
    }
    throw fail('不支持的管理方法', 'MANAGEMENT_METHOD_INVALID');
  };
  const server = net.createServer(socket => {
    if (closed || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.setTimeout(20000, () => socket.destroy());
    let buffer = Buffer.alloc(0), used = false;
    socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', async chunk => {
      if (used) return socket.destroy();
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 65536) return socket.destroy();
      const newline = buffer.indexOf(10); if (newline < 0) return;
      used = true;
      let request;
      try {
        request = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (!object(request) || request.version !== 1 || typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/.test(request.id) || typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token) || !timingSafeEqual(Buffer.from(request.token), Buffer.from(token))) return socket.destroy();
        if (Object.keys(request).some(key => !['version', 'id', 'token', 'method', 'params'].includes(key))) throw fail('管理请求包含不支持的字段', 'MANAGEMENT_REQUEST_INVALID');
        const result = await dispatch(request.method, request.params ?? {}, socket);
        socket.end(JSON.stringify({version: 1, id: request.id, pid: process.pid, result}) + '\n', request.method === 'service.quit' ? onQuit : undefined);
      } catch (error) {
        if (!request?.id) return socket.destroy();
        const safe = typeof error?.code === 'string' && /^MANAGEMENT_[A-Z_]+$/.test(error.code);
        socket.end(JSON.stringify({version: 1, id: request.id, pid: process.pid, error: {code: safe ? error.code : 'MANAGEMENT_UNAVAILABLE', message: safe ? error.message : '本机管理操作未完成，请检查服务状态'}}) + '\n');
      }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
    writePrivateJson(file, {version: 1, address, token, pid: process.pid, workerIdentity: identity, workerConfigRevision: revision});
  } catch (error) { server.close(); if (process.platform !== 'win32') try { fs.unlinkSync(address); } catch {} throw error; }
  return {
    address,
    /** 关闭只清理本次端点，不能删除后来启动的服务登记。 */
    close() {
      if (closed) return; closed = true;
      for (const socket of sockets) socket.destroy(); server.close();
      try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.pid === process.pid && saved.token === token) fs.unlinkSync(file); } catch {}
      if (process.platform !== 'win32') try { fs.unlinkSync(address); } catch {}
    },
  };
}
