import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const unavailable = () => new Error('实例身份核对暂时失败');

/** 复用只读扫描进程，每次请求仍重新枚举进程、管道和实例身份，不缓存发现结果。 */
export class WindowsInstanceDiscovery {
  constructor({ launch = spawn, timeoutMs = 12000 } = {}) {
    this.launch = launch;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.reading = null;
    this.pending = null;
    this.closed = false;
  }

  start() {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = this.launch(executable, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./windows-instances.ps1', import.meta.url)), '-Serve'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 65536) return this.fail(child);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/^\uFEFF/, '');
      buffer = buffer.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); } catch { return this.fail(child); }
      if (!this.pending || buffer.trim() || !Array.isArray(response?.rows) || response.error) return this.fail(child);
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(response.rows);
    });
    // 原始错误可能包含本机路径，只消费，不透传到诊断日志或手机。
    child.stderr.resume();
    child.stdout.on('error', () => this.fail(child));
    child.stderr.on('error', () => this.fail(child));
    child.stdin.on('error', () => this.fail(child));
    child.once('error', () => this.fail(child));
    child.once('exit', () => this.fail(child));
    // 空闲扫描器不阻止父进程退出；父端关闭输入后，帮助进程自行结束。
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
    return child;
  }

  /** 仅合并尚未完成的同轮扫描，结束后立即释放，下一次请求重新读取系统事实。 */
  scan() {
    if (this.closed) return Promise.reject(unavailable());
    if (this.reading) return this.reading;
    this.reading = new Promise((resolve, reject) => {
      const child = this.child ?? this.start();
      this.pending = { resolve, reject, timer: setTimeout(() => this.fail(child), this.timeoutMs) };
      child.stdin.write('scan\n');
    }).finally(() => { this.reading = null; });
    return this.reading;
  }

  fail(child) {
    if (this.child !== child) return;
    this.child = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(unavailable()); }
    child.stdin.destroy();
    child.kill();
  }

  close() {
    this.closed = true;
    if (this.child) this.fail(this.child);
  }
}
