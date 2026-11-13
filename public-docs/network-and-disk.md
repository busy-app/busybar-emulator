# What the emulator does on the network and on disk

This page is written from the emulator's code in this version. The emulator does nothing that is not listed here. If
you find that it does, that is a bug: [report it](https://github.com/busy-app/busybar-emulator/issues).

## On the network

### What listens

| Address | What answers there | Who may use it |
|---|---|---|
| `127.0.0.1:8640` | The emulated BUSY Bar: its HTTP API, its state stream, its local web and the emulator's window. | Programs on this computer, as with a BUSY Bar: `busy-cli`, `curl`, scripts, agents. Web pages of other sites are refused ([how that differs from a BUSY Bar](differences.md)). |
| `127.0.0.1:<a port the system picks>` | The management address, for the emulator's own command line. | Only programs that send the server's key, which is in the data folder below and readable by your user alone. |

Nothing listens on any other address: not on your network, not on IPv6, not on UDP. Your firewall has nothing to
ask about. The BUSY Bar's port is always 8640. If another program holds it, the emulator says so and does not start
([troubleshooting](troubleshooting.md#port-8640-is-in-use)).

### What goes out

- **Your app's own requests.** When the app on the emulated BUSY Bar calls `fetch`, the emulator's server makes the
  request the way the BUSY Bar's firmware makes it: HTTP/1.0, the firmware's own headers, no redirects followed. It goes
  to the address the app names. An address on this computer is refused, because it would reach your own services and
  not the BUSY Bar ([details](differences.md#what-an-app-on-the-busy-bar-may-reach)).
- **Requests with the BUSY Bar's own key.** A BUSY Bar signs some requests to BUSY's apps API (`apps-api.busy.app`) with a
  key of its own; the emulator has no such key. For the one request it knows, the weather forecast
  (`GET /weather/v1/forecast`), it answers itself from a saved answer, and nothing is sent. Any other request with
  the key goes out without it, as an ordinary request.
- **The windows go nowhere.** They show only the pages of the emulator's own server, on `127.0.0.1:8640`: the BUSY Bar,
  and the BUSY Bar's local web ("App settings"). Every other request of a page, a name lookup included, is refused. Spell
  checking, which downloads dictionaries on Windows, is off. The local web's icons, which a BUSY Bar's page fetches from
  `api.iconify.design`, come from a file inside the app. A link to another site does not open in the app: an
  `https:` link is handed to your browser, anything else is dropped.
- **The project commands use the npm registry.** `create` downloads the app template's generator
  (`@busy-app/create-app`) and the project's dependencies (about 60 MB in the project); `build`, `dev` and
  `typecheck` download the dependencies only when the project has none. They use the registry and proxy of your npm
  settings (`~/.npmrc`, `npm_config_registry`, `HTTPS_PROXY`), `https://registry.npmjs.org` by default, and npm
  sends the registry what it always sends. The emulator gives npm a 60 s timeout and two retries, and stops it
  after 45 s with no answer; then it tries npm's cache in its data folder. `install`, `run`, `stop`, `record` and the
  other commands talk only to `127.0.0.1`; `check`, `submit`, `catalog-texts` and publishing's first stage talk to
  nothing, but `publish prepare` builds the project and so may need the registry as `build` does.
- **Publishing to GitHub, when you ask for it.** Publish to GitHub and Send to catalog (and `publish signin`, `push`
  and `pr`) run GitHub CLI (`gh`, made by GitHub, inside the app), which talks to `github.com` and `api.github.com`
  only: the sign-in, your public repository, the files of the commit, the catalog's fork, branch and pull request.
  GitHub CLI runs with its update check and its telemetry off. Nothing goes to GitHub until you sign in there or
  choose Use <login>; a push and a pull request each wait for your click (from the command line, for your yes in the
  app's own dialog).
- **One check for a new version.** Each time the app starts (not again within a minute of the last answer), and then once a day while it runs, it asks GitHub which release of
  the emulator is the latest: `GET https://api.github.com/repos/busy-app/busybar-emulator/releases/latest`. The
  request carries a fixed `User-Agent: busybar-emulator`, without the app's version, and an `Accept` header: no
  identifier, nothing about your computer. GitHub sees your network address, as it does when you open any of its
  pages. If there is a newer release, the window shows **Update to <version>** (or, where this copy cannot replace
  itself, a Download link to the release page); nothing is downloaded or installed until you click. A check that
  fails shows nothing. To
  switch the check off, untick **Check for New Versions at Start** in the menu (the app's own menu on macOS,
  **Options** on Windows), or start the app with `BUSY_EMULATOR_NO_UPDATE_CHECK=1` in its environment.
- **The update, when you click Update.** The app downloads two small files of that release,
  `update.json` and `update.json.sig`, then this system's file of it (`busybar-emulator-mac-arm64.zip`,
  `busybar-emulator-mac-x64.zip` or `busybar-emulator-win-x64-setup.exe`, 150 to 250 MB), from
  `https://github.com/busy-app/busybar-emulator/releases/download/v<version>/`, following GitHub's redirects only to
  its own hosts (`objects.githubusercontent.com`, `release-assets.githubusercontent.com`), over HTTPS only. The
  requests carry the same fixed `User-Agent` and nothing else. The file is kept in the data folder's
  `tmp/update-<version>/` and is installed only if the manifest's signature is the release's key (built into the
  app) and the file's size and SHA-256 are the manifest's. On macOS the new app is unpacked beside the installed one,
  in a hidden `.busy-emulator-update-<version>` folder, and the old app is kept there until the new one has started
  once. **Restart to update** asks you once more; the app quits, puts the new version in place and opens it. Your
  data folder is not touched by the update itself; the new version moves it to its new layout if it has one.
  `busy-emulator update` does the same after your yes in the app's dialog; `busy-emulator update --check` only asks
  GitHub for the latest version, as the check at start does.
- **No telemetry, no crash reports.** The emulator sends nothing about you or about its use anywhere. With the check
  for a new version off, the app itself makes no request to the network.

Installing the emulator downloads its files from GitHub: [install.md](install.md#what-is-downloaded-and-from-where).

## On disk

| What | macOS | Windows |
|---|---|---|
| The app | `/Applications/BUSY Bar Emulator.app` or `~/Applications/BUSY Bar Emulator.app` | `%LOCALAPPDATA%\Programs\BUSY Bar Emulator\` (with `uninstall.exe` in it), a shortcut in your Start menu and the entry Settings → Apps shows, in the registry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\app.busy.emulator` |
| The data folder | `~/Library/Application Support/BUSY Bar Emulator/` | `%LOCALAPPDATA%\BUSY Bar Emulator\` |
| The command line, rewritten at every start of the app, in a folder for your user alone | `~/.busy-emulator/bin/busy-emulator` | `%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe` and `busy-emulator.launch` beside it |
| The preferences file macOS keeps for every app (the system's own settings for the app; the emulator stores nothing of its own there) | `~/Library/Preferences/app.busy.emulator.plist` | none |

In the data folder:

| | What |
|---|---|
| `bar/<firmware>/ext/` | The emulated BUSY Bar's storage, one for each firmware (`bar/1.3.1/ext/`): the apps you installed, their settings and their data. It stays from one start to the next. The BUSY Bar's own settings (volume, name, time zone) do not: every start is a BUSY Bar fresh out of the box, with your apps on it. |
| `install.json` | Where the app and its command line are. Agents read it to find the command line. |
| `key` | The server's key for the management address: new at every start, readable by your user alone, removed when the emulator quits (from its menu or with `busy-emulator quit`). If the emulator is ended some other way, the file stays until the next start writes a new one; nothing answers to the old key. |
| `set-aside/` | Only after an update that could not carry the folder over to its new layout (it says so in `logs/shell.log`): what the folder held then, untouched. The emulator never reads it again; delete it when you no longer need it. |
| `format`, `run/` | The folder's layout version (a newer emulator moves an older folder to its own layout when it first starts); which process uses the folder and where its BUSY Bar answers (`run/server.lock` and `run/emulator.json`, both removed when the emulator quits), and two small notes `start` and `quit` leave each other so that a `quit` during a `start` leaves nothing running. `run/build-lines.jsonl` holds what the window's buttons ran (build, install, start, the checks) for the Console and `logs --kind build`; it is emptied at every start. |
| `logs/shell.log` | The app's log, with everything the server prints: at most about 2 MB (`shell.log.1` holds the previous megabyte). |
| `shell/` | The windows' own browser files. |
| `app-settings.json` | The app's own settings: whether it checks for a new version, when it last asked and what it was told, and whether you answered the window's first question (by hand or with an agent). |
| `captures/`, `mcp/screenshots/` | A clip while `record` makes it (the command then moves it where you asked; one left behind goes after 24 hours); the screenshots the MCP server's `screenshot` takes outside a project, kept for 7 days. |
| `tools/`, `npm-cache/` | The template's generator and npm's cache, for the project commands. |
| `projects/trusted.json`, `projects/registry.json` | The project folders `create` made and the ones you trusted in the emulator's dialog (`trust`); the projects the emulator knows, with the state of their dependencies' install. |
| `github/` | GitHub CLI's own state, data and cache (`gh-state/`, `gh-data/`, `gh-cache/`); `signed-in.json`, the account publishing uses and the one GitHub CLI used before; `published.json`, the repositories and pull requests the app made for each project. No token: GitHub CLI keeps it in the system's password store (the login keychain on macOS, Credential Manager on Windows), and its settings stay where GitHub CLI keeps them on your computer, `~/.config/gh` or `%APPDATA%\GitHub CLI`. |

In your project and the folder you work in:

- Create app in the window makes the project's folder in `~/BUSY Bar projects` (`%USERPROFILE%\BUSY Bar projects`
  on Windows) unless you choose another Location.
- `create` makes the project folder from the template and runs `git init` in it if you have git. It takes your GitHub
  login as the author when you are signed in to GitHub (in the emulator or GitHub CLI) and give no `--author`, else
  your git `user.name`, else the name of your account on this computer, writes it into `package.json` and the app's
  manifest, and says so. A name many computers share ("User", "admin") is never taken: `create` then asks for
  `--author`.
- `build` adds `node_modules/` (when it is not there) and `dist/<app id>.tgz`. On Windows it also fixes one line of
  `node_modules/@busy-app/cli/dist/lib/fontMapsPlugin.js`, a bug in busy-cli 0.6.0 that breaks every build there.
- The window's Screenshot writes `screenshots/front-<n>.png` and `back-<n>.png`, with their `@8x` copies, into the
  running app's project; for an app without a project, where you choose in the Save dialog.
- `screenshot` writes `screenshots/front-<n>.png` (or `back-<n>.png`) in the current folder, or where `--out` says.
  Without `--out` it replaces nothing.
- `record` writes `media/clip-<n>.mp4` (or `.gif`) in the current folder, or where `--out` says. Without `--out` it
  replaces nothing.
- `icon` writes the app's two icons into `src/appmeta/`, and replaces icons that are there only with `--force`.
- `check` and `submit` write `catalog.json`, the empty form for the catalog's texts, if the project has none;
  `submit` also writes the folder `submission/`. `catalog-texts set` writes the texts into `catalog.json`.
- Publishing (the window's Publish, or `publish`) writes, each when you ask for it: `catalog.json` and the app's name
  in its manifest; `LICENSE`; `README.md` (a README of your own only with `--readme replace`, or from the README
  step); lines added to `.gitignore`; screenshots, taken or uploaded, with their enlarged copies in `screenshots/`,
  and the ones you take out in `.busy/removed/`; `submission/`. It notes the steps done in `.busy/publish.json`;
  `.busy/` has a `.gitignore` of its own that keeps it out of git.
- Delete in the Apps list, or `uninstall --delete-files`, moves the project's folder to the Trash (the Recycle Bin
  on Windows), from where you can put it back. Nothing is deleted for good.

The emulator writes nowhere else, asks for no administrator rights, does not change `PATH` and adds nothing that
starts with your computer. What macOS and Windows keep about any app on their own (crash reports, lists of recent
programs) is not listed here and has not been checked.

## Removing it

- Windows: **Settings → Apps → BUSY Bar Emulator → Uninstall**, or `uninstall.exe` in the app's folder. It quits the
  emulator and removes the app's folder, the shortcut, the entry in Settings, `%LOCALAPPDATA%\busy-emulator\` and
  the setup's log `%TEMP%\busybar-emulator-setup.log`; it asks before it removes the data folder
  `%LOCALAPPDATA%\BUSY Bar Emulator\`, and keeps it unless you say yes.
- macOS: quit the emulator, then delete `BUSY Bar Emulator.app`, the folder `~/.busy-emulator/`, the file
  `~/Library/Preferences/app.busy.emulator.plist` and, for the data, `~/Library/Application Support/BUSY Bar Emulator/`.

The steps, the silent uninstall for agents and its exit codes are in [install.md](install.md#removing-it). Deleting
the data folder deletes the apps on the emulated BUSY Bar too. Your projects stay where they are.
