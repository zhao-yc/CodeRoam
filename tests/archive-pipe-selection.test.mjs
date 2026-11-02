import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** 仅执行实际脚本的进程选择片段；模拟窗口及内存管道，不连接原桌面或调用归档。 */
test('独立托管归档选择唯一可见桌面，多个可见或全部隐藏时仍拒绝', { skip: process.platform !== 'win32' }, () => {
  const source = fs.readFileSync('apps/bridge/windows-archive.ps1', 'utf8');
  const selection = source.slice(source.indexOf('  # 独立托管不继承桌面管道'), source.indexOf('  $script:pipe=$candidates[0].pipe'));
  assert.ok(selection.length > 0);
  for (const [windows, expected] of [
    [[{ id: 1, visible: false }], [1]],
    [[{ id: 1, visible: false }, { id: 2, visible: true }], [2]],
    [[{ id: 1, visible: true }, { id: 2, visible: true }], null],
    [[{ id: 1, visible: false }, { id: 2, visible: false }], null],
    [[{ id: 1, visible: false }, { id: 2, visible: true }, { id: 2, visible: true }], [2]],
  ]) {
    const code = `
$ErrorActionPreference='Stop'
$windows=ConvertFrom-Json '${JSON.stringify(windows)}'
function Get-Process { param($Id) $w=$windows|Where-Object {$_.id -eq $Id}|Select-Object -First 1; [pscustomobject]@{MainWindowHandle=[IntPtr][int]$w.visible;MainWindowTitle='Codex'} }
$candidates=@($windows|ForEach-Object {@{processId=$_.id;pipe=(New-Object IO.MemoryStream)}})
try {
${selection}
ConvertTo-Json -Compress -InputObject @($candidates|ForEach-Object {$_.processId}|Select-Object -Unique)
} catch { Write-Output 'null' }
`;
    const result = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
  }
});
