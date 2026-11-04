import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 用合成进程和监听端口执行实际发现脚本，不访问本机桌面或打开调试端口。 */
test('预测发现不限制桌面版本，仍拒绝其他应用、子进程和不可信端口', { skip: process.platform !== 'win32' }, () => {
  const source = fs.readFileSync('apps/bridge/windows-prediction-ports.ps1', 'utf8');
  const desktop = (version, id, extra = {}) => ({
    ProcessId: id,
    ExecutablePath: `C:\\Program Files\\WindowsApps\\OpenAI.Codex_${version}_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe`,
    CommandLine: `ChatGPT.exe --remote-debugging-port=${30000 + id}`,
    ...extra,
  });
  const processes = [
    desktop('26.1027.3384.0', 1),
    desktop('26.1029.7803.0', 2),
    desktop('99.1231.9999.0', 3),
    desktop('99.1231.9999.0', 4, { ExecutablePath: 'C:\\OtherApp\\ChatGPT.exe' }),
    desktop('99.1231.9999.0', 5, { CommandLine: 'ChatGPT.exe --type=renderer --remote-debugging-port=30005' }),
    desktop('99.1231.9999.0', 6),
    desktop('99.1231.9999.0', 7),
    desktop('99.1231.9999.0', 8),
    desktop('99.1231.9999.0', 9, { CommandLine: 'ChatGPT.exe' }),
    desktop('99.1231.9999.0', 10, { ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_99.1231.9999.0_x64__otherpublisher\\app\\ChatGPT.exe' }),
  ];
  const listeners = processes.map(({ ProcessId }) => ({ LocalPort: 30000 + ProcessId, LocalAddress: '127.0.0.1', OwningProcess: ProcessId }));
  listeners[5].LocalAddress = '0.0.0.0';
  listeners[6].OwningProcess = 999;
  listeners.push({ ...listeners[7], LocalAddress: '::1' });
  const code = `
$fixtureProcesses=ConvertFrom-Json '${JSON.stringify(processes)}'
$fixtureListeners=ConvertFrom-Json '${JSON.stringify(listeners)}'
function Get-CimInstance { param($ClassName,$Filter) $fixtureProcesses }
function Get-NetTCPConnection { param($State) $fixtureListeners }
${source}
`;
  const executable = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()), processes.slice(0, 3).map(process => ({ port: 30000 + process.ProcessId, pid: process.ProcessId, executable: process.ExecutablePath })));
});
