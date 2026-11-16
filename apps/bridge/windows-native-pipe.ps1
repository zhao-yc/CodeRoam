# 只核对原桌面通道的服务进程与主窗口，不读取鉴权文件或操作界面。
param([ValidatePattern('^[A-Za-z0-9._-]+$')][string]$IpcPipeName='codex-ipc',[switch]$AsObject)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
if (-not ('NativePipeIdentity' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativePipeIdentity {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
}
'@
}
$found=New-Object 'System.Collections.Generic.List[object]'
$toolPipeTimeouts=New-Object 'System.Collections.Generic.List[string]'
foreach($file in [IO.Directory]::GetFiles('\\.\pipe\')) {
 $name=[IO.Path]::GetFileName($file)
 if($name -notmatch '^codex-app-tools-[0-9a-f-]+$'){continue}
 $pipe=New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
 try {
  $pipe.Connect(300)
  [uint32]$serverPid=0
  if(![NativePipeIdentity]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(),[ref]$serverPid)){continue}
  $owner=Get-Process -Id $serverPid
  if($owner.Path -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$'){continue}
  $found.Add([pscustomobject]@{path='\\.\pipe\'+$name;pid=$serverPid;hasWindow=($owner.MainWindowHandle -ne [IntPtr]::Zero)})
 } catch [System.TimeoutException] {
  if($toolPipeTimeouts.Count -lt 32){$toolPipeTimeouts.Add('\\.\pipe\'+$name)}
 } catch {} finally {$pipe.Dispose()}
}
# 后台服务没有聊天环境变量；只读查询正在使用的会话 IPC 服务进程来绑定实例。
$ipcProcessId=$null
$sessionPipeProbe='probe_failed'
$ipc=New-Object IO.Pipes.NamedPipeClientStream('.', $IpcPipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
try {
 $ipc.Connect(300)
 [uint32]$serverPid=0
 if([NativePipeIdentity]::GetNamedPipeServerProcessId($ipc.SafePipeHandle.DangerousGetHandle(),[ref]$serverPid)){$ipcProcessId=$serverPid;$sessionPipeProbe='owner_read'}
} catch [System.TimeoutException] {$sessionPipeProbe='timeout'} catch {} finally {$ipc.Dispose()}
$result=@{candidates=@($found.ToArray());ipcProcessId=$ipcProcessId}
# 探测细节仅供实例扫描进程比对，桥接日志只记录原因码。
if($AsObject){$result.sessionPipeProbe=$sessionPipeProbe;$result.toolPipeTimeouts=$toolPipeTimeouts.ToArray()}
if($AsObject){Write-Output $result}else{[Console]::WriteLine((ConvertTo-Json -InputObject $result -Depth 3 -Compress))}
