import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const execute = promisify(execFile);
const failure = message => Object.assign(new Error(message), {code: 'MANAGEMENT_MIGRATION_FAILED'});
const sameFile = (a, b) => {
  try {
    const real = name => fs.realpathSync.native(name);
    return process.platform === 'win32' ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b);
  } catch { return false; }
};

const windows = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$services=@(Get-CimInstance Win32_Service -Filter "Name='CodeRoamBridge' OR Name='CodexMobileBridge'")
if(!$services.Count){
  if($env:CODEROAM_LEGACY_ACTION -eq 'read'){exit 0}
  throw 'service disappeared'
}
if($services.Count -ne 1){throw 'multiple services'}
$service=$services[0]
$programData=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$image=[IO.Path]::GetFullPath($service.PathName.Trim('"'))
if(!$image.StartsWith($programData+'\',[StringComparison]::OrdinalIgnoreCase) -or
   [IO.Path]::GetFileName($image) -notin @('CodeRoamBridge.exe','CodexMobileBridge.exe')){throw 'unexpected service path'}
$directory=Split-Path -Parent $image
$manifest=Join-Path $directory 'service.json'
$trusted=@('S-1-5-18','S-1-5-32-544')
$writeRights=[Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
foreach($file in @($directory,$image,$manifest)){
  $attributes=[IO.File]::GetAttributes($file)
  if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'unexpected link'}
  $acl=if($attributes -band [IO.FileAttributes]::Directory){[IO.Directory]::GetAccessControl($file)}else{[IO.File]::GetAccessControl($file)}
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'unexpected owner'}
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and ($rule.FileSystemRights -band $writeRights)){throw 'unsafe write access'}
  }
}
$settings=Get-Content -Raw -Encoding UTF8 -LiteralPath $manifest | ConvertFrom-Json
if($settings.UserSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){exit 0}
if($env:CODEROAM_LEGACY_ACTION -eq 'read'){
  [pscustomobject]@{name=$service.Name; worker=$settings.WorkerConfig; mode=$service.StartMode; state=$service.State; pid=$service.ProcessId} | ConvertTo-Json -Compress
  exit 0
}
if($env:CODEROAM_LEGACY_SERVICE -ne $service.Name -or $env:CODEROAM_LEGACY_WORKER -ne $settings.WorkerConfig){throw 'service changed'}
$supervisorId=[int]$env:CODEROAM_LEGACY_PID
if($service.State -ne 'Stopped'){
  $supervisor=Get-CimInstance Win32_Process -Filter "ProcessId=$supervisorId"
  if(!$supervisor -or $supervisor.ParentProcessId -ne $service.ProcessId){throw 'unexpected supervisor'}
}
if($env:CODEROAM_LEGACY_ACTION -eq 'verify'){exit 0}
if($env:CODEROAM_LEGACY_ACTION -ne 'retire'){throw 'unexpected action'}
if($service.StartMode -ne 'Disabled'){
  $result=Start-Process -FilePath (Join-Path ([Environment]::SystemDirectory) 'sc.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('config',$service.Name,'start=','disabled')
  if($result.ExitCode -ne 0){throw 'service disable failed'}
}
if($service.State -ne 'Stopped'){
  Stop-Service -Name $service.Name
  (Get-Service -Name $service.Name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(15))
}
$verified=Get-CimInstance Win32_Service -Filter ("Name='" + $service.Name + "'")
if($verified.State -ne 'Stopped' -or $verified.StartMode -ne 'Disabled'){throw 'legacy service still enabled'}
`;

async function windowsAction(action, legacy, supervisor = 0) {
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const {stdout} = await execute(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windows, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: action === 'retire' ? 90000 : 8000, maxBuffer: 65536,
      env: {...process.env, CODEROAM_LEGACY_ACTION: action, CODEROAM_LEGACY_SERVICE: legacy?.name ?? '',
        CODEROAM_LEGACY_WORKER: legacy?.worker ?? '', CODEROAM_LEGACY_PID: String(supervisor)},
    });
    return action === 'read' && stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    throw failure(action === 'retire'
      ? '旧 Windows 服务尚未完成迁移，请确认管理员授权后重试'
      : '无法核对旧 Windows 服务的账号或托管归属');
  }
}

const launchctl = args => execute('/bin/launchctl', args, {timeout: 6000, maxBuffer: 65536, env: {...process.env, LC_ALL: 'C'}});
const legacyLabel = 'com.coderoam.bridge';

async function readMacJob() {
  const target = 'gui/' + process.getuid() + '/' + legacyLabel;
  try {
    const {stdout} = await launchctl(['print', target]);
    const pid = Number(/^\s*pid\s*=\s*(\d+)\s*$/m.exec(stdout)?.[1]) || 0;
    return {target, pid};
  } catch (error) {
    if (/could not find service/i.test(error.stderr ?? '')) return null;
    throw failure('无法核对旧 macOS 登录项的进程');
  }
}

async function readMacRegistration() {
  const {homedir, uid} = os.userInfo();
  const directory = path.join(homedir, 'Library', 'LaunchAgents');
  const file = path.join(directory, legacyLabel + '.plist');
  try {
    const info = fs.lstatSync(file), parent = fs.lstatSync(directory);
    if (!info.isFile() || info.uid !== uid || info.size > 65536 || (info.mode & 0o022) ||
        !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022)) throw failure('旧 macOS 登录项归属异常');
    const read = async key => (await execute('/usr/bin/plutil', ['-extract', key, 'json', '-o', '-', file], {timeout: 3000, maxBuffer: 65536})).stdout;
    const args = JSON.parse(await read('ProgramArguments'));
    if ((await execute('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', file], {timeout: 3000, maxBuffer: 65536})).stdout.trim() !== legacyLabel ||
        !Array.isArray(args) || args.length !== 4 || args[2] !== '--config' ||
        !path.isAbsolute(args[0]) || !path.isAbsolute(args[1]) || path.basename(args[1]) !== 'service-supervisor.mjs' || !path.isAbsolute(args[3])) {
      throw failure('旧 macOS 登录项入口与 CodeRoam 守护不匹配');
    }
    const bytes = fs.readFileSync(file);
    return {file, bytes, info, worker: args[3]};
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(file)) return null;
    if (error.code === 'MANAGEMENT_MIGRATION_FAILED') throw error;
    throw failure('无法读取旧 macOS 登录项');
  }
}

function gone(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** 从已核对的系统服务或用户登录项发现托管文件，兼容旧安装位置。 */
export async function discoverLegacyWorker(platform = process.platform) {
  if (platform === 'win32') return (await windowsAction('read'))?.worker ?? '';
  if (platform === 'darwin') return (await readMacRegistration())?.worker ?? '';
  return '';
}

/** 只迁移与选定托管配置绑定的旧服务；失败时保留可核对的原配置和账本。 */
export function createLegacyMigration({connect, login, platform = process.platform, controlWindows = windowsAction, processGone = gone}) {
  return async worker => {
    if (platform !== 'win32' && platform !== 'darwin') return;
    const isWindows = platform === 'win32';
    const legacy = isWindows ? await controlWindows('read') : await readMacRegistration();
    if (!legacy || !sameFile(worker, legacy.worker)) return;
    if (isWindows && legacy.mode === 'Disabled' && legacy.state === 'Stopped') return;
    const client = connect(worker);
    const macJob = isWindows ? null : await readMacJob();
    const status = await client.request('status').catch(() => null);
    if (isWindows && (legacy.state === 'Stopped') === Boolean(status) || macJob?.pid && macJob.pid !== status?.supervisorPid) {
      throw failure('旧守护尚未通过归属验证，请稍后重试');
    }
    if (isWindows) await controlWindows('verify', legacy, status?.supervisorPid);
    else if (status && !macJob?.pid) throw failure('当前守护并非由旧登录项启动，请先从原启动入口正常退出');
    let prepared;
    try {
      if (status) {
        prepared = await client.request('service.prepareQuit');
        if (prepared.pid !== status.supervisorPid) throw failure('旧守护进程归属已变化');
      }
      // 先登记同样的自启动偏好。即使迁移中断，下次启动仍会先核对旧服务。
      if (!isWindows || legacy.mode === 'Auto') login.set(true);
      if (isWindows) await controlWindows('retire', legacy, prepared?.pid);
      else {
        if (macJob) await launchctl(['bootout', macJob.target]);
        const current = fs.lstatSync(legacy.file);
        if (current.dev !== legacy.info.dev || current.ino !== legacy.info.ino || !fs.readFileSync(legacy.file).equals(legacy.bytes)) {
          throw failure('旧登录项已变化，请核对后重试');
        }
        fs.unlinkSync(legacy.file);
      }
      for (let attempt = 0; attempt < 60; attempt++) {
        if (processGone(prepared?.pid) && processGone(status?.pid)) return;
        await delay(100);
      }
      throw failure('旧守护或桥接尚未退出，请稍后重试');
    } catch (error) {
      if (prepared && !processGone(prepared.pid)) {
        await client.request('service.cancelQuit').catch(() => {});
        if (prepared.wasRunning) await client.request('service.start').catch(() => {});
      }
      if (error.code?.startsWith('MANAGEMENT_')) throw error;
      throw failure('旧守护迁移未完成，请从管理窗口查看状态后重试');
    }
  };
}
