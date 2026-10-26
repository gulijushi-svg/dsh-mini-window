<#
.SYNOPSIS
  把 dsh-mini-window 一键发布到 GitHub（不需要安装 git / gh）。

.DESCRIPTION
  纯 GitHub REST API 实现：创建仓库 → 逐个文件提交 → 打 topics。
  只用 PowerShell 自带的 Invoke-RestMethod，所以任何 Windows 机器上都能跑。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File upload-github.ps1 -Token ghp_xxxxxxxx

.EXAMPLE
  # 指定仓库名、公开、附描述
  powershell -ExecutionPolicy Bypass -File upload-github.ps1 -Token <TOKEN> -Repo my-mini-window -Private:$false
#>
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Repo = 'dsh-mini-window',
  [string]$SourceDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
  [string]$Description = 'DeepSeek Harness 小窗插件：常驻悬浮球入口 + 屏幕级置顶小窗 + 页内小窗，消息直通当前会话并实时显示模型回复。',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'

$api = 'https://api.github.com'
$headers = @{
  Authorization        = "Bearer $Token"
  Accept               = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'         = 'dsh-mini-window-uploader'
}

# 排除本机残留与依赖；其余全部按仓库内容上传。
$excludeDirs = @('node_modules', '.git', 'dist', '.vscode', '.idea')
$excludeFiles = @('dsh-mini-window-state.json', '*.log', '*.bak', '*.bak-*', '*.tmp', 'Thumbs.db', 'desktop.ini')

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

Write-Step '校验 token 与账号'
$me = Invoke-RestMethod -Uri "$api/user" -Headers $headers -Method Get
$owner = $me.login
Write-Host "    账号：$owner"

Write-Step "创建 / 复用仓库 $owner/$Repo"
$payload = @{
  name        = $Repo
  description = $Description
  private     = [bool]$Private
  auto_init   = $false
  has_issues  = $true
} | ConvertTo-Json
try {
  $repoInfo = Invoke-RestMethod -Uri "$api/user/repos" -Headers $headers -Method Post -Body $payload -ContentType 'application/json'
  Write-Host "    已创建：$($repoInfo.html_url)"
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 422) {
    Write-Host '    仓库已存在，直接往里提交。'
    $repoInfo = Invoke-RestMethod -Uri "$api/repos/$owner/$Repo" -Headers $headers -Method Get
  } else {
    throw
  }
}

Write-Step '收集待上传文件'
$root = (Resolve-Path $SourceDir).Path
$files = Get-ChildItem -Path $root -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($root.Length + 1)
  $parts = $rel -split '[\\/]'
  $inExcludedDir = $false
  foreach ($part in $parts[0..([Math]::Max(0, $parts.Count - 2))]) {
    if ($excludeDirs -contains $part) { $inExcludedDir = $true }
  }
  if ($inExcludedDir) { return $false }
  foreach ($pattern in $excludeFiles) {
    if ($_.Name -like $pattern) { return $false }
  }
  return $true
}
Write-Host "    共 $($files.Count) 个文件"

$committed = 0
foreach ($file in $files) {
  $rel = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
  $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
  $body = @{
    message = "Add $rel"
    content = [Convert]::ToBase64String($bytes)
    branch  = 'main'
  } | ConvertTo-Json

  # 已存在的文件需要带上旧 blob 的 sha 才能更新。
  $sha = $null
  try {
    $existing = Invoke-RestMethod -Uri "$api/repos/$owner/$Repo/contents/$rel`?ref=main" -Headers $headers -Method Get
    $sha = $existing.sha
  } catch {
    $sha = $null
  }
  if ($null -ne $sha) { $body = ($body | ConvertFrom-Json); $body | Add-Member -NotePropertyName sha -NotePropertyValue $sha; $body = $body | ConvertTo-Json }

  try {
    Invoke-RestMethod -Uri "$api/repos/$owner/$Repo/contents/$rel" -Headers $headers -Method Put -Body $body -ContentType 'application/json' | Out-Null
    $committed += 1
    Write-Host "    [$committed/$($files.Count)] $rel"
  } catch {
    Write-Warning "    上传失败 $rel ：$($_.Exception.Message)"
  }
}

Write-Step '设置 topics'
try {
  $topics = @{ names = @('dsh', 'deepseek-harness', 'cordis-plugin', 'mini-window', 'always-on-top') } | ConvertTo-Json
  Invoke-RestMethod -Uri "$api/repos/$owner/$Repo/topics" -Headers $headers -Method Put -Body $topics -ContentType 'application/json' | Out-Null
  Write-Host '    已设置'
} catch {
  Write-Warning "    topics 设置失败（不影响仓库）：$($_.Exception.Message)"
}

Write-Host ''
Write-Host "完成：$($repoInfo.html_url)" -ForegroundColor Green
Write-Host "安装到 dsh：dsh plugin --profile desktop add github:$owner/$Repo"