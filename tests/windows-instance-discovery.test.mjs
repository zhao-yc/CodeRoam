import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('Windows 发现按需共用 TCP 查询，并继续校验回环地址、端口归属与失败状态', {skip: process.platform !== 'win32'}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-listener-query-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.copyFileSync('apps/bridge/windows-instances.ps1', path.join(root, 'windows-instances.ps1'));
  fs.writeFileSync(path.join(root, 'windows-native-pipe.ps1'), '\ufeffparam([switch]$AsObject)\nWrite-Output $global:DiscoveryFixture.native\n');
  // 在隔离 PowerShell 中运行真实发现脚本，系统查询全部替换为合成实例。
  const fixture = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
public static class InstanceEnvironment {
 public static string[] Read(int pid) { return new string[] {@"C:\example\config", null}; }
}
'@
function Add-Type { param([string]$TypeDefinition) }
function Get-CimInstance {
 param([string]$ClassName,[string]$Filter)
 if($Filter -match '^ProcessId=(\d+)$') { return $global:DiscoveryFixture.processes | Where-Object {$_.ProcessId -eq [int]$Matches[1]} }
 return $global:DiscoveryFixture.processes
}
function Invoke-CimMethod {
 param($InputObject,[string]$MethodName)
 return [pscustomobject]@{Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
}
function Get-Process { param([int]$Id) return [pscustomobject]@{SessionId=1} }
function Get-NetTCPConnection {
 [CmdletBinding()]param([string]$State)
 $global:TcpQueries++
 if($global:DiscoveryFixture.failTcp) { throw '合成监听表读取失败' }
 return $global:DiscoveryFixture.listeners
}
$results=@()
foreach($case in @('ordinary','multi','wrongOwner','nonLoopback','duplicate','queryFailure','emptyListeners')) {
 $global:TcpQueries=0
 $processes=@([pscustomobject]@{ProcessId=101;CommandLine='Codex.exe';ExecutablePath='C:\example\Codex.exe';CreationDate=[DateTime]'2026-01-01'})
 $candidates=@([pscustomobject]@{pid=101;path='pipe-one'})
 $listeners=@()
 if($case -ne 'ordinary') {
  $processes[0].CommandLine='Codex.exe --remote-debugging-port=1234'
  $listeners=@([pscustomobject]@{LocalPort=1234;LocalAddress='127.0.0.1';OwningProcess=101})
 }
 if($case -eq 'multi' -or $case -eq 'emptyListeners') {
  $processes+=([pscustomobject]@{ProcessId=102;CommandLine='Codex.exe --remote-debugging-port=1235';ExecutablePath='C:\example\Codex.exe';CreationDate=[DateTime]'2026-01-01'})
  $candidates+=([pscustomobject]@{pid=102;path='pipe-two'})
  $listeners+=([pscustomobject]@{LocalPort=1235;LocalAddress='127.0.0.1';OwningProcess=102})
 }
 if($case -eq 'wrongOwner') {$listeners[0].OwningProcess=999}
 if($case -eq 'nonLoopback') {$listeners[0].LocalAddress='0.0.0.0'}
 if($case -eq 'duplicate') {$listeners+=([pscustomobject]@{LocalPort=1234;LocalAddress='::1';OwningProcess=101})}
 if($case -eq 'emptyListeners') {$listeners=@()}
 $global:DiscoveryFixture=@{processes=$processes;native=@{candidates=$candidates;ipcProcessId=101};listeners=$listeners;failTcp=($case -eq 'queryFailure')}
 $failed=$false
 try {$rows=@(& (Join-Path $PSScriptRoot 'windows-instances.ps1') -AsObject)}catch {$failed=$_.Exception.Message -eq 'INSTANCE_IDENTITY_INCOMPLETE';$rows=@()}
 $results+=([pscustomobject]@{scenario=$case;queries=$global:TcpQueries;failed=$failed;ports=@($rows|ForEach-Object {$_.port})})
}
[Console]::WriteLine((ConvertTo-Json -Depth 5 -Compress -InputObject $results))
`;
  const file = path.join(root, 'fixture.ps1');
  fs.writeFileSync(file, '\ufeff' + fixture);
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', file], {encoding: 'utf8', windowsHide: true, timeout: 20000});
  assert.equal(result.status, 0, result.stderr);
  const rows = Object.fromEntries(JSON.parse(result.stdout.trim()).map(row => [row.scenario, row]));
  assert.equal(rows.ordinary.queries, 0);
  assert.equal(rows.multi.queries, 1);
  assert.deepEqual(rows.multi.ports, [1234, 1235]);
  for (const scenario of ['wrongOwner', 'nonLoopback', 'duplicate']) assert.deepEqual(rows[scenario].ports, [null]);
  assert.equal(rows.queryFailure.failed, true);
  assert.equal(rows.emptyListeners.queries, 1);
  assert.deepEqual(rows.emptyListeners.ports, [null, null]);
});
