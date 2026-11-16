param([switch]$AsObject,[switch]$Serve)
# 只枚举当前用户的原桌面，仅读取定位需要的两个环境字段，不读取鉴权文件。
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
if (-not ('InstanceEnvironment' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class InstanceEnvironment {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] buffer,IntPtr size,out IntPtr read);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int info,IntPtr[] data,int size,out int returned);
 // 直接读取进程令牌的用户 SID，保留同用户约束，避免逐进程发起额外的 WMI 方法调用。
 public static string OwnerSid(int pid) {
  var process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)throw new InvalidOperationException();
  IntPtr token=IntPtr.Zero;
  try {
   if(!OpenProcessToken(process,8,out token))throw new InvalidOperationException();
   using(var identity=new System.Security.Principal.WindowsIdentity(token)){return identity.User.Value;}
  }finally{if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
 }
 // x64 原桌面的 PEB 与进程参数只读定位；失败则不猜测其他实例的用户目录。
 public static string[] Read(int pid) {
  if(IntPtr.Size!=8)throw new InvalidOperationException();
  var handle=OpenProcess(0x410,false,pid);if(handle==IntPtr.Zero)throw new InvalidOperationException();
  try {
   var info=new IntPtr[6];int returned;if(NtQueryInformationProcess(handle,0,info,48,out returned)!=0)throw new InvalidOperationException();
   var parameters=Pointer(handle,new IntPtr(info[1].ToInt64()+0x20));
   var environment=Pointer(handle,new IntPtr(parameters.ToInt64()+0x80));
   var text=new StringBuilder();bool ended=false;
   for(int offset=0;offset<1048576;offset+=4096){var bytes=new byte[4096];IntPtr read;if(!ReadProcessMemory(handle,new IntPtr(environment.ToInt64()+offset),bytes,new IntPtr(bytes.Length),out read)||read.ToInt64()<2)break;text.Append(Encoding.Unicode.GetString(bytes,0,(int)read));if(text.ToString().IndexOf("\0\0",StringComparison.Ordinal)>=0){ended=true;break;}}
   if(!ended)throw new InvalidOperationException();
   var result=new string[2];foreach(var line in text.ToString().Split('\0')){if(line.StartsWith("CODEX_HOME=",StringComparison.OrdinalIgnoreCase))result[0]=line.Substring(11);else if(line.StartsWith("CODEX_ELECTRON_USER_DATA_PATH=",StringComparison.OrdinalIgnoreCase))result[1]=line.Substring(30);}
   return result;
  }finally{CloseHandle(handle);}
 }
 static IntPtr Pointer(IntPtr handle,IntPtr address){var bytes=new byte[8];IntPtr read;if(!ReadProcessMemory(handle,address,bytes,new IntPtr(8),out read)||read.ToInt64()!=8)throw new InvalidOperationException();return new IntPtr(BitConverter.ToInt64(bytes,0));}
}
'@
}

# 每轮重新读取系统事实；常驻模式只复用 PowerShell 和只读辅助类型。
function Get-DesktopInstances {
$native=& (Join-Path $PSScriptRoot 'windows-native-pipe.ps1') -AsObject
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# 同轮候选与独占性判断使用同一份实时进程清单，仍涵盖尚未建立工具管道的第二个桌面。
$processes=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'")
$listeners=$null
$failedIdentity=$false
$result=@(foreach($candidate in $native.candidates){
 try {
  $process=$processes|Where-Object {$_.ProcessId -eq $candidate.pid}|Select-Object -First 1
  if(!$process -or $process.CommandLine -match '--type='){continue}
  if([InstanceEnvironment]::OwnerSid([int]$candidate.pid) -ne $sid){continue}
  $environment=[InstanceEnvironment]::Read([int]$candidate.pid)
  $instanceHome=if($environment[0]){$environment[0]}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'}
  if(![IO.Path]::IsPathRooted($instanceHome)){$failedIdentity=$true;continue}
  $userData=$environment[1]
  if(!$userData -and $process.CommandLine -match '--user-data-dir(?:=|\s+)(?:"([^"]+)"|(\S+))'){$userData=if($Matches[1]){$Matches[1]}else{$Matches[2]}}
  $port=$null
  if($process.CommandLine -match '--remote-debugging-port[= ](\d+)'){
   $number=[int]$Matches[1]
   # 仅带调试端口的实例需要监听表，本轮多实例共用一次查询；查询失败时拒绝不完整身份。
   if($null -eq $listeners){$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop)}
   $bindings=@($listeners|Where-Object {$_.LocalPort -eq $number})
   if($bindings.Count -eq 1 -and $bindings[0].LocalAddress -eq '127.0.0.1' -and $bindings[0].OwningProcess -eq $candidate.pid){$port=$number}
  }
  [pscustomobject]@{pid=[int]$candidate.pid;startedAt=([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds();nativePipe=$candidate.path;codexHome=[IO.Path]::GetFullPath($instanceHome);userData=$userData;port=$port;executable=$process.ExecutablePath}
 } catch { $failedIdentity=$true }
})
if($failedIdentity){throw 'INSTANCE_IDENTITY_INCOMPLETE'}
# 普通启动时只有一个官方桌面主进程，且会话 IPC 由同一进程提供，才允许单实例直连。
# 主进程枚举同时覆盖尚未建立工具管道的第二个实例。
if($result.Count -eq 1 -and !$result[0].port -and $native.ipcProcessId -eq $result[0].pid){
 $sessionId=(Get-Process -Id $PID).SessionId
 $desktopProcesses=@($processes | Where-Object {
  $_.SessionId -eq $sessionId -and (!$_.ExecutablePath -or $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$') -and $_.CommandLine -notmatch '--type='
 })
 if($desktopProcesses.Count -eq 1 -and $desktopProcesses[0].ProcessId -eq $result[0].pid){
  $result[0] | Add-Member -NotePropertyName soleIpc -NotePropertyValue $true
 }
}
$sessionPipeProbe=$native.sessionPipeProbe
if($result.Count -eq 1 -and $native.ipcProcessId -and $native.ipcProcessId -ne $result[0].pid){$sessionPipeProbe='owner_mismatch'}
return @{rows=$result;windowsProbe=@{sessionPipe=$sessionPipeProbe;toolPipeTimeouts=@($native.toolPipeTimeouts)}}
}

if ($Serve) {
 while (($request = [Console]::ReadLine()) -ne $null) {
  if ($request -ne 'scan') { break }
  try {
   [Console]::WriteLine((ConvertTo-Json -InputObject (Get-DesktopInstances) -Depth 4 -Compress))
  } catch {
   [Console]::WriteLine('{"error":"INSTANCE_IDENTITY_INCOMPLETE"}')
  }
 }
} else {
 $result = (Get-DesktopInstances).rows
 if($AsObject){Write-Output -NoEnumerate $result}else{[Console]::WriteLine((ConvertTo-Json -InputObject $result -Depth 3 -Compress))}
}
