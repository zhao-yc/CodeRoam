import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash, randomUUID} from 'node:crypto';

const execute = promisify(execFile);
const problem = message => new Error(message);
const revision = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const validLaunch = value => Number.isSafeInteger(value?.pid) && value.pid > 0 &&
  typeof value.node === 'string' && path.isAbsolute(value.node) &&
  typeof value.supervisor === 'string' && path.isAbsolute(value.supervisor) &&
  path.basename(value.supervisor) === 'service-supervisor.mjs';

const windowsService = String.raw`
$ErrorActionPreference = 'Stop'
$service = Get-CimInstance Win32_Service -Filter "Name='CodexMobileBridge'"
if (!$service) { [Console]::WriteLine('unmanaged'); exit 0 }
$image = $service.PathName.Trim('"')
$root = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if (![IO.Path]::IsPathRooted($image) -or [IO.Path]::GetFileName($image) -ne 'CodexMobileBridge.exe' -or
    ![IO.Path]::GetFullPath($image).StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) {
  [Console]::WriteLine('unmanaged'); exit 0
}
$hostConfig = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $image) 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IO.Path]::GetFullPath($hostConfig.WorkerConfig) -ne [IO.Path]::GetFullPath($env:CODEROAM_SESSION_WORKER)) { [Console]::WriteLine('unmanaged'); exit 0 }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($hostConfig.UserSid -ne $identity) { throw '托管服务账号不匹配' }
if ($env:CODEROAM_SESSION_ACTION -eq 'start') {
  Start-Service -Name 'CodexMobileBridge'
} elseif ($env:CODEROAM_SESSION_ACTION -eq 'stop') {
  if ($service.State -eq 'Stopped') { [Console]::WriteLine('unmanaged'); exit 0 }
  $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$env:CODEROAM_SESSION_PID)
  if (!$parent -or $parent.ParentProcessId -ne $service.ProcessId) { throw '托管进程归属已变化' }
  Stop-Service -Name 'CodexMobileBridge'
  (Get-Service -Name 'CodexMobileBridge').WaitForStatus('Stopped',[TimeSpan]::FromSeconds(12))
} else { throw '无效的服务操作' }
[Console]::WriteLine('managed')
`;

async function manageWindows(action, worker, pid) {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const {stdout} = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsService, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 18000, maxBuffer: 65536,
    env: {...process.env, CODEROAM_SESSION_WORKER: worker, CODEROAM_SESSION_ACTION: action, CODEROAM_SESSION_PID: String(pid)},
  });
  return stdout.trim() === 'managed';
}

const launchctl = args => execute('/bin/launchctl', args, {timeout: 5000, maxBuffer: 65536, env: {...process.env, LC_ALL: 'C'}});
const macDomain = () => 'gui/' + process.getuid();
const macPlist = () => path.join(os.userInfo().homedir, 'Library', 'LaunchAgents', 'com.coderoam.bridge.plist');

function macPlistRevision() {
  const file = macPlist();
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.size > 65536) throw problem('macOS 登录项归属异常');
    return revision(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function stopLaunchAgent(pid) {
  const target = macDomain() + '/com.coderoam.bridge';
  let info;
  try { info = (await launchctl(['print', target])).stdout; }
  catch (error) {
    if (/could not find service/i.test(error.stderr ?? '')) return false;
    throw error;
  }
  const match = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(info);
  if (Number(match?.[1]) !== pid) return null;
  const plistRevision = macPlistRevision();
  await launchctl(['bootout', target]);
  return {plistRevision};
}

async function waitUntil(check, message) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await check()) return;
    await delay(200);
  }
  throw problem(message);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function confirmedOffline(file) {
  const read = name => JSON.parse(fs.readFileSync(name, 'utf8').replace(/^\uFEFF/, ''));
  const worker = read(file);
  const endpoint = path.join(worker.runDirectory, 'management.json');
  try {
    const {pid} = read(endpoint);
    return Number.isSafeInteger(pid) && pid > 0 && !alive(pid);
  } catch (error) { if (error.code !== 'ENOENT') return false; }
  try {
    const {supervisorPid, entry} = read(path.join(worker.logDirectory, 'supervisor.json'));
    return entry === worker.entry && Number.isSafeInteger(supervisorPid) && supervisorPid > 0 && !alive(supervisorPid);
  } catch (error) { return error.code === 'ENOENT'; }
}

/** 托盘退出只控制已认证的当前守护。恢复记录绑定原托管文件，自动启动前重新核对。 */
export function createServiceSession({file, connect, platform = process.platform}) {
  const request = (worker, method) => connect(worker).request(method);
  function remember(record) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), {mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function removeRecord() {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  return {
    async close(worker) {
      if (!worker) return;
      let launch;
      try {
        launch = await request(worker, 'service.prepareQuit');
        if (!validLaunch(launch)) throw problem('守护未确认安全退出，请重试');
        const record = {worker, revision: revision(worker), launch};
        remember(record);
        if (platform === 'win32') record.windowsManaged = await manageWindows('stop', worker, launch.pid);
        if (platform === 'darwin') record.launchAgent = await stopLaunchAgent(launch.pid);
        if (record.windowsManaged || record.launchAgent) remember(record);
        else await request(worker, 'service.quit');
        await waitUntil(() => !alive(launch.pid), '仍在等待守护退出，请稍后重试');
      } catch (error) {
        if (!launch && error.code === 'MANAGEMENT_UNAVAILABLE' && confirmedOffline(worker)) return;
        if (validLaunch(launch) && alive(launch.pid)) {
          await request(worker, 'service.cancelQuit').catch(() => {});
          if (launch.wasRunning) await request(worker, 'service.start').catch(() => {});
          removeRecord();
        }
        throw error;
      }
    },
    async resume(worker) {
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw problem('无法读取上次的服务退出记录'); }
      if (record.worker !== worker || !worker) return;
      const status = await request(worker, 'status').catch(() => null);
      if (status) {
        if (status.serviceState === 'stopped') await request(worker, 'service.start');
      } else {
        if (!validLaunch(record.launch) || revision(worker) !== record.revision) throw problem('托管配置已变化，请重新关联服务');
        const {pid, node, supervisor} = record.launch;
        if (alive(pid)) throw problem('上一次守护尚未退出');
        if (platform === 'win32' && record.windowsManaged) {
          if (!await manageWindows('start', worker, pid)) throw problem('原 Windows 服务托管配置已变化');
        } else if (platform === 'darwin' && record.launchAgent?.plistRevision && macPlistRevision()) {
          if (macPlistRevision() !== record.launchAgent.plistRevision) throw problem('原 macOS 登录项已变化');
          await launchctl(['bootstrap', macDomain(), macPlist()]);
        } else {
          const child = spawn(node, [supervisor, '--config', worker], {detached: true, stdio: 'ignore', windowsHide: true});
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          child.unref();
        }
      }
      await waitUntil(async () => {
        const state = await request(worker, 'status').catch(() => null);
        return state?.running === true && state.serviceState === 'running';
      }, '守护启动尚未确认，请查看运行状态');
      removeRecord();
    },
  };
}
