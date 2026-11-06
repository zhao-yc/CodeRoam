$bridgeServiceName='CodeRoamBridge'
$legacyBridgeServiceName='CodexMobileBridge'

# 旧安装仍可启停。出现两个注册时拒绝自动选择，避免同一桥接启动两次。
function Get-BridgeServiceRegistration {
  $services=@(Get-CimInstance Win32_Service -Filter "Name='$bridgeServiceName' OR Name='$legacyBridgeServiceName'")
  if($services.Count -gt 1){throw '检测到 CodeRoamBridge 和旧名服务同时注册，请先核对并完成迁移'}
  return $services | Select-Object -First 1
}
