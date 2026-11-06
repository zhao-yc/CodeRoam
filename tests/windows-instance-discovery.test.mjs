import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {WindowsInstanceDiscovery} from '../apps/bridge/windows-instance-discovery.mjs';

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
 public static bool FailOwner;
 public static bool ForeignOwner;
 public static string[] Read(int pid) { return new string[] {@"C:\example\config", null}; }
 public static string OwnerSid(int pid) {
  if(FailOwner)throw new System.InvalidOperationException();
  return ForeignOwner ? "S-1-5-21-999" : System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
 }
}
'@
function Add-Type { param([string]$TypeDefinition) }
function Get-CimInstance {
 param([string]$ClassName,[string]$Filter)
 $global:ProcessQueries++
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
foreach($case in @('ordinary','multi','wrongOwner','nonLoopback','duplicate','queryFailure','emptyListeners','foreignUser','ownerFailure','secondStarting')) {
 $global:TcpQueries=0
 $global:ProcessQueries=0
 [InstanceEnvironment]::FailOwner=$case -eq 'ownerFailure'
 [InstanceEnvironment]::ForeignOwner=$case -eq 'foreignUser'
 $processes=@([pscustomobject]@{ProcessId=101;SessionId=1;CommandLine='Codex.exe';ExecutablePath='C:\example\WindowsApps\OpenAI.Codex_1.0_x64__synthetic\app\Codex.exe';CreationDate=[DateTime]'2026-01-01'})
 $candidates=@([pscustomobject]@{pid=101;path='pipe-one'})
 $listeners=@()
 if($case -notin @('ordinary','secondStarting','foreignUser','ownerFailure')) {
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
 if($case -eq 'secondStarting') {$processes+=([pscustomobject]@{ProcessId=103;SessionId=1;CommandLine='Codex.exe';ExecutablePath=$processes[0].ExecutablePath;CreationDate=[DateTime]'2026-01-01'})}
 $global:DiscoveryFixture=@{processes=$processes;native=@{candidates=$candidates;ipcProcessId=101};listeners=$listeners;failTcp=($case -eq 'queryFailure')}
 $failed=$false
 try {$rows=& (Join-Path $PSScriptRoot 'windows-instances.ps1') -AsObject}catch {$failed=$_.Exception.Message -eq 'INSTANCE_IDENTITY_INCOMPLETE';$rows=@()}
 $results+=([pscustomobject]@{scenario=$case;queries=$global:TcpQueries;processQueries=$global:ProcessQueries;failed=$failed;ports=@($rows|ForEach-Object {$_.port});count=$rows.Count;soleIpc=($rows.Count -eq 1 -and $rows[0].soleIpc -eq $true)})
}
[Console]::WriteLine((ConvertTo-Json -Depth 5 -Compress -InputObject $results))
[InstanceEnvironment]::FailOwner=$false
[InstanceEnvironment]::ForeignOwner=$false
$global:DiscoveryFixture=@{
 processes=@([pscustomobject]@{ProcessId=101;SessionId=1;CommandLine='Codex.exe';ExecutablePath='C:\example\Codex.exe';CreationDate=[DateTime]'2026-01-01'})
 native=@{candidates=@([pscustomobject]@{pid=101;path='pipe-one'});ipcProcessId=102;sessionPipeProbe='owner_read';toolPipeTimeouts=@('pipe-two')}
}
& (Join-Path $PSScriptRoot 'windows-instances.ps1') -Serve
`;
  const file = path.join(root, 'fixture.ps1');
  fs.writeFileSync(file, '\ufeff' + fixture);
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', file], {input: 'scan\n', encoding: 'utf8', windowsHide: true, timeout: 20000});
  assert.equal(result.status, 0, result.stderr);
  const [cases, scan] = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(scan.windowsProbe, {sessionPipe: 'owner_mismatch', toolPipeTimeouts: ['pipe-two']});
  assert.equal(scan.rows[0].pid, 101);
  const rows = Object.fromEntries(cases.map(row => [row.scenario, row]));
  assert.equal(rows.ordinary.queries, 0);
  assert.equal(rows.multi.queries, 1);
  assert.deepEqual(rows.multi.ports, [1234, 1235]);
  for (const scenario of ['wrongOwner', 'nonLoopback', 'duplicate']) assert.deepEqual(rows[scenario].ports, [null]);
  assert.equal(rows.queryFailure.failed, true);
  assert.equal(rows.emptyListeners.queries, 1);
  assert.deepEqual(rows.emptyListeners.ports, [null, null]);
  assert.ok(Object.values(rows).every(row => row.processQueries === 1), '同轮候选和独占性核验只查询一次实时进程清单');
  assert.equal(rows.ordinary.soleIpc, true);
  assert.equal(rows.secondStarting.soleIpc, false, '第二个桌面尚未建立工具管道也必须撤销独占性');
  assert.equal(rows.foreignUser.count, 0);
  assert.equal(rows.ownerFailure.failed, true, '无法核实用户身份时必须拒绝发现');
});

/** 合成帮助进程只提供私有管道，不访问真实桌面、会话或系统进程。 */
function discoveryFixture(t, timeoutMs = 1000) {
  const children = [];
  const reader = new WindowsInstanceDiscovery({timeoutMs, launch: (_executable, args, options) => {
    assert.ok(args.includes('-Serve'));
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    Object.assign(child, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {}, kill() { this.killed = true; }});
    child.requests = [];
    child.stdin.on('data', data => child.requests.push(data.toString()));
    children.push(child);
    return child;
  }});
  t.after(() => reader.close());
  return {reader, children};
}

test('扫描器合并在途读取，结束后重新请求，同一进程可发现第二实例和管道换代', async t => {
  const {reader, children} = discoveryFixture(t);
  const first = reader.scan(), concurrent = reader.scan();
  assert.equal(first, concurrent);
  const child = children[0];
  assert.deepEqual(child.requests, ['scan\n']);
  child.stdout.write('\ufeff{"rows":[{"pid":101,"nativePipe":"pipe-one"}]}\n');
  assert.deepEqual((await first).rows, [{pid:101, nativePipe:'pipe-one'}]);
  const second = reader.scan();
  assert.deepEqual(child.requests, ['scan\n', 'scan\n']);
  child.stdout.write('{"rows":[{"pid":101,"nativePipe":"pipe-new"},{"pid":102}],"windowsProbe":{"sessionPipe":"timeout","toolPipeTimeouts":["pipe-three"]}}\n');
  assert.deepEqual(await second, {
    rows: [{pid:101, nativePipe:'pipe-new'}, {pid:102}],
    windowsProbe: {sessionPipe:'timeout', toolPipeTimeouts:['pipe-three']},
  });
  assert.equal(children.length, 1);
});

test('分片 UTF-8 回执完整拼接，原始错误只消费，不进入结果', async t => {
  const {reader, children} = discoveryFixture(t);
  const reading = reader.scan(), child = children[0];
  const body = Buffer.from('{"rows":[{"label":"合成电脑"}]}\n');
  const split = body.indexOf(Buffer.from('合')) + 1;
  child.stderr.write('合成私有路径与错误');
  child.stdout.write(body.subarray(0, split));
  child.stdout.write(body.subarray(split));
  assert.deepEqual((await reading).rows, [{label:'合成电脑'}]);
});

test('异常、非法回执或超时使本轮失败，后续扫描重建进程且不使用旧结果', async t => {
  for (const failure of ['error', 'exit', 'null', 'invalid', 'extra', 'large', 'reported', 'timeout']) {
    const {reader, children} = discoveryFixture(t, 20);
    const reading = reader.scan(), child = children[0];
    const rejected = assert.rejects(reading, {message:'实例身份核对暂时失败', code:failure === 'timeout' ? 'DISCOVERY_TIMEOUT' : 'DISCOVERY_FAILED'});
    if (failure === 'error') child.emit('error', Error('合成私有错误'));
    if (failure === 'exit') child.emit('exit', 1);
    if (failure === 'null') child.stdout.write('null\n');
    if (failure === 'invalid') child.stdout.write('invalid\n');
    if (failure === 'extra') child.stdout.write('{"rows":[]}\n{"rows":[]}\n');
    if (failure === 'large') child.stdout.write('x'.repeat(65537));
    if (failure === 'reported') child.stdout.write('{"error":"INSTANCE_IDENTITY_INCOMPLETE"}\n');
    await rejected;
    assert.equal(child.killed, true, failure);
    const next = reader.scan();
    child.stdout.write('{"rows":[{"pid":999}]}\n');
    children[1].stdout.write('{"rows":[]}\n');
    assert.deepEqual((await next).rows, []);
  }
});

test('关闭扫描器拒绝在途与后续读取，只结束自己创建的帮助进程', async t => {
  const {reader, children} = discoveryFixture(t);
  const reading = reader.scan();
  const rejected = assert.rejects(reading, {message:'实例身份核对暂时失败'});
  reader.close();
  await rejected;
  assert.equal(children[0].killed, true);
  await assert.rejects(reader.scan(), {message:'实例身份核对暂时失败'});
  assert.equal(children.length, 1);
});
