# 只核对原桌面通道的服务进程与主窗口，不读取鉴权文件或操作界面。
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativePipeIdentity {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
}
'@
$found=New-Object 'System.Collections.Generic.List[object]'
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
  $found.Add([pscustomobject]@{path='\\.\pipe\'+$name;pid=$serverPid})
 } catch {} finally {$pipe.Dispose()}
}
$chosen=$null
foreach($entry in $found){if($entry.path -eq $env:CODEX_APP_TOOLS_PIPE_PATH){$chosen=$entry;break}}
if($null -eq $chosen){
 $visible=New-Object 'System.Collections.Generic.List[object]'
 foreach($entry in $found){
  $owner=Get-Process -Id $entry.pid
  if($owner.MainWindowHandle -ne [IntPtr]::Zero -and $owner.MainWindowTitle -in @('ChatGPT','Codex')){$visible.Add($entry)}
 }
 if($visible.Count -eq 0 -and $found.Count -eq 1){$chosen=$found.get_Item(0)}
 elseif($visible.Count -eq 1){$chosen=$visible.get_Item(0)}
}
if($null -eq $chosen -or !$chosen.path){throw ('NATIVE_DESKTOP_AMBIGUOUS_'+$found.Count)}
[Console]::WriteLine((ConvertTo-Json -InputObject $chosen -Compress))
