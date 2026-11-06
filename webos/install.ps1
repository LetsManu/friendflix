# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
<#
.SYNOPSIS
  Installs FriendFlix (or the test app) on an LG TV in Developer Mode, from a GitHub release (docs/webos.md).
.DESCRIPTION
  Needs Node.js 20+. Installs the pinned ares CLI (@webos-tools/cli) into %LOCALAPPDATA%\friendflix-webos, downloads the
  .ipk and SHA256SUMS-webos.txt (latest release by default), checks the SHA-256, then registers the TV, fetches its key
  (ares asks for the Developer Mode passphrase itself; this script never sees it) and installs and launches the app.
  Works in Windows PowerShell 5.1 and pwsh 7.
.EXAMPLE
  .\install.ps1 192.0.2.10
.EXAMPLE
  .\install.ps1 192.0.2.10 -Probe -Version v2.4.0
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $TvIp,
  # no longer used: ares asks for the Developer Mode passphrase itself (kept so old command lines still parse)
  [Parameter(Position = 1)] [string] $Passphrase,
  # install FriendFlix Test (the test app) instead of FriendFlix
  [switch] $Probe,
  # install this .ipk instead of downloading a release
  [string] $Ipk,
  # a specific release such as v2.4.0 (default: the latest)
  [string] $Version,
  # tests only
  [Parameter(DontShow)] [string] $BaseUrl = 'https://github.com/LetsManu/friendflix/releases',
  [Parameter(DontShow)] [string] $AresDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest in 5.1 is slow with the progress bar
Set-StrictMode -Version 2

