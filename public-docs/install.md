# Installing BUSY Bar Emulator

BUSY Bar Emulator is a desktop app for macOS (Apple Silicon and Intel) and Windows x64. Node, npm and the tools that
build a BUSY Bar app are inside it. It installs for your user only and needs no administrator rights.

## What is downloaded, and from where

Everything comes from the releases of the emulator's public repository on GitHub, `busy-app/busybar-emulator`. The
files have the same names in every release, so the address of the latest one never changes:

| File | Address | What it is | Size |
|---|---|---|---|
| macOS on Apple Silicon, for people | https://github.com/busy-app/busybar-emulator/releases/latest/download/busybar-emulator-mac-arm64.dmg | a disk image with the app and a link to Applications | about 210 MB |
| macOS on Apple Silicon, for agents | https://github.com/busy-app/busybar-emulator/releases/latest/download/busybar-emulator-mac-arm64.zip | the same app, zipped | about 210 MB |
| macOS on Intel, for people | https://github.com/busy-app/busybar-emulator/releases/latest/download/busybar-emulator-mac-x64.dmg | the same for a Mac with an Intel processor | about 215 MB |
| macOS on Intel, for agents | https://github.com/busy-app/busybar-emulator/releases/latest/download/busybar-emulator-mac-x64.zip | the same app, zipped | about 220 MB |
| Windows | https://github.com/busy-app/busybar-emulator/releases/latest/download/busybar-emulator-win-x64-setup.exe | the setup: installs for the current user, without administrator rights | about 250 MB |
| Checksums | https://github.com/busy-app/busybar-emulator/releases/latest/download/SHA256SUMS | the SHA-256 of each file above | under 1 KB |

A Mac with Apple Silicon (M1 and later) takes the `arm64` files, a Mac with an Intel processor the `x64` ones: Apple
menu → About This Mac says "Chip: Apple M…" or "Processor: … Intel …". The two hold the same app, each with the
Electron and the Node of its processor. Both need macOS 13.5 (Ventura) or later.

GitHub answers each address with a redirect to the file of the latest release. The install sequences below check the
downloaded file against `SHA256SUMS` before anything is unpacked or run. That catches a damaged or incomplete
download, or a file of another release. It is not a signature: whoever can replace the release files can replace
`SHA256SUMS` too. What vouches for the files is HTTPS to github.com.

What the app puts on the disk:

