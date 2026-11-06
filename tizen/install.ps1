# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
<#
.SYNOPSIS
  Installs FriendFlix (or the probe) on a Samsung TV in developer mode, from a GitHub release (docs/tizen.md).
.DESCRIPTION
  Downloads the .wgt and SHA256SUMS-tizen.txt (latest release by default), checks the SHA-256, then runs
  `sdb connect <ip>:26101` and `tizen install` on that TV. Needs Tizen Studio's sdb and tizen (on PATH, in
  $env:TIZEN_STUDIO, in %USERPROFILE%\tizen-studio or in C:\tizen-studio). Works in Windows PowerShell 5.1 and pwsh 7.
.EXAMPLE
  .\install.ps1 192.168.1.50
.EXAMPLE
  .\install.ps1 192.168.1.50 -Probe -Version v2.4.0
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $TvIp,
  # install the FriendFlix Probe (the test app) instead of FriendFlix
  [switch] $Probe,
  # a specific release such as v2.4.0 (default: the latest)
  [string] $Version,
  # tests only
  [Parameter(DontShow)] [string] $BaseUrl = 'https://github.com/LetsManu/friendflix/releases'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest in 5.1 is slow with the progress bar
Set-StrictMode -Version 2

function Fail([string] $msg, [int] $code = 1) { [Console]::Error.WriteLine($msg); exit $code }
function Show-Usage([string] $why) {
  if ($why) { [Console]::Error.WriteLine($why) }
  [Console]::Error.WriteLine(@'
Usage: .\install.ps1 <tv-ip> [-Probe] [-Version vX.Y.Z]
  <tv-ip>            the TV's IP address (TV: Settings > General > Network > Network status > IP settings)
  -Probe             install the FriendFlix Probe (the test app) instead of FriendFlix
  -Version vX.Y.Z    a specific release (default: the latest)
'@)
  exit 2
}
function Show-Hints {
  [Console]::Error.WriteLine(@"

Installing on the TV at $TvIp did not work. Check:
  - Developer mode is on and its Host PC IP is this computer's address (TV: Apps, then 1-2-3-4-5 on the remote; set
    Developer mode On, enter the Host PC IP, then restart the TV). Some TVs turn developer mode off after a reboot.
  - The TV and this computer are on the same network, and nothing blocks port 26101.
  - The app is signed with a Samsung certificate that lists this TV's DUID. "install failed ... author certificate" or
    "Check certificate error" means the DUID is missing: add it to the certificate and re-sign (docs/tizen.md).
"@)
}

if (-not $TvIp) { Show-Usage }
$validIp = $TvIp -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'
if ($validIp) { foreach ($part in $TvIp.Split('.')) { if ([int]$part -gt 255) { $validIp = $false } } }
if (-not $validIp) { Show-Usage "not an IPv4 address: $TvIp" }
$tag = $null
if ($Version) {
  if ($Version -notmatch '^v?\d+\.\d+\.\d+$') { Show-Usage "the version looks like v1.2.3, not $Version" }
  $tag = 'v' + $Version.TrimStart('v')
}
$BaseUrl = $BaseUrl.TrimEnd('/')

function Find-Tool([string] $name) {
  $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  $roots = @($env:TIZEN_STUDIO, (Join-Path $HOME 'tizen-studio'), 'C:\tizen-studio') | Where-Object { $_ }
  foreach ($root in $roots) {
    foreach ($f in @("tools\$name.exe", "tools\ide\bin\$name.bat", "tools/$name", "tools/ide/bin/$name")) {
      $p = Join-Path $root $f
      if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
    }
  }
  Fail "Tizen Studio's '$name' was not found (PATH, `$env:TIZEN_STUDIO, ~\tizen-studio, C:\tizen-studio). Install Tizen Studio (docs/tizen.md)."
}
$sdb = Find-Tool 'sdb'
$tizen = Find-Tool 'tizen'

if ($PSVersionTable.PSVersion.Major -lt 6) {
  # Windows PowerShell 5.1 may default to TLS 1.0; GitHub needs 1.2
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

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
$file = if ($Probe) { "FriendFlix-probe-$v.wgt" } else { "FriendFlix-$v.wgt" }
Write-Host "FriendFlix ${tag}: $file"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('friendflix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  foreach ($f in @($file, 'SHA256SUMS-tizen.txt')) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/download/$tag/$f" -OutFile (Join-Path $tmp $f) }
    catch { Fail "could not download $BaseUrl/download/$tag/$f ($($_.Exception.Message))" }
  }
  $expected = $null
  foreach ($line in Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS-tizen.txt')) {
    $parts = $line.Trim() -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $file) { $expected = $parts[0].ToLowerInvariant(); break }
  }
  if (-not $expected) { Fail "SHA256SUMS-tizen.txt has no SHA-256 for $file" }
  $wgt = Join-Path $tmp $file
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $wgt).Hash.ToLowerInvariant()
  if ($got -ne $expected) { Fail "SHA-256 mismatch for ${file}: expected $expected, got $got. Not installing." }
  Write-Host 'SHA-256 ok'

  # native tools write to stderr; in 5.1 that must not turn into terminating errors
  $ErrorActionPreference = 'Continue'
  $serial = "${TvIp}:26101"
  & $sdb connect $serial 2>&1 | ForEach-Object { Write-Host $_ }
  $device = $null
  foreach ($l in (& $sdb devices 2>&1)) {
    $cols = "$l".Trim() -split '\s+'
    if ($cols.Count -ge 2 -and $cols[0] -eq $serial -and $cols[1] -eq 'device') { $device = $cols[-1]; break }
  }
  if (-not $device) {
    [Console]::Error.WriteLine("The TV did not connect (sdb devices does not list $serial as a device).")
    Show-Hints; exit 1
  }
  Write-Host "Installing on $device ($serial)"
  # tizen.bat breaks on paths with spaces (a user name with a space): run from the temp dir with the bare file name
  Push-Location -LiteralPath $tmp
  try {
    $out = (& $tizen install -n $file -t $device 2>&1 | Out-String)
    $rc = $LASTEXITCODE
  } finally { Pop-Location }
  Write-Host $out
  # the Tizen CLI can exit 0 after a failed install; its output decides
  if ($rc -ne 0 -or $out -match '(?i)install failed|error') { Show-Hints; exit 1 }
  Write-Host "Installed. Open it from the TV's Apps."
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
