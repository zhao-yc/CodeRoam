# 只允许桌面原生归档工具；不操作窗口、审批、安装文件或 Codex 数据库。
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ArchivePipe {
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint processId);
}
'@
$script:pipe=$null
$script:committed=$false
$script:requestId=0
function Write-Result($Value){[Console]::WriteLine(($Value|ConvertTo-Json -Compress -Depth 8))}
function Assert-Deadline {if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$script:inputData.deadline){throw 'ARCHIVE_DEADLINE'}}
# 按帧长限量读取，断线与超时不重放原生写操作。
function Read-Exact([int]$Length){
  $bytes=New-Object byte[] $Length;$offset=0
  while($offset -lt $Length){Assert-Deadline;$read=$script:pipe.ReadAsync($bytes,$offset,$Length-$offset);if(!$read.Wait([Math]::Max(1,[Math]::Min(5000,[long]$script:inputData.deadline-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())))){throw 'ARCHIVE_PIPE_TIMEOUT'};if($read.Result -le 0){throw 'ARCHIVE_PIPE_CLOSED'};$offset+=$read.Result}
  return ,$bytes
}
function Send-NativeRequest([string]$Method,$Params){
  Assert-Deadline;$script:requestId++
  $body=[Text.Encoding]::UTF8.GetBytes((@{id=$script:requestId;jsonrpc='2.0';method=$Method;params=$Params}|ConvertTo-Json -Compress -Depth 12))
  $prefix=[BitConverter]::GetBytes([int]$body.Length);$script:pipe.Write($prefix,0,4);$script:pipe.Write($body,0,$body.Length);$script:pipe.Flush()
  $length=[BitConverter]::ToInt32((Read-Exact 4),0);if($length -lt 1 -or $length -gt 2097152){throw 'ARCHIVE_BAD_FRAME'}
  $reply=[Text.Encoding]::UTF8.GetString((Read-Exact $length))|ConvertFrom-Json
  if($reply.error -or $reply.id -ne $script:requestId){throw 'ARCHIVE_NATIVE_REJECTED'}
  return $reply.result
}
try{
  $script:inputData=[Console]::ReadLine()|ConvertFrom-Json
  if($script:inputData.threadId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $script:inputData.hostId -notin @('local','durable')){throw 'ARCHIVE_BAD_INPUT'}
  # 优先使用桌面给本机服务继承的原生工具管道；手机不能传入管道名称。
  $preferred=[IO.Path]::GetFileName($env:CODEX_APP_TOOLS_PIPE_PATH)
  # 多实例约束仅来自电脑连接服务，固定管道消失时不能退回扫描其他实例。
  $bound=$script:inputData.PSObject.Properties.Name -contains 'nativePipe'
  if($bound){
    if($script:inputData.nativePipe -notmatch '^\\\\\.\\pipe\\codex-app-tools-[0-9a-f-]+$' -or [long]$script:inputData.processId -le 0){throw 'ARCHIVE_BAD_PIPE'}
    $preferred=[IO.Path]::GetFileName($script:inputData.nativePipe)
  }
  if($preferred -and $preferred -notmatch '^codex-app-tools-[0-9a-f-]+$'){throw 'ARCHIVE_BAD_PIPE'}
  $pipes=[IO.Directory]::GetFiles('\\.\pipe\')
  if($preferred -and !@($pipes|Where-Object {[IO.Path]::GetFileName($_) -eq $preferred}).Count){if($bound){throw 'ARCHIVE_PROCESS_UNAVAILABLE'};$preferred=''}
  $candidates=@()
  foreach($file in $pipes){
    Assert-Deadline;$name=[IO.Path]::GetFileName($file);if($name -notmatch '^codex-app-tools-[0-9a-f-]+$'){continue}
    if($preferred -and $name -ne $preferred){continue}
    $candidate=New-Object IO.Pipes.NamedPipeClientStream('.',$name,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
    try{
      $candidate.Connect(400);[uint32]$serverProcessId=0
      if(![ArchivePipe]::GetNamedPipeServerProcessId($candidate.SafePipeHandle.DangerousGetHandle(),[ref]$serverProcessId)){throw 'ARCHIVE_PROCESS_UNAVAILABLE'}
      if($bound -and $serverProcessId -ne [long]$script:inputData.processId){throw 'ARCHIVE_PROCESS_MISMATCH'}
      $process=Get-Process -Id $serverProcessId
      if($process.Path -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$'){throw 'ARCHIVE_PROCESS_MISMATCH'}
      $script:pipe=$candidate;$tools=Send-NativeRequest 'tools/list' @{threadStartKind='all'}
      $supported=@($tools.tools|Where-Object {$_.namespace -eq 'codex_app' -and $_.name -eq 'set_thread_archived' -and $_.inputSchema.properties.threadId -and $_.inputSchema.properties.archived})
      if($supported.Count -ne 1){throw 'ARCHIVE_UNSUPPORTED'}
      $candidates+=@{pipe=$candidate;processId=$serverProcessId}
    }catch{$candidate.Dispose()}
  }
  # 独立托管不继承桌面管道；多个合法进程时，仅选择唯一可见的原桌面窗口。
  if(@($candidates|ForEach-Object {$_.processId}|Select-Object -Unique).Count -gt 1){
    $visible=@($candidates|Where-Object {
      $owner=Get-Process -Id $_.processId -ErrorAction SilentlyContinue
      $owner -and $owner.MainWindowHandle -ne [IntPtr]::Zero -and $owner.MainWindowTitle -in @('ChatGPT','Codex')
    })
    if(@($visible|ForEach-Object {$_.processId}|Select-Object -Unique).Count -eq 1){
      foreach($entry in $candidates){if($entry.processId -ne $visible[0].processId){$entry.pipe.Dispose()}}
      $candidates=$visible
    }
  }
  if(@($candidates|ForEach-Object {$_.processId}|Select-Object -Unique).Count -ne 1){foreach($entry in $candidates){$entry.pipe.Dispose()};throw 'ARCHIVE_PROCESS_AMBIGUOUS'}
  $script:pipe=$candidates[0].pipe;foreach($entry in $candidates|Select-Object -Skip 1){$entry.pipe.Dispose()}
  Write-Result @{stage='ready'}
  $decision=[Console]::ReadLine()|ConvertFrom-Json;if($decision.commit -ne $true){throw 'ARCHIVE_CANCELED'}
  Assert-Deadline;$script:committed=$true
  # 始终显式指定目标编号，绝不使用工具的“当前会话”默认值，也不清理工作树。
  $result=Send-NativeRequest 'tools/call' @{namespace='codex_app';tool='set_thread_archived';arguments=@{source='codex';threadId=$script:inputData.threadId;hostId=$script:inputData.hostId;archived=$true};callerSource='codex';callId=$script:inputData.commandId;threadId=$script:inputData.threadId;turnId=$script:inputData.commandId;hostId=$script:inputData.hostId}
  if($result.isError -eq $true){throw 'ARCHIVE_NATIVE_REJECTED'}
  Write-Result @{stage='done'}
}catch{Write-Result @{stage='error';outcomeUnknown=$script:committed};exit 1}
finally{if($script:pipe){$script:pipe.Dispose()}}
