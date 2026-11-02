import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { BridgeError, errorPayload } from '../../packages/protocol/contracts.mjs';
import { computerName } from './computer-name.mjs';
import { InstanceRegistry } from './instance-registry.mjs';
import { discoverInstances } from './instance-discovery.mjs';
import { InstanceRuntime } from './instance-runtime.mjs';
import { bindBackendOwners } from './instance-binding.mjs';

/** 一条电脑鉴权连接承载多个实例，每个实例维护独立账本、订阅及运行代次。 */
export class InstanceHub extends EventEmitter {
  constructor({ config, dataPath, discover = discoverInstances, createRuntime = options => new InstanceRuntime(options), bindOwners = bindBackendOwners, intervalMs = 10000 }) {
    super(); this.config = config; this.dataPath = dataPath; this.discover = discover; this.createRuntime = createRuntime; this.intervalMs = intervalMs;
    this.registry = new InstanceRegistry({ file: path.join(dataPath, 'instances.json'), hostId: config.hostId, defaultHome: config.codexHome ?? path.join(os.homedir(), '.codex'), label: computerName(config.label), backupDirectory: config.instanceBackupDirectory });
    this.runtimes = new Map(); this.stopped = false; this.socket = null; this.scan = null; this.supported = false; this.retries = 0;
    this.bindOwners=bindOwners;
  }
  /** 仅发布匿名编号和显示名称，目录、PID、端口都不进入中转设备资料。 */
  manifest() { return [...this.runtimes.values()].map(({ instance }) => ({ id: instance.id, label: instance.label, generation: instance.generation, online: instance.alive && instance.ready })); }
  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > 8 * 1024 * 1024) { this.socket.terminate(); return false; }
    this.socket.send(JSON.stringify(message)); return true;
  }
  publish() { const instances=this.manifest(), fingerprint=JSON.stringify(instances); if (this.supported && fingerprint !== this.lastManifest && this.send({ v: 1, type: 'host.instances', instances })) this.lastManifest=fingerprint; }
  start() {
    const url = new URL(this.config.relayUrl);
    if (url.username || url.password || url.search || url.hash || url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('中转连接配置无效');
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    const socket = new WebSocket(this.config.relayUrl, { headers: { Authorization: `Bearer ${this.config.token}` }, handshakeTimeout: 8000, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 }); this.socket = socket;
    let alive = true;
    const timer = setInterval(() => { if (socket.readyState !== WebSocket.OPEN) return; if (!alive) return socket.terminate(); alive = false; socket.ping(); }, 15000); timer.unref();
    socket.on('pong', () => { alive = true; });
    socket.on('message', data => {
      let message; try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'welcome') {
        this.lastManifest = null;
        this.supported = message.capabilities?.hostInstances === true;
        this.send({ v: 1, type: 'host.ready', label: computerName(this.config.label), hostname: os.hostname(), connectionType: 'codex-desktop' });
        if (!this.supported) { this.emit('warning', { code: 'INSTANCES_RELAY_UNSUPPORTED', message: '请先更新中转服务以启用多实例连接' }); socket.close(4001); return; }
        this.retries = 0; this.emit('connected');
        this.refresh().catch(() => {});
        if (!this.timer) { this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs); this.timer.unref(); }
        this.publish();
      } else if (message.type === 'request') this.request(message).then(response => { if (this.socket === socket) this.send(response); }).catch(() => {});
    });
    socket.on('error', () => this.emit('warning', { code: 'RELAY_UNAVAILABLE', message: '中转暂时不可用，正在重连' }));
    socket.on('close', code => {
      clearInterval(timer); this.supported = false; this.emit('disconnected');
      for (const runtime of this.runtimes.values()) { runtime.agent.threadListFeed.devices.clear(); runtime.agent.threadListFeed.stop(); }
      if (!this.stopped && code !== 4001) this.reconnect = setTimeout(() => this.connect(), Math.min(15000, 500 * 2 ** Math.min(this.retries++, 5)));
    });
  }
  /** 周期发现只改变本服务的上下文，不启动、关闭或重启任何 Codex 桌面。 */
  async refresh() {
    if (this.stopped) return;
    if (this.scan) return this.scan;
    this.scan = (async () => {
      let rows;
      try { rows = await this.discover(); }
      catch { for (const runtime of this.runtimes.values()) runtime.instance.ready = false; this.publish(); this.emit('warning', { code: 'INSTANCE_DISCOVERY_FAILED', message: '实例身份核对暂时失败，已暂停操作' }); return; }
      if (this.stopped) return;
      const seen = new Set();
      rows.sort((a, b) => Number(!!a.userData) - Number(!!b.userData) || a.startedAt - b.startedAt);
      for (const row of rows) {
        const identity = this.registry.identify(row);
        // 同一用户数据目录意外对应多个活动进程时拒绝混用，而不是覆盖正在工作的实例。
        if (seen.has(identity.id)) { const duplicate = this.runtimes.get(identity.id); if (duplicate) duplicate.instance.ready = false; continue; }
        seen.add(identity.id);
        let runtime = this.runtimes.get(identity.id);
        if (runtime && (runtime.instance.pid !== row.pid || runtime.instance.startedAt !== row.startedAt || runtime.instance.nativePipe !== row.nativePipe || runtime.instance.port !== row.port)) { await runtime.close(); this.runtimes.delete(identity.id); runtime = null; }
        if (!runtime) {
          const instance = { ...row, id: identity.id, label: identity.label, generation: randomUUID(), alive: true, ready: false, refreshOwners: () => this.refreshOwners() };
          instance.verify = () => instance.platform === 'darwin' ? this.verifyMacInstance(instance) : this.verifyWindowsInstance(instance);
          const directory = identity.id === this.config.hostId ? this.dataPath : path.join(this.dataPath, 'instances', identity.id.slice(this.config.hostId.length + 1));
          fs.mkdirSync(directory, { recursive: true });
          runtime = this.createRuntime({ instance, config: this.config, dataPath: directory, send: message => this.send(message) });
          runtime.agent.on('warning', warning => this.emit('warning', warning));
          this.runtimes.set(identity.id, runtime);
        }
        if (row.platform === 'darwin' && rows.filter(other => other.ipcSocketPath === row.ipcSocketPath).length !== 1) { runtime.instance.ready = false; this.emit('warning', { code: 'INSTANCE_DIRECTORY_SHARED', message: '多个 Mac 实例共用配置目录，请为每个实例使用独立目录后重连' }); continue; }
        try { await runtime.ready(); } catch { runtime.instance.ready = false; this.emit('warning', { code: 'INSTANCE_BINDING_FAILED', message: '实例连接尚未就绪，未选择其他桌面代替' }); }
      }
      for (const [id, runtime] of this.runtimes) if (!seen.has(id)) { await runtime.close(); this.runtimes.delete(id); }
      try { await this.refreshOwners(); } catch { for (const runtime of this.runtimes.values()) runtime.instance.ready = false; this.emit('warning', {code:'INSTANCE_OWNER_UNVERIFIED',message:'实例后台所有者暂时无法核对，已暂停操作'}); }
      this.publish();
    })().finally(() => { this.scan = null; });
    return this.scan;
  }
  async request(message) {
    try {
      const runtime = this.runtimes.get(message.hostId);
      if (!runtime) throw new BridgeError('INSTANCE_OFFLINE', '所选实例已离线，请重新选择设备');
      const response = await runtime.request(message);
      return { ...response, hostId: message.hostId, generation: message.generation };
    } catch (error) { return { v: 1, type: 'response', transportId: message.transportId, hostId: message.hostId, generation: message.generation, error: errorPayload(error) }; }
  }
  /** Windows 按进程和管道复核绑定，不能把缺少 Mac IPC 的多个实例误判为共享目录。 */
  async verifyWindowsInstance(instance) {
    try {
      if (this.stopped || !instance.alive) throw new Error();
      const rows = await (this.windowsVerification ??= this.discover().finally(() => { this.windowsVerification = null; }));
      const matches = rows.filter(row => row.pid === instance.pid || row.nativePipe === instance.nativePipe);
      const current = matches[0];
      if (matches.length !== 1 || !current || ['pid', 'startedAt', 'nativePipe', 'executable', 'codexHome', 'userData', 'port'].some(key => current[key] !== instance[key]) || !instance.alive || this.stopped) throw new Error();
    } catch { instance.ready = false; throw new BridgeError('INSTANCE_NOT_READY', '所选 Windows 实例身份已变化，请在电脑核对后重连'); }
  }
  /** Mac 不借用全局调试页面；操作前复核专属 IPC，目录共用或 PID 换代立即暂停。 */
  async verifyMacInstance(instance) {
    try {
      if (this.stopped || !instance.alive) throw new Error();
      // 同一轮并发请求共享系统快照，完成后即丢弃，不缓存过期进程身份。
      const rows = await (this.macVerification ??= this.discover().finally(() => { this.macVerification = null; }));
      const matches = rows.filter(row => row.ipcSocketPath === instance.ipcSocketPath);
      const current = matches[0];
      if (matches.length !== 1 || !current || ['pid', 'startedAt', 'nativePipe', 'executable', 'codexHome', 'userData'].some(key => current[key] !== instance[key]) || !instance.alive || this.stopped) throw new Error();
    } catch { instance.ready = false; throw new BridgeError('INSTANCE_NOT_READY', '所选 Mac 实例身份已变化或配置目录被共用，请在电脑核对后重连'); }
  }
  /** 导航与后台发现共用一次身份复核，不能并发重写客户端集合。 */
  refreshOwners() { return this.ownerScan ??= Promise.resolve().then(() => { const runtimes = [...this.runtimes.values()].filter(runtime => runtime.instance.platform !== 'darwin'); return runtimes.length ? this.bindOwners(runtimes) : undefined; }).finally(() => { this.ownerScan = null; }); }
  async close() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.reconnect); this.socket?.terminate(); if (this.scan) await this.scan.catch(() => {}); await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.close())); this.runtimes.clear(); }
}
