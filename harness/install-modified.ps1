<#
.SYNOPSIS
  把 patch\ 目录里的改版文件装进一份官方 DSH NEXT 2.0.19-next 安装里。

.DESCRIPTION
  官方桌面端把全部代码打进 resources\app.asar。Electron 启动时优先加载
  resources\app\ 目录（存在即优先于 app.asar），所以流程是：
    1. 找到安装目录（注册表 / 常见路径 / -InstallDir）
    2. 只结束「可执行文件就在这个安装目录下」的 DSH NEXT 进程
    3. app.asar 改名为 app.asar.orig（不删，留退路）
    4. 用 asar-read.mjs 把 app.asar.orig 展开成 resources\app\
    5. 叠加 app.asar.unpacked 里的原生模块
    6. 用 patch\ 下的同名文件覆盖，逐个校验 sha256

.PARAMETER InstallDir
  DSH NEXT 安装根目录（含 resources 子目录的那层）。默认自动探测。

.PARAMETER Revert
  还原：删掉 resources\app\，把 app.asar.orig 改回 app.asar。

.PARAMETER Force
  resources\app 已存在时也继续（默认拒绝，避免覆盖别人改过的东西）。

.PARAMETER DryRun
  只打印将要做什么，不改任何文件、不结束任何进程。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-modified.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -InstallDir "D:\DSH NEXT"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -Revert
#>

[CmdletBinding()]
param(
  [string]$InstallDir,
  [switch]$Revert,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root      = $PSScriptRoot
$PatchDir  = Join-Path $Root 'patch'
$Manifest  = Join-Path $Root 'MANIFEST.txt'
$AsarTool  = Join-Path $Root 'asar-read.mjs'

function Say  { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Ok   { param([string]$m) Write-Host "    $m" -ForegroundColor DarkGray }
function Bad  { param([string]$m) Write-Host "!!! $m" -ForegroundColor Red }
function Plan { param([string]$m) Write-Host "  [dry] $m" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 定位安装
function Resolve-InstallDir {
  param([string]$Hint)

  if ($Hint) {
    $h = $Hint.TrimEnd('\')
    if (Test-Path (Join-Path $h 'resources\app.asar'))       { return (Resolve-Path $h).Path }
    if (Test-Path (Join-Path $h 'resources\app.asar.orig'))  { return (Resolve-Path $h).Path }
    if (Test-Path (Join-Path $h 'resources\app'))            { return (Resolve-Path $h).Path }
    throw "指定的目录里没有 resources\app.asar 或 resources\app：$Hint"
  }

  $regRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($r in $regRoots) {
    $hit = Get-ItemProperty $r -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like '*DSH*NEXT*' -and $_.UninstallString } |
      Select-Object -First 1
    if ($hit) {
      $u = $hit.UninstallString
      if ($u -match '^\s*"([^"]+)"') { $exe = $matches[1] }
      elseif ($u -match '^\s*(\S+\.exe)') { $exe = $matches[1] }
      else { $exe = $null }
      if ($exe -and (Test-Path $exe)) {
        $dir = Split-Path $exe -Parent
        if (Test-Path (Join-Path $dir 'resources')) { return $dir }
      }
    }
  }

  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DSH NEXT') }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'DSH NEXT') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DSH NEXT') }
  $candidates += @('D:\DSH NEXT','D:\Program Files\DSH NEXT','E:\DSH NEXT')

  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'resources')) { return $c }
  }

  throw "没找到 DSH NEXT。请用 -InstallDir 指定安装根目录（含 resources 子目录的那层）。"
}

