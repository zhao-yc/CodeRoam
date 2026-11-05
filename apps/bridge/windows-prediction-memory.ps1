param([int]$TargetProcessId, [long]$StartedAtMs)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Protocol($Value) {
    try { [Console]::WriteLine((ConvertTo-Json -InputObject $Value -Depth 8 -Compress)) }
    catch { exit 1 }
}

function Test-JsonInteger($Value, [long]$Minimum, [long]$Maximum) {
    return (($Value -is [int] -or $Value -is [long]) -and $Value -ge $Minimum -and $Value -le $Maximum)
}

# 只放行本辅助进程定义的固定错误文本，编译器、系统和进程异常的原文不会进入标准流。
function Get-ProtocolError($Failure) {
    $exception = $Failure.Exception
    while ($null -ne $exception) {
        if ($exception.GetType().FullName -eq 'PredictionMemoryException') { return $exception.Message }
        $exception = $exception.InnerException
    }
    return '内存读取请求失败'
}

$reader = $null
$inputStream = $null
try {
    if ([IntPtr]::Size -ne 8 -or $TargetProcessId -le 0 -or $StartedAtMs -lt 0) {
        throw '进程参数无效'
    }
    if (-not [Console]::IsInputRedirected -or -not [Console]::IsOutputRedirected) {
        throw '标准流未隔离'
    }

    # 命令行只用于确认主进程，绝不输出。CIM 与随后打开的固定句柄均核对同一创建毫秒。
    $target = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId"
    $packageRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'WindowsApps'
    $officialPath = '^' + [regex]::Escape($packageRoot) + '\\OpenAI\.Codex_[^\\]+__2p2nqsd0c76g0\\app\\(?:ChatGPT|Codex)\.exe$'
    if ($null -eq $target -or [string]::IsNullOrEmpty($target.CommandLine) -or
        $target.CommandLine -match '(?i)--type(?:=|\s|$|")' -or $target.ExecutablePath -notmatch $officialPath) {
        throw '目标进程身份校验失败'
    }
    $actualStartedAtMs = ([DateTimeOffset]$target.CreationDate).ToUnixTimeMilliseconds()
    if ($actualStartedAtMs -le 0 -or ($StartedAtMs -ne 0 -and $actualStartedAtMs -ne $StartedAtMs)) {
        throw '目标进程身份校验失败'
    }
    # 旧入口仅提供 PID 时，在身份核验后固定实际创建时间，后续仍按同一代进程处理。
    $StartedAtMs = $actualStartedAtMs
    $target = $null

    $null = Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'prediction-memory-reader.cs'), [Text.Encoding]::UTF8))
    $reader = New-Object PredictionMemoryReader($TargetProcessId, $StartedAtMs)
    $inputStream = [Console]::OpenStandardInput()
    Write-Protocol @{ ready = $true; pid = $TargetProcessId; startedAtMs = $StartedAtMs }

    while ($true) {
        try { $line = [PredictionMemoryReader]::ReadRequestLine($inputStream) }
        catch {
            Write-Protocol @{ id = $null; error = (Get-ProtocolError $_) }
            break
        }
        if ($null -eq $line) { break }
        $requestId = $null
        try {
            try { $request = ConvertFrom-Json -InputObject $line }
            catch { throw [PredictionMemoryException]::new('请求格式无效') }
            if ($request -isnot [System.Management.Automation.PSCustomObject] -or
                -not (Test-JsonInteger $request.id ([int]::MinValue) ([int]::MaxValue))) {
                throw [PredictionMemoryException]::new('请求标识无效')
            }
            $requestId = [int]$request.id
            switch -CaseSensitive ($request.op) {
                'findKeys' {
                    if ($request.names -isnot [Array] -or $request.names.Count -eq 0 -or $request.names.Count -gt 4) {
                        throw [PredictionMemoryException]::new('字段名不在白名单内')
                    }
                    foreach ($name in $request.names) {
                        if ($name -isnot [string]) { throw [PredictionMemoryException]::new('字段名不在白名单内') }
                    }
                    $result = $reader.FindKeys([string[]]$request.names)
                }
                'references' {
                    if ($request.targets -isnot [Array] -or $request.targets.Count -eq 0) {
                        throw [PredictionMemoryException]::new('引用目标无效')
                    }
                    $targets = New-Object 'System.Collections.Generic.List[PredictionMemoryReferenceTarget]'
                    foreach ($target in $request.targets) {
                        if ($target.cage -isnot [string] -or -not (Test-JsonInteger $target.value 0 4294967295)) {
                            throw [PredictionMemoryException]::new('引用目标无效')
                        }
                        $entry = New-Object PredictionMemoryReferenceTarget
                        $entry.cage = $target.cage
                        $entry.value = [uint32]$target.value
                        $targets.Add($entry)
                    }
                    $result = $reader.References($targets.ToArray())
                }
                'read' {
                    if ($request.address -isnot [string] -or -not (Test-JsonInteger $request.length 0 65536)) {
                        throw [PredictionMemoryException]::new('读取参数无效')
                    }
                    $result = $reader.Read($request.address, [int]$request.length)
                }
                default { throw [PredictionMemoryException]::new('不支持的内存操作') }
            }
            Write-Protocol @{ id = $requestId; result = $result }
        }
        catch { Write-Protocol @{ id = $requestId; error = (Get-ProtocolError $_) } }
        finally {
            $line = $null
            $request = $null
            $result = $null
        }
    }
}
catch {
    Write-Protocol @{ ready = $false; error = '目标进程只读校验失败' }
    exit 1
}
finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $inputStream) { $inputStream.Dispose() }
}
