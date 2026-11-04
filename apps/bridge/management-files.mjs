import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

/** 新文件在创建时就赋予私有 ACL，兼容父目录只授予修改权限的普通用户。 */
export function createPrivateFile(file) {
  if(process.platform!=='win32'){fs.closeSync(fs.openSync(file,'wx',0o600));return;}
  const script="param([string]$target) $ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid); foreach($identity in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($identity)),'FullControl','Allow')))}; $stream=[IO.FileStream]::new($target,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$acl); $stream.Dispose()";
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const result=spawnSync(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','& { '+script+' } '+quote(path.resolve(file))],{windowsHide:true,stdio:'ignore',timeout:10000});
  if(result.status!==0)throw Object.assign(new Error('无法创建私有管理文件，请检查目录权限'),{code:'MANAGEMENT_FILE_PERMISSIONS'});
}

/** 私有管理材料仅允许当前用户及系统管理员访问，Windows 显式落实 ACL。 */
export function protectManagedFile(file) {
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return; }
  const script = "param([string]$target) $ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid); foreach($identity in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($identity)),'FullControl','Allow')))}; [IO.File]::SetAccessControl($target,$acl)";
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', '& { ' + script + ' } ' + quote(path.resolve(file))], {windowsHide: true, stdio: 'ignore', timeout: 10000});
  if (result.status !== 0) throw Object.assign(new Error('无法保护本机管理文件，请检查当前用户的文件权限'), {code: 'MANAGEMENT_FILE_PERMISSIONS'});
}

/** 随机临时文件先落实私有权限再原子替换，拒绝跟随既有链接。 */
export function writePrivateJson(file, value) {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('管理文件不能是链接'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  try {
    createPrivateFile(temporary);
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n');
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
