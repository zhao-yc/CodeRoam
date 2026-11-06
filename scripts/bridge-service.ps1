param(
  [ValidateSet('prepare','install','start','stop','restart','status','update')][string]$Action='status',
  [string]$Entry='',
  [switch]$Prepared
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$local=Join-Path $project '.local/bridge-service'
$systemRoot=Join-Path $env:ProgramData 'CodexMobile/Bridge'
$serviceRegistration=Join-Path $PSScriptRoot 'windows/bridge-service-registration.ps1'
. $serviceRegistration
$serviceBinary="$bridgeServiceName.exe"
$utf8=New-Object System.Text.UTF8Encoding($false)
Set-Location -LiteralPath $project

# 配置只存固定路径和用户 SID，不复制手机令牌或 Windows 密码。
function Save-Json([string]$File,$Value) { [IO.File]::WriteAllText($File,($Value|ConvertTo-Json -Depth 8),$utf8) }
function Read-Json([string]$File) { Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json }
function Read-RegisteredWorker($Registered) {
  $binaryPath=if($Registered.PathName -match '^"([^"]+)"'){$Matches[1]}else{($Registered.PathName -split '\s+')[0]}
  $hostSettings=Read-Json (Join-Path (Split-Path -Parent $binaryPath) 'service.json')
  Read-Json $hostSettings.WorkerConfig
}
function Assert-Idle($Registered) {
  $configPath=Join-Path $project '.local/bridge.json'
  $workingDirectory=$project
  # 已安装服务可能保留独立运行目录；查询实际托管配置，避免迁移后误读新的空账本。
  if($null -ne $Registered){
    $worker=Read-RegisteredWorker $Registered
    $configPath=$worker.bridgeConfig
    $workingDirectory=$worker.projectRoot
  }
  $config=Read-Json $configPath
  $data=if($config.PSObject.Properties.Name -contains 'dataPath'){$config.dataPath}else{'.local/bridge'}
  $dataDirectory=if([IO.Path]::IsPathRooted($data)){$data}else{Join-Path $workingDirectory $data}
  $database=[IO.Path]::GetFullPath((Join-Path $dataDirectory 'journal.sqlite'))
  $count=& node --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('SELECT count(*) AS n FROM commands WHERE state=char(112,101,110,100,105,110,103)').get().n);d.close();" $database
  if($LASTEXITCODE -ne 0 -or [int]$count -ne 0){throw '手机写操作尚未结束或账本不可读，保留原桥接'}
}
function Prepare-Install {
  New-Item -ItemType Directory -Force -Path $local,(Join-Path $local 'logs') | Out-Null
  $record=Read-Json (Join-Path $project '.local/run/bridge.json')
  $target=if($Entry.Length -gt 0){$Entry}else{[string]$record.marker}
  $target=(Resolve-Path -LiteralPath $target).Path
  if(!$target.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -ne 'cli.mjs'){throw '桥接入口必须是本项目内已发布的 cli.mjs'}
  # 从当前已发布源码复制独立版本，只叠加进程排他保护，保留线上功能。
  $sourceRoot=Split-Path (Split-Path (Split-Path $target -Parent) -Parent) -Parent
  $releaseRoot=Join-Path $local ('releases/'+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ'))
  New-Item -ItemType Directory -Force -Path (Join-Path $releaseRoot 'apps'),(Join-Path $releaseRoot 'packages') | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'apps/bridge') -Destination (Join-Path $releaseRoot 'apps/bridge') -Recurse
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'packages/protocol') -Destination (Join-Path $releaseRoot 'packages/protocol') -Recurse
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json') -Destination (Join-Path $releaseRoot 'package.json')
  $target=Join-Path $releaseRoot 'apps/bridge/cli.mjs'
  $cli=[IO.File]::ReadAllText($target)
  if(!$cli.Contains('acquireBridgeLock')) {
    $cli="import { acquireBridgeLock } from './runtime-lock.mjs';`n"+$cli
    $cli=$cli.Replace('try {',"let releaseBridgeLock=()=>{};`ntry {`n  releaseBridgeLock=await acquireBridgeLock(values.config);")
    $cli=$cli.Replace('await agent.close();','try{await agent.close();}finally{releaseBridgeLock();}')
    $cli=$cli.Replace('}catch(error){console.error(', '}catch(error){releaseBridgeLock();console.error(')
    [IO.File]::WriteAllText($target,$cli,$utf8)
  }
  Copy-Item -LiteralPath (Join-Path $project 'apps/bridge/runtime-lock.mjs') -Destination (Join-Path $releaseRoot 'apps/bridge/runtime-lock.mjs')
  $node=& node -p "require('node:fs').realpathSync(process.execPath)"
  if((& $node --version) -notmatch '^v24\.'){throw '服务要求 Node.js 24'}
  New-Item -ItemType Directory -Force -Path (Join-Path $releaseRoot 'supervisor') | Out-Null
  foreach($name in @('service-supervisor.mjs','service-lifecycle.mjs','runtime-lock.mjs','management-server.mjs','management-client.mjs','management-config.mjs','management-files.mjs','management-startup.mjs')){Copy-Item -LiteralPath (Join-Path $project "apps/bridge/$name") -Destination (Join-Path $releaseRoot "supervisor/$name")}
  $config=Read-Json (Join-Path $project '.local/bridge.json')
  $data=if($config.PSObject.Properties.Name -contains 'dataPath'){$config.dataPath}else{'.local/bridge'}
  $worker=@{entry=$target;bridgeConfig=(Join-Path $project '.local/bridge.json');projectRoot=$project;runDirectory=(Join-Path $project '.local/run');statusFile=([IO.Path]::GetFullPath((Join-Path $project (Join-Path $data 'runtime-status.json'))));logDirectory=(Join-Path $local 'logs')}
  Save-Json (Join-Path $releaseRoot 'worker.json') $worker
  $source=Join-Path $project 'scripts/windows/BridgeService.cs'
  $binary=Join-Path $local $serviceBinary
  & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 /reference:System.ServiceProcess.dll /reference:System.Web.Extensions.dll "/out:$binary" $source
  if($LASTEXITCODE -ne 0){throw '原生服务编译失败'}
  $hostConfig=@{UserSid=([Security.Principal.WindowsIdentity]::GetCurrent().User.Value);NodePath=$node;SupervisorPath=(Join-Path $releaseRoot 'supervisor/service-supervisor.mjs');WorkerConfig=(Join-Path $releaseRoot 'worker.json');ProjectRoot=$project}
  Save-Json (Join-Path $local 'service.json') $hostConfig
  Save-Json (Join-Path $local 'prepared.json') @{binarySha256=(Get-FileHash $binary -Algorithm SHA256).Hash;entry=$target;previousPid=$record.pid;previousMarker=$record.marker;preparedAt=(Get-Date).ToUniversalTime().ToString('o')}
  Write-Output "服务安装材料已准备：$local"
}
function Native-Service([string[]]$Arguments) { & "$env:WINDIR\System32\sc.exe" @Arguments; if($LASTEXITCODE -ne 0){throw 'Windows 服务配置命令失败'} }

