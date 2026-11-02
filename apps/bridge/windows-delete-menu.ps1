# 仅选择已验证原桌面进程的“永久删除”菜单项；实际删除确认由编号校验后的弹窗执行。
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$stage='identity'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeleteWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
try {
  $request=[Console]::ReadLine()|ConvertFrom-Json
  if ([long]$request.processId -le 0 -or [long]$request.deadline -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { throw 'DELETE_BAD_INPUT' }
  $owner=Get-Process -Id ([int]$request.processId)
  if ($owner.Path -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$') { throw 'DELETE_PROCESS_MISMATCH' }
  if ($request.action -eq 'activate') {
    $stage='activate'
    if ($owner.MainWindowHandle -eq [IntPtr]::Zero) { throw 'DELETE_WINDOW_UNAVAILABLE' }
    if ([DeleteWindow]::IsIconic($owner.MainWindowHandle)) { [void][DeleteWindow]::ShowWindow($owner.MainWindowHandle,9) }
    [void][DeleteWindow]::SetForegroundWindow($owner.MainWindowHandle)
    if ([DeleteWindow]::GetForegroundWindow() -ne $owner.MainWindowHandle) { throw 'DELETE_WINDOW_UNAVAILABLE' }
    [Console]::WriteLine('{"selected":true}')
    exit 0
  }
  if ($request.action -ne 'select') { throw 'DELETE_BAD_INPUT' }
  $pidCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$request.processId)
  $typeCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::MenuItem)
  # 原生弹出菜单可能是渲染进程的独立窗口，必须沿进程父链证明属于同一原桌面。
  function Test-OwnedProcess([int]$CandidateId) {
    for($depth=0;$depth -lt 6;$depth++) {
      if($CandidateId -eq [int]$request.processId) { return $true }
      $candidate=Get-CimInstance Win32_Process -Filter ('ProcessId='+$CandidateId) -ErrorAction SilentlyContinue
      if(!$candidate -or $candidate.ExecutablePath -ne $owner.Path) { return $false }
      $CandidateId=[int]$candidate.ParentProcessId
    }
    return $false
  }
  $limit=[Math]::Min([long]$request.deadline,[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+5000)
  $stage='enumerate'
  do {
    $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$pidCondition)
    $allMenuItems=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants,$typeCondition)
    $items=@($allMenuItems|Where-Object {
      $invoke=$null
      !$_.Current.IsOffscreen -and $_.Current.Name -match '(永久删除|Permanently\s+delete)' -and (Test-OwnedProcess $_.Current.ProcessId) -and $_.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)
    })
    if ($items.Count -gt 1) { throw 'DELETE_MENU_AMBIGUOUS' }
    if ($items.Count -eq 1) {
      $stage='invoke'
      $pattern=$items[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
      $pattern.Invoke()
      [Console]::WriteLine('{"selected":true}')
      exit 0
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $limit)
  throw 'DELETE_MENU_UNAVAILABLE'
} catch {
  [Console]::WriteLine((@{selected=$false;stage=$stage;windowCount=@($windows).Count;itemCount=@($items).Count;menuItemCount=@($allMenuItems).Count}|ConvertTo-Json -Compress))
  exit 1
}
