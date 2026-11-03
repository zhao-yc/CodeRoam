import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsIpcRouter } from './windows-ipc-router.mjs';

const peerLimit = 80;

/** 只接收本次管道帮助进程提供的内核身份，随后将字节流交给路由器。 */
export class WindowsIpcHost {
  constructor({ pipeName = 'codex-ipc', waitForRelease = true, onState = () => {} } = {}) {
    this.pipeName = pipeName;
    this.waitForRelease = waitForRelease;
    this.onState = onState;
    this.router = new WindowsIpcRouter();
    this.pending = new Set();
    this.ready = false;
    this.closed = false;
  }

  /** 占用检查在 Windows 内核执行。现有 Codex 仍提供管道时，帮助进程保持待命。 */
  async start() {
    if (this.server || this.closed) return;
    const secret = randomBytes(32).toString('hex');
    const server = net.createServer(socket => this.authenticate(socket, secret));
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    if (this.closed) return;
    server.on('error', () => this.close());
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const args = ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./windows-ipc-host.ps1', import.meta.url)), '-PipeName', this.pipeName];
    if (this.waitForRelease) args.push('-WaitForRelease');
    const child = spawn(powershell, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_MOBILE_IPC_PORT: String(server.address().port), CODEX_MOBILE_IPC_SECRET: secret },
    });
    this.child = child;
    let status = '';
    child.stdout.on('data', chunk => {
      status += chunk.toString('utf8');
      if (status.length > 256) return this.close();
      let newline;
      while ((newline = status.indexOf('\n')) >= 0) {
        const state = status.slice(0, newline).trim();
        if (state === 'ready' || state === 'busy') {
          this.ready = state === 'ready';
          this.onState(state);
        }
        status = status.slice(newline + 1);
      }
    });
    // 原始异常可能带本机路径。仅以状态降级，由桌面继续使用原有通道。
    child.stderr.resume();
    child.stdin.on('error', () => this.close());
    child.once('error', () => this.close());
    child.once('exit', () => this.close());
  }

  /** 未握手的连接有数量、长度及时间上限，手机和局域网无法接入此端口。 */
  authenticate(socket, secret) {
    if (this.closed || this.pending.size >= peerLimit) { socket.destroy(); return; }
    this.pending.add(socket);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 2000);
    timer.unref();
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { clearTimeout(timer); this.pending.delete(socket); });
    const receive = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length < 1 || length > 2048) { socket.destroy(); return; }
      if (buffer.length < length + 4) return;
      let peer;
      try { peer = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')); }
      catch { socket.destroy(); return; }
      if (peer?.type !== 'bridge-peer' || typeof peer.secret !== 'string' || !/^[a-f0-9]{64}$/.test(peer.secret) ||
          !timingSafeEqual(Buffer.from(peer.secret, 'hex'), Buffer.from(secret, 'hex')) ||
          !Number.isSafeInteger(peer.pid) || peer.pid < 1 || !Number.isSafeInteger(peer.startedAt) || peer.startedAt < 1) {
        socket.destroy(); return;
      }
      socket.pause();
      socket.off('data', receive);
      clearTimeout(timer);
      this.pending.delete(socket);
      const rest = buffer.subarray(length + 4);
      buffer = Buffer.alloc(0);
      if (rest.length) socket.unshift(rest);
      try { this.router.accept(socket, { pid: peer.pid, startedAt: peer.startedAt }); }
      catch { socket.destroy(); return; }
      socket.resume();
    };
    socket.on('data', receive);
  }

  /** 返回同一 PID 及启动时间当前持有的连接编号，不根据窗口顺序推测。 */
  clientIds(instance) { return this.ready && !this.closed ? this.router.clientIds(instance) : new Set(); }

  ownsConnection(clientId) { return this.ready && !this.closed && this.router.ownsClient(clientId, process.pid); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const socket of this.pending) socket.destroy();
    this.router.close();
    this.server?.close();
    // 关闭父端输入使帮助进程退出并释放全部管道实例。
    this.child?.stdin.end();
  }
}
