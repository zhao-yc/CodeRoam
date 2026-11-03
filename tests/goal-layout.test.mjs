import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// 只提取真实脚本中的纯布局判断和守卫；测试不加载桌面连接、导航或点击函数。
function check(input) {
  const script = `
    [Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
    [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
    $inputData=[Console]::ReadLine() | ConvertFrom-Json
    $caseMode=$inputData.mode
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'apps/bridge/windows-goals.ps1'),[ref]$tokens,[ref]$errors)
    if ($errors.Count) {throw '脚本语法错误'}
    $names=@('Resolve-MainThreadTab','Wait-ThreadView','Select-MainThreadTab','Assert-MainThreadTab')
    $functions=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names},$true)
    foreach ($function in $functions) {. ([scriptblock]::Create($function.Extent.Text))}
    try {
      if ($inputData.mode -eq 'layout') {
        $tabs=@($inputData.titles | ForEach-Object {[pscustomobject]@{Current=[pscustomobject]@{Name=$_}}})
        $tab=Resolve-MainThreadTab $tabs '合成聊天' $inputData.tabLists $inputData.composers
        $result=@{layout=$(if($null -eq $tab){'single'}else{'tabs'})}
      } else {
        $script:checks=0; $script:reads=0
        $script:inputData=@{deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$(if($inputData.mode -eq 'timeout'){1000}else{10000})}
        function Start-Sleep {}
        function Assert-ThreadContext {
          $script:checks++
          if($caseMode -eq 'foreground'){throw 'GOAL_UI_FOREGROUND_CHANGED'}
          if($caseMode -eq 'loading' -and $script:checks -lt 3){throw 'GOAL_UI_THREAD_CHANGED'}
        }
        function Get-MainThreadTab {
          $script:reads++
          if($caseMode -eq 'timeout'){throw 'GOAL_UI_LAYOUT_LOADING'}
          return $null
        }
        if($caseMode -eq 'single-guards'){Select-MainThreadTab; Assert-MainThreadTab}
        else {Wait-ThreadView}
        $result=@{checks=$script:checks;reads=$script:reads}
      }
    } catch {$result=@{code=$_.Exception.Message}}
    [Console]::WriteLine(($result | ConvertTo-Json -Compress))
  `;
  const executable=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const run=spawnSync(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify(input)+'\n',encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout.trim());
}
const windows={skip:process.platform!=='win32'};

test('无标签栏的单聊天通过；加载未完成或多个输入框仍拒绝',windows,()=>{
  assert.equal(check({mode:'layout',titles:[],tabLists:0,composers:1}).layout,'single');
  for(const [tabLists,composers,code] of [[1,1,'GOAL_UI_LAYOUT_LOADING'],[0,0,'GOAL_UI_LAYOUT_LOADING'],[0,2,'GOAL_UI_SIDECHAT_ACTIVE']])
    assert.equal(check({mode:'layout',titles:[],tabLists,composers}).code,code);
});

test('存在标签时必须匹配唯一主聊天，不能退化成单聊天绕过校验',windows,()=>{
  assert.equal(check({mode:'layout',titles:['合成聊天','其他聊天'],tabLists:1,composers:2}).layout,'tabs');
  for(const titles of [['其他聊天'],['合成聊天','合成聊天']])assert.equal(check({mode:'layout',titles,tabLists:1,composers:1}).code,'GOAL_UI_THREAD_CHANGED');
});

test('单聊天在选择及提交前仍复核上下文，并跳过不存在的标签模式',windows,()=>{
  const result=check({mode:'single-guards'});assert.equal(result.checks,2);assert.equal(result.reads,2);
});

test('首次导航等待布局就绪，但前台切换和超时不会被忽略',windows,()=>{
  assert.equal(check({mode:'loading'}).checks,3);
  assert.equal(check({mode:'foreground'}).code,'GOAL_UI_FOREGROUND_CHANGED');
  assert.equal(check({mode:'timeout'}).code,'GOAL_UI_LAYOUT_LOADING');
});
