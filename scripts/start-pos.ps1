<#
  Starts the POS server in the background (if not already running) and opens the POS
  in Microsoft Edge (or Chrome) as an app window with silent printing enabled.

  -Port 3000     Port for the server (default 3000)
  -Kiosk         Open full-screen kiosk mode (staff cannot leave the POS; Alt+F4 to close)
  -ServerOnly    Only start the server (e.g. on a machine used purely as the server)
#>
param([int]$Port = 3000, [switch]$Kiosk, [switch]$ServerOnly)
. "$PSScriptRoot\common.ps1"

$node = Get-NodeExe
if (-not $node) { Show-Error "Node.js not found. Run setup.bat first (see README.md)."; exit 1 }

if (-not (Test-PosRunning $Port)) {
  $logDir = Join-Path $AppDir 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $log = Join-Path $logDir 'server.log'
  $errLog = Join-Path $logDir 'server-error.log'
  foreach ($f in @($log, $errLog)) {
    if ((Test-Path $f) -and (Get-Item $f).Length -gt 5MB) { Move-Item $f "$f.old" -Force }
  }
  $env:PORT = "$Port"
  Start-Process -FilePath $node `
    -ArgumentList @('--disable-warning=ExperimentalWarning', 'server\index.js') `
    -WorkingDirectory $AppDir -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError $errLog | Out-Null

  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Test-PosRunning $Port)) {
    if ((Get-Date) -gt $deadline) {
      Show-Error "POS server did not start. Check $errLog"
      exit 1
    }
    Start-Sleep -Milliseconds 500
  }
}

if ($ServerOnly) { Write-Host "POS server running on http://localhost:$Port"; exit 0 }

$browser = Get-BrowserExe
$url = "http://localhost:$Port/"
if (-not $browser) { Start-Process $url; exit 0 }

# A dedicated browser profile guarantees the flags below take effect even if the
# user has other Edge/Chrome windows open, and keeps the POS isolated.
$profileDir = Join-Path $AppDir 'data\browser-profile'
$browserArgs = @(
  "--user-data-dir=`"$profileDir`"",
  '--kiosk-printing',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-features=Translate,msEdgeSidebarV2,msShowFRE'
)
if ($Kiosk) {
  $browserArgs += @('--kiosk', $url, '--edge-kiosk-type=fullscreen')
} else {
  $browserArgs += @("--app=$url", '--start-maximized')
}
Start-Process -FilePath $browser -ArgumentList $browserArgs | Out-Null