# ---------------------------------------------------------------- 精确结束进程
# 只结束 exe 路径落在 $Root 内的 DSH NEXT 进程。
# 早期版本按进程名一刀切，会把机器上别的安装（甚至正在用的那个）一起关掉。
function Get-TargetProcesses {
  param([string]$RootDir)

  $normRoot = [System.IO.Path]::GetFullPath($RootDir).TrimEnd('\') + '\'
  $mine = @()
  $others = @()

  foreach ($p in @(Get-Process -Name 'DSH NEXT' -ErrorAction SilentlyContinue)) {
    $exePath = $null
    try { $exePath = $p.Path } catch { }
    if (-not $exePath) {
      # 拿不到路径（权限/已退出）时按不确定处理，绝不主动杀
      $others += [pscustomobject]@{ Id = $p.Id; Path = '<unknown>' }
      continue
    }
    $full = [System.IO.Path]::GetFullPath($exePath)
    if ($full.StartsWith($normRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      $mine += [pscustomobject]@{ Id = $p.Id; Path = $full }
    } else {
      $others += [pscustomobject]@{ Id = $p.Id; Path = $full }
    }
  }
  [pscustomobject]@{ Target = $mine; Others = $others }
}

# ---------------------------------------------------------------- asar 解包
function Expand-Asar {
  param([string]$AsarPath, [string]$DestDir)

  if (-not (Test-Path $AsarTool)) { throw "缺少 asar-read.mjs（应与本脚本同目录）" }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { $node = Get-Command node.exe -ErrorAction SilentlyContinue }
  if (-not $node) {
    throw "需要 node 在 PATH 里来解包 asar。装 Node.js 22+ / 24，或把 DSH NEXT 自带的 node 加到 PATH。"
  }

  $out = & $node.Source $AsarTool $AsarPath $DestDir 2>&1
  if ($LASTEXITCODE -ne 0) { throw "asar 解包失败：`n$($out -join "`n")" }
  Ok ($out | Select-Object -Last 1)
}

# ---------------------------------------------------------------- 主流程
Say '读取 MANIFEST'
if (-not (Test-Path $Manifest)) { throw "缺少 MANIFEST.txt" }
$entries = @()
foreach ($line in (Get-Content $Manifest)) {
  if (-not $line.Trim()) { continue }
  $p = $line -split '\s+', 3
  $entries += [pscustomobject]@{ Sha256 = $p[0]; Size = [int64]$p[1]; Rel = $p[2] }
}
Ok ("清单 {0} 个文件" -f $entries.Count)

Say '定位 DSH NEXT'
$rootResolved = Resolve-InstallDir -Hint $InstallDir
Ok $rootResolved
if ($DryRun) { Plan "目标安装：$rootResolved" }

$resDir   = Join-Path $rootResolved 'resources'
$asarPath = Join-Path $resDir 'app.asar'
$origAsar = Join-Path $resDir 'app.asar.orig'
$appDir   = Join-Path $resDir 'app'
$unpacked = Join-Path $resDir 'app.asar.unpacked'

if ($Revert) {
  Say '还原模式'
  if ($DryRun) { Plan "删除 $appDir；把 $origAsar 改回 $asarPath"; return }
  if (Test-Path $appDir) {
    Say "删除解包目录 $appDir"
    Remove-Item $appDir -Recurse -Force
    Ok 'done'
  }
  if ((Test-Path $origAsar) -and -not (Test-Path $asarPath)) {
    Say 'app.asar.orig 改回 app.asar'
    Move-Item $origAsar $asarPath -Force
    Ok 'done'
  }
  if (-not (Test-Path $asarPath)) { Bad '没有 app.asar，也没有 app.asar.orig —— 这份安装不完整。' }
  Write-Host "`n还原完成，启动 DSH NEXT 确认。" -ForegroundColor Green
  return
}

if (-not (Test-Path $asarPath) -and -not (Test-Path $origAsar)) {
  $bak = Join-Path $resDir 'app.asar.bak'
  if ((Test-Path $bak) -and (Test-Path (Join-Path $appDir 'package.json'))) {
    if ($Force) {
      # 已解包 + -Force：允许用 app.asar.bak 重新解包覆盖
      Write-Host ""
      Ok '检测到已解包的安装（app.asar 不在，有 app.asar.bak）'
      Ok '按 -Force 处理：用 app.asar.bak 重新解包，再覆盖补丁'
      Write-Host ""
    } else {
      Write-Host ""
      Bad "这个安装已经是解包状态了（有 app.asar.bak 和 resources\app）。"
      Bad "说明 dsh-purge 或本脚本之前已经跑过，补丁大概率已在位。"
      Write-Host ""
      Write-Host "  只想更新补丁文件：加 -Force 重跑（会用 app.asar.bak 重新解包再覆盖）" -ForegroundColor Yellow
      Write-Host "  想查当前补丁状态：PowerShell 里执行下面的核对命令" -ForegroundColor Yellow
      Write-Host ""
      Write-Host '  Get-Content .\MANIFEST.txt | ForEach-Object {' -ForegroundColor DarkGray
      Write-Host '      $h,$sz,$rel = $_ -split ''\s+'',3' -ForegroundColor DarkGray
      Write-Host '      $fp = Join-Path "<安装目录>\resources\app" ($rel -replace ''/'',''\'')' -ForegroundColor DarkGray
      Write-Host '      if (-not (Test-Path $fp)) { "MISSING $rel"; return }' -ForegroundColor DarkGray
      Write-Host '      if ((Get-FileHash $fp -Algorithm SHA256).Hash -ne $h) { "DIFF    $rel" }' -ForegroundColor DarkGray
      Write-Host '  }' -ForegroundColor DarkGray
      Write-Host ""
      throw "已解包的安装，未做任何改动。"
    }
  } else {
    throw "既没有 app.asar 也没有 app.asar.orig。这不是一份完整的官方安装，或者已经被改过。"
  }
}
if ((Test-Path $appDir) -and -not $Force -and -not $DryRun) {
  $n = @(Get-ChildItem $appDir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
  throw "resources\app 已存在（$n 个文件）。可能已经装过补丁，或者用了别的魔改。确认要覆盖就加 -Force。"
}

# ---- 结束进程：只动目标目录里的
Say '关闭 DSH NEXT（仅限目标安装目录内的进程）'
$scan = Get-TargetProcesses -RootDir $rootResolved
if ($scan.Others.Count -gt 0) {
  Ok ("另有 {0} 个 DSH NEXT 进程不属于这个安装，不动它们：" -f $scan.Others.Count)
  foreach ($o in $scan.Others) { Ok ("   pid {0}  {1}" -f $o.Id, $o.Path) }
}
if ($scan.Target.Count -gt 0) {
  Ok ("将结束 {0} 个：{1}" -f $scan.Target.Count, (($scan.Target | ForEach-Object { "pid $($_.Id)" }) -join ', '))
  if ($DryRun) {
    Plan '跳过实际结束（dry run）'
  } else {
    foreach ($t in $scan.Target) {
      try { Stop-Process -Id $t.Id -Force -ErrorAction Stop }
      catch { Bad ("pid {0} 结束失败：{1}" -f $t.Id, $_.Exception.Message) }
    }
    Start-Sleep -Seconds 2
    $left = (Get-TargetProcesses -RootDir $rootResolved).Target.Count
    if ($left -gt 0) { Bad ("仍有 {0} 个进程未退出，继续会导致文件占用。" -f $left) }
    else { Ok '已全部退出' }
  }
} else {
  Ok '目标目录里没有运行中的进程'
}

# ---- 准备原始归档
if (Test-Path $asarPath) {
  Say 'app.asar 改名为 app.asar.orig（保留退路）'
  if ($DryRun) { Plan "Move $asarPath -> $origAsar" }
  else {
    if (Test-Path $origAsar) { Remove-Item $origAsar -Force }
    Move-Item $asarPath $origAsar -Force
    Ok ("{0:N1} MB" -f ((Get-Item $origAsar).Length / 1MB))
  }
} elseif ((Test-Path (Join-Path $resDir 'app.asar.bak')) -and -not (Test-Path $origAsar)) {
  Say 'app.asar 已不在（之前解包过），用 app.asar.bak 当原始归档'
  if ($DryRun) { Plan "Copy app.asar.bak -> $origAsar" }
  else {
    Copy-Item (Join-Path $resDir 'app.asar.bak') $origAsar -Force
    Ok ("{0:N1} MB" -f ((Get-Item $origAsar).Length / 1MB))
  }
}

# ---- 解包
Say '解包 app.asar.orig → resources\app'
if ($DryRun) { Plan "Remove $appDir; asar-read.mjs $origAsar $appDir" }
else {
  if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
  Expand-Asar -AsarPath $origAsar -DestDir $appDir
}

# ---- 叠加 unpacked
if (Test-Path $unpacked) {
  Say '叠加 app.asar.unpacked 里的原生模块'
  if ($DryRun) { Plan "copy $unpacked\** -> $appDir" }
  else {
    $n = 0
    foreach ($f in (Get-ChildItem $unpacked -Recurse -File -Force)) {
      $rel = $f.FullName.Substring($unpacked.Length).TrimStart('\')
      $tgt = Join-Path $appDir $rel
      $d = Split-Path $tgt -Parent
      if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }
      Copy-Item $f.FullName $tgt -Force
      $n++
    }
    Ok ("叠加 {0} 个文件" -f $n)
  }
}

# ---- 覆盖 patch
Say '覆盖 patch\ 下的改版文件'
if ($DryRun) {
  Plan ("将覆盖 {0} 个文件到 $appDir" -f $entries.Count)
} else {
  $applied = 0
  $failed = @()
  foreach ($e in $entries) {
    $src = Join-Path $PatchDir ($e.Rel -replace '/', '\')
    if (-not (Test-Path $src)) { $failed += "缺失 $($e.Rel)"; continue }
    $tgt = Join-Path $appDir ($e.Rel -replace '/', '\')
    $d = Split-Path $tgt -Parent
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }
    Copy-Item $src $tgt -Force
    $h = (Get-FileHash $tgt -Algorithm SHA256).Hash
    if ($h -ne $e.Sha256) { $failed += "哈希不符 $($e.Rel)" } else { $applied++ }
  }
  Ok ("覆盖 {0} / {1} 个文件" -f $applied, $entries.Count)

  Say '验证关键补丁'
  $mainJs = Join-Path $appDir 'lib\main.js'
  if (Test-Path $mainJs) {
    if (Select-String -Path $mainJs -Pattern 'updates-off' -Quiet) { Ok 'OK  官方自动更新已关闭' }
    else { Bad '--  未找到 updates-off 标记' }
  } else { Bad 'lib\main.js 缺失' }

  $ws = Join-Path $appDir 'node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js'
  if (Test-Path $ws) {
    if (Select-String -Path $ws -Pattern 'dsh-session-delete' -Quiet) { Ok 'OK  会话删除接口已加' }
    else { Bad '--  未找到 dsh-session-delete' }
  }

  $sb = Join-Path $appDir 'node_modules\@deepseek-ai\dsh-sandbox\lib\index.js'
  if (Test-Path $sb) {
    if (Select-String -Path $sb -Pattern 'dsh-purge' -Quiet) { Ok 'OK  沙箱补丁存在' }
    else { Bad '--  沙箱补丁未找到 dsh-purge 标记' }
  }

  if ($failed.Count -gt 0) {
    Write-Host "`n以下条目有问题：" -ForegroundColor Yellow
    foreach ($f in $failed) { Bad $f }
  }
}

if ($DryRun) {
  Write-Host "`n[dry run] 什么都没改。" -ForegroundColor Yellow
  return
}

Write-Host @"

装完了。启动 DSH NEXT 验证：
  1) 双击安装目录里的 "DSH NEXT.exe"
  2) 设置里看 dsh-purge 补丁状态
  3) 托盘菜单里不再出现「检查更新」

还原：
  powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -Revert

"@ -ForegroundColor Green
