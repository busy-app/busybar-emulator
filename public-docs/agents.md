# JS apps on BUSY Bar Emulator

Instructions for AI coding agents making a JavaScript app for BUSY Bar when the person has no BUSY Bar. With a
BUSY Bar, follow [JS apps on BUSY Bar](https://github.com/busy-app/busybar-firmware/blob/dev/applications_js/AGENTS.md)
instead.

BUSY Bar Emulator is a desktop app for macOS (Apple Silicon and Intel) and Windows (x64). It runs the BUSY Bar
firmware at `127.0.0.1:8640` and has its own Node, npm and busy-tools. You drive it with its command line,
`busy-emulator`. How to write the app is in the project's own `AGENTS.md` after step 4; how the emulator differs
from a BUSY Bar is in [Emulator Docs](https://go.busy.app/busy-emulator-docs).

## Tell the user first

Before you download or run anything, tell the user the following and wait for a yes:

- **What is downloaded, from where.** If the emulator is not installed: its install script (a few KB), the
  emulator (about 210 MB on macOS, 250 MB on Windows) and `SHA256SUMS`, from the releases of
  `github.com/busy-app/busybar-emulator`. Then `create` downloads the app template and its dependencies from the
  npm registry (about 110 MB).
- **Where it goes.** For this user only, about 525 MB on macOS and 580 MB on Windows:
  - the app: `~/Applications`, or `%LOCALAPPDATA%\Programs\BUSY Bar Emulator`;
  - its data: `~/Library/Application Support/BUSY Bar Emulator`, or `%LOCALAPPDATA%\BUSY Bar Emulator`;
  - its command line: `~/.busy-emulator/bin`, or `%LOCALAPPDATA%\busy-emulator\bin`.

  No administrator rights, no `sudo`, no system setting changed. The first releases are not notarized or signed,
  and a file downloaded by a command skips the system's first-open warning. The checksum proves the download is
  complete; only HTTPS to github.com vouches for its origin.
- **What you will ask to be allowed.** To run the install script, to read the pointer file (step 1), and to run
  `busy-emulator` outside your sandbox. That lets you start the emulator and build and run the project's code on
  this computer. To be asked only once, the user can allow that one command by its full path in your tool's
  permission rules.

If the emulator is installed and the user has already allowed `busy-emulator`, there is nothing to wait for: say in
a line what `create` downloads and go on.

## 1. Is it installed?

Read the pointer file; `busy-emulator` is usually not on `PATH`:

- macOS: `~/Library/Application Support/BUSY Bar Emulator/install.json`
- Windows: `%LOCALAPPDATA%\BUSY Bar Emulator\install.json`

Its field `cli` is the full path of the command line, `<cli>` below: `~/.busy-emulator/bin/busy-emulator` on macOS,
`%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe` on Windows. On Windows call it in PowerShell as
`& "$env:LOCALAPPDATA\busy-emulator\bin\busy-emulator.exe"`, in Git Bash as
`"$LOCALAPPDATA/busy-emulator/bin/busy-emulator.exe"`, in cmd as `"%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe"`.

If the file is there and the path in `cli` exists, go to step 3. Otherwise go to step 2: the install script also
finds an app that was moved.

## 2. Install it

Run the install script for the system, as one command. It checks the download against `SHA256SUMS` before anything
is unpacked or run, installs for the current user, starts the emulator and prints `cli=<path>` last.

macOS (the script picks the build for the Mac's processor):

```sh
curl -fsSL -o "$TMPDIR/busy-emulator-install.sh" https://github.com/busy-app/busybar-emulator/releases/latest/download/install-macos.sh && zsh "$TMPDIR/busy-emulator-install.sh"
```

Windows, in PowerShell:

```powershell
curl.exe -fsSL -o "$env:TEMP\busy-emulator-install.ps1" https://github.com/busy-app/busybar-emulator/releases/latest/download/install-windows.ps1; if ($LASTEXITCODE -eq 0) { powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\busy-emulator-install.ps1" }
```

The emulator is now running: go to step 4.

## 3. Start it

```text
<cli> start
```

`start` opens the emulator's window and returns once its BUSY Bar answers; the emulator keeps running after you
finish. Start it this way, never with `open` or `Start-Process`. For every `busy-emulator` command:

- run it by its full path, on its own, not joined with other commands;
- add `--json` for one line of JSON: `"ok":true`, or `"ok":false` with `code`, `message` and `hint`: do what the
  hint says;
- `<cli> help` lists the commands, `<cli> help <command>` explains one.

## 4. Create the app and run it

```text
<cli> create my-app --name "<App Name>" --description "<one line>"
```

`create` makes the project from the official template that `npm create @busy-app/app` uses, with its dependencies
installed. It makes the folder itself: name a new one, not `.`. It takes the author from git, else from the user's
account, and makes the app's id from the author and the folder: do not ask for an author.

**The new project's `AGENTS.md` starts with a section of the emulator's own. Read it and follow it.** It lists the
commands for every step, the settings format and the network and memory limits, and it replaces `npm run ...` in the
rest of that file and in the project's README. The loop, run from the project's folder, or with the folder as an
argument (`<cli> dev my-app --once`):

```text
<cli> dev --once
<cli> screenshot --scale 8
<cli> logs --since-run
<cli> press start
<cli> time advance 25m
<cli> settings set <field>=<value> --restart
<cli> typecheck
```

`dev --once` builds, installs and starts the app: exit code 0 means it runs. `screenshot` writes into `screenshots/`
of the current folder (`--out` names another place); open `front-<n>@8x.png` and check that BUSY Bar shows what the
user asked for. The emulator runs apps at a BUSY Bar's speed: what is slow here is slow on a BUSY Bar too. Keep the
project where `create` made it. When you are done, `<cli> stop` stops the app; leave the emulator running for the
user.

Trusting a folder, signing in to GitHub, the license, how AI was used, the push, the pull request and the catalog's
checklist are the user's: ask, and never choose, confirm or tick for them. `refused` or `trust_refused` means they
chose Cancel: do not ask again. Sending the app to the catalog: `<cli> help publish`.

## If a command is refused

- `blocked_network`, `blocked_file` or "Operation not permitted": your sandbox is in the way. Every `busy-emulator`
  command talks to `127.0.0.1` and writes to the emulator's data folder, so all of them run outside the sandbox;
  ask the user in the way your tool provides. The install script and `create` also download.
- If your permission rules refuse a command, do not look for a way around them: say which command was refused and
  ask the user to allow it.
- `not_running`: run `<cli> start`.
- `untrusted_project`: the folder was not made by `create`, or was moved. Run `<cli> trust <folder>`; the user
  answers in the emulator's dialog.
- `app_crashed`: read `<cli> logs --since-run`, fix the script, run `<cli> dev --once` again.

## Before finishing

- `<cli> typecheck` and `<cli> build` succeed.
- `<cli> dev --once` exits with 0, and you looked at a screenshot of what BUSY Bar shows.
- Tell the person it ran on BUSY Bar Emulator, not on a BUSY Bar.