if($Action -eq 'prepare'){Prepare-Install;exit}
$registered=Get-BridgeServiceRegistration
if($Action -eq 'status') {
  if($null -eq $registered){Write-Output '尚未安装独立托管服务';exit}
  $registered|Select-Object Name,DisplayName,State,StartMode,ProcessId,StartName
  $worker=Read-RegisteredWorker $registered
  $state=Join-Path $worker.logDirectory 'supervisor.json';if(Test-Path -LiteralPath $state){Read-Json $state}
  exit
}
if($Action -eq 'install') {
  if($null -ne $registered -and $registered.Name -eq $legacyBridgeServiceName){throw '检测到旧名托管服务。请先完成服务名迁移，再安装 CodeRoamBridge'}
  if(!$Prepared){Prepare-Install}
  $admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if(!$admin){throw '安装 Windows 系统服务需要管理员权限；材料已准备，可在管理员 PowerShell 中执行本命令并添加 -Prepared'}
  $manifest=Read-Json (Join-Path $local 'prepared.json');$hostConfig=Read-Json (Join-Path $local 'service.json')
  $baseline=Read-Json (Join-Path $project '.local/run/bridge.json')
  if($baseline.pid -ne $manifest.previousPid -or $baseline.marker -ne $manifest.previousMarker){throw '准备后桥接已被其他任务切换，请重新准备安装材料'}
  $duplicates=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($project) -and $_.CommandLine -match 'apps[\\/]bridge[\\/]cli\.mjs' -and $_.ProcessId -ne $baseline.pid})
  if($duplicates.Count -gt 0){throw '检测到未登记的桥接实例，拒绝安装切换，请先核对它们的归属'}
  $binary=Join-Path $local $serviceBinary
  if((Get-FileHash $binary -Algorithm SHA256).Hash -ne $manifest.binarySha256){throw '服务二进制校验失败'}
  Assert-Idle $registered
  $existing=$registered
  $installed=Join-Path $systemRoot $serviceBinary
  if($null -ne $existing -and $existing.PathName -ne ('"'+$installed+'"')){throw '同名服务的程序路径不符，保留现场'}
  if($null -ne $existing -and $existing.State -ne 'Stopped'){Stop-Service $bridgeServiceName; (Get-Service $bridgeServiceName).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(20))}
  # 宿主和宿主配置只能由系统或管理员修改；桥接文件始终以原用户令牌执行。
  New-Item -ItemType Directory -Force -Path $systemRoot | Out-Null
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($hostConfig.UserSid)),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
  Set-Acl -LiteralPath $systemRoot -AclObject $acl
  Copy-Item -LiteralPath $binary -Destination $installed
  Copy-Item -LiteralPath (Join-Path $local 'service.json') -Destination (Join-Path $systemRoot 'service.json')
  foreach($protectedFile in @($installed,(Join-Path $systemRoot 'service.json'))){$fileAcl=Get-Acl -LiteralPath $protectedFile;$fileAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')));Set-Acl -LiteralPath $protectedFile -AclObject $fileAcl}
  if($null -eq $existing){New-Service -Name $bridgeServiceName -DisplayName 'CodeRoam 桥接托管服务' -BinaryPathName ('"'+$installed+'"') -StartupType Automatic -Description '开机启动托管器；登录后以原账号运行桥接，异常退出自动恢复，不改变 Codex 审批与沙箱。'|Out-Null}
  Native-Service @('config',$bridgeServiceName,'start=','auto')
  Native-Service @('failure',$bridgeServiceName,'reset=','86400','actions=','restart/5000/restart/15000/restart/30000')
  Native-Service @('failureflag',$bridgeServiceName,'1')
  # 目标用户可查询、启停服务，不能修改服务程序或系统账户。
  $descriptor='D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPLO;;;'+$hostConfig.UserSid+')'
  Native-Service @('sdset',$bridgeServiceName,$descriptor)
  $recordPath=Join-Path $project '.local/run/bridge.json';$record=Read-Json $recordPath
  $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
  if($null -ne $process){if(!$process.CommandLine.Contains([string]$record.marker)){throw '旧桥接 PID 已复用，拒绝停止'};Save-Json (Join-Path $local 'previous-bridge.json') $record;Stop-Process -Id $process.ProcessId}
  try {
    $startedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Start-Service $bridgeServiceName
    $ready=$false
    for($attempt=0;$attempt -lt 30;$attempt++) {
      Start-Sleep -Milliseconds 500
      try {
        $state=Read-Json (Join-Path $local 'logs/supervisor.json')
        $actual=Get-CimInstance Win32_Process -Filter "ProcessId=$($state.childPid)" -ErrorAction SilentlyContinue
        $runtime=Read-Json ((Read-Json $hostConfig.WorkerConfig).statusFile)
        if($state.state -eq 'running' -and $null -ne $actual -and $actual.CommandLine.Contains([string]$manifest.entry) -and $runtime.pid -eq $state.childPid -and $runtime.connected -and $runtime.updatedAt -ge $startedAt){$ready=$true;break}
      }catch{}
    }
    if(!$ready){throw '服务已启动，但原账号桥接尚未就绪'}
    Write-Output '独立托管服务已安装并启动，原账号桥接已就绪'
  } catch {
    $failure=$_
    Stop-Service $bridgeServiceName -ErrorAction SilentlyContinue
    # 切换失败时恢复原固定入口，服务配置保留供排查，避免手机长期失联。
    $node=[string]$hostConfig.NodePath
    $rollback=Join-Path $local 'rollback.mjs'
    $rollbackCode=@'
import fs from 'node:fs';import{spawn}from'node:child_process';
const record=JSON.parse(fs.readFileSync('.local/bridge-service/previous-bridge.json','utf8'));
const output=fs.openSync('.local/run/bridge.stdout.log','a'),error=fs.openSync('.local/run/bridge.stderr.log','a');
const child=spawn(process.execPath,[record.marker,'--config',process.cwd()+'/.local/bridge.json'],{cwd:process.cwd(),detached:true,windowsHide:true,stdio:['ignore',output,error]});
child.once('spawn',()=>{fs.writeFileSync('.local/run/bridge.json',JSON.stringify({pid:child.pid,marker:record.marker}));child.unref();fs.closeSync(output);fs.closeSync(error);});
'@
    [IO.File]::WriteAllText($rollback,$rollbackCode,$utf8)
    # 回滚也必须在原用户会话执行，不能从管理员安装进程启动提升权限的业务桥接。
    Write-Warning '服务未就绪，已停止服务；原入口记录保存在 previous-bridge.json。请以原账号普通权限运行 rollback.mjs 恢复。'
    throw $failure
  }
  exit
}
if($Action -eq 'update'){throw '更新入口请先停止服务，执行 prepare -Entry <固定入口>，再运行 install -Prepared；不得直接启动第二个桥接'}
if($null -eq $registered){throw '尚未安装 CodeRoamBridge 托管服务'}
if($Action -in @('stop','restart')){Assert-Idle $registered;Stop-Service $registered.Name;(Get-Service $registered.Name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(20))}
if($Action -in @('start','restart')){Start-Service $registered.Name}
Write-Output "托管服务 $($registered.Name) 操作完成：$Action"