| | macOS | Windows |
|---|---|---|
| The app | `~/Applications/BUSY Bar Emulator.app` (or `/Applications`, if you put it there) | `%LOCALAPPDATA%\Programs\BUSY Bar Emulator\`, a Start menu shortcut and an entry in Settings → Apps |
| Its data and the pointer file `install.json` | `~/Library/Application Support/BUSY Bar Emulator/` | `%LOCALAPPDATA%\BUSY Bar Emulator\` |
| The command line `busy-emulator`, rewritten at every start | `~/.busy-emulator/bin/busy-emulator` | `%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe` |
| The preferences file macOS keeps for every app (the system's own settings for the app; the emulator stores nothing of its own there) | `~/Library/Preferences/app.busy.emulator.plist` | none |

The app takes about 525 MB on macOS and 580 MB on Windows; while it installs, the download (on macOS with its
unpacked copy) needs up to 750 MB more in the temporary folder.

The app sends nothing about you anywhere, and its emulated BUSY Bar answers on 127.0.0.1 only:
[what the emulator does on the network and on disk](network-and-disk.md). To take all of it away again, see
[Removing it](#removing-it).

## Opening it for the first time

The first releases are not notarized by Apple and not signed for Windows. Your system warns you once, the first time
you open the app; after that it opens like any other app.

The steps below follow Apple's and Microsoft's documentation for macOS 15 and Windows. They have not been walked
through on a clean machine yet, and the exact words on your screen may differ.

### macOS

1. Download the disk image for your Mac and open it: `busybar-emulator-mac-arm64.dmg` on Apple Silicon,
   `busybar-emulator-mac-x64.dmg` on Intel. The wrong one does no harm: the Apple Silicon app does not open on an
   Intel Mac, and the Intel app runs on Apple Silicon through Rosetta, slower.
2. Drag BUSY Bar Emulator to Applications. Do not open it from the disk image or from Downloads: macOS then runs it
   from a temporary read-only place, and the emulator asks you to move it: "BUSY Bar Emulator cannot work from where
   it is now … Quit, drag BUSY Bar Emulator to the Applications folder and open it from there."
3. Open BUSY Bar Emulator from Applications. macOS refuses: it says it cannot verify that the app is free of malware.
   Choose **Done** (not Move to Trash).
4. Open **System Settings → Privacy & Security**, scroll to Security, where it says BUSY Bar Emulator "was blocked to
   protect your Mac", and choose **Open Anyway**. Confirm with **Open Anyway** in the dialog that follows; macOS may
   ask for your login password.
5. BUSY Bar Emulator opens. From now on it opens without a question.

On macOS 15, Control-click → Open no longer lets an app through as it did on earlier versions; System Settings is
the only way.

### Windows

1. Download `busybar-emulator-win-x64-setup.exe` and run it.
2. Windows SmartScreen says **"Windows protected your PC"** and that it prevented an unrecognized app from starting.
   Choose **More info**, check that the app is `busybar-emulator-win-x64-setup.exe`, and choose **Run anyway**.
3. The setup asks whether to install BUSY Bar Emulator for you; it needs no administrator rights. When it is done, open
   BUSY Bar Emulator from the Start menu.

### Downloaded by a command instead of a browser

macOS and Windows warn only about files marked as coming from the internet, and browsers are what mark them. A file
fetched with `curl` on macOS, or with `Invoke-WebRequest` or `curl.exe` in PowerShell, carries no such mark (seen on
macOS 15 and Windows 10). Gatekeeper on macOS and SmartScreen on Windows do not check it, and the app opens without
a warning. That is how the agent's sequence below works. For this app, which is neither notarized nor signed, it
leaves HTTPS to GitHub as the only check. If you download the zip with a browser and unpack it yourself, the mark
goes with it, and the steps above apply.

## For agents: install and start the emulator

If the user has no BUSY Bar, the emulator stands in for it. Tell the user what you are going to download (the table
above) and that a download by command skips the system's first-open check (above), and ask before you do it. Then
run the sequence for the system you are on. Each one:

1. checks whether the emulator is installed, by the pointer file `install.json` and the app it names. It does not
   look for `busy-emulator` on `PATH`, where it usually is not. An app that was moved or put in the Trash leaves the
   pointer file behind; the sequence then looks for the app itself;
2. if the app is not installed, downloads the release file (on macOS the one for this Mac's processor) and
   `SHA256SUMS` into a new temporary folder, and stops with nothing unpacked or run if the sum does not match;
3. installs: on macOS it unpacks the app into `~/Applications`; on Windows it runs the setup silently, for the
   current user;
4. starts the emulator with `busy-emulator start` (never `open`), which waits until its BUSY Bar answers;
5. reads the path of the command line from `install.json` and prints it last, as `cli=<path>`.

Use that path for every command from then on: `<cli> help` lists them. The path is the same for every command, so
one permission rule in your agent covers them all. On macOS it has no spaces. On Windows it is under
`%LOCALAPPDATA%`, in the user's profile. Write it with forward slashes, `C:/Users/you/AppData/Local/busy-emulator/bin/busy-emulator.exe status`:
with no quotes that runs in PowerShell, Git Bash and cmd alike. The profile's folder name may have a space in it;
then in PowerShell call it as `& '<cli>' status`, in Git Bash and cmd as `"<cli, with / for \>" status`. If a command answers `blocked_network`, your sandbox does not let it
reach 127.0.0.1: ask the user to allow the command outside the sandbox.

What comes next, a project and your app on the emulated BUSY Bar, is in
[Your first app on the emulated BUSY Bar](first-app.md).

The sequences use only what the system has: on macOS `zsh`, `curl`, `shasum`, `ditto`, `plutil` and `sysctl`; on
Windows, PowerShell. They need no Node and no administrator rights.

`BUSY_EMULATOR_RELEASE_URL` replaces the address of the latest release (the folder its files are in). It is for tests
and for a mirror the user names: set it only when the user tells you to, and if you find it already set, ask the user
before you run a sequence. It must be an `https` address (plain `http` only to 127.0.0.1 or localhost). A sequence
says when the files do not come from the official release.

### macOS

Save as `install-macos.sh` and run `zsh install-macos.sh` (the same file is `public-docs/install/install-macos.sh` in
the emulator's repository).

```sh
#!/bin/zsh
# Installs BUSY Bar Emulator for the current user on macOS (Apple Silicon or Intel), starts it and prints the path of
# its command line. Nothing but what macOS has: curl, shasum, ditto, plutil. No Node, no administrator rights.
# What it downloads and from where: public-docs/install.md.
#
#   zsh install-macos.sh
#
# BUSY_EMULATOR_RELEASE_URL replaces the address of the latest release (the folder the release files lie in): only
# for tests and for a mirror the user names. It must be https (http only to 127.0.0.1 or localhost).
set -eu

