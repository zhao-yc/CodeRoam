param([ValidateSet('all','bridge','mobile','tunnel','stop','logs','status')][string]$Action='all')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$runtimeDirectory=Join-Path $projectRoot '.local/run'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Set-Location -LiteralPath $projectRoot

# PID 文件与完整命令必须同时匹配，避免停止其他项目的进程。
function Get-ManagedProcess([string]$Name) {
  $recordPath=Join-Path $runtimeDirectory "$Name.json"
  if(!(Test-Path -LiteralPath $recordPath)){return $null}
  $record=Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $entry=Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
  if($null -eq $entry){return $null}
  if(!$entry.CommandLine.Contains([string]$record.marker)){throw "PID 已被其他进程复用，拒绝操作：$Name"}
  return $entry
}
function Save-ManagedProcess([string]$Name,[int]$ProcessId,[string]$Marker) {
  @{pid=$ProcessId;marker=$Marker} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDirectory "$Name.json") -Encoding utf8
}
function Start-Tunnel {
  if(!$env:CODEX_MOBILE_DEV_SERVER){throw '请通过 CODEX_MOBILE_DEV_SERVER 指定自己的开发服务器 SSH 别名'}
  $existing=Get-ManagedProcess 'tunnel'
  if($null -ne $existing){Write-Output '复用本项目的 开发隧道';return}
  $listener=Get-NetTCPConnection -State Listen -LocalPort 18787 -ErrorAction SilentlyContinue
  if($listener){throw '18787 已被其他进程占用，保留现场，请先核对来源'}
  $arguments=@('-N','-L','127.0.0.1:18787:127.0.0.1:18787','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',$env:CODEX_MOBILE_DEV_SERVER)
  $process=Start-Process -FilePath (Get-Command ssh.exe).Source -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory 'tunnel.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'tunnel.stderr.log')
  Save-ManagedProcess 'tunnel' $process.Id '127.0.0.1:18787:127.0.0.1:18787'
  $ready=$false
  for($attempt=0;$attempt -lt 20;$attempt++) {
    try{$response=Invoke-RestMethod 'http://127.0.0.1:18787/healthz' -TimeoutSec 2;if($response.protocolVersion -eq 1){$ready=$true;break}}catch{}
    if($process.HasExited){break}
    Start-Sleep -Milliseconds 300
  }
  if(!$ready){throw '开发隧道未就绪，请查看 .local/run/tunnel.stderr.log'}
  Write-Output '开发中转健康检查通过：http://127.0.0.1:18787/healthz'
}
function Start-Bridge {
  # 安装独立托管后统一交给服务管理，避免临时命令再启动第二个桥接。
  if($null -ne (Get-Service -Name 'CodexMobileBridge' -ErrorAction SilentlyContinue)) {
    & (Join-Path $PSScriptRoot 'bridge-service.ps1') -Action start
    return
  }
  if($null -ne (Get-ManagedProcess 'bridge')){Write-Output '复用本项目的电脑连接服务';return}
  $entry=Join-Path $projectRoot 'apps/bridge/cli.mjs'
  $config=Join-Path $projectRoot '.local/bridge.json'
  if(!(Test-Path -LiteralPath $config)){throw '请先执行 npm run provision 并完成凭据备份'}
  $node=(Get-Command node.exe).Source
  $node=& $node -p "require('node:fs').realpathSync(process.execPath)"
  $process=Start-Process -FilePath $node -ArgumentList @("`"$entry`"",'--config',"`"$config`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory 'bridge.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'bridge.stderr.log')
  Save-ManagedProcess 'bridge' $process.Id $entry
  $ready=$false
  for($attempt=0;$attempt -lt 40;$attempt++) {
    $statusFile=Join-Path $projectRoot '.local/bridge/runtime-status.json'
    if(Test-Path -LiteralPath $statusFile){try{$status=Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json;if($status.pid -eq $process.Id -and $status.connected){$ready=$true;break}}catch{}}
    if($process.HasExited){break};Start-Sleep -Milliseconds 250
  }
  if(!$ready){throw '电脑连接服务未就绪，请查看 .local/run/bridge.stderr.log'}
  Write-Output "电脑连接服务已启动，PID=$($process.Id)"
}
function Start-Mobile {
  $cli=if($env:HBX_CLI){$env:HBX_CLI}else{(Get-Command cli.exe -ErrorAction Stop).Source}
  $mobile=Join-Path $projectRoot 'apps/mobile'
  & $cli project open --path $mobile
  & $cli launch web --project $mobile --ui true --browser Built
  if($LASTEXITCODE -ne 0){throw 'HBuilderX 手机界面预览启动失败'}
}
function Stop-Managed {
  if($null -ne (Get-Service -Name 'CodexMobileBridge' -ErrorAction SilentlyContinue)) {
    & (Join-Path $PSScriptRoot 'bridge-service.ps1') -Action stop
    if($LASTEXITCODE -ne 0){throw '托管服务尚未停止，保留现场'}
  }
  foreach($name in @('bridge','tunnel')){
    $process=Get-ManagedProcess $name
    if($null -ne $process){Stop-Process -Id $process.ProcessId;Write-Output "已停止本项目服务：$name"}
  }
  Write-Output '手机界面预览由 HBuilderX 运行面板的停止按钮管理。'
}
switch($Action){
  'all'{if((Get-Content -LiteralPath '.local/bridge.json' -Raw -Encoding UTF8 | ConvertFrom-Json).relayUrl -like 'ws://127.0.0.1:*'){Start-Tunnel};Start-Bridge;Start-Mobile}
  'tunnel'{Start-Tunnel}
  'bridge'{if((Get-Content -LiteralPath '.local/bridge.json' -Raw -Encoding UTF8 | ConvertFrom-Json).relayUrl -like 'ws://127.0.0.1:*'){Start-Tunnel};Start-Bridge}
  'mobile'{Start-Mobile}
  'stop'{Stop-Managed}
  'logs'{foreach($name in @('bridge.stdout.log','bridge.stderr.log','tunnel.stderr.log')){$file=Join-Path $runtimeDirectory $name;if(Test-Path -LiteralPath $file){Write-Output "日志：$name";Get-Content -LiteralPath $file -Tail 40 -Encoding UTF8}}}
  'status'{foreach($name in @('bridge','tunnel')){$entry=Get-ManagedProcess $name;Write-Output "${name}：$(if($entry){'运行中，PID='+$entry.ProcessId}else{'未运行'})"}}
}
