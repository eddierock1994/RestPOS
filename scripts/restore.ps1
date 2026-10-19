<#
  Restores the POS database from a backup file.
  restore.bat                       -> pick from a list of recent backups
  restore.bat -File E:\pos-xxx.db   -> restore a specific file
  The current database is saved to backups\pos-before-restore-*.db first.
#>
param([string]$File, [int]$Port = 3000)
. "$PSScriptRoot\common.ps1"

$backupDir = Join-Path $AppDir 'backups'
$dataDir = Join-Path $AppDir 'data'
$dbFile = Join-Path $dataDir 'pos.db'

if (-not $File) {
  $list = @(Get-ChildItem -Path $backupDir -Filter '*.db' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 20)
  if (-not $list.Count) { Write-Host "No backups found in $backupDir"; exit 1 }
  for ($i = 0; $i -lt $list.Count; $i++) { Write-Host ("{0,3}) {1}   {2:dd-MM-yyyy HH:mm}   {3:N0} KB" -f ($i + 1), $list[$i].Name, $list[$i].LastWriteTime, ($list[$i].Length / 1KB)) }
  $choice = Read-Host 'Enter number to restore (or press Enter to cancel)'
  if (-not $choice) { exit 0 }
  $File = $list[[int]$choice - 1].FullName
}
if (-not (Test-Path $File)) { Write-Host "File not found: $File" -ForegroundColor Red; exit 1 }

$confirm = Read-Host "Restore '$File'? All changes after that backup will be lost. Type YES to continue"
if ($confirm -ne 'YES') { Write-Host 'Cancelled.'; exit 0 }

$wasRunning = Test-PosRunning $Port
& "$PSScriptRoot\stop-pos.ps1" -Port $Port
Start-Sleep -Seconds 1

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
foreach ($suffix in '', '-wal', '-shm') {
  $src = "$dbFile$suffix"
  if (Test-Path $src) { Copy-Item $src (Join-Path $backupDir "pos-before-restore-$stamp.db$suffix") -Force }
}
Remove-Item "$dbFile-wal", "$dbFile-shm" -Force -ErrorAction SilentlyContinue
Copy-Item $File $dbFile -Force
Write-Host "Restored. Previous database saved as backups\pos-before-restore-$stamp.db" -ForegroundColor Green

if ($wasRunning) { & "$PSScriptRoot\start-pos.ps1" -Port $Port -ServerOnly }
