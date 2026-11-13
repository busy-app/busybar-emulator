# app

The desktop shell of BUSY Bar Emulator (ADR-0016): the main process of an Electron app. It starts the emulator server
as a separate process on the bundled Node, keeps it running, shows its window and makes sure the app runs once. It
contains no product logic and no firmware code, and it imports nothing from the other packages. The one file of this
package that runs outside the app's process, the supervisor, runs the server in its own process: it loads the server's
module by the path the shell gives it (`startServer`, EMU-004).

License: GPL-2.0-or-later, copyright Flipper FZCO, like the rest of the emulator (ADR-0003, decided on 11 Nov 2026).
Every build carries the license summary of the whole app, `THIRD_PARTY_NOTICES.md` (below).

## Run

```
npm install
node node_modules/electron/install.js     # fetches the Electron binary
npm start                                 # the shell, with the server on the Node that runs npm
```

Release, test variant or development run: the marker `build.json` in the app's folder (inside `app.asar`) says, and
its copy in the resources folder says the same to the command line; the packaging writes both
(`tools/stage-resources.mjs`). Without a marker an app loaded from an archive is a release and a run from this source
folder is a development run. `app.isPackaged`, which looks only at the executable's name, is not used.

A development run and the test variant read these from the environment; a release reads none of them:

| Variable | What |
|---|---|
| `BUSY_EMULATOR_PORT` | the port of the emulated BUSY Bar, 8640 by default |
| `BUSY_EMULATOR_DATA` | the data folder, instead of the user's own |
| `BUSY_EMULATOR_NODE` | the Node the server runs on (any Node 22 or later); a release uses the one inside the app |
| `BUSY_EMULATOR_SERVER_ENTRY` | the server's module (the file that exports `startServer`), instead of `../server/server.mjs` |
| `BUSY_EMULATOR_APP_LOCATION` | the place the macOS location check looks at, instead of the app's real one |
| `BUSY_EMULATOR_HIDDEN` | `1`: windows are made but never shown, and the app stays out of the Dock and the taskbar |
| `BUSY_EMULATOR_USER_HOME` | the folder that stands for the home (macOS) or `%LOCALAPPDATA%` (Windows) for the launcher of the command line; without it a packaged test variant writes neither the launcher nor the pointer file, and a run from the source folder never does |
| `BUSY_EMULATOR_TEST_HOOK` | where the test entry connects; test variant only |
| `BUSY_EMULATOR_GH` | the GitHub CLI publishing runs: a program, or a `.mjs` the given Node runs (the tests' stand-in, `test/fixtures/fake-gh.mjs`, which speaks to a stand-in for GitHub on 127.0.0.1); `none` for a build without it. A release always runs the gh inside it; a run from the source folder has none unless named |
| `BUSY_EMULATOR_GH_CONFIG_DIR` | GitHub CLI's configuration folder instead of the person's own (`~/.config/gh`, `%APPDATA%\GitHub CLI`): the tests never touch the person's GitHub CLI |
| `BUSY_EMULATOR_UPDATE_URL` | a stand-in for GitHub's answer about the latest release, an `http://127.0.0.1:<port>/…` address only: with it a development run or the test variant makes the update check there; without it they make none |

A release reads one variable, which can only make it do less: `BUSY_EMULATOR_NO_UPDATE_CHECK=1` switches the check
for a new version off (below).

The data folder is the server's `--data` (EMU-005): it holds the server's `format`, `run/server.lock` and
`bar/<firmware>/ext` (the emulated BUSY Bar's storage, one BUSY Bar for each firmware), and the shell's `logs/shell.log` (the
shell's events and everything the server prints; past 1 MB, while the app runs as well as at its start, it is put
aside as `shell.log.1` and begun anew, and what pages are refused is written at most 20 times a minute of each kind),
`shell/` (Chromium's own files), `app-settings.json` (the app's own settings: the update check), `install.json` (the pointer file,
ADR-0002 section 7) and `run/emulator.json` (the mirror of the emulator's state for the command line). A data folder
from before EMU-005 kept the BUSY Bar in `bar/ext`; `node emulator/test/convert-data-folder.mjs <data folder>` moves it.

## Windows, the menu and the notice of a new version

- **The device window**: the server's page `/emulator`, the app's main window. Of the shell it has the actions on
  app projects (below) and nothing else.
- **Projects in the window** (EMU-260, EMU-261, EMU-262). The device window's page can create an app project, open
  one, refresh it (build, install, start again), run the single steps and the development loop, ask the catalog's
  checks and write the submission folder, show a folder in Finder or Explorer and copy a text. The page asks through
  the bridge (`window.busyShell.action`, given by `src/window-preload.cjs`; the page wraps it as
  `window.emulatorActions`, whose contract is `packages/server/legacy-window/README.md`); the main process does the
  work by running the command line `busy-emulator` on the Node inside the app (`src/actions.mjs`,
  `src/cli-process.mjs`), so the window, a terminal and an agent run the same code. The rules:
  only the top frame of the main window's page at the server's address may ask (not the local web's window, not a
  frame, not a page in a browser); a folder is chosen in the system's dialog, shown by the main process
  (`src/folder-dialogs.mjs`), and the page names none; the folder an action takes is only looked up in the
  emulator's list of projects, and must be trusted; trust comes from the trust dialog alone (no action passes
  `--trust` or writes the trusted list); one job for a project at a time; the development loop ends when the window
  closes, every job when the app quits; a folder is shown only when it is a project of the list, inside one, or
  inside the data folder; every action but reading (the list, the examples, the greeting's facts, where publishing stands,
  its checks, the plan of the repository's files) needs the person's click or key in the window within two seconds,
  up to four per click or key, however long one of them runs (`src/gestures.mjs`), and is refused with `no_gesture`
  otherwise, so work that follows a long step is done by the main process inside one action (Build and package is
  `publish.package` with `build`); `copy` takes at most 64 KiB. The menu's **File → New App…** and **Open App
  Folder…** call the same actions, with no gesture needed. The trust dialog says "You opened this folder" for a
  folder the person chose in Open App Folder. Two actions are the first run's greeting (EMU-207), not a project's:
  `welcome.get` (whether to show it, the way chosen last time, the system, the command line's path from
  `install.json`) and `welcome.seen`, which writes `welcomed` and the way chosen (`welcomeWay`: `code` or `agent`)
  into `app-settings.json` in the data folder. Show in Finder/Explorer (`reveal`) opens a folder with its files in
  view and selects a file in its folder (`showPath`).
  The app in the emulator is its project folder: the main process lets a project whose folder was deleted go, with
  its app on the BUSY Bar when this project installed it and the BUSY Bar still holds it (`busy-emulator projects --prune`: when the window lists, when the server is ready, and when a
  look at the folders every five seconds or on the window's focus finds one gone); a folder whose disk is not there
  stays, marked unavailable. A hidden run shows no dialog, shows no folder and leaves the clipboard alone.
- **App settings: the BUSY Bar's local web in a window of its own** (EMU-209). The menu's **BUSY Bar → App Settings** and the
  device window's **App settings** link open the firmware's local web from the server's address, on its Apps tab,
  where an app's settings are. The window has a storage of its own (the session partition `persist:local-web`), no
  bridge and no preload of its own, and the device window's rules: it stays on the local web's addresses, makes no
  new windows, and reaches the server's address and nothing else. Asked for again, the open window comes to the
  front. The tab is set by a page of the server, `/emulator/local-web.html?tab=apps`, which writes it where the local
  web keeps it and goes on to `/`; the same link works in a browser.
- **The local web's icons** come from inside the app. The firmware's local web takes its Lucide icons from
  Iconify's API while it runs (`api.iconify.design`); the window has no network, so `src/icons/lucide.json` holds
  those icons (20 of them, found by name in the engine's builds) and the handler of `https:` in the local web's
  session answers the page's requests for them, on Iconify's three hosts, in the API's format (`src/icons.mjs`). It
  answers nothing else and passes nothing on; the session's proxy is as closed as the device window's. To make the
  file anew when a firmware build names other icons (a unit test says so): unpack the npm package
  `@iconify-json/lucide`, run `node tools/local-web-icons.mjs <its icons.json>`, and update the version in
  `tools/notices/app-libraries.json`.
- **Links that point outside** are for the user's browser: an `https:` address a page asked a new window for, or
  tried to leave for, is given to the system, three in ten seconds at most (`src/external.mjs`); anything else goes
  nowhere. The server's opener takes this over when it exists (EMU-010). A hidden run and a run under a test open
  nothing and keep what they would have opened.
- **The notice of a new version** (EMU-205; ADR-0014, point 6). At every start (not again within a minute of the last answer) and then once a day while it runs, the main
  process asks `https://api.github.com/repos/busy-app/busybar-emulator/releases/latest` (owner and repository:
  `RELEASES` in `src/update-check.mjs`). The request carries a fixed `User-Agent: busybar-emulator` and an `Accept`
  header, and nothing else. When the release is newer than the app, the device window shows one line with a Download
  link to the release page, which opens in the user's browser; the shell tells the page in the fragment of its
  address (`#update=<version>&page=<address>`), so the page is not loaded again and needs no bridge. Anyone can write
  a fragment, so the page takes only the version from it, and only one written as a version (a pre-release too:
  `0.1.0-beta.2`); the link is the page's own, made from the version, and the address named there is not used. Nothing is
  downloaded or installed. It is the only request the app itself makes. Off: `BUSY_EMULATOR_NO_UPDATE_CHECK=1`; the
  menu's **Check for New Versions at Start** (the app's own menu on macOS, **Options** on Windows), kept in
  `app-settings.json` in the data folder with the time of the last check and what it found; always in the test
  variant and in a run from the source folder. A check that fails writes a line to the log and shows nothing.

## Publishing to GitHub (stage 2)

The device window's Publish dialog goes on after stage 1's Ready: **Publish to GitHub** signs the person in to GitHub
(a code they enter on github.com/login/device), makes their public repository and puts the project's files in it in one
commit, read back; **Send to catalog** opens the pull request to the apps catalog (from their fork, or from a branch
in the catalog when they may push to it). GitHub CLI (`gh`, bundled with the app) signs the person in, keeps the token
and makes every request; the main process starts it (`src/github/publish-flow.mjs`) and never holds a token, and the
page gets the login and the results. A development run and the test variant may name a stand-in for gh.

- `src/github/gh.mjs` — GitHub CLI, which does the sign-in, keeps the token and makes every call: the app never holds
  a GitHub token. gh's accounts are the person's own GitHub CLI's: gh names its items in the system's store
  `gh:github.com` whatever its configuration folder (gh 2.103.3), so a folder of the app's own could not keep them
  apart, and gh runs with the person's configuration folder. Its state, data and cache folders are the app's
  (`<data>/github/gh-*`); `GH_HOST=github.com`, no prompt, no update notice, no telemetry, and no `GH_TOKEN`,
  `GITHUB_TOKEN` or other `GH_`/`GITHUB_` variable of the environment. The app never reads a token and never runs
  `gh auth status` (it asks GitHub about every account); which account GitHub CLI has it reads with
  `gh config get --host github.com user`. Never `--insecure-storage`: if the store refuses and gh falls back to plain
  text, the app signs that account out of GitHub CLI again and says so. Every request is
  `gh api <path> --method <M> --include` with JSON on gh's standard input, read back with its status and headers.
- Signing in (`publish-flow.mjs`): when GitHub CLI is signed in, the window asks "Use <login>?" (nothing is asked of
  GitHub before the click; then `gh api user` must answer for that account) or **Sign in with another account**:
  `gh auth login --hostname github.com --git-protocol https --web`, which adds the account to GitHub CLI and makes it
  the one GitHub CLI uses (its own accounts stay), as the window says. With no account, the same sign-in, said to sign
  in GitHub CLI too. `github/signed-in.json` (login, `origin` `existing` or `app`, the account GitHub CLI had before)
  says what signing out may do: an `existing` account is only forgotten, never signed out of GitHub CLI; an `app` one
  is signed out of it (`gh auth logout --user <login>`) only when the person ticks it, or GitHub CLI is switched back
  (`gh auth switch`). gh's default scopes (`repo`, `read:org`, `gist`) are wider than publishing needs, and the window
  says so. When GitHub answers for another account than the one noted, the app asks again rather than publish.
- Where the person's GitHub CLI settings are: gh's defaults only (`~/.config/gh`, `%APPDATA%\GitHub CLI`). A release
  does not honour `GH_CONFIG_DIR` or `XDG_CONFIG_HOME` (security review F8): it reads nothing from its environment
  (ADR-0016), and a configuration chosen through the environment would decide where gh sends requests with the token
  (`http_unix_socket` in its `config.yml`); an app opened from the Dock or Start would not see those variables anyway.
  `troubleshooting.md` says what to do.
- `src/github/publish-flow.mjs` — sign-in, the repository (a name that is taken gets a free one offered; the project
  remembers its repository in `.busy/publish.json` and publishing again updates it), the pull request with the
  catalog's own template (`.github/PULL_REQUEST_TEMPLATE.md`, read from the catalog), the authorship box ticked only
  when the person ticked it in the window, and the one AI-usage line they chose. `.github/workflows/` is left out of
  the files pushed.
- Into the person's own repository, an update, an import (catalog-update): a repository name the account has
  already, that the app did not publish to, is offered as **Publish into <name>** after a confirmation that names it
  and what changes: a new commit on its default branch with the project's files, nothing deleted unless the person
  ticks it (`.github/workflows/` never), never by force. A repository with commits the project does not have (its
  head is not the commit the app published or imported, nor in the project's own git) is never published into; the
  window says to import it again. **Send to catalog** reads `applications/<id>/manifest.yml` from the catalog: an app
  it has is an update, titled "Update <name> to <version>", sent only with a higher version than the one at the
  commit that manifest names, and with a What's new of its own (written into catalog.json and the manifest).
  Create app's **Import from GitHub** downloads a repository's default branch through gh (no git needed) into a new
  folder and opens it as Open existing does; the record notes the commit it came from.
- `src/github/local-git.mjs` — a project's own git, read from `.git` without git: its HEAD, and whether it holds a
  commit (a loose object or a pack's index).
- `src/github/publish-record.mjs` — what the app itself published, in its data folder (`github/published.json`): the
  repository of each project, and the flagged files the person chose to publish with a click. Only this record lets a
  push replace an existing repository's files (and only when the commit it noted is in that repository), lets a flagged
  file go up, and names the repository in the catalog's manifest; the project's `.busy/publish.json` decides none of it.
- `src/github/github-api.mjs` — the REST calls, through gh: the person, a new public repository (`auto_init`), one
  commit of the project's files through the Git Data API (blobs, tree, commit, the branch moved; only changed files
  are uploaded; read back afterwards, a push that did not land is an error), the fork of the catalog, a branch in it, a
  pull request with `maintainer_can_modify` and the open one found again. A second between two writes, at most 500
  writes an hour and 400 files a push; GitHub's primary and secondary limits are waited out when the wait is short and
  told when not.
- `tools/bundled-gh.mjs`, `bundled-gh.json` — the pinned gh (2.103.3): the archives of its release for macOS (arm64,
  amd64) and Windows (amd64), checked against the SHA-256 sums of the release's checksums file and refused on a
  mismatch, staged unchanged into `<resources>/gh/` (`bin/gh` or `bin/gh.exe`, `LICENSE`). On macOS it keeps GitHub's
  Developer ID signature (the bundle's ad hoc signature does not replace it); the release check runs `gh --version`
  and checks the signature.

The tests run a stand-in for gh (`test/fixtures/fake-gh.mjs`: the commands above, nothing more) against a stand-in for
GitHub on 127.0.0.1 (`test/fixtures/github-stub.mjs`); a release always runs the gh inside it.

## The bundled Node and the command line

The Node inside the app is pinned in `bundled-node.json`: one version, the SHA-256 of its official archives for
`darwin-arm64`, `darwin-x64` and `win32-x64` from the release's `SHASUMS256.txt` on nodejs.org. The build takes it
from there and checks the sum before it unpacks anything; nothing is downloaded while the app runs.

```
node tools/bundled-node.mjs pin 24.22.2                  # a new version: records the sums of its archives
node tools/bundled-node.mjs fetch                        # the archives into the cache, checked
node tools/stage-resources.mjs darwin-arm64 <resources> --kind release   # Node, the command line, the marker
```

The cache lies outside the repository: `~/Library/Caches/busy-emulator-build/node` on macOS,
`%LOCALAPPDATA%\busy-emulator-build\node` on Windows; `--cache` moves it. Inside the app:

| Path in the resources folder | What |
|---|---|
| `node/` | Node: `bin/node` and `lib/node_modules/npm` (Windows: `node.exe`, `node_modules\npm`), `LICENSE`. No headers, documentation, corepack, no links `bin/npm`/`bin/npx` (a link fails `codesign --verify`) and no `npm.cmd`. npm runs as `<node> <npm>/bin/npm-cli.js` |
| `bin/busy-emulator` | macOS: the command line's entry, a sh script that finds everything from its own place and needs no `PATH` (`launcher/macos/busy-emulator`) |
| `bin/busy-emulator.exe` | Windows: the same, a real executable (`launcher/windows/busy-emulator.cs`, built by `tools/windows-launcher.mjs` with the C# compiler of .NET Framework 4 that Windows has; on Windows only). It passes its command line on to Node as it got it, so `& % ^ "` and spaces arrive unchanged. The one message it prints itself (the app is no longer where it was) goes to a console as Unicode and to a pipe or a file as UTF-8, as Node's output does, so a path with letters outside the console's code page is printed as it is |
| `emulator/packages/server/cli/` | the command line (`../server/cli`) |
| `build.json` | the marker, readable by plain Node |
| `THIRD_PARTY_NOTICES.md` | the license summary (below); laid out by the packaging, not by `stage-resources.mjs` |

At every start, after the macOS location check, the app writes the launcher at the fixed path of ADR-0002 section 7a
(macOS `~/.busy-emulator/bin/busy-emulator`: a sh script with this copy's paths; Windows
`%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe`: a copy of the executable with `busy-emulator.launch` beside
it), then `install.json`
(`{ "app", "cli", "version" }`, `cli` being the launcher). Both name the copy that started last.

## Release files

Each system builds its own files of a release (ADR-0002, section 3): a Mac the disk image and the zip for Apple
Silicon and for Intel, Windows the setup. There is no CI yet; the builds run on a Mac and on a Windows machine.

```
npm ci && node node_modules/electron/install.js   # once, on each system: Electron's binary for that system
npm run dist                                      # build this system's files into <out>/release (a Mac: both architectures)
npm run dist -- --arch x64                        # one architecture only: arm64, x64 or all
npm run dist:check -- <out>/release --partial     # check them, before the other system's files are there
npm run dist:sums -- <out>/release                # SHA256SUMS, once every file is in the folder
npm run dist:check -- <out>/release               # names, sums and every file
```

`<out>` is `~/Library/Caches/busy-emulator-build/dist` on macOS and `%LOCALAPPDATA%\busy-emulator-build\dist` on
Windows; `--out` moves it, but never into the repository (the build refuses). It holds `release/` (the files of a
release and nothing else), `reports/` (what each build and each check found, with sizes), `work/` (the app as built)
and `test-variant/`. A release is built from a commit only: the build refuses a working tree with changes, and the
marker (`build.json`) records the commit, the sources that match the app. `npm run dist -- --kind test` builds the
test variant (below) instead of the release; `--allow-uncommitted` is for it alone. A file git ignores is never
packed, wherever it lies.

**The two builds for macOS.** A Mac builds both, whichever processor it has itself: `darwin-arm64` for Apple Silicon
and `darwin-x64` for Intel. They differ in two parts only, Electron and the bundled Node, each of the target's
architecture; the app's archive, the server, the engine (WebAssembly) and the command line's entry (a sh script) are
the same, and the app has no native module. Electron for this Mac's own architecture is the installed package's; for
the other one the build downloads the archive of the same Electron release from Electron's releases on GitHub into
the cache (`<cache>/electron/`), checks it against the SHA-256 the installed `electron` package records for it
(`node_modules/electron/checksums.json`; the package is pinned by `package-lock.json`) and unpacks it anew for every
build (`packaging/electron.mjs`). The build refuses an Electron or a Node of another architecture than the target's.
Nothing of the built app is run by the build, and the ad-hoc signature is made by this Mac's `codesign` for either.
A release builds both by default; the test variant, which the tests start, is built for this Mac's own architecture
unless `--arch` says otherwise. On Apple Silicon the Intel build runs under Rosetta, if it is installed: that is how
it is checked here (below), since no Intel Mac builds or tests it. Under Rosetta the first start of a new build waits
for the translation (30–50 s on an M3 Pro, longer while the machine is busy, 4–6 s after that; the Apple Silicon build starts there in 1–2.5 s).

| File | What |
|---|---|
| `busybar-emulator-mac-arm64.zip` | `BUSY Bar Emulator.app` for Apple Silicon, zipped by `ditto` without resource forks and extended attributes: for agents (`ditto -x -k`) |
| `busybar-emulator-mac-arm64.dmg` | the same app and a link to `/Applications`, an LZFSE image (`hdiutil`): for people |
| `busybar-emulator-mac-x64.zip`, `busybar-emulator-mac-x64.dmg` | the same two for a Mac with an Intel processor |
| `busybar-emulator-win-x64-setup.exe` | the setup: installs for the current user, without administrator rights |
| `SHA256SUMS` | `<sha256>  <name>` per file, as `shasum -a 256 -c` reads it |

The names carry no version (`tools/packaging/names.mjs`), so the address of the latest release does not change.

**What the build does.** It copies Electron from the installed `electron` package (its `install.js` checked the
download against the package's checksums; for the other architecture of macOS, see above), removes Electron's default app, renames the executable and, on macOS, the
helpers, and lays out the resources: the bundled Node, the command line's entry and the marker (`stage-resources.mjs`),
the server with `capture/png.mjs` and the part of the engine it runs on (`packaging/composition.mjs`: committed files
only, without tests, the engine's build sources and the copies of the catalog's code). The app's own files go into `app.asar`
(`@electron/asar`), from the list of `tools/release-files.mjs` with a trimmed `package.json` and the marker;
`src/supervisor.mjs` lies beside it, unpacked, because the bundled Node runs it. The hash of the archive's header is
recorded where Electron checks it: `ElectronAsarIntegrity` in Info.plist, a resource of type `INTEGRITY` in the
Windows executable (`resedit`). Then the fuses (`packaging/fuses.mjs`, ADR-0016: `RunAsNode`,
`EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`, `GrantFileProtocolExtraPrivileges`,
`EnableCookieEncryption` and `LoadBrowserProcessSpecificV8Snapshot` off; `EnableEmbeddedAsarIntegrityValidation`,
`OnlyLoadAppFromAsar` and `WasmTrapHandlers` on), set with `@electron/fuses` and read back by our own reader. On macOS
Info.plist loses the descriptions of access (camera, microphone, Bluetooth, audio capture) and the exception for plain
HTTP, and the app is signed ad hoc. On Windows the executable's version information names the app and loses
Electron's company, copyright and Squirrel mark; Electron's signature no longer matches and is dropped.

**The license summary.** Every build has `THIRD_PARTY_NOTICES.md` in its resources folder (macOS
`Contents/Resources`, Windows `resources\`): the emulator's license (GPL-2.0-or-later, Flipper FZCO) and where its
source is — the release tag `v<version>` of the public repository, which is exported without history, so the
internal commit the build was made from is named beside it, not as a commit of the public repository; for each firmware build in the app its commit, the libraries compiled into `runtime.wasm` and
`screen.wasm` with their versions, the commits they come from and their licenses (JerryScript, LVGL with LodePNG and
the QR code generator, mongoose under GPLv2, cJSON, stb_ds, M*LIB, utz, Furi, datetime, ...); the local web, which is
the firmware's `assets/frontend-build/public` unchanged under GPL-2.0-or-later, with its source `assets/frontend` at
that commit and its fonts; the licenses of the firmware's assets as the firmware's `REUSE.toml` gives them (the
`busy_*` fonts follow their own files, OFL-1.1: the paths `REUSE.toml` gives them match no file — `REUSE_FIXES` in
`refresh.mjs`, which stops once the firmware is corrected), with the
attribution "© Flipper FZCO, CC BY-SA 4.0"; Electron, Chromium and Node.js with the places of their own license files;
Emscripten; and the full texts of the licenses. `tools/notices/notices.mjs` makes it, for one system and one commit:

```
node tools/notices/notices.mjs darwin|win32 [<commit>]     # prints it
node tools/notices/refresh.mjs --firmware-repo <firmware checkout> --emsdk <emsdk> [--check]
```

A release is built without the firmware, so what the summary says about it is recorded in
`tools/notices/libraries.json` and `tools/notices/texts/` by `refresh.mjs`, which reads the firmware checkout at the
commits `packages/engine/firmware.json` pins (`git show`, nothing is changed there) and the Emscripten SDK the modules
are built with. Nothing in `libraries.json` is typed by hand: the hand-written part is the catalogue in `refresh.mjs`
— which third-party library a path of the firmware is, under which license its license file is, where its version is
written. Every path the engine's build (`packages/engine/build.mjs`) takes from the firmware is read from the build
script (`tools/notices/build-paths.mjs`) and must belong to a library of the catalogue or be the firmware's own code
by its `REUSE.toml`; otherwise `refresh.mjs` stops. The build makes the summary first and stops when
`libraries.json` is older than what it ships: a firmware added to `firmware.json`, modules built from other library
commits, a path added to `build.mjs`, a changed `apps-assets.json`. Then run `refresh.mjs` and commit what it
writes.

**The integrity check protects a signed build only.** Without a signature, whoever can change `app.asar` can change
the hash recorded beside it (Info.plist, the executable's resources) as well: `test/app/built.test.mjs` does exactly
that and the app starts. The first releases are unsigned (ADR-0002, section 4).

**The setup** (`installer/windows/setup.cs`) is a small C# program compiled with the C# compiler of .NET Framework 4
that is part of Windows, as the command line's entry is; the app folder follows it as a zip, and a trailer with the
zip's SHA-256. It needs nothing that Windows does not have, starts nothing after it is done, and changes only its own
folder, the user's Start menu and the user's entry for the app in Settings → Apps (below). Its own folder is one it made: it writes `busybar-emulator-install.json` into every
folder it installs, and replaces a folder only when it is not there, is empty, is a link (the link goes, never what it
points to) or holds that file. A folder with anything else in it is refused with exit code 2 and not touched. Of the
folders an interrupted run leaves beside the app's (`<name>.new-<number>`, `<name>.old-<number>`) it removes only
those with its file inside:

```
busybar-emulator-win-x64-setup.exe [/S] [/NoShortcut] [/LOG=<file>] [/D=<folder>]
```

| | |
|---|---|
| `/S` | silent: no question, no window; the result is the exit code and the log |
| `/NoShortcut` | no Start menu shortcut and no entry in Settings → Apps (a copy that is not the user's own) |
| `/LOG=<file>` | the log, added to the file, never overwriting it; by default `%TEMP%\busybar-emulator-setup.log` |
| `/D=<folder>` | the app's folder, last on the line (the rest of the line is the folder, quotes optional; a switch after it is refused with exit code 2, so /S is never lost); by default `%LOCALAPPDATA%\Programs\BUSY Bar Emulator` |
| exit code | 0 installed, 1 failed (a damaged setup, no right to change the folder), 2 wrong arguments or a folder that is not the setup's, 3 the app is running from the folder, 4 the user said no |

It unpacks into a folder beside the app's and swaps the two, so the app's folder is whole or untouched; with the app
running there it changes nothing and ends with 3. Its manifest asks to run as invoked: Windows takes a 32-bit program
named "setup" without one for an installer that needs administrator rights (ours is 64-bit; the manifest is the
second line, and the check reads it). It is aware of paths past 260 characters. The silent setup is a window program,
so PowerShell does not wait for it on its own: `Start-Process -Wait -FilePath <setup> -ArgumentList '/S'`, or
`start /wait` in cmd.

**The uninstaller** (`installer/windows/uninstall.cs`, EMU-218) is the same program: the setup without the app at its
end. The setup writes exactly that — its own bytes up to the zip — into every folder it installs, as `uninstall.exe`,
and (unless `/NoShortcut`) registers the app for the current user under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\app.busy.emulator`, after the app is in place:
`DisplayName`, `DisplayVersion`, `Publisher` (Flipper FZCO), `InstallLocation`, `DisplayIcon`, `UninstallString`
(`"<folder>\uninstall.exe"`), `QuietUninstallString` (the same with `/S`), `NoModify`, `NoRepair`, `EstimatedSize`
(the app's files, in KB) and `InstallDate`. That is what Settings → Apps lists and runs. The setup itself uninstalls
with `/Uninstall`.

```
uninstall.exe [/S] [/KeepData | /RemoveData] [/LOG=<file>] [/D=<folder>]
busybar-emulator-win-x64-setup.exe /Uninstall [/S] [/KeepData | /RemoveData] [/LOG=<file>] [/D=<folder>]
```

| | |
|---|---|
| `/S` | silent: no question, no window; the result is the exit code and the log |
| `/KeepData`, `/RemoveData` | the data folder `%LOCALAPPDATA%\BUSY Bar Emulator` stays, or goes too. Silent mode keeps it unless told to remove it; without `/S` the uninstaller asks, and No is the default |
| `/LOG=<file>` | the log, added to the file; by default `%TEMP%\busybar-emulator-setup.log`, which a removal that succeeded deletes with the rest (a log the caller named stays) |
| `/D=<folder>` | the app's folder, last on the line; by default the folder `uninstall.exe` lies in (for the setup with `/Uninstall`: the folder the entry names, else the default one) |
| exit code | 0 removed, 1 failed (the log names what is left), 2 wrong arguments or a folder that is not an install of the setup's, 3 the emulator or a command of it runs from the folder and did not end (nothing was removed), 4 the user said no |

What it does, in this order, and what it never does:

1. It removes only a folder with the setup's `busybar-emulator-install.json` in it; anything else is exit code 2.
2. It looks at the processes of this user whose program lies in the folder, by the program's full path, never by its
   name. One that is not the app nor started by it is a command — `busy-emulator build`, the dev loop, the command
   line an agent is running: the uninstaller refuses with exit code 3, before anything is touched.
3. If the app runs, it is asked to quit through its own command line, `resources\bin\busy-emulator.exe quit`, and
   the uninstaller waits until nothing runs from the folder. It ends no process (but its own `quit` command, should
   that not return in 45 s); an app that does not quit is exit code 3.
4. A running program cannot delete its own file, so the uninstaller moves its file out of the folder (into `%TEMP%`,
   or beside the folder when `%TEMP%` is on another disk), then renames the folder to `<name>.old-<pid>`: with a
   file of it still open the rename fails, the uninstaller moves back and nothing has changed (exit code 3).
   Then the folder is removed, links in it as links.
5. Outside the folder it removes what names this copy: the Start menu shortcut whose target is this folder's
   executable, the entry whose `InstallLocation` is this folder, the command line's folder
   `%LOCALAPPDATA%\busy-emulator` when the first line of its `busy-emulator.launch` is this copy's Node, and
   `install.json` in the data folder when it names this copy. So removing a second copy leaves the user's own
   install as it was. With `/RemoveData` the data folder goes, if it looks like one (`format`, `install.json` or
   `logs\shell.log` in it); a link in its place goes as a link.
6. Last, `cmd.exe` deletes the moved uninstaller two seconds after it ends (started in the file's folder, by full
   paths, with the file named without its path). `Start-Process -Wait` waits for that too.

**The check** (`npm run dist:check`, `packaging/check.mjs`) opens no window: the app itself is never started, since a
release takes the user's own folders and shows its window (that is EMU-017's smoke test). For every file: the name,
the sum, the fuses, the list and the bytes of `app.asar` against the source, the marker, the integrity record, every
file under `resources/emulator` against the list, the folders `node/` and `bin/`, on macOS Info.plist,
`codesign --verify --deep --strict` and the architecture of every program in the bundle (the app, Electron's
framework and helpers, Node) against the one the file's name says, on Windows the executable's resources, Electron's license files beside it and the
setup's manifest, and `THIRD_PARTY_NOTICES.md` against what `notices.mjs` makes for that system and the commit the
marker names. On the files of
the system it runs on (on a Mac with Apple Silicon also the Intel files, under Rosetta; without Rosetta they are read
but not run, and the check ends with 3), also what has no window: the bundled Node (`--version`), the command line inside the app
(`version --json` must say `kind: "release"`), and the server on the bundled Node, from the read-only disk image and
from a read-only copy of the zip's app on macOS and from a silent install into a temporary folder on Windows, until it
answers `GET /api/status` on 127.0.0.1:8981.

A release goes to a public repository's releases, so the check also runs the export check itself — its forbidden
files and all its content rules, without its exceptions (an exception lets a file stay in the private repository; it
does not make it publishable) — over what each file of the release holds: `resources/emulator`, the files of
`app.asar` and the license summary. Exit code 0: sound and publishable; 1: a problem; 3: sound, but holding what the
export check refuses, or not everything checked (another system's files, which this system cannot read; no export
check or no private patterns here, as outside the monorepo). A release gets 0 (EMU-255, checked on
macOS): the firmware's local web is public since the owner's decision of 11 Nov (ADR-0003), and the
export check allows the Cyrillic in its bundles by exact value and file (`tools/export-check/layer.json`). A
release is built from the exported tree — the public repository's — and checked there with the export check of the
internal repository, which the exported tree does not hold:
`npm run dist:check -- <out>/release --export-check <tools/export-check of the internal repository>`. Without it the
check of a sound release ends with 3 there, never with 0.

**The commit a build records** (the marker `build.json`, the license summary) is a commit of the internal repository.
There it is `HEAD`; in the exported tree it is the commit the export was made from, as `.busybar-export.json` at the
top of the tree names it, not the tree's own commit, which the internal repository never had. So the files built
from the exported tree are the bytes a build of that internal commit gives (`sourceCommit()` in
`tools/packaging/composition.mjs`). A build of a changed copy of the public repository still records that commit:
whoever changes the tree says so in their own release.

**Two builds of one commit** (compared 11.11). `app.asar` is the same bytes on both systems (fixed order, one mode
for every file). The macOS zip is the same bytes: every file in it carries the commit's time, and the ad-hoc
signature has no time in it. What differs: the disk image (`hdiutil` makes its identifiers and times new), and on
Windows the two programs the C# compiler makes, the setup's own and `resources\bin\busy-emulator.exe` (it writes a
time stamp and an identifier into each; the old compiler of .NET Framework has no deterministic mode). Every other file
of the Windows app is the same bytes.

## What is where

| File | What |
|---|---|
| `src/main.mjs` | The main process: wiring only |
| `src/config.mjs` | Paths, port and the rules for what a release may be told from outside |
| `src/build-kind.mjs` | Release, test variant or development: the marker |
| `src/install-files.mjs` | The launcher at the fixed path, the pointer file, the mirror of the state |
| `src/server-keeper.mjs` | The server's life: start, wait until ready, restart (the third death within a minute is the last), stop |
| `src/server-process.mjs`, `src/supervisor.mjs` | One run of the server. The supervisor runs on the bundled Node with the server in its own process: the options and the news (ready, with the port; how it ended) go over the Node channel, the shell holds its standard input, and it stops the server through `stop()` when the shell asks or is gone; on macOS and Linux it leads a process group, which goes with it |
| `src/windows.mjs` | The windows: the main one — the device window (the server's page) or the shell's message page — and the local web's |
| `src/icons.mjs`, `src/icons/lucide.json`, `tools/local-web-icons.mjs` | The local web's Lucide icons, answered inside the app; the tool that makes the file |
| `src/external.mjs` | What goes to the user's browser: `https:` only, a few at a time |
| `src/github/` | Publish stage 2: GitHub CLI (sign-in, token, every call), the REST calls through it, the app's record (above) |
| `src/update-check.mjs` | The notice of a new version: the one request, when it is made, the app's settings file |
| `src/menu.mjs` | The menu: File (New App, Open App Folder), App Settings, the switch of the update check, and what macOS needs |
| `src/app-scheme.mjs` | `app://shell/...`: the shell's own pages, from a fixed folder |
| `src/security.mjs`, `src/permissions.mjs` | The rules for every page and every session: sandbox, no Node, no new windows, no leaving, permissions by list, a network closed but for the server's address (the session's proxy, by scheme, and a rule on requests) and no names resolved, no dialogs, no holding the window open, no downloads, no spelling, no service workers; the release takes no switches from its command line |
| `src/page-preload.cjs` | Runs before every page's top frame and takes WebRTC's constructor out of it; gives the page nothing |
| `src/bridge.mjs`, `src/preload.cjs`, `src/window-preload.cjs` | The bridge: the one list of what a page may ask the shell for, checked against the calling frame; what the message page and the device window's page get of it |
| `src/gestures.mjs` | The person's clicks and keys in each window: an action with consequences needs one just before (`no_gesture`) |
| `src/actions.mjs`, `src/cli-process.mjs`, `src/folder-dialogs.mjs` | The window's actions on app projects: the rules, the runs of the command line, the system's folder dialogs |
| `src/location-check.mjs` | macOS: an app run from a disk image or from Downloads asks to be moved |
| `src/messages.mjs`, `src/pages/shell/` | The texts and the page of the shell's own messages |
| `test-variant/` | The test entry. This folder is what makes a build the test variant; a release does not contain it (`files` in `package.json`) |
| `tools/release-files.mjs` | The list of files that go into a release, for the packaging and for the tests |
| `tools/start.mjs` | `npm start` |
| `tools/bundled-node.mjs`, `bundled-node.json` | The pinned Node: pin, fetch, check, unpack |
| `tools/bundled-gh.mjs`, `bundled-gh.json` | The pinned GitHub CLI: pin, fetch, check, unpack (above) |
| `tools/stage-resources.mjs`, `tools/windows-launcher.mjs`, `launcher/` | The parts of the resources folder above, for the packaging and the tests |
| `tools/dist.mjs`, `tools/packaging/` | The release files: build, SHA256SUMS, check (above) |
| `tools/notices/` | The license summary: `notices.mjs` makes it, `refresh.mjs` records what it says about the firmware (`libraries.json`, `texts/`); what the app carries besides the firmware's parts (the Lucide icons) is in `app-libraries.json` and `app-texts/`, by hand |
| `installer/windows/` | The setup for Windows (`setup.cs`), the uninstaller it also is (`uninstall.cs`) and their manifest |
| `icon/`, `tools/app-icon.mjs`, `tools/app-icon/` | The app's icon, see below |

## The app's icon

The one master is `icon/emulator-icon.svg`, BUSY's "BUSY Emulator Icon" from Figma (the blue square, the cutting
mat's grid and the BUSY logo). Every other icon file is made from it by `node tools/app-icon.mjs` on a Mac and
committed; the builds only read them:

- `icon/emulator.icns`: the macOS app, 16 to 512 points, each also @2x, on Apple's grid (the rounded square with its
  soft shadow). `tools/packaging/macos.mjs` puts it in as `Contents/Resources/app.icns`.
- `icon/emulator.ico`: Windows, 16 to 256 pixels. `tools/packaging/windows.mjs` puts it into the app's executable;
  the setup (which is also the uninstaller) and `resources\bin\busy-emulator.exe` are compiled with it.
- `src/assets/app-icon.png` (the windows' icon outside macOS), `src/pages/shell/icon.png` (the shell's pages),
  `../server/legacy-window/icons/emulator-logo.svg`, `emulator-logo-32.png` and `emulator-logo-64.png` (the device
  window's mark and its pages' icon), `../../public-docs/images/emulator-logo.png` (the documents).

The picture gets simpler as it gets smaller (`tools/app-icon/art.mjs`): everything from 200 pixels, the heavy grid
lines only from 40, and below that the whole logo alone, drawn pixel by pixel for the size, with no grid and no
shadow. `node tools/app-icon.mjs --sheet <png>` also draws every size on white and on black, the small ones
enlarged: look at it after any change. `dist:check` finds the icon in each built file.

## Tests

```
npm run test:unit     # plain Node: rules, the supervisor, the server's life with a stand-in server
npm run test:app      # starts the app (test variant) and drives it through the test entry
```

The tests use ports 8831–8839 on 127.0.0.1 (`BUSY_APP_TEST_PORTS=<first>-<last>` moves them to another nine) and
their own temporary data folders, and check after themselves that no
process and no listener is left. A test file that hangs is cut off after 10 minutes (`--test-timeout` in the scripts)
and is red; what it started is ended and its folders removed (`test/helpers.mjs`; on Windows the folders of a cut-off
file go at the next run). Every launch of the app is also watched for what it listens on: anything but
127.0.0.1 and ::1 fails the test (`test/app/sockets.mjs`). In a copy of this package without the server beside it,
the tests that start the real server are skipped and the rest run on a stand-in server. The tests that lay out a
packaged app (`test/unit/packaged-layout.test.mjs`, `test/app/bundled.test.mjs`) take the Node archive from
`BUSY_EMULATOR_NODE_CACHE` or the build's cache, and download it from nodejs.org once, checked, if it is not there.
They never write the user's own `~/.busy-emulator` or data folder.

**The tests put nothing on the screen.** Every launch runs hidden (`BUSY_EMULATOR_HIDDEN=1`): no window appears, the
app is not in the Dock or the taskbar and never becomes the active app, so the suite can run on a machine somebody is
using. On macOS the hidden launches start a copy of Electron's bundle marked as an app without a Dock icon (the
system shows any other app in the Dock before its code runs); the copy is made once in `node_modules/.cache/`. On
Windows the app tests still need a desktop session (over SSH there is none).

The built app has its own tests, which need a build first (`npm run dist -- --kind test --allow-uncommitted`):

| Variable | What it runs |
|---|---|
| `BUSY_EMULATOR_TEST_BUILT=<test variant app>` | `test/app/built.test.mjs`: the test variant as built (the release's fuses, archive and integrity record) starts from its archive with its own Node and server; `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` (under Electron's own executable name, where Electron would honour it) and `--inspect` change nothing; an archive changed with its recorded hash runs; a changed archive is refused, and an `app/` folder in place of the archive is not run (these two end the app, in a crash for the first; on macOS they run only with `BUSY_EMULATOR_TEST_FAILING_STARTS=1`, since the system may show a window for it). Over SSH on Windows too. `test/app/release.test.mjs`: the test variant zipped or packed under a release's name fails the check |
| `BUSY_EMULATOR_TEST_RELEASE=<out>/release` | `test/app/release.test.mjs`: the release's files pass the check |
| `BUSY_EMULATOR_TEST_START_MENU=1` | Windows: the runs that make a real install for the user and remove it — `test/unit/windows-setup.test.mjs` (the Start menu shortcut) and `test/unit/windows-uninstall.test.mjs` (the entry in Settings → Apps, the shortcut, and stand-ins for the command line's folder and the data folder under `%LOCALAPPDATA%`, kept and removed). They refuse to run when any of these is there already |

The rest of `test/unit/windows-setup.test.mjs` and `test/unit/windows-uninstall.test.mjs` runs the setup and the
uninstaller of a small stand-in app on Windows with the rights of a standard user
(`test/fixtures/windows/standard-user.cs`: the caller's own token cut down as UAC cuts down an administrator's), into
temporary folders, as copies that are not the user's own (`/NoShortcut`): such a copy's uninstaller finds nothing of
the user's that names it and leaves the user's shortcut, entry, command line and data alone. The stand-in's programs
are real executables (`test/fixtures/windows/uninstall-stand-in.cs`), so "the app runs", "a command runs" and "the
app quit through its command line" are real processes.

What reaches outside the app is off by default and switched on by name:

| Variable | What it adds |
|---|---|
| `BUSY_EMULATOR_TEST_VISIBLE=1` | The whole suite with real windows on the screen, and the test that a second launch brings a minimized window back |
| `BUSY_EMULATOR_TEST_CLIPBOARD=1` (with `VISIBLE`) | The window really writes to the system clipboard; needs a focused window and replaces what the clipboard holds |
| `BUSY_EMULATOR_TEST_WEBRTC_OPEN=1` | The tests that make a real WebRTC connection: no UDP packet leaves with the shell's rule, packets leave without it. A page that creates a connection makes Chromium bind UDP sockets on every network interface, rule or no rule, and the system's firewall may ask about it |

## Limits

- The server runs in the supervisor's process, so no way of killing the shell, the supervisor or both leaves it
  running. A process the server itself starts and does not end, which ignores its parent's end, would outlive a
  SIGKILL of that process on macOS and Linux: nothing is left there to end it. The server starts none; it runs only
  `ps` and `xattr` with a time limit.
- A link meant for the user's browser goes nowhere yet: new windows and navigation away are refused. The server's
  opener (EMU-010) will take such addresses.
- A page that creates a WebRTC connection made the app bind UDP sockets on every network interface (port 5353 and
  two more while the connection gathers addresses), although no packet went out. Port 5353 is now off for the app
  (Chromium's `WebRtcHideLocalIpsWithMdns`), and the top frame of every page has no `RTCPeerConnection`. A frame
  the page makes still has one in its first, empty document, where Electron runs no preload; whether such a
  connection, gathering behind the closed proxy, still binds the other two sockets has not been run (it could make
  the system ask the person at the machine).
- Some of Chromium's switches are read before the shell's first line and so are not removed: `--enable-logging`
  with `--log-file` (Chromium creates the named file) and `--force-device-scale-factor`, besides Node's `--inspect`,
  which the fuses close. The command line gives the app no arguments.
- The release is not started by any test here (it would show its window and use the user's folders). Its rules
  are tested on the test variant made of the release's files (`test/app/switches.test.mjs`). A release under the
  name `electron` and the release itself given switches are not tested: the smoke test of a built app (`npm run
  smoke` in `emulator/`, EMU-017) runs the test variant through its command line and does not start a release, for
  the same reason (the release's own launch path is EMU-172).
- The questions of the setup and of the uninstaller (without `/S`) are not run by a test: they are windows. Both
  were answered on Windows 10 with the release installed (11 Nov 2026), the second time by a script that pressed
  the buttons: the uninstaller's two questions, the data kept, and its last message, which must be answered before
  the uninstaller ends and deletes its own file; the setup's question (Cancel: exit code 4, nothing installed) and
  its "Open it now?" (Yes started the app). The Start menu shortcut has no AppUserModelID, which Windows
  notifications from the app will need.
- The uninstaller removes the data folder of the current user only, at its default place, and nothing of other
  users of the computer. On macOS there is no uninstaller: `public-docs/install.md` lists what to delete.