function Fail([string] $msg, [int] $code = 1) { [Console]::Error.WriteLine($msg); exit $code }
function Show-Usage([string] $why) {
  if ($why) { [Console]::Error.WriteLine($why) }
  [Console]::Error.WriteLine(@'
Usage: .\install.ps1 <TvIp> [-Probe] [-Ipk <file>] [-Version vX.Y.Z]
  <TvIp>             the TV's IP address (TV: Settings > Network > your connection)
                     LG's ares tool asks for the Developer Mode passphrase at "input passphrase:"
  -Probe             install FriendFlix Test (the test app) instead of FriendFlix
  -Ipk <file>        install this .ipk instead of downloading a release
  -Version vX.Y.Z    a specific release (default: the latest)
'@)
  exit 2
}
function Show-Hints {
  [Console]::Error.WriteLine(@"

Installing on the TV at $TvIp did not work. Check:
  - The Developer Mode app is installed on the TV, Dev Mode Status is ON and Key Server is ON.
  - The passphrase is the one the app shows now (it changes when the key server is switched off and on).
  - The TV and this computer are on the same network, and nothing blocks port 9922.
  - Developer Mode runs out after 50 hours: open the app and press Extend, then try again.
"@)
}
function Fail-Install([string] $msg) { [Console]::Error.WriteLine($msg); Show-Hints; exit 1 }

if (-not $TvIp) { Show-Usage }
$validIp = $TvIp -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'
if ($validIp) { foreach ($part in $TvIp.Split('.')) { if ([int]$part -gt 255) { $validIp = $false } } }
if (-not $validIp) { Show-Usage "not an IPv4 address: $TvIp" }
$tag = $null
if ($Version) {
  if ($Version -notmatch '^v?\d+\.\d+\.\d+$') { Show-Usage "the version looks like v1.2.3, not $Version" }
  $tag = 'v' + $Version.TrimStart('v')
}
if ($Ipk -and -not (Test-Path -LiteralPath $Ipk -PathType Leaf)) { Fail "no such file: $Ipk" }
$BaseUrl = $BaseUrl.TrimEnd('/')

$nodeMajor = $null
try { $nodeMajor = [int]((& node -p 'parseInt(process.versions.node, 10)' 2>$null) | Select-Object -First 1) } catch { $nodeMajor = $null }
if ($null -eq $nodeMajor -or $nodeMajor -lt 20) { Fail 'Node.js 20 or newer is needed: https://nodejs.org/' }

# The passphrase is typed into ares' own prompt: piping it from PowerShell 5.1 into the .cmd shim reached ares changed,
# so the TV refused the key (first run on a real TV). This script never reads, holds or passes it.
if ($Passphrase) { [Console]::Error.WriteLine('The passphrase argument is no longer used: type it when ares asks "input passphrase:".') }
$Passphrase = $null
if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { Show-Usage 'ares asks for the passphrase: run this in a terminal' }

if ($Probe) { $appId = 'com.friendflix.tv.probe'; $title = 'FriendFlix Test' } else { $appId = 'com.friendflix.tv'; $title = 'FriendFlix' }

$isWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows # 5.1 has no $IsWindows and only runs on Windows
if (-not $AresDir) {
  $cacheRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } else { Join-Path $HOME '.cache' }
  $cache = Join-Path $cacheRoot 'friendflix-webos'
  $want = (& node -p 'require(process.argv[1]).devDependencies[process.argv[2]]' (Join-Path $PSScriptRoot 'package.json') '@webos-tools/cli' | Select-Object -First 1)
  $marker = Join-Path $cache ".ff-installed-$want"
  $npmCmd = if ($isWin) { 'npm.cmd' } else { 'npm' }
  if (-not (Test-Path -LiteralPath $marker)) {
    Write-Host "Installing the webOS CLI $want into $cache"
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    Get-ChildItem -LiteralPath $cache -Filter '.ff-installed-*' -Force | Remove-Item -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package.json'), (Join-Path $PSScriptRoot 'package-lock.json') -Destination $cache -Force
    Push-Location -LiteralPath $cache
    try {
      $ErrorActionPreference = 'Continue'
      & $npmCmd ci --ignore-scripts --no-audit --no-fund
      $npmRc = $LASTEXITCODE
      $ErrorActionPreference = 'Stop'
    } finally { Pop-Location }
    if ($npmRc -ne 0) { Fail 'installing the webOS CLI failed' }
    New-Item -ItemType File -Path $marker -Force | Out-Null # only after a complete install
  }
  $AresDir = Join-Path $cache 'node_modules\.bin'
}
function Find-Ares([string] $name) {
  foreach ($f in $(if ($isWin) { @("$name.cmd", $name) } else { @($name) })) {
    $p = Join-Path $AresDir $f
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  }
  Fail "the webOS CLI tool '$name' was not found in $AresDir"
}

if ($PSVersionTable.PSVersion.Major -lt 6) {
  # Windows PowerShell 5.1 may default to TLS 1.0; GitHub needs 1.2
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('friendflix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($Ipk) {
    $ipkPath = (Resolve-Path -LiteralPath $Ipk).ProviderPath
  } else {
    if (-not $tag) {
      # /releases/latest redirects to /releases/tag/<tag>
      try {
        $req = [System.Net.WebRequest]::Create("$BaseUrl/latest")
        $req.Method = 'HEAD'
        $resp = $req.GetResponse()
        $final = $resp.ResponseUri.AbsoluteUri
        $resp.Close()
      } catch { Fail "could not reach $BaseUrl/latest ($($_.Exception.Message))" }
      if ($final -notmatch '/tag/(v\d+\.\d+\.\d+)$') { Fail "could not find the latest release ($final)" }
      $tag = $Matches[1]
    }
    $v = $tag.Substring(1)
    $file = if ($Probe) { "FriendFlix-probe-$v.ipk" } else { "FriendFlix-$v.ipk" }
    Write-Host "FriendFlix ${tag}: $file"
    foreach ($f in @($file, 'SHA256SUMS-webos.txt')) {
      try { Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/download/$tag/$f" -OutFile (Join-Path $tmp $f) }
      catch { Fail "could not download $BaseUrl/download/$tag/$f ($($_.Exception.Message))" }
    }
    $expected = $null
    foreach ($line in Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS-webos.txt')) {
      $parts = $line.Trim() -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $file) { $expected = $parts[0].ToLowerInvariant(); break }
    }
    if (-not $expected) { Fail "SHA256SUMS-webos.txt has no SHA-256 for $file" }
    $ipkPath = Join-Path $tmp $file
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $ipkPath).Hash.ToLowerInvariant()
    if ($got -ne $expected) { Fail "SHA-256 mismatch for ${file}: expected $expected, got $got. Not installing." }
    Write-Host 'SHA-256 ok'
  }

  $setupDevice = Find-Ares 'ares-setup-device'
  $novacom = Find-Ares 'ares-novacom'
  $aresInstall = Find-Ares 'ares-install'
  $aresLaunch = Find-Ares 'ares-launch'

  # native tools write to stderr; in 5.1 that must not turn into terminating errors
  $ErrorActionPreference = 'Continue'
  Write-Host "Registering the TV at $TvIp"
  & $setupDevice --remove friendflix-tv *> $null # an unknown device is fine
  & $setupDevice --add friendflix-tv -i "host=$TvIp" -i 'port=9922' -i 'username=prisoner'
  if ($LASTEXITCODE -ne 0) { Fail-Install 'could not register the TV' }
  Write-Host "Type the passphrase the Developer Mode app shows now, then press Enter:"
  & $novacom --device friendflix-tv --getkey
  if ($LASTEXITCODE -ne 0) { Fail-Install "could not fetch the TV's key (wrong passphrase, or the key server is off)" }
  & $aresInstall --device friendflix-tv $ipkPath
  if ($LASTEXITCODE -ne 0) { Fail-Install 'the install failed' }
  & $aresLaunch --device friendflix-tv $appId
  if ($LASTEXITCODE -ne 0) { Fail-Install 'the app was installed but did not start' }
  Write-Host "Installed $title. Developer Mode expires after 50 hours: press Extend in the Developer Mode app."
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
