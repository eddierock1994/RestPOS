<#
  One-time setup for the Restaurant POS on the billing PC (works fully offline).

  .\setup.bat                 -> check Node, create folders, desktop shortcuts, auto-start at login
  .\setup.bat -AllowLan       -> also open the firewall so phones/tablets/other PCs on the LAN can use the POS (run as Administrator)
  .\setup.bat -Kiosk          -> shortcuts open full-screen kiosk mode
  .\setup.bat -NoAutostart    -> don't start the POS automatically when Windows logs in
  .\setup.bat -RemoveAutostart-> remove the auto-start entry
  .\setup.bat -Port 8080      -> use a different port
#>
param([int]$Port = 3000, [switch]$AllowLan, [switch]$Kiosk, [switch]$NoAutostart, [switch]$RemoveAutostart)
. "$PSScriptRoot\common.ps1"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Restaurant POS.lnk'

if ($RemoveAutostart) {
  if (Test-Path $startupLnk) { Remove-Item $startupLnk -Force; Ok 'Auto-start removed.' } else { Ok 'Auto-start was not configured.' }
  exit 0
}

Write-Host "Restaurant POS setup  (folder: $AppDir)" -ForegroundColor White

# 1. Node.js runtime ------------------------------------------------------------
Step 'Checking Node.js runtime'
$node = Get-NodeExe
if (-not $node) {
  $msi = Get-ChildItem -Path (Join-Path $AppDir 'installers') -Filter 'node-*-x64.msi' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if ($msi) {
    if (-not $isAdmin) { Show-Error "Node.js installer found ($($msi.Name)) but setup must be run as Administrator to install it.`nRight-click setup.bat > Run as administrator."; exit 1 }
    Write-Host "    Installing $($msi.Name) silently..."
    $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$($msi.FullName)`"", '/qn', '/norestart') -Wait -PassThru
    if ($p.ExitCode -ne 0) { Show-Error "Node.js installer failed (exit code $($p.ExitCode))."; exit 1 }
    $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH"
    $node = Get-NodeExe
  }
}
if (-not $node) {
  Show-Error @"
Node.js was not found.
Fix (pick one):
  a) On a PC with internet, run prepare-offline.bat inside this folder, then copy the whole folder here again.
  b) Install Node.js 24 LTS (64-bit) from a USB drive, then run setup.bat again.
"@
  exit 1
}
$ver = Get-NodeVersion $node
if (-not $ver -or $ver -lt $MinNodeVersion) { Show-Error "Node.js $ver at $node is too old. Version $MinNodeVersion or newer is required (Node 24 LTS recommended)."; exit 1 }
Ok "Node.js $ver  ($node)"
& $node --disable-warning=ExperimentalWarning -e "require('node:sqlite')" 2>$null
if ($LASTEXITCODE -ne 0) { Show-Error 'This Node.js build has no built-in SQLite support. Use Node.js 24 LTS.'; exit 1 }
Ok 'Built-in SQLite available'

# 2. Folders & database ------------------------------------------------------------
Step 'Preparing data folders and database'
foreach ($d in 'data', 'backups', 'logs') { New-Item -ItemType Directory -Force -Path (Join-Path $AppDir $d) | Out-Null }
Push-Location $AppDir
try {
  & $node --disable-warning=ExperimentalWarning -e "require('./server/db').open(require('path').join('data','pos.db')).close(); console.log('    Database ready: data\\pos.db')"
  if ($LASTEXITCODE -ne 0) { throw 'Database initialisation failed' }
} finally { Pop-Location }

# 3. Shortcuts ---------------------------------------------------------------------
Step 'Creating shortcuts'
$shell = New-Object -ComObject WScript.Shell
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\scripts\start-pos.ps1`" -Port $Port"
if ($Kiosk) { $startArgs += ' -Kiosk' }
$browserIcon = Get-BrowserExe

function New-Shortcut($path, $arguments, $icon, $desc) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = $ps
  $s.Arguments = $arguments
  $s.WorkingDirectory = $AppDir
  $s.WindowStyle = 7
  $s.Description = $desc
  if ($icon) { $s.IconLocation = "$icon,0" }
  $s.Save()
}
$desktop = [Environment]::GetFolderPath('Desktop')
New-Shortcut (Join-Path $desktop 'Restaurant POS.lnk') $startArgs $browserIcon 'Open the Restaurant POS'
New-Shortcut (Join-Path $desktop 'Stop POS server.lnk') "-NoProfile -ExecutionPolicy Bypass -File `"$AppDir\scripts\stop-pos.ps1`" -Port $Port" "$env:SystemRoot\System32\shell32.dll,27" 'Stop the POS server'
Ok 'Desktop: "Restaurant POS" and "Stop POS server"'

if (-not $NoAutostart) {
  New-Shortcut $startupLnk $startArgs $browserIcon 'Start Restaurant POS at login'
  Ok 'POS will start automatically when this Windows user logs in'
} else {
  Warn 'Auto-start skipped (-NoAutostart)'
}

# 4. LAN access (optional) -----------------------------------------------------------
if ($AllowLan) {
  Step "Allowing LAN access on TCP port $Port"
  if (-not $isAdmin) {
    Warn 'Skipped: run setup.bat -AllowLan as Administrator to add the firewall rule.'
  } else {
    Get-NetFirewallRule -DisplayName 'Restaurant POS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName 'Restaurant POS' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private, Domain | Out-Null
    Ok 'Firewall rule "Restaurant POS" added (Private/Domain networks)'
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
    foreach ($ip in $ips) { Ok "Other devices can open: http://${ip}:$Port" }
    Warn 'Tip: give this PC a fixed IP (or a DHCP reservation in the router) so the address never changes.'
  }
}

# 5. Keep the PC awake on mains power ------------------------------------------------
Step 'Power settings'
try {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null
  Ok 'Sleep/hibernate disabled while on AC power'
} catch { Warn 'Could not change power settings (do it manually: Settings > System > Power > Sleep = Never)' }

Step 'Done'
Ok 'Double-click "Restaurant POS" on the desktop to start.'
Ok 'Admin PIN is 1234 by default - change it in Configuration > Security & backup.'
