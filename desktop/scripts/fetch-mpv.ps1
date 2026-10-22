# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Puts the pinned mpv into the app's resources (spec §6): downloads the archive named in desktop/player/mpv.lock, refuses
# it unless its SHA-256 matches the lock, and extracts mpv.exe, d3dcompiler_43.dll (if the build has it) and the licence
# texts into -Dest. Needs 7-Zip (`7z`, on the windows-latest runners). Exits non-zero on any failure.
#   pwsh desktop/scripts/fetch-mpv.ps1 -Dest desktop/app/mpv
param(
  [Parameter(Mandatory = $true)][string]$Dest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Dest = [IO.Path]::GetFullPath($Dest, (Get-Location).Path)

function Fail([string]$message) {
  # GitHub Actions shows ::error lines as annotations; elsewhere it is a plain line
  Write-Host "::error title=fetch-mpv::$message"
  exit 1
}

$player = Join-Path $PSScriptRoot '..' 'player'
$lockFile = Join-Path $player 'mpv.lock'
$lock = @{}
foreach ($line in Get-Content -LiteralPath $lockFile -Encoding utf8) {
  if ($line -match '^\s*(#|$)') { continue }
  if ($line -match '^\s*([a-z0-9]+)\s*=\s*(\S+)\s*$') { $lock[$Matches[1]] = $Matches[2] }
  else { Fail "mpv.lock: unreadable line: $line" }
}
$url = $lock['url']
$sha256 = $lock['sha256']
$prefix = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/'
if (-not $url -or -not $url.StartsWith($prefix) -or $url -notmatch '/mpv-x86_64-[0-9]{8}-git-[0-9a-f]+\.7z$') {
  Fail "mpv.lock: url must be a $prefix<tag>/mpv-x86_64-<date>-git-<sha>.7z asset"
}
if (-not $sha256 -or $sha256 -notmatch '^[0-9a-f]{64}$') {
  Fail "mpv.lock: sha256 is not set ('$sha256'). Download $url, put its SHA-256 (64 lowercase hex digits) into desktop/player/mpv.lock and commit it."
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('ff-mpv-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $archive = Join-Path $work 'mpv.7z'
  $ProgressPreference = 'SilentlyContinue'  # the progress bar slows Invoke-WebRequest down a lot
  $done = $false
  for ($try = 1; $try -le 3 -and -not $done; $try++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -MaximumRedirection 5
      $done = $true
    } catch {
      Write-Host "download attempt $try failed: $($_.Exception.Message)"
      if ($try -lt 3) { Start-Sleep -Seconds (5 * $try) }
    }
  }
  if (-not $done) { Fail "could not download $url" }

  $got = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($got -ne $sha256) {
    Fail "SHA-256 mismatch for $url`: expected $sha256, got $got. The archive is not used."
  }
  Write-Host "mpv archive verified: $got"

  $out = Join-Path $work 'x'
  & 7z x $archive "-o$out" -y -bso0 -bsp0
  if ($LASTEXITCODE -ne 0) { Fail "7z could not extract the archive (exit $LASTEXITCODE)" }
  $exe = Join-Path $out 'mpv.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { Fail 'the archive has no mpv.exe at its top level' }

  # a fresh folder: nothing from an older pin stays behind
  if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
  New-Item -ItemType Directory -Path $Dest | Out-Null
  Copy-Item -LiteralPath $exe -Destination $Dest
  $d3d = Join-Path $out 'd3dcompiler_43.dll'
  if (Test-Path -LiteralPath $d3d -PathType Leaf) { Copy-Item -LiteralPath $d3d -Destination $Dest }

  # licence texts: the build's own (if it ships any) and the GPL/LGPL texts kept in the repository
  $licences = Join-Path $Dest 'licenses'
  New-Item -ItemType Directory -Path $licences | Out-Null
  Get-ChildItem -LiteralPath $out -Recurse -File |
    Where-Object { $_.Name -match '^(LICEN[CS]E|COPYING|Copyright)' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licences ('mpv-build-' + $_.Name)) }
  Copy-Item -Path (Join-Path $player 'licenses' '*') -Destination $licences
  $name = Split-Path -Leaf $url
  $commit = if ($name -match '-git-([0-9a-f]+)\.7z$') { $Matches[1] } else { 'unknown' }
  @(
    'mpv.exe in this folder is mpv (https://mpv.io), a free media player, in the Windows build made by'
    'shinchiro/mpv-winbuild-cmake (https://github.com/shinchiro/mpv-winbuild-cmake). FriendFlix starts it as a separate program.'
    ''
    'mpv is licensed under the GNU General Public License, version 2 or later (GPL-2.0.txt); parts of it and of the libraries'
    'in this build are under the GNU Lesser General Public License, version 2.1 or later (LGPL-2.1.txt), or other free'
    'licences named in their sources.'
    ''
    'Source code:'
    "  mpv:          https://github.com/mpv-player/mpv (commit $commit)"
    "  build recipe: https://github.com/shinchiro/mpv-winbuild-cmake (the release of $name lists every library and version)"
    "  this build:   $url"
    "  SHA-256:      $sha256"
  ) | Set-Content -LiteralPath (Join-Path $licences 'mpv-NOTICE.txt') -Encoding utf8

  Get-ChildItem -LiteralPath $Dest -Recurse -File | ForEach-Object { Write-Host "  $([IO.Path]::GetRelativePath($Dest, $_.FullName))" }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
