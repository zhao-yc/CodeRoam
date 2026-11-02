# 电脑端目标操作仅允许固定的原生导航及目标控件，不接收任意脚本或控件选择器。
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GoalDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public MouseInput mouse; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetPhysicalCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
  // 后台桥接只激活已核对的主窗口；临时连接输入队列后立即解绑，不改系统前台策略。
  public static bool Focus(IntPtr window) {
    if (GetForegroundWindow() == window) return true;
    if (SetForegroundWindow(window) && GetForegroundWindow() == window) return true;
    uint processId;
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out processId);
    uint currentThread = GetCurrentThreadId();
    if (foregroundThread == 0 || foregroundThread == currentThread || !AttachThreadInput(currentThread, foregroundThread, true)) return false;
    try { BringWindowToTop(window); SetForegroundWindow(window); return GetForegroundWindow() == window; }
    finally { AttachThreadInput(currentThread, foregroundThread, false); }
  }
  // 点击位置必须属于已核对的桌面进程，完成事件后再恢复鼠标。
  public static bool Click(int x, int y, uint processId) {
    var point = new Point { X=x, Y=y }; uint actual;
    GetWindowThreadProcessId(WindowFromPoint(point), out actual);
    if (actual != processId) return false;
    Point original; GetPhysicalCursorPos(out original); SetPhysicalCursorPos(x,y);
    var down = new Input { type=0, mouse=new MouseInput { flags=2 } };
    var up = new Input { type=0, mouse=new MouseInput { flags=4 } };
    bool sent=SendInput(2,new Input[]{down,up},Marshal.SizeOf(typeof(Input)))==2;
    System.Threading.Thread.Sleep(100);
    Point current; GetPhysicalCursorPos(out current); if(current.X==x && current.Y==y) SetPhysicalCursorPos(original.X,original.Y);
    return sent;
  }
}
'@
$script:committed = $false
$script:root = $null
$script:pipe = $null
$script:requestId = 0
$script:phase = 'initialize'