official=https://github.com/busy-app/busybar-emulator/releases/latest/download
base=${BUSY_EMULATOR_RELEASE_URL:-$official}
base=${base%/}
# The build for this Mac's processor. The hardware, not uname -m: a shell under Rosetta says x86_64 on Apple Silicon.
# An Intel Mac has no such key, and takes the Intel build.
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  zip=busybar-emulator-mac-arm64.zip
else
  zip=busybar-emulator-mac-x64.zip
fi
name='BUSY Bar Emulator.app'
pointer="$HOME/Library/Application Support/BUSY Bar Emulator/install.json"

say() { printf 'install: %s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }
in_pointer() { /usr/bin/plutil -extract "$1" raw -o - "$pointer" 2>/dev/null || true; }

case $base in
  https://?*|http://127.0.0.1:*|http://127.0.0.1/*|http://localhost:*|http://localhost/*) ;;
  *) fail "BUSY_EMULATOR_RELEASE_URL must be an https address: $base" ;;
esac
[ "$base" = "$official" ] || say "not the official release: the files come from $base"

# 1. Is the emulator installed? The pointer file says, if the app it names is still there; the command may well not
# be on PATH. An app moved or put in the Trash leaves the pointer file and the command line behind.
cli=
if [ -f "$pointer" ]; then
  cli=$(in_pointer cli)
  named=$(in_pointer app)
  if [ -n "$cli" ] && [ -f "$cli" ] && [ -x "$cli" ] && [ -n "$named" ] && [ -d "$named" ]; then
    say "installed: $pointer names $cli"
  else
    say "$pointer names no app or command line that exists; looking for the app"
    cli=
  fi
fi

if [ -n "$cli" ]; then
  start=$cli
else
  # 2. The app may be in place without the pointer file (it writes it at its first start).
  app=
  for place in "/Applications/$name" "$HOME/Applications/$name"; do
    if [ -d "$place" ]; then
      app=$place
      break
    fi
  done
  if [ -n "$app" ]; then
    say "found $app"
  else
    tmp=$(/usr/bin/mktemp -d -t busy-emulator-install)
    trap '/bin/rm -rf "$tmp"' EXIT
    say "downloading $base/$zip and $base/SHA256SUMS"
    /usr/bin/curl -fsSL --proto-redir '=https' --retry 2 -o "$tmp/$zip" "$base/$zip" || fail "could not download $base/$zip"
    /usr/bin/curl -fsSL --proto-redir '=https' --retry 2 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download $base/SHA256SUMS"
    # 3. The archive must match its line in SHA256SUMS before anything is unpacked.
    expected=$(/usr/bin/awk -v n="$zip" '$2 == n { print $1 }' "$tmp/SHA256SUMS")
    printf '%s\n' "$expected" | /usr/bin/grep -Eqx '[0-9a-f]{64}' || fail "SHA256SUMS has no single sum for $zip; nothing installed"
    actual=$(/usr/bin/shasum -a 256 "$tmp/$zip" | /usr/bin/awk '{ print $1 }')
    [ "$actual" = "$expected" ] || fail "$zip does not match SHA256SUMS (expected $expected, got $actual); nothing unpacked, nothing installed"
    say "$zip matches SHA256SUMS"
    # 4. Unpack beside the download, then move the app into ~/Applications: no half app is ever left there.
    /usr/bin/ditto -x -k "$tmp/$zip" "$tmp/unpacked"
    [ -d "$tmp/unpacked/$name" ] || fail "$zip holds no $name; nothing installed"
    /bin/mkdir -p "$HOME/Applications"
    [ ! -e "$HOME/Applications/$name" ] || fail "$HOME/Applications/$name appeared meanwhile; nothing replaced"
    /bin/mv "$tmp/unpacked/$name" "$HOME/Applications/$name"
    app="$HOME/Applications/$name"
    say "installed $app"
  fi
  start="$app/Contents/Resources/bin/busy-emulator"
fi

