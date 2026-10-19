<#
  Run this ONCE on any Windows PC that has internet. It downloads a portable
  Node.js (64-bit) into the "runtime" folder so the POS can run on the
  offline billing PC without installing anything.
  Afterwards copy the whole POS folder to the billing PC (pen drive) and run setup.bat there.
#>
param([string]$Major = '24')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$AppDir = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $AppDir 'runtime'

Write-Host "Finding latest Node.js v$Major LTS..."
$index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
$rel = $index | Where-Object { $_.version -like "v$Major.*" -and $_.lts } | Select-Object -First 1
if (-not $rel) { $rel = $index | Where-Object { $_.version -like "v$Major.*" } | Select-Object -First 1 }
if (-not $rel) { throw "No Node.js v$Major release found" }
$v = $rel.version
$zipName = "node-$v-win-x64.zip"
$url = "https://nodejs.org/dist/$v/$zipName"
$tmp = Join-Path $env:TEMP $zipName

Write-Host "Downloading $url ..."
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

Write-Host 'Verifying checksum...'
$sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$v/SHASUMS256.txt" -UseBasicParsing).Content
$expected = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) }) -replace '\s+.*$', ''
$actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
if ($expected.Trim().ToLower() -ne $actual) { throw "Checksum mismatch for $zipName" }

Write-Host "Extracting to $runtime ..."
if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
$extract = Join-Path $env:TEMP "node-extract-$([guid]::NewGuid())"
Expand-Archive -Path $tmp -DestinationPath $extract -Force
Move-Item (Join-Path $extract "node-$v-win-x64") $runtime
Remove-Item $extract -Recurse -Force
Remove-Item $tmp -Force

& (Join-Path $runtime 'node.exe') -v
Write-Host "`nDone. Portable Node.js $v is in the 'runtime' folder." -ForegroundColor Green
Write-Host 'Now copy the entire POS folder to the billing PC and run setup.bat there.' -ForegroundColor Green
