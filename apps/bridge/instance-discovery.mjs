import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WindowsInstanceDiscovery } from './windows-instance-discovery.mjs';
const execute = promisify(execFile);
const windowsDiscovery = new WindowsInstanceDiscovery();

/** 服务退出时只清理本服务创建的只读扫描器，不影响任何桌面实例。 */
export function closeInstanceDiscovery() { windowsDiscovery.close(); }

/** 发现结果只用于本机绑定，不作为日志或公网设备资料发布。 */
export async function discoverInstances() {
  if (process.platform === 'darwin') {
    const { stdout } = await execute('/usr/bin/python3', [fileURLToPath(new URL('./macos-instances.py', import.meta.url))], { timeout: 20000, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C' } });
    const rows = JSON.parse(stdout);
    // Mac 的可选调试端口由系统发现器核验 PID 与回环监听；缺失时继续保留 IPC 能力。
    if (Array.isArray(rows) && rows.some(row => row.port != null && (!Number.isSafeInteger(row.port) || row.port < 1 || row.port > 65535))) throw new Error('Mac 实例端点核对不完整');
    if (!Array.isArray(rows) || rows.length > 16 || rows.some(row => row.platform !== 'darwin' || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.startedAt) || row.startedAt <= 0 || !/^\/private\/tmp\/codex-app-tools\/[0-9a-f-]{36}\.sock$/i.test(row.nativePipe) || !path.isAbsolute(row.codexHome) || row.ipcSocketPath !== path.join(row.codexHome, 'ipc/ipc.sock') || row.userData != null && !path.isAbsolute(row.userData))) throw new Error('Mac 实例身份核对不完整');
    return { rows };
  }
  if (process.platform !== 'win32') return { rows: [] };
  const scan = await windowsDiscovery.scan();
  const { rows } = scan;
  if (!Array.isArray(rows)) throw new Error('实例清单格式无效');
  if (rows.length > 16 || rows.some(row => !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.startedAt) || row.startedAt <= 0 || !/^\\\\\.\\pipe\\codex-app-tools-[0-9a-f-]+$/i.test(row.nativePipe) || typeof row.codexHome !== 'string' || !path.isAbsolute(row.codexHome))) throw new Error('实例身份核对不完整');
  return scan;
}
