$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$bossRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bossRuntime = Join-Path $bossRoot '.runtime'
function Test-BossNode([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  try {
    & $file -e 'process.exit(parseInt(process.versions.node,10)>=22?0:1)' 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}
function Assert-BossDirectory([string]$file) {
  if (Test-Path -LiteralPath $file) {
    $entry = Get-Item -LiteralPath $file -Force
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$file must be an ordinary directory, not a junction or symlink." }
  }
}
$bossStage = $null
$bossLock = $null
try {
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode -and (Get-Command npm.cmd -ErrorAction SilentlyContinue) -and (Test-BossNode $systemNode.Source)) { Write-Output $systemNode.Source; exit 0 }
  Assert-BossDirectory $bossRuntime
  if (-not (Test-Path -LiteralPath $bossRuntime)) { New-Item -ItemType Directory -Path $bossRuntime | Out-Null }
  $bossNodeDir = Join-Path $bossRuntime 'node'
  Assert-BossDirectory $bossNodeDir
  if (Test-Path -LiteralPath $bossNodeDir) {
    $localNode = Join-Path $bossNodeDir 'node.exe'
    if ((Test-BossNode $localNode) -and (Test-Path -LiteralPath (Join-Path $bossNodeDir 'node_modules/npm/bin/npm-cli.js') -PathType Leaf)) { Write-Output $localNode; exit 0 }
    throw 'Project Node is incomplete. No files were overwritten. Check or remove .runtime/node and try again.'
  }
  $bossArchitecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
  if (-not $bossArchitecture) { $bossArchitecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
  switch ($bossArchitecture.ToUpperInvariant()) { 'AMD64' { $bossArch = 'x64' } 'ARM64' { $bossArch = 'arm64' } default { throw 'Unsupported CPU architecture. Install Node.js 22 or newer from https://nodejs.org/.' } }
  $bossName = "node-v22.23.3-win-$bossArch"
  $bossArchive = "$bossName.zip"
  $bossManifest = Join-Path $bossRoot 'scripts/install-node-checksums.txt'
  $matches = @(Get-Content -LiteralPath $bossManifest | Where-Object { $_ -match ('^[a-f0-9]{64}\s+' + [regex]::Escape($bossArchive) + '$') })
  if ($matches.Count -ne 1) { throw 'Missing or ambiguous Node SHA-256 entry. Download the complete source again.' }
  $bossExpected = ($matches[0] -split '\s+')[0]
  $lockPath = Join-Path $bossRuntime 'node-install.lock'
  $bossLock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $bossStage = Join-Path $bossRuntime ('.node-install-' + [Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $bossStage | Out-Null
  [Console]::Error.WriteLine('First launch: downloading official Node.js 22.23.3 into this project and verifying SHA-256...')
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $download = Join-Path $bossStage $bossArchive
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v22.23.3/$bossArchive" -OutFile $download -TimeoutSec 180 -MaximumRedirection 0
  $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $bossExpected) { throw 'Node archive SHA-256 mismatch. Nothing was extracted or executed.' }
  Expand-Archive -LiteralPath $download -DestinationPath $bossStage
  $extracted = Join-Path $bossStage $bossName
  if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node_modules/npm/bin/npm-cli.js') -PathType Leaf) -or -not (Test-BossNode (Join-Path $extracted 'node.exe'))) { throw 'The downloaded Node runtime is incomplete or cannot run on this system.' }
  if (Test-Path -LiteralPath $bossNodeDir) { throw 'Project Node changed during installation. Existing files were not overwritten.' }
  Move-Item -LiteralPath $extracted -Destination $bossNodeDir
  Write-Output (Join-Path $bossNodeDir 'node.exe')
} catch {
  [Console]::Error.WriteLine(('Node setup failed: ' + $_.Exception.Message))
  exit 1
} finally {
  if ($bossStage -and (Test-Path -LiteralPath $bossStage)) { Remove-Item -LiteralPath $bossStage -Recurse -Force }
  if ($bossLock) { $bossLock.Dispose(); Remove-Item -LiteralPath (Join-Path $bossRuntime 'node-install.lock') -Force }
}
