# 受控启动入口只改变新进程的环境；已经运行的配置拒绝重开，避免中断现有任务。
param([string]$Config='.local/bridge.json',[string]$InstanceId='')
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$configPath=if([IO.Path]::IsPathRooted($Config)){$Config}else{[IO.Path]::GetFullPath((Join-Path $project $Config))}
$settings=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
$data=if($settings.dataPath){$settings.dataPath}else{'.local/bridge'}
$registry=Get-Content -LiteralPath (Join-Path $project (Join-Path $data 'instances.json')) -Raw -Encoding UTF8|ConvertFrom-Json
if(!$InstanceId){$InstanceId=$settings.hostId}
$entry=@($registry.entries|Where-Object {$_.id -eq $InstanceId})
if($entry.Count -ne 1){throw '未找到此设备的本机实例配置'}
$entry=$entry[0]
$running=& (Join-Path $project 'apps/bridge/windows-instances.ps1') -AsObject
$rows=$running
if(@($rows|Where-Object {$_.codexHome.TrimEnd('\').ToLowerInvariant() -eq $entry.home -and (($_.userData -and $_.userData.TrimEnd('\').ToLowerInvariant() -eq $entry.userData) -or (!$_.userData -and $entry.userData -eq 'default'))}).Count){throw '此实例仍在运行，请先在电脑保存工作并关闭，再使用此入口启动'}
$package=Get-AppxPackage -Name OpenAI.Codex|Select-Object -First 1
if(!$package){throw '未找到已安装的 Codex 桌面'}
$executable=Join-Path $package.InstallLocation 'app/ChatGPT.exe'
if(!(Test-Path -LiteralPath $executable)){throw '桌面安装入口暂不兼容'}
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
$arguments=@('--remote-debugging-address=127.0.0.1',"--remote-debugging-port=$port")
$previousHome=$env:CODEX_HOME;$previousData=$env:CODEX_ELECTRON_USER_DATA_PATH
try {
 $env:CODEX_HOME=$entry.home
 if($entry.userData -ne 'default'){$env:CODEX_ELECTRON_USER_DATA_PATH=$entry.userData;$arguments+=('--user-data-dir="'+$entry.userData+'"')}else{Remove-Item Env:CODEX_ELECTRON_USER_DATA_PATH -ErrorAction SilentlyContinue}
 Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden|Out-Null
 Write-Output '已通过受控入口启动实例，连接服务会自动核验并更新设备状态'
}finally{$env:CODEX_HOME=$previousHome;$env:CODEX_ELECTRON_USER_DATA_PATH=$previousData}