# 标准输出只返回结构化阶段和结论，不记录目标正文。
function Write-Result($Value) { [Console]::WriteLine(($Value | ConvertTo-Json -Compress -Depth 12)) }
# 所有管道等待和界面操作受同一截止时间约束。
function Assert-Deadline {
  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$script:inputData.deadline) { throw 'GOAL_UI_DEADLINE' }
}
# 按帧长度读取完整响应，拒绝半包和连接中断。
function Read-Exact([int]$Length) {
  $bytes = New-Object byte[] $Length
  $offset = 0
  while ($offset -lt $Length) {
    Assert-Deadline
    $read = $script:pipe.ReadAsync($bytes, $offset, $Length - $offset)
    if (!$read.Wait([Math]::Max(1, [Math]::Min(4000, [long]$script:inputData.deadline - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())))) { throw 'GOAL_UI_PIPE_TIMEOUT' }
    if ($read.Result -le 0) { throw 'GOAL_UI_PIPE_CLOSED' }
    $offset += $read.Result
  }
  return ,$bytes
}
# 只用于本文件固定的原生工具目录及会话导航请求。
function Send-NativeRequest([string]$Method, $Params) {
  Assert-Deadline
  $script:requestId++
  $message = @{ id = $script:requestId; jsonrpc = '2.0'; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 12
  $body = [Text.Encoding]::UTF8.GetBytes($message)
  $prefix = [BitConverter]::GetBytes([int]$body.Length)
  $script:pipe.Write($prefix, 0, 4); $script:pipe.Write($body, 0, $body.Length); $script:pipe.Flush()
  $length = [BitConverter]::ToInt32((Read-Exact 4), 0)
  if ($length -lt 1 -or $length -gt 2097152) { throw 'GOAL_UI_BAD_FRAME' }
  $reply = [Text.Encoding]::UTF8.GetString((Read-Exact $length)) | ConvertFrom-Json
  if ($reply.error -or $reply.id -ne $script:requestId) { throw 'GOAL_UI_NATIVE_REJECTED' }
  return $reply.result
}

# 先核对管道服务进程及工具目录，不能把同名应用或其他本地服务当作目标桌面。
function Connect-Desktop {
  $candidates = @()
  foreach ($file in [IO.Directory]::GetFiles('\\.\pipe\')) {
    $name = [IO.Path]::GetFileName($file)
    if ($name -notmatch '^codex-app-tools-[0-9a-f-]+$') { continue }
    $candidate = New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try {
      $candidate.Connect(400)
      [uint32]$serverProcessId = 0
      if (![GoalDesktop]::GetNamedPipeServerProcessId($candidate.SafePipeHandle.DangerousGetHandle(), [ref]$serverProcessId)) { throw 'GOAL_UI_PROCESS_UNAVAILABLE' }
      $process = Get-Process -Id $serverProcessId
      if ($process.Path -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$') { throw 'GOAL_UI_PROCESS_MISMATCH' }
      $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$serverProcessId)
      $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
      $main = @($windows | Where-Object { $_.Current.Name -in @('ChatGPT', 'Codex') -and !$_.Current.IsOffscreen })
      if ($main.Count -ne 1) { throw 'GOAL_UI_WINDOW_UNAVAILABLE' }
      $script:pipe = $candidate
      $tools = Send-NativeRequest 'tools/list' @{ threadStartKind = 'all' }
      if (!@($tools.tools | Where-Object { $_.namespace -eq 'codex_app' -and $_.name -eq 'navigate_to_codex_page' }).Count) { throw 'GOAL_UI_NAVIGATION_UNAVAILABLE' }
      $candidates += @{ pipe = $candidate; root = $main[0]; processId = $serverProcessId }
    } catch { $candidate.Dispose() }
  }
  $processIds = @($candidates | ForEach-Object { $_.processId } | Select-Object -Unique)
  if ($processIds.Count -ne 1) { foreach ($entry in $candidates) { $entry.pipe.Dispose() }; throw 'GOAL_UI_WINDOW_AMBIGUOUS' }
  $script:pipe = $candidates[0].pipe; $script:root = $candidates[0].root; $script:processId = $candidates[0].processId
  foreach ($entry in $candidates | Select-Object -Skip 1) { $entry.pipe.Dispose() }
}

# 每次从当前窗口重新读取可见控件，不缓存跨页面索引。
function Get-Controls($Type) {
  $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, $Type)
  return @($script:root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object { !$_.Current.IsOffscreen })
}
# 仅匹配项目内固定名称且已启用的原生控件。
function Find-Named($Type, [string[]]$Names) {
  return @(Get-Controls $Type | Where-Object { $_.Current.Name -in $Names -and $_.Current.IsEnabled })
}
# 控件必须唯一；尚未就绪时有限等待，不能猜测后继续。
function Wait-Unique($Type, [string[]]$Names) {
  do {
    Assert-Deadline
    $matches = @(Find-Named $Type $Names)
    if ($matches.Count -eq 1) { return $matches[0] }
    if ($matches.Count -gt 1) { throw 'GOAL_UI_CHANGED' }
    Start-Sleep -Milliseconds 120
  } while ($true)
}
# 区分普通按钮和展开控件，避免重复切换已展开菜单。
function Invoke-Control($Control) {
  Assert-Deadline
  $pattern = $null
  if ($Control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return }
  if ($Control.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { if ($pattern.Current.ExpandCollapseState -ne [Windows.Automation.ExpandCollapseState]::Expanded) { $pattern.Expand() }; return }
  throw 'GOAL_UI_INVOKE_UNSUPPORTED'
}
# 标签选择只核对窗口及会话文档，不能依赖尚未显示的目标栏。
function Click-ThreadControl($Control) {
  Assert-ThreadContext
  $bounds = $Control.Current.BoundingRectangle
  if ($Control.Current.IsOffscreen -or !$Control.Current.IsEnabled -or $bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'GOAL_UI_CHANGED' }
  if (![GoalDesktop]::Click([int]($bounds.X + $bounds.Width / 2), [int]($bounds.Y + $bounds.Height / 2), $script:processId)) { throw 'GOAL_UI_CHANGED' }
}
# 目标按钮点击必须额外复核主标签及原目标正文。
function Click-Control($Control) {
  Assert-CurrentGoal
  Click-ThreadControl $Control
}
# 只读取受支持的编辑模式，用于保留原电脑草稿。
function Get-Value($Control) {
  $pattern = $null
  if ($Control.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return $pattern.Current.Value }
  throw 'GOAL_UI_EDIT_UNSUPPORTED'
}
# 将目标作为普通文字填写，不执行字符串中的任何指令。
function Set-Value($Control, [string]$Value) {
  Assert-Deadline
  $pattern = $Control.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
  if ($pattern.Current.IsReadOnly) { throw 'GOAL_UI_EDIT_UNSUPPORTED' }
  $pattern.SetValue($Value)
}

# 同一主会话的侧边聊天也会沿用文档标题，因此标题校验不能替代标签校验。
function Assert-ThreadContext {
  Assert-Deadline
  [uint32]$foregroundProcessId = 0
  [void][GoalDesktop]::GetWindowThreadProcessId([GoalDesktop]::GetForegroundWindow(), [ref]$foregroundProcessId)
  if ($foregroundProcessId -ne $script:processId) { throw 'GOAL_UI_FOREGROUND_CHANGED' }
  $documents = @(Get-Controls ([Windows.Automation.ControlType]::Document) | Where-Object { $_.Current.AutomationId -eq 'RootWebArea' })
  if (!$script:inputData.title -or $documents.Count -ne 1 -or $documents[0].Current.Name -ne $script:inputData.title) { throw 'GOAL_UI_THREAD_CHANGED' }
}
# 主标签必须唯一，并通过原生选中状态证明当前内容属于主会话。
function Get-MainThreadTab {
  $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
  $tabs = @($script:root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object { $_.Current.Name -eq $script:inputData.title })
  if ($tabs.Count -ne 1) { throw 'GOAL_UI_THREAD_CHANGED' }
  return $tabs[0]
}
# 只切换视图，不关闭侧边聊天，不发送任务，也不修改目标。
function Select-MainThreadTab {
  Assert-ThreadContext
  $tab = Get-MainThreadTab
  $selection = $null
  if (!$tab.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) { throw 'GOAL_UI_TAB_UNSUPPORTED' }
  if ($selection.Current.IsSelected) { return }
  $selection.Select()
  $fallbackAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 500
  $limit = [Math]::Min([long]$script:inputData.deadline - 1000, $fallbackAt + 2000)
  $clicked = $false
  do {
    Assert-ThreadContext
    $tab = Get-MainThreadTab
    $selection = $tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
    if ($selection.Current.IsSelected) { return }
    if (!$clicked -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $fallbackAt) { Click-ThreadControl $tab; $clicked = $true }
    Start-Sleep -Milliseconds 100
  } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $limit)
  throw 'GOAL_UI_SIDECHAT_ACTIVE'
}
# 提交前持续复核标签，用户切回侧边聊天时立即停止操作。
function Assert-MainThreadTab {
  Assert-ThreadContext
  $tab = Get-MainThreadTab
  $selection = $tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
  if (!$selection.Current.IsSelected) { throw 'GOAL_UI_SIDECHAT_ACTIVE' }
}
# 原生导航的目标编号来自已订阅会话；每次提交前再核对目标正文与前台窗口。
function Assert-CurrentGoal {
  Assert-MainThreadTab
  $buttons = @(Get-Controls ([Windows.Automation.ControlType]::Button))
  if ($script:inputData.previousGoal) {
    $objective = [string]$script:inputData.previousGoal.objective
    $summaries = @($buttons | Where-Object { ([string]$_.Current.Name).Contains($objective) })
    if ($summaries.Count -ne 1) { throw 'GOAL_UI_CHANGED' }
  } elseif (@($buttons | Where-Object { $_.Current.Name -in @('清除目标', 'Clear goal') }).Count) { throw 'GOAL_UI_CHANGED' }
}
# 长会话切换后可能先显示标题再加载输入区，有限等待目标栏，不重放导航或目标操作。
function Wait-CurrentGoal {
  $limit = [Math]::Min([long]$script:inputData.deadline - 1000, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 8000)
  do {
    Assert-MainThreadTab
    if (!$script:inputData.previousGoal) { Assert-CurrentGoal; return }
    $objective = [string]$script:inputData.previousGoal.objective
    $matches = @(Get-Controls ([Windows.Automation.ControlType]::Button) | Where-Object { ([string]$_.Current.Name).Contains($objective) })
    if ($matches.Count -gt 0) { Assert-CurrentGoal; return }
    Start-Sleep -Milliseconds 120
  } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $limit)
  throw 'GOAL_UI_LAYOUT_LOADING'
}

