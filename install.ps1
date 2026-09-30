param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Undagi"
)

$ErrorActionPreference = "Stop"
$Repository = "CharisChakim/undagi"
# Until after 1.0.1-beta the app was called The Architech and installed here.
# Its data/ and .env live in the install directory, so the old one is moved
# to the new name rather than left behind.
$LegacyInstallDir = "$env:LOCALAPPDATA\TheArchitech"
# The ARCHITECH_* name from before the rename is still accepted as a fallback.
$ArchiveUrl = if ($env:UNDAGI_ARCHIVE_URL) { $env:UNDAGI_ARCHIVE_URL } elseif ($env:ARCHITECH_ARCHIVE_URL) { $env:ARCHITECH_ARCHIVE_URL } else { "https://github.com/$Repository/archive/refs/heads/main.zip" }

foreach ($CommandName in @("node", "npm")) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Missing requirement: $CommandName"
  }
}

$NodeVersion = (& node -p 'process.versions.node').Trim().Split(".")
$NodeMajor = [int]$NodeVersion[0]
$NodeMinor = [int]$NodeVersion[1]
if (($NodeMajor -lt 22) -or (($NodeMajor -eq 22) -and ($NodeMinor -lt 14))) {
  throw "Node.js 22.14 or newer is required. Current version: $(& node --version)"
}

if (-not $PSBoundParameters.ContainsKey("InstallDir") -and (Test-Path $LegacyInstallDir) -and -not (Test-Path $InstallDir)) {
  Write-Host "Moving The Architech install to $InstallDir..."
  Move-Item -Path $LegacyInstallDir -Destination $InstallDir
  $LegacyLauncher = Join-Path $InstallDir "start-the-architech.cmd"
  if (Test-Path $LegacyLauncher) { Remove-Item -Path $LegacyLauncher }
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("undagi-" + [guid]::NewGuid())
$ArchivePath = Join-Path $TempDir "source.zip"

try {
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
  Write-Host "Downloading Undagi..."
  Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath
  Expand-Archive -Path $ArchivePath -DestinationPath $TempDir -Force
  $SourceDir = Get-ChildItem -Path $TempDir -Directory | Where-Object { $_.Name -like "undagi-*" } | Select-Object -First 1
  if (-not $SourceDir) {
    throw "Downloaded archive did not contain the application."
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  # Copying over the existing directory keeps data/ and .env during updates.
  Get-ChildItem -Path $SourceDir.FullName -Force | Copy-Item -Destination $InstallDir -Recurse -Force

  Write-Host "Installing dependencies and building production files..."
  Push-Location $InstallDir
  try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path (Join-Path $InstallDir "dist\index.html")) -or -not (Test-Path (Join-Path $InstallDir "dist\server.cjs"))) {
      throw "Production build is incomplete."
    }
  }
  finally {
    Pop-Location
  }

  $Launcher = Join-Path $InstallDir "start-undagi.cmd"
  "@echo off`r`ncd /d `"%~dp0`"`r`nnode dist\server.cjs --production`r`n" | Set-Content -Path $Launcher -Encoding Ascii

  Write-Host ""
  Write-Host "Installed in: $InstallDir"
  Write-Host "Start with: $Launcher"
  Write-Host "Then open http://localhost:3000"
}
finally {
  if (Test-Path $TempDir) {
    Remove-Item -Path $TempDir -Recurse -Force
  }
}
