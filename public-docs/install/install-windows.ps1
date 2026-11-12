# Installs BUSY Bar Emulator for the current user on Windows (x64), starts it and prints the path of its command
# line. Nothing but Windows PowerShell 5.1 (or PowerShell 7). No Node, no administrator rights.
# What it downloads and from where: public-docs/install.md.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1
#
# BUSY_EMULATOR_RELEASE_URL replaces the address of the latest release (the folder the release files lie in): only
# for tests and for a mirror the user names. It must be https (http only to 127.0.0.1 or localhost).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$official = 'https://github.com/busy-app/busybar-emulator/releases/latest/download'
$base = $official
if ($env:BUSY_EMULATOR_RELEASE_URL) { $base = $env:BUSY_EMULATOR_RELEASE_URL }
$base = $base.TrimEnd('/')
$file = 'busybar-emulator-win-x64-setup.exe'
$pointer = Join-Path $env:LOCALAPPDATA 'BUSY Bar Emulator\install.json'
$appFolder = Join-Path $env:LOCALAPPDATA 'Programs\BUSY Bar Emulator'

function Say($text) { Write-Output "install: $text" }
function Fail($text) { [Console]::Error.WriteLine("install: $text"); exit 1 }
function InPointer($field) {
  try { return [string](Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json).$field } catch { return '' }
}

if ($base -notmatch '^(https://[^/]+|http://(127\.0\.0\.1|localhost)(:\d+)?)(/|$)') { Fail "BUSY_EMULATOR_RELEASE_URL must be an https address: $base" }
if ($base -ne $official) { Say "not the official release: the files come from $base" }

# 1. Is the emulator installed? The pointer file says, if the app it names is still there; the command may well not
# be on PATH. An app removed or moved leaves the pointer file and the command line behind.
$cli = ''
if (Test-Path -LiteralPath $pointer -PathType Leaf) {
  $cli = InPointer 'cli'
  $named = InPointer 'app'
  if ($cli -and (Test-Path -LiteralPath $cli -PathType Leaf) -and $named -and (Test-Path -LiteralPath $named -PathType Leaf)) {
    Say "installed: $pointer names $cli"
  } else {
    Say "$pointer names no app or command line that exists; looking for the app"
    $cli = ''
  }
}

if ($cli) {
  $start = $cli
} else {
  # 2. The app may be in place without the pointer file (it writes it at its first start).
  if (Test-Path -LiteralPath (Join-Path $appFolder 'BUSY Bar Emulator.exe') -PathType Leaf) {
    Say "found $appFolder"
  } else {
    if (-not [Environment]::Is64BitOperatingSystem) { Fail 'this Windows is not 64-bit; the emulator is built for Windows x64 only' }
    # Windows PowerShell 5.1 may not offer TLS 1.2 by default, and GitHub takes nothing older.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    # Behind a company's proxy: Windows PowerShell 5.1 uses the system's proxy but not the user's credentials for it
    # (a 407 otherwise), and reads no HTTPS_PROXY; PowerShell 7 reads it itself.
    try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }
    $web = @{}
    if ($env:HTTPS_PROXY -and $PSVersionTable.PSVersion.Major -lt 6) { $web.Proxy = $env:HTTPS_PROXY; $web.ProxyUseDefaultCredentials = $true }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('busy-emulator-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      $setup = Join-Path $tmp $file
      $sums = Join-Path $tmp 'SHA256SUMS'
      Say "downloading $base/$file and $base/SHA256SUMS"
      try { Invoke-WebRequest @web -UseBasicParsing -Uri "$base/$file" -OutFile $setup } catch { Fail "could not download $base/${file}: $($_.Exception.Message)" }
      try { Invoke-WebRequest @web -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums } catch { Fail "could not download $base/SHA256SUMS: $($_.Exception.Message)" }
      # 3. The setup must match its line in SHA256SUMS before it is run.
      $expected = @(Get-Content -LiteralPath $sums | ForEach-Object { if ($_ -match '^([0-9a-f]{64})  (.+)$' -and $Matches[2] -eq $file) { $Matches[1] } })
      if ($expected.Count -ne 1) { Fail "SHA256SUMS has no single sum for $file; nothing installed" }
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLowerInvariant()
      if ($actual -ne $expected[0]) { Fail "$file does not match SHA256SUMS (expected $($expected[0]), got $actual); the setup was not run, nothing installed" }
      Say "$file matches SHA256SUMS"
      # 4. The setup, silent, for this user only. The folder goes last on its command line.
      $run = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$appFolder") -Wait -PassThru
      if ($run.ExitCode -ne 0) { Fail "the setup ended with exit code $($run.ExitCode) (its log: $env:TEMP\busybar-emulator-setup.log)" }
      Say "installed $appFolder"
    } finally {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $start = Join-Path $appFolder 'resources\bin\busy-emulator.exe'
}

# 5. Start it. At every start the app writes the pointer file and the command line at its fixed place.
Say 'starting the emulator'
& $start start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$cli = InPointer 'cli'
if (-not $cli -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) { Fail "the emulator started but $pointer names no command line" }
Say "the command line is $cli"
Write-Output "cli=$cli"