try {
  $script:inputData = [Console]::ReadLine() | ConvertFrom-Json
  if ($script:inputData.threadId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $script:inputData.action -notin @('create', 'edit', 'pause', 'resume', 'clear', 'inspect')) { throw 'GOAL_UI_BAD_INPUT' }
  Connect-Desktop
  $script:phase = 'navigation'
  if ($script:inputData.action -eq 'inspect' -and !$script:inputData.navigate) {
    Write-Result @{ stage = 'inspection'; buttons = @(Get-Controls ([Windows.Automation.ControlType]::Button) | ForEach-Object { $_.Current.Name } | Where-Object { $_ -match '^(清除目标|暂停目标|恢复目标|编辑目标|添加文件|目标|Goal|Save|保存|取消|发送|Send|明确目标)' } | ForEach-Object { $_.Substring(0, [Math]::Min(80, $_.Length)) }); editors = @(Get-Controls ([Windows.Automation.ControlType]::Edit) | ForEach-Object { $_.Current.Name }) }
    exit
  }
  $native = Send-NativeRequest 'tools/call' @{ namespace = 'codex_app'; tool = 'navigate_to_codex_page'; arguments = @{ threadId = $script:inputData.threadId }; callerSource = 'codex'; callId = $script:inputData.commandId; threadId = $script:inputData.threadId; turnId = $script:inputData.commandId; hostId = 'local' }
  if ($script:inputData.action -eq 'inspect') { Write-Result @{ stage = 'navigation-inspection'; response = $native }; exit }
  $navigation = (($native.contentItems | Where-Object { $_.type -eq 'inputText' }).text | Select-Object -First 1) | ConvertFrom-Json
  if ($native.success -ne $true -or $navigation.navigated -ne $true) { throw 'GOAL_UI_NAVIGATION_REJECTED' }
  $script:phase = 'activate-window'
  if (![GoalDesktop]::Focus([IntPtr]$script:root.Current.NativeWindowHandle)) { throw 'GOAL_UI_FOREGROUND_CHANGED' }
  Start-Sleep -Milliseconds 250
  $script:phase = 'select-main-thread'
  Select-MainThreadTab
  $script:phase = 'wait-goal-ui'
  Wait-CurrentGoal
  $action = [string]$script:inputData.action
  $editor = $null; $submitNames = @()
  # 新建和编辑均使用原生目标输入模式；已有目标由桌面的替换确认提交。
  if ($action -in @('create', 'edit')) {
    $script:phase = 'read-composer'
    $editor = Wait-Unique ([Windows.Automation.ControlType]::Edit) @('和 Codex 一起工作', 'Work with Codex', '向 Codex 发送消息', 'Message Codex')
    $draftValue = (Get-Value $editor).Trim([char[]]@([char]32, [char]9, [char]10, [char]13, [char]0x200B, [char]0xFEFF))
    if ($draftValue -and $draftValue -notin @('和 Codex 一起工作', 'Work with Codex', '向 Codex 发送消息', 'Message Codex')) { throw 'GOAL_DESKTOP_DRAFT' }
    # 已有附件不应随目标被提交；原生附件区域存在时明确保留，要求用户先处理。
    if (@(Get-Controls ([Windows.Automation.ControlType]::Button) | Where-Object { $_.Current.Name -match '^(移除|删除|Remove attachment|Remove file|Remove image|Delete attachment)' }).Count) { throw 'GOAL_DESKTOP_DRAFT' }
    $script:phase = 'open-goal-menu'
    Invoke-Control (Wait-Unique ([Windows.Automation.ControlType]::Button) @('添加文件等内容', '添加文件等', 'Add files and more'))
    $script:phase = 'select-goal-mode'
    $goalMenu = Wait-Unique ([Windows.Automation.ControlType]::Button) @('目标 设置要持续追求的目标', 'Goal Set a goal to pursue')
    Click-Control $goalMenu
    # 目标模式必须有原生明确目标按钮；没有则绝不把正文当作普通消息发送。
    [void](Wait-Unique ([Windows.Automation.ControlType]::Button) @('明确目标', 'Clear goal'))
    $submitNames = @('发送', 'Send', '开始目标', 'Start goal')
  } elseif ($action -eq 'pause') { $submitNames = @('暂停目标', 'Pause goal') }
  elseif ($action -eq 'resume') { $submitNames = @('恢复目标', 'Resume goal', '继续目标') }
  elseif ($action -eq 'clear') { $submitNames = @('清除目标', 'Clear goal') }
  if ($action -notin @('create', 'edit')) { [void](Wait-Unique ([Windows.Automation.ControlType]::Button) $submitNames) }
  $script:phase = 'await-commit'
  Write-Result @{ stage = 'ready'; phase = $script:phase }
  $confirmation = [Console]::ReadLine() | ConvertFrom-Json
  if (!$confirmation.commit) { throw 'GOAL_UI_CANCELLED' }
  Assert-CurrentGoal
  $script:committed = $true
  $script:phase = 'fill-objective'
  if ($editor) { Set-Value $editor ([string]$script:inputData.objective).Trim() }
  $script:phase = 'submit-goal'
  Invoke-Control (Wait-Unique ([Windows.Automation.ControlType]::Button) $submitNames)
  if ($action -eq 'edit') {
    $script:phase = 'confirm-replacement'
    Invoke-Control (Wait-Unique ([Windows.Automation.ControlType]::Button) @('替换目标', 'Replace goal'))
  }
  Write-Result @{ stage = 'done'; phase = $script:phase }
} catch {
  $code = 'GOAL_UI_UNAVAILABLE'
  if ($_.Exception.Message -match 'GOAL_[A-Z_]+') { $code = $Matches[0] }
  Write-Result @{ stage = 'error'; code = $code; phase = $script:phase; errorKind = $_.Exception.GetType().Name; errorId = $_.FullyQualifiedErrorId; line = $_.InvocationInfo.ScriptLineNumber; outcomeUnknown = $script:committed }
} finally { if ($script:pipe) { $script:pipe.Dispose() } }
