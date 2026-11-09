param([ValidateSet('status')][string]$Action='status')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows/bridge-service-registration.ps1')

# 旧系统服务仅保留诊断入口，日常启停和旧服务迁移由桌面托盘管理。
$registered=Get-BridgeServiceRegistration
if($null -eq $registered){Write-Output '没有旧的 Windows 托管服务';return}
$registered | Select-Object Name,DisplayName,State,StartMode,ProcessId
Write-Output '请从 CodeRoam 桌面托盘启动和停止连接服务。'
