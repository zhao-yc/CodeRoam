param([string]$PipeName = 'codex-ipc', [switch]$WaitForRelease)
$ErrorActionPreference = 'Stop'

# 生产与合成测试使用固定的管道命名，启动器不接受来自手机的路径或命令。
if ($PipeName -ne 'codex-ipc' -and $PipeName -notmatch '^codex-mobile-ipc-test-[0-9a-f-]{36}$') {
    throw 'INVALID_IPC_PIPE_NAME'
}
Add-Type -Path (Join-Path $PSScriptRoot 'windows-ipc-pipe.cs')
$code = [WindowsIpcPipe]::Run($PipeName, $WaitForRelease.IsPresent)
exit $code
