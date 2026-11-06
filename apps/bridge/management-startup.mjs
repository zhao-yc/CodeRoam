import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const winPath = path.win32;
const serviceName = 'CodexMobileBridge';
const supervisorPath = fileURLToPath(new URL('./service-supervisor.mjs', import.meta.url));
const failure = (message, code) => Object.assign(new Error(message), {code});

const queryScript = String.raw`
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $service = Get-CimInstance Win32_Service -Filter "Name='CodexMobileBridge'"
  if ($null -ne $service) {
    [pscustomobject]@{
      name = $service.Name
      processId = $service.ProcessId
      image = $service.PathName
      mode = $service.StartMode
      programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
      userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    } | ConvertTo-Json -Compress
  }
`;

function samePath(left, right) {
  return [left, right].every(value => typeof value === 'string' && winPath.isAbsolute(value))
    && winPath.normalize(left).toLowerCase() === winPath.normalize(right).toLowerCase();
}

function readHostConfig(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

async function runPowerShell(script, timeout) {
  const powershell = winPath.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const {stdout} = await exec(powershell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 65536});
  return stdout.trim();
}

/** 仅允许当前 Windows 服务宿主实际托管的守护读取和变更自身启动类型。 */
export function createWindowsStartupControl({workerConfigPath, projectRoot}, {
  runtime = process, supervisor = supervisorPath, execute = runPowerShell, readHost = readHostConfig,
} = {}) {
  if (runtime.platform !== 'win32' || !workerConfigPath) return null;

  let changing = false;
  let querying;
  async function queryMode() {
    try {
      const output = await execute(queryScript, 4500);
      if (!output) return undefined;
      const service = JSON.parse(output);
      if (service.name !== serviceName || service.processId !== runtime.ppid || !['Auto', 'Manual', 'Disabled'].includes(service.mode)) return undefined;
      const image = /^"([^"]+)"$/.exec(service.image)?.[1] ?? service.image;
      if (typeof image !== 'string' || winPath.basename(image).toLowerCase() !== 'codexmobilebridge.exe') return undefined;
      if (typeof service.programData !== 'string' || !winPath.isAbsolute(image) || !winPath.isAbsolute(service.programData)) return undefined;
      const relative = winPath.relative(service.programData, image);
      if (!relative || relative.split(winPath.sep)[0] === '..' || winPath.isAbsolute(relative)) return undefined;
      const host = readHost(winPath.join(winPath.dirname(image), 'service.json'));
      if (!host || typeof service.userSid !== 'string' || !service.userSid || host.UserSid !== service.userSid
        || !samePath(host.WorkerConfig, workerConfigPath) || !samePath(host.SupervisorPath, supervisor)
        || !samePath(host.NodePath, runtime.execPath) || !samePath(host.ProjectRoot, projectRoot)) return undefined;
      return service.mode;
    } catch { return undefined; }
  }

  function readMode() {
    querying ??= queryMode().finally(() => { querying = undefined; });
    return querying;
  }

  return {
    async read() {
      const mode = await readMode();
      return mode === undefined ? undefined : mode === 'Auto';
    },
    async set(enabled) {
      if (typeof enabled !== 'boolean') throw failure('开机启动开关必须是布尔值', 'MANAGEMENT_REQUEST_INVALID');
      if (changing) throw failure('正在等待上一次开机启动设置的 Windows 确认', 'MANAGEMENT_BUSY');
      changing = true;
      try {
        const current = await readMode();
        if (current === undefined) throw failure('无法核实此守护对应的 Windows 服务', 'MANAGEMENT_STARTUP_UNAVAILABLE');
        const desired = enabled ? 'Auto' : 'Manual';
        if (current === desired) return {startupEnabled: enabled};

        // 管理员确认只提升系统自带的 sc.exe，普通用户始终不能更改服务程序或账户。
        const script = `
          $ErrorActionPreference = 'Stop'
          try {
            $result = Start-Process -FilePath (Join-Path ([Environment]::SystemDirectory) 'sc.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('config', 'CodexMobileBridge', 'start=', '${enabled ? 'auto' : 'demand'}')
            [Console]::WriteLine($result.ExitCode)
          } catch {
            for ($errorDetail = $_.Exception; $null -ne $errorDetail; $errorDetail = $errorDetail.InnerException) {
              if ($errorDetail -is [ComponentModel.Win32Exception] -and $errorDetail.NativeErrorCode -eq 1223) {
                [Console]::WriteLine('canceled')
                exit 0
              }
            }
            exit 1
          }
        `;
        let result;
        try {
          // 管道可能先超时，仍保留写锁直到系统确认结束，避免出现两个提权请求。
          result = await execute(script, 0);
        } catch {
          throw failure('Windows 未完成开机启动设置，请检查管理员授权后重试', 'MANAGEMENT_STARTUP_FAILED');
        }
        if (result === 'canceled') throw failure('已取消 Windows 管理员确认', 'MANAGEMENT_STARTUP_CANCELED');
        if (result !== '0' || await queryMode() !== desired) {
          throw failure('未能确认 Windows 开机启动状态，请刷新后重试', 'MANAGEMENT_STARTUP_FAILED');
        }
        return {startupEnabled: enabled};
      } finally { changing = false; }
    },
  };
}

