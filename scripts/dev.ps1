param([ValidateSet('all','bridge','mobile','tunnel','stop','logs','status')][string]$Action='all')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot

$localSettings=@{}
$settingsFile=Join-Path $projectRoot '.local/development.json'
if(Test-Path -LiteralPath $settingsFile){
  $document=Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach($property in $document.PSObject.Properties){$localSettings[$property.Name]=$property.Value}
}
# 本机工具和既有运行配置留在忽略目录，公共脚本随工程迁移，不保存个人绝对路径。
function Resolve-LocalPath([string]$Name,[string]$Fallback) {
  if(!$localSettings.ContainsKey($Name) -or !($localSettings[$Name] -is [string]) -or [string]::IsNullOrWhiteSpace($localSettings[$Name])){return $Fallback}
  $value=[string]$localSettings[$Name]
  if([IO.Path]::IsPathRooted($value)){return [IO.Path]::GetFullPath($value)}
  return [IO.Path]::GetFullPath((Join-Path $projectRoot $value))
}
$runtimeDirectory=Resolve-LocalPath 'runDirectory' (Join-Path $projectRoot '.local/run')
$bridgeConfig=Resolve-LocalPath 'bridgeConfig' (Join-Path $projectRoot '.local/bridge.json')
$bridgeWorkingDirectory=Resolve-LocalPath 'bridgeWorkingDirectory' $projectRoot
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
function Invoke-DesktopManager([string[]]$Arguments) {
  $manager=Join-Path $projectRoot 'apps/desktop-manager'
  $electron=Join-Path $manager 'node_modules/electron/dist/electron.exe'
  if(!(Test-Path -LiteralPath $electron)){throw '请先安装桌面管理客户端依赖'}
  $previous=$env:CODEX_MOBILE_MANAGER_USER_DATA
  try {
    # 开发托盘使用独立偏好目录，启动和退出命令不会控制日常安装。
    $env:CODEX_MOBILE_MANAGER_USER_DATA=Join-Path $runtimeDirectory 'desktop-manager'
    Start-Process -FilePath $electron -ArgumentList (@(('"'+$manager+'"'))+$Arguments) -WorkingDirectory $projectRoot
  } finally {
    $env:CODEX_MOBILE_MANAGER_USER_DATA=$previous
  }
}
function Start-Bridge {
  if(!(Test-Path -LiteralPath $bridgeConfig)){throw '请先执行 npm run provision 并完成凭据备份'}
  if((Get-Content -LiteralPath $bridgeConfig -Raw -Encoding UTF8 | ConvertFrom-Json).relayUrl -like 'ws://127.0.0.1:*'){Start-Tunnel}
  & npm run desktop:build
  if($LASTEXITCODE -ne 0){throw '桌面管理客户端构建失败'}
  Invoke-DesktopManager @('--bridge-config',('"'+$bridgeConfig+'"'),'--bridge-working-directory',('"'+$bridgeWorkingDirectory+'"'),'--run-directory',('"'+$runtimeDirectory+'"'))
  Write-Output 'CodeRoam 开发托盘已请求启动，可从托盘打开管理窗口查看连接状态。'
}
function Start-Mobile {
  $configuredCli=Resolve-LocalPath 'hbuilderxCli' ''
  $cli=if($env:HBX_CLI){$env:HBX_CLI}elseif($configuredCli){$configuredCli}else{(Get-Command cli.exe -ErrorAction Stop).Source}
  $mobile=Join-Path $projectRoot 'apps/mobile'
  & $cli project open --path $mobile
  & $cli launch web --project $mobile --ui true --browser Built
  if($LASTEXITCODE -ne 0){throw 'HBuilderX 手机界面预览启动失败'}
}
function Stop-Managed {
  Invoke-DesktopManager @('--quit')
  for($attempt=0;$attempt -lt 20;$attempt++){
    if($null -eq (Get-ManagedProcess 'bridge')){break}
    Start-Sleep -Milliseconds 500
  }
  if($null -eq (Get-ManagedProcess 'bridge')) {
    $tunnel=Get-ManagedProcess 'tunnel'
    if($null -ne $tunnel){Stop-Process -Id $tunnel.ProcessId;Write-Output '已停止本项目开发隧道'}
  } else {Write-Output '连接服务仍在运行，请查看桌面托盘的退出结果。'}
  Write-Output '手机界面预览由 HBuilderX 运行面板的停止按钮管理。'
}
switch($Action){
  'all'{Start-Bridge;Start-Mobile}
  'tunnel'{Start-Tunnel}
  'bridge'{Start-Bridge}
  'mobile'{Start-Mobile}
  'stop'{Stop-Managed}
  'logs'{foreach($name in @('bridge.stdout.log','bridge.stderr.log','tunnel.stderr.log')){$file=Join-Path $runtimeDirectory $name;if(Test-Path -LiteralPath $file){Write-Output "日志：$name";Get-Content -LiteralPath $file -Tail 40 -Encoding UTF8}}}
  'status'{
    foreach($name in @('bridge','tunnel')){
      $entry=Get-ManagedProcess $name
      Write-Output "${name}：$(if($entry){'运行中，PID='+$entry.ProcessId}else{'未运行'})"
    }
  }
}
