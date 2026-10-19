# Stops the POS server listening on the given port.
param([int]$Port = 3000)
. "$PSScriptRoot\common.ps1"

$stopped = $false
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') {
    Stop-Process -Id $p.Id -Force
    $stopped = $true
  }
}
if ($stopped) { Write-Host "POS server stopped." } else { Write-Host "POS server was not running on port $Port." }
