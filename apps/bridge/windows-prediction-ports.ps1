# 只发现已存在的原桌面回环调试端口，不开启端口、不重启应用。
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$listeners=@(Get-NetTCPConnection -State Listen)
$result=@(foreach($process in Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'") {
  # 只核对官方包身份和主进程，不按版本号阻止读取；兼容性由实际页面结构判断。
  if($process.CommandLine -match '--type=' -or $process.ExecutablePath -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+__2p2nqsd0c76g0\\app\\ChatGPT\.exe$'){continue}
  if($process.CommandLine -notmatch '--remote-debugging-port[= ](\d+)'){continue}
  $port=[int]$Matches[1]
  $bindings=@($listeners | Where-Object {$_.LocalPort -eq $port})
  if($bindings.Count -ne 1 -or $bindings[0].LocalAddress -ne '127.0.0.1' -or $bindings[0].OwningProcess -ne $process.ProcessId){continue}
  [pscustomobject]@{port=$port;pid=$process.ProcessId;executable=$process.ExecutablePath}
})
ConvertTo-Json -InputObject $result -Compress