const macAgentLabel = 'com.coderoam.bridge';
const plistText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** 只管理本用户、当前托管入口生成的登录项。launchd 会在下次登录时读取该文件。 */
export function createMacStartupControl({workerConfigPath, projectRoot}, {
  runtime = process, supervisor = supervisorPath, user = os.userInfo,
} = {}) {
  if (runtime.platform !== 'darwin') return null;
  const paths = [runtime.execPath, supervisor, workerConfigPath, projectRoot];
  if (paths.some(value => typeof value !== 'string' || !path.posix.isAbsolute(value) || /[\x00-\x1f]/.test(value))) return null;
  let account;
  try { account = user(); } catch { return null; }
  const {uid, homedir} = account;
  if (uid <= 0 || !path.posix.isAbsolute(homedir)) return null;
  const directory = path.join(homedir, 'Library', 'LaunchAgents');
  const file = path.join(directory, macAgentLabel + '.plist');
  const args = [runtime.execPath, supervisor, '--config', workerConfigPath];
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${macAgentLabel}</string>`,
    '<key>ProgramArguments</key><array>',
    ...args.map(value => `<string>${plistText(value)}</string>`),
    '</array>',
    `<key>WorkingDirectory</key><string>${plistText(projectRoot)}</string>`,
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    '</dict></plist>',
    '',
  ].join('\n');

  function checkDirectory() {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) throw Error('登录项目录归属或权限异常');
  }

  function read() {
    try {
      checkDirectory();
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o022) !== 0 || info.size !== Buffer.byteLength(content)) return undefined;
      return fs.readFileSync(file, 'utf8') === content ? true : undefined;
    } catch (error) { return error.code === 'ENOENT' ? false : undefined; }
  }

  return {
    read,
    set(enabled) {
      if (typeof enabled !== 'boolean') throw failure('开机启动开关必须是布尔值', 'MANAGEMENT_REQUEST_INVALID');
      const current = read();
      if (current === undefined) throw failure('无法确认 macOS 登录项归属，请检查现有登录项', 'MANAGEMENT_STARTUP_UNAVAILABLE');
      if (current === enabled) return {startupEnabled: enabled};
      try {
        if (enabled) {
          fs.mkdirSync(directory, {recursive: true, mode: 0o700});
          checkDirectory();
          // 先写好完整文件，再原子创建固定入口。已有同名登录项时保留现场。
          const temporary = fs.mkdtempSync(path.join(directory, '.coderoam-'));
          const candidate = path.join(temporary, 'agent.plist');
          try {
            fs.writeFileSync(candidate, content, {mode: 0o600, flag: 'wx'});
            fs.linkSync(candidate, file);
          } finally {
            try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            fs.rmdirSync(temporary);
          }
        } else {
          // 删除下次登录的配置，无需卸载当前会话中已运行的守护。
          fs.unlinkSync(file);
        }
        if (read() !== enabled) throw Error('登录项状态未确认');
        return {startupEnabled: enabled};
      } catch {
        throw failure('未能确认 macOS 登录启动设置，请刷新后重试', 'MANAGEMENT_STARTUP_FAILED');
      }
    },
  };
}