# 5. Start it. At every start the app writes the pointer file and the command line at its fixed place.
say "starting the emulator"
"$start" start
cli=$(in_pointer cli)
[ -n "$cli" ] && [ -f "$cli" ] && [ -x "$cli" ] || fail "the emulator started but $pointer names no command line"
say "the command line is $cli"
printf 'cli=%s\n' "$cli"
```

### Windows

Save as `install-windows.ps1` and run
`powershell -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1` (`-ExecutionPolicy Bypass` lets this one
PowerShell run the saved file, and changes no setting; the same file is `public-docs/install/install-windows.ps1` in
the emulator's repository). The silent setup shows no window and asks nothing; its log,
`%TEMP%\busybar-emulator-setup.log`, is removed when the install succeeded and kept, and named, when it failed. The copy
that the one-line install for agents downloads, `%TEMP%\busy-emulator-install.ps1`, removes itself when it runs; a
copy saved under any other name or folder stays.

```powershell
# Installs BUSY Bar Emulator for the current user on Windows (x64), starts it and prints the path of its command
# line. Nothing but Windows PowerShell 5.1 (or PowerShell 7). No Node, no administrator rights.
# What it downloads and from where: public-docs/install.md.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1
#
# BUSY_EMULATOR_RELEASE_URL replaces the address of the latest release (the folder the release files lie in): only
# for tests and for a mirror the user names. It must be https (http only to 127.0.0.1 or localhost).
#
# It leaves nothing in %TEMP%: the copy the one-line install downloads, %TEMP%\busy-emulator-install.ps1, is removed as
# soon as it runs (PowerShell has read it whole by then), and the setup's log once the install succeeded. A failed
# setup keeps its log and names it.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$temp = [IO.Path]::GetTempPath()
if ($PSCommandPath -and [IO.Path]::GetFileName($PSCommandPath) -eq 'busy-emulator-install.ps1') {
  $from = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PSCommandPath)).TrimEnd('\')
  $temps = @($temp, $env:TEMP) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }
  if ($temps -contains $from) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }
}

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
      $setupLog = Join-Path $temp 'busybar-emulator-setup.log'
      if ($run.ExitCode -ne 0) { Fail "the setup ended with exit code $($run.ExitCode); its log is $setupLog" }
      Remove-Item -LiteralPath $setupLog -Force -ErrorAction SilentlyContinue
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
```

Both end with exit code 0 and the line `cli=<path>` when the emulator runs. Anything else ends with a non-zero exit
code and a line that says what happened. Running a sequence again is safe: an installed emulator is only started, and
one whose app was removed is installed again.

## Updating to a new version

When a newer release is out, the emulator's window shows **Update to <version>** at the top (the emulator checks when
it starts, and once a day while it runs). Click it: the emulator downloads the new version from GitHub and checks
that it is the one the release signed. Then click **Restart to update** and **Restart**: the emulator quits, puts
the new version in place and opens again. An agent can do the same with `busy-emulator update`; you answer in the
emulator's dialog. Updating keeps everything: the apps on the emulated BUSY Bar and their settings, your projects and the
folders you trusted, your answer to the first question, the windows' own settings, your GitHub CLI sign-in, and the
command line at the same path (`~/.busy-emulator/bin/busy-emulator`,
`%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe`), so agents' instructions keep working.

Where the emulator cannot replace itself, the line is a **Download** link instead, and its tooltip says why: on macOS
when it runs from the disk image or from Downloads, or from a folder it may not write to; on Windows when it was not
installed by its setup. Then update by hand, as below. On Windows the setup cannot replace the app while another
program runs from its folder (an agent's `busy-emulator mcp`, for one): Restart then says which program it is and
does not quit; end the agent session (or close that program) and click Restart again. For the same reason an agent
cannot update the emulator on Windows through its MCP tools: end the session and click Update in the window.

If the Mac lost power or crashed in the second or two in which the update swaps the app, the app may be missing from
its folder: the previous version lies beside it, in the hidden folder `.busy-emulator-update-<version>/previous/`
(press Cmd+Shift+. in Finder to see it); drag `BUSY Bar Emulator.app` from there back to its folder and open it.

### macOS

1. Quit BUSY Bar Emulator: **BUSY Bar Emulator → Quit** in the menu bar, or `~/.busy-emulator/bin/busy-emulator quit`.
2. Download the new disk image for your Mac and open it.
3. Drag BUSY Bar Emulator to Applications and choose **Replace**. Not **Keep Both**: two copies of the app share one
   data folder, and the command line runs whichever was opened last.
4. Open it from Applications. A new download is checked again, so macOS refuses it once more: allow it in
   **System Settings → Privacy & Security** as in [Opening it for the first time](#macos).

### Windows

1. Quit BUSY Bar Emulator: close its window, or **BUSY Bar → Exit**, or `busy-emulator quit`. If it is still running, the
   setup says so and changes nothing.
2. Download the new `busybar-emulator-win-x64-setup.exe` and run it; SmartScreen asks again (**More info → Run
   anyway**). It installs over the old version, in the same folder.
3. Open BUSY Bar Emulator from the Start menu.

The install sequence for agents below does not update: it starts the copy that is installed. To update, follow the
steps above.

If the new version changes how its data folder is laid out, it moves the folder over at its first start; the older
version cannot open it after that. If it ever cannot move it, it keeps what the folder held in `set-aside/` inside the
data folder, untouched, and says so in its log.

## Removing it

Your projects stay where they are, whatever you remove. The data folder holds the emulated BUSY Bar's storage (the apps
you installed on it and their settings), the list of project folders you trusted, npm's cache and the logs. Deleting
it is the only step that loses anything.

If you published with the emulator, GitHub CLI on your computer keeps the account it signed in: its settings
(`~/.config/gh`, `%APPDATA%\GitHub CLI`) and its token in the login keychain or Credential Manager. Sign out in the
emulator's Publish to GitHub first, with Also sign out GitHub CLI on this computer ticked (it is offered when the
emulator signed GitHub CLI in), if you want that gone too.

### Windows

Open **Settings → Apps**, find BUSY Bar Emulator and choose **Uninstall**, or run `uninstall.exe` in
`%LOCALAPPDATA%\Programs\BUSY Bar Emulator\`. It needs no administrator rights. The uninstaller asks whether to
remove the app, and then whether to remove its data too. No is the default: it keeps the data for a later install.

It quits the emulator if it is running, then removes the app's folder, the Start menu shortcut, the entry in
Settings → Apps, the command line's folder `%LOCALAPPDATA%\busy-emulator\`, the pointer file `install.json` and the
setup's log `%TEMP%\busybar-emulator-setup.log`. If you said yes, it removes the data folder
`%LOCALAPPDATA%\BUSY Bar Emulator\` as well. While a `busy-emulator` command such as `build` or `dev` is still
running, it removes nothing and says so: wait for the command or stop it, then run the uninstaller again. It ends no
process itself; it only asks the emulator to quit.

For agents, the uninstaller runs silently: no window, no question, and the result is the exit code. Ask the user
before you remove the data.

```powershell
$uninstaller = Join-Path $env:LOCALAPPDATA 'Programs\BUSY Bar Emulator\uninstall.exe'
$log = Join-Path ([IO.Path]::GetTempPath()) 'busybar-emulator-uninstall.log'
# The log's path may have a space in it (the user's folder name): the argument is quoted as a whole.
$run = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/KeepData', ('"/LOG=' + $log + '"')) -Wait -PassThru
Write-Output "uninstall: exit code $($run.ExitCode)"
Get-Content -LiteralPath $log
```

| | |
|---|---|
| `/S` | silent: no question, no window |
| `/KeepData` | the data folder stays (what silent mode does when neither is given) |
| `/RemoveData` | the data folder goes too |
| `/LOG=<file>` | the log, added to the file; without it the log is `%TEMP%\busybar-emulator-setup.log`, which a removal that succeeded deletes |
| exit code `0` | removed |
| exit code `1` | failed; the log says what is left |
| exit code `2` | wrong arguments, or the folder is not an install the setup made |
| exit code `3` | the emulator or one of its commands is running and did not end; nothing was removed |
| exit code `4` | the user said no |

Installing again over an install, or after a removal that kept the data, works as the first time.

### macOS

Quit the emulator (Quit in its menu, or `busy-emulator quit`), then delete:

- the app, `BUSY Bar Emulator.app`, from `~/Applications` or `/Applications`;
- the command line's folder, `~/.busy-emulator/`;
- what macOS keeps about the app's window, `~/Library/Preferences/app.busy.emulator.plist`;
- the data folder, `~/Library/Application Support/BUSY Bar Emulator/`, if you want the data gone too.

For agents, the same as commands; ask the user before the last line:

```sh
"$HOME/.busy-emulator/bin/busy-emulator" quit
rm -rf "$HOME/Applications/BUSY Bar Emulator.app" "$HOME/.busy-emulator"
rm -f "$HOME/Library/Preferences/app.busy.emulator.plist"
rm -rf "$HOME/Library/Application Support/BUSY Bar Emulator"
```

If the app is in `/Applications`, delete it there instead. There is no uninstaller on macOS: these four places are
everything the app puts on the disk, besides GitHub CLI's sign-in (above).
