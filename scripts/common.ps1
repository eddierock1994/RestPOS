# Shared helpers dot-sourced by the other POS scripts.
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $PSScriptRoot
$MinNodeVersion = [version]'22.13.0'

function Get-NodeExe {
  $local = Join-Path $AppDir 'runtime\node.exe'
  if (Test-Path $local) { return $local }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $pf = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $pf) { return $pf }
  return $null
}

function Get-NodeVersion([string]$node) {
  try { return [version](& $node -p 'process.versions.node') } catch { return $null }
}

function Test-PosRunning([int]$Port) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/session" -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Get-BrowserExe {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Show-Error([string]$msg) {
  Write-Host $msg -ForegroundColor Red
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($msg, 'Restaurant POS', 'OK', 'Error')
  } catch { }
}
