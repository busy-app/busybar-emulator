# Troubleshooting

Every `busy-emulator` command says what went wrong and what to do; with `--json` the answer has a `code` and a
`hint`. This page covers what the commands cannot tell you, and the codes you are most likely to meet. The command
line is `~/.busy-emulator/bin/busy-emulator` on macOS and `%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe` on
Windows; this page calls it `busy-emulator`.

## On any system

### The system will not open the app the first time

The app is not notarized by Apple and not signed for Windows yet. Allow it once, as
[install.md](install.md#opening-it-for-the-first-time) shows; after that it opens like any other app.

### "Move BUSY Bar Emulator to Applications" (macOS)

The app was opened from the disk image or from Downloads, where macOS runs it from a temporary read-only place.
Quit, drag BUSY Bar Emulator to the Applications folder and open it from there.

### `busy-emulator: command not found`

The command line is not on your `PATH`. Call it by its full path, as above. The app writes the file when it starts,
so open the app once before you use it.

### Port 8640 is in use

The emulated BUSY Bar listens on `127.0.0.1:8640`, and another program already does, most likely another copy of the
emulator or a server you started yourself. Find it, stop it, then choose Try again in the emulator's window:

```sh
lsof -nP -iTCP:8640 -sTCP:LISTEN
```

```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 8640 -State Listen).OwningProcess
```

### Port 8640 is not available

The window says the port is reserved. The system does not let the emulator listen on `127.0.0.1:8640`: on Windows the
system keeps ranges of ports back for Hyper-V, WSL and Docker, and a security program can block a port too. List the
reserved ranges in a Command Prompt:

```text
netsh int ipv4 show excludedportrange protocol=tcp
```

If 8640 is inside a range, stop Docker Desktop and WSL (`wsl --shutdown`), or restart the computer (the ranges move),
then choose Try again in the emulator's window.

### `not_running`

The emulator is not running, or its BUSY Bar has not finished starting. Only `start` starts it, so that a command you
repeat never brings its window to the front. Run `busy-emulator start`; it returns once the BUSY Bar answers.

### `blocked_network` or `blocked_file`

The command runs inside an AI agent's sandbox, which closes `127.0.0.1` (`blocked_network`) or the emulator's data
folder (`blocked_file`) to it. Let your agent run `busy-emulator` outside its sandbox. That lets the agent start the
emulator and build and run your project's code on your computer. In Claude Code, for example, approve the command
when Claude asks to run it outside the sandbox, or add `"sandbox": {"network": {"allowLocalBinding": true}}` to
`.claude/settings.local.json` in the project.

### `untrusted_project`

Building a project runs code from its folder: its dependencies, its npm settings, its build configuration. The
emulator builds the projects its own `create` made. It builds any other folder (one made with `npm create`, a clone,
a copy) only after you trust it, once. Trust only a project whose code you are willing to run.

`busy-emulator trust my-app` makes the emulator ask you in a dialog on its window. The dialog names the folder; its
buttons are "Don't Trust" and "Trust". You or your AI agent run the command; you click. Nothing else trusts a
folder: no option of the command line does (`--trust` answers `trust_needs_person`), and an agent cannot answer for
you. The emulator must be running, with its window (`busy-emulator start`). The command waits 120 s for your click
(`--wait <seconds>` for longer, up to 600).

| Code | What happened |
|---|---|
| `trust_refused` | You chose "Don't Trust". An agent should not ask again unless you say so. |
| `trust_refused_recently` | You chose "Don't Trust" less than 30 s ago, and the emulator does not ask about that folder again yet. |
| `trust_no_answer` | Nobody clicked in time. Run the command again. |
| `trust_refused_path` | The folder's path holds something a person cannot see or read as it is (an invisible character, a line break, several spaces in a row), so the emulator does not show it in the question. The message names the character. Rename the folder. |

Your own project is refused too after you move or rename its folder: the emulator trusts a folder at its place. The
message says "it was moved or renamed since" and names the old place (`"reason": "moved"` and `trusted_as` in the
JSON). Move the folder back, or trust it again the same way.

### `settings_invalid`, or the BUSY Bar shows "Settings file is invalid."

The app's `src/appmeta/settings.json` is not what the BUSY Bar's firmware takes. `build`, `dev` and `run` say which field
and why (`field` and `problem` in the JSON) and show the smallest valid file. The usual causes: `fields` written as a
list (it is a map keyed by each field's id), a type the firmware does not have (`select` instead of `enum`), an
`enum` whose `options` are not `{ "value": …, "label": … }`, a `default` that is not among the options or out of
`min` and `max`, a field without `label`. The format is in the project's `AGENTS.md` and in
[Your first app](first-app.md).

### `app_crashed`, or the BUSY Bar shows nothing after `run`

`run` starts the app and watches it for a second. `app_crashed` means the app's script stopped with an error at once;
the message carries the error's first line. `busy-emulator logs` shows the app's console: what it printed with
`console.log`, the error, and why it ended. Fix the script, then `build` and `run` again.

### `start_interrupted`

The emulator ended before its BUSY Bar was ready: `quit` was called while it was starting, somebody closed it, or it
failed. Run `busy-emulator start` again; if it ends by itself again, see "The emulator keeps stopping" below.

### `no_dependencies`, `install_running`, `network_failed`, `network_stalled`, `tool_failed`

- `no_dependencies`: the project has no `node_modules` yet. Run `busy-emulator build` first; it installs them.
- `install_running`: another command (the window's Build button, another agent) is installing this project's
  dependencies right now. Wait until it has ended, then run the command again.
- `network_failed`: npm could not reach the registry. Check your connection, and the registry and proxy in
  `~/.npmrc` (on Windows `%USERPROFILE%\.npmrc`), if you set them.
- `network_stalled`: the registry did not answer for 45 s (a Wi-Fi out of range, a proxy that holds the
  connection), and the emulator stopped npm rather than let it wait for minutes. Packages a past create fetched
  come from npm's cache without the network.
- `tool_failed`: the template's generator, npm or busy-cli failed. The answer ends with what that tool printed and its
  exit code: fix what it says. A failed `build` leaves the app the BUSY Bar has as it was.

### "Dependencies not installed" on an app's row

The project was made, but npm could not fetch its packages: the row says why ("no network", "no answer from the npm
registry", "the install was stopped"). **Retry** installs them; the window also tries again by itself when the
computer is back online. From the command line, `busy-emulator build --dependencies-only` does the same. Then
Refresh puts the app on the BUSY Bar.

### The app stopped: "did not return for 2 s"

The app's JavaScript ran 2 s without returning, in a loop such as `for (;;) {}` or `while (!ready) {}`, and the
emulator stopped it, as a long Back stops an app on a BUSY Bar. `run` answers `app_crashed`, and `busy-emulator logs`
says why. Wait with `setTimeout` or `await` instead of a loop:
[a loop that never returns](differences.md#other-differences-we-know-of).

### BUSY Bar is frozen

An app can leave BUSY Bar taking no keys: the supervisor's warning after its JavaScript memory filled up, or a screen
that nothing changes. On a real BUSY Bar you hold Back and Start together; here press **Restart BUSY Bar** on its
card in the window, or run `busy-emulator restart-bar` (the MCP tool `restart_bar`), which waits until it answers
again. Installed apps and their settings are kept. If the app hangs again once it is started, `busy-emulator
uninstall` it and fix it.

### `10.0.4.20` does not answer

That is the address of a BUSY Bar on USB; the emulator has none. Use the address `busy-emulator status` prints,
`http://127.0.0.1:8640` by default, and `--addr 127.0.0.1:8640` for busy-cli. The API documentation is at `/docs/`
of that address.

### The BUSY Bar still shows the previous version of my app

`build` makes the package; it does not change the BUSY Bar. `run` installs what `build` made and starts it (`install`
alone installs without starting). If the install fails while the app is running, `stop` it first. An app reads its
settings when it starts: after you change them in the local web, use Restart there.

### My app cannot reach a service on my computer

That is deliberate: on a BUSY Bar, `localhost` is the BUSY Bar itself, and in the emulator the same address would reach your own
databases and dev servers. Your app's console says why a request was refused. `busy-emulator allow-local <port>`
asks you in the emulator's dialog and, once you choose Allow, allows that one port until the emulator quits:
[what an app on the BUSY Bar may reach](differences.md#what-an-app-on-the-busy-bar-may-reach).

### A web page cannot call the emulator (`403`)

Unlike a BUSY Bar, the emulator refuses pages of other sites:
[who may call the emulator](differences.md#who-may-call-the-emulator). Programs without a browser (`busy-cli`,
`curl`, scripts) are not affected, so a page of your own can ask a program on your computer to make the request for
it. The desktop app has no setting that lets a page in; `--allow-origin`, which the refusal names, is an option of
the server started from the emulator's source.

### The emulator keeps stopping, or did not start

Choose Try again in its window. If it fails again, the log is `logs/shell.log` in the data folder
(`~/Library/Application Support/BUSY Bar Emulator/` on macOS, `%LOCALAPPDATA%\BUSY Bar Emulator\` on Windows).
[Report it](https://github.com/busy-app/busybar-emulator/issues) with that file.

### An animation jumps, or a clip has jumps in it

The emulated BUSY Bar keeps time with your computer's clock, and when the computer holds the emulator up for more than
half a second (heavy load, sleep, a debugger), the BUSY Bar skips what it could not draw in that time:
[when the computer is very busy](differences.md#other-differences-we-know-of). Close what keeps the computer busy and
record again. A BUSY Bar does not do this.

### `record` answers that the clip could not be made

`record` needs the emulator running (`not_running` otherwise). The default layout records the emulator's window: the
command brings it to the front and opens it if you closed it. `--layout post`, `front` and `both` need no window. A
GIF has a frame limit that depends on `--scale` and `--fps`; the answer says what fits. A clip is not made while the
server runs with `--fast`.

### Publish to GitHub: "GitHub CLI asks for access to your repositories"

The emulator signs in to GitHub through GitHub CLI (`gh`, made by GitHub, inside the app), and GitHub's page asks you
to authorize **GitHub CLI**, not BUSY Bar Emulator. GitHub CLI always asks for the same access: your repositories
(public and private), your organizations' membership and your gists. The emulator uses it to create the app's public
repository, fork the catalog and open the pull request. GitHub CLI keeps the token in your system's password store;
the emulator never holds it.

This sign-in belongs to GitHub CLI on this computer: other programs, including AI agents, can use it too. The
emulator's confirmations cover only its own commands; a program that runs `gh` itself is not asked anything by the
emulator. If that is not what you want, sign out in the emulator with Also sign out GitHub CLI on this computer
ticked (it starts ticked when GitHub CLI had no account before), or publish by hand (`SUBMIT.md`).

To take the access back, sign out in Publish to GitHub (tick Also sign out GitHub CLI on this computer if the emulator
signed it in), then on github.com/settings/applications, under Authorized OAuth Apps, revoke **GitHub CLI**. That signs
out GitHub CLI everywhere you use it with this account.

### Publish to GitHub: "GitHub CLI on this computer is signed in as <login>"

The emulator publishes through GitHub CLI and shares its accounts with GitHub CLI on your computer. **Use <login>**
publishes with that account; signing out in the emulator only forgets it there. **Sign in with another account** adds
an account to GitHub CLI and makes it the one GitHub CLI uses, in your terminal too. To go back, sign out in the
emulator and leave Switch GitHub CLI back ticked, or run `gh auth switch`.

From the command line, `publish signin` answers `choose_account`: run it with `--use-existing` or `--new-account`.

### Publish to GitHub does not see GitHub CLI's account

The emulator looks for GitHub CLI's settings where GitHub CLI keeps them by default: `~/.config/gh` on macOS,
`%APPDATA%\GitHub CLI` on Windows. If you moved them with `GH_CONFIG_DIR` or `XDG_CONFIG_HOME`, the emulator does not
follow: it reads nothing from its environment, which decides where a program looks and, through GitHub CLI's settings,
where GitHub CLI sends its requests with your token. Sign in with another account in the emulator instead, or move
the settings back.

### "The system's password store did not take the sign-in"

GitHub CLI could not keep the token in the login keychain (macOS) or Credential Manager (Windows), and the emulator
does not let it keep the token in a plain file: it signs that account out of GitHub CLI again. Unlock the login keychain in Keychain Access (macOS), then sign in
again.

## macOS

### macOS asks for a keychain item

The emulator's own code keeps nothing in the keychain. GitHub CLI inside it keeps its sign-in there, under
`gh:github.com`, through the system's `security` tool, so macOS should not ask. If it does, [report it](#reporting-a-problem),
with what you were doing at the time.

## Windows

### "Windows protected your PC"

SmartScreen shows this for the setup, which is not signed yet. Choose More info, check that the file is
`busybar-emulator-win-x64-setup.exe`, then Run anyway. Details: [install.md](install.md#windows).

### Windows Firewall asks about BUSY Bar Emulator

The emulator listens on `127.0.0.1` only and needs no firewall rule, so Windows should not ask. If it does, choose
Cancel: the emulator works the same. Then [report it](https://github.com/busy-app/busybar-emulator/issues), with
what you were doing at the time.

### The uninstaller says the emulator or a command is running

The uninstaller removes nothing while a program of the emulator is running from the app's folder. It ends none
itself; it only asks the emulator to quit. Its message names the process. A `busy-emulator` command that is still
running, such as `build` or `dev`, must end first: wait for it, or stop it with Ctrl+C where it runs. If the emulator
itself did not quit, choose Quit in its menu. Then run the uninstaller again ([install.md](install.md#removing-it)).

### Running the command line in PowerShell, Git Bash or cmd

Agents on Windows run commands in different shells: Codex and Cursor in PowerShell, Claude Code in PowerShell or in
Git Bash. When the full path has no space in it, write it with forward slashes and no quotes, and the same command
runs in PowerShell, Git Bash and cmd alike (letters outside the English alphabet are fine):

```sh
C:/Users/you/AppData/Local/busy-emulator/bin/busy-emulator.exe status
```

A path with a space needs quotes, and each shell its own form. PowerShell needs `&` in front of a program given as a
quoted path or a variable; without it, it only prints the string:

```powershell
& "$env:LOCALAPPDATA\busy-emulator\bin\busy-emulator.exe" status
```

In Git Bash and in cmd:

```sh
"$LOCALAPPDATA/busy-emulator/bin/busy-emulator.exe" status
```

```bat
"%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe" status
```

A backslash in Git Bash is an escape: `C:\Users\you\…` without quotes loses its backslashes there. `busy-emulator help`
prints the command as your shells need it: one line when one form runs in all three. A folder for `--out` must not end in `\"`:
PowerShell then passes the quote on and swallows the rest of the line. End it with `/` or with no slash.

### Delete, or `uninstall --delete-files`, keeps the folder

The emulator moves a project's folder only to the Recycle Bin, never deletes it for good. Where Windows has no
Recycle Bin for it, on a network share or a removable drive, or when the command runs in a session with no desktop
(over SSH), it refuses (`not_deletable`) before anything changes. Choose Remove from the emulator instead (or
`uninstall` without `--delete-files`), then delete the folder yourself if you want it gone.

### `build` fails on a project whose path has letters outside the English alphabet

busy-cli packs the app with Windows' own `tar.exe`, which cannot handle a path with letters outside the system's code
page (for example Cyrillic, Greek or Chinese letters in your user name or in a folder name). `build` and `dev` say
so. Move the project to a folder whose path has Latin letters only. This is a bug in busy-cli.

### `npm run build` fails with `Rolldown failed to resolve import`, or `npm create @busy-app/app` installs nothing

Both are bugs in busy-tools on Windows (busy-cli 0.6.0 and create-app 0.5.0). `busy-emulator create` and
`busy-emulator build` work around them; use them instead of the npm scripts.

## Every code, A to Z

What each `code` of an answer means and what to do. The command line's answers and the window's messages for
publishing use the same codes. A code with a section above links to it. The exit code is 2 for `usage` and
`unknown_command`, 1 for every other. The steps of publishing are in
[From zero to a catalog submission](from-zero-to-catalog.md).

### Making and running the app

| Code | What happened | What to do |
|---|---|---|
| `app_crashed` | The app started and stopped at once with an error | [The BUSY Bar shows nothing after run](#app_crashed-or-the-busy-bar-shows-nothing-after-run) |
| `author_required` | `create` found no author but a name many computers share ("User", "admin"), which would give other people's apps the same id | Give `--author` with your GitHub login or your name, or sign in to GitHub first |
| `bar_off` | The emulated BUSY Bar is powered down in the window, or its battery ran out there | Turn it on in the window, then try again |
| `blocked_file`, `blocked_network` | An agent's sandbox is in the way | [Sandboxes](#blocked_network-or-blocked_file) |
| `build_failed`, `install_failed`, `run_failed` | A round of `dev` failed at that stage; the BUSY Bar keeps the last version that built | Read the output, fix it and save again |
| `folder_not_empty` | `create` needs a new folder name, or an empty folder | Give a name that is not taken: `create` makes the folder |
| `icon_exists` | The project has icons already, and they are kept | Add `--force` to replace them |
| `interrupted` | npm or busy-cli was stopped before it ended | Run the command again |
| `move_app` | macOS runs the app from the disk image or from Downloads | [Move it to Applications](#move-busy-bar-emulator-to-applications-macos) |
| `network_failed`, `network_stalled`, `no_dependencies`, `tool_failed` | npm or busy-cli could not do its part | [The project's tools](#no_dependencies-install_running-network_failed-network_stalled-tool_failed) |
| `no_node_tools` | This copy of the emulator lacks its own Node | Install the emulator again |
| `no_settings` | The app has no `src/appmeta/settings.json` | Add one: [Your first app](first-app.md#what-each-command-does) |
| `no_typecheck` | The project's `package.json` has no typecheck script | Nothing to do: the template's projects have one |
| `not_a_project` | The folder is not an app project, or is not there | Run it in the project's folder, or name the folder |
| `not_built` | Nothing is built yet | Run `build` first |
| `not_installed`, `no_app_named` | The app is not on the emulated BUSY Bar | `run` it first, or name the app with `--app` |
| `not_running` | The emulator is not running | [Start it](#not_running) |
| `package_too_large` | The package is over 100 MiB, more than a BUSY Bar takes | Keep large files out of the app |
| `picture_unreadable` | The picture cannot be made into an icon | Use a PNG |
| `port_busy` | Another program listens on port 8640 | [Port 8640 is in use](#port-8640-is-in-use) |
| `settings_invalid` | `settings.json` is not what the firmware takes | [The settings file](#settings_invalid-or-the-busy-bar-shows-settings-file-is-invalid) |
| `settings_refused` | The BUSY Bar refused a value; the answer says why | Give a value the field takes |
| `start_failed`, `server_failed`, `start_interrupted`, `start_timeout` | The emulator did not start, or ended while it started | [The emulator keeps stopping](#the-emulator-keeps-stopping-or-did-not-start) |
| `typecheck_failed` | The project's TypeScript has errors; each names its file and line | Fix them; `build` does not check types |
| `untrusted_package`, `untrusted_project`, `trust_needs_person` | The folder is not trusted | [Trust it](#untrusted_project) |
| `trust_refused`, `trust_refused_recently`, `trust_no_answer`, `trust_refused_path` | The trust question was answered No, asked again too soon, not answered, or not asked | [The trust codes](#untrusted_project) |
| `trust_busy`, `trust_unavailable` | Another question is open in the emulator, or its window could not ask | Answer the open question or open the window, then try again |
| `watch_failed` | The system would not watch the folder for `dev` | Check that the folder is there and readable; `dev --once` needs no watch |

### Screenshots and clips

| Code | What happened | What to do |
|---|---|---|
| `catalog_check` | The screenshot is saved, but the catalog would not take it | Take it again with the app on screen; the answer says why |
| `encode_failed`, `record_failed` | The clip could not be made | [When record fails](#record-answers-that-the-clip-could-not-be-made) |
| `fast_mode` | The emulator runs faster than a BUSY Bar, and a clip would be wrong | Start it without `--fast` |
| `record_busy` | Another clip is being recorded | Wait for it, then record again |
| `screen_failed` | The BUSY Bar gave no frame | Try again; if it repeats, [report it](#reporting-a-problem) |
| `window_hidden` | The emulator's window is closed or hidden, so it cannot record it or ask you | Open the window, or record with `--layout post` |

### Preparing for the catalog (stage 1)

| Code | What happened | What to do |
|---|---|---|
| `bad_name` | The catalog would not take the app's name, or GitHub the repository's | An app's name: at most 32 characters, Latin letters, digits and a few signs. A repository's: letters, digits, `.`, `-` and `_` |
| `check_failed` | Some of the catalog's checks fail; nothing was written | Each failure names its step and what to change. Put it right and package again |
| `details_unreadable` | `catalog.json` is not JSON | Fix the file, or write the texts again in Application Info |
| `no_author` | Nobody to name in LICENSE | Write the copyright holder (`--author "Your Name"`) |
| `no_manifest` | The project has no `src/appmeta/manifest.json` | Run it in the app's project |
| `not_a_license`, `not_found` | The license file is not plain text of up to 200 KB, or cannot be read | Choose the license's text file |
| `not_screenshots` | No file was taken | A front screenshot is a PNG of 72×16, a back one of 160×80, or an exact enlargement |
| `readme_incomplete` | The README is not written yet | Write it in the README step, with at least one How to use row |
| `submission_exists` | `submission/` is there and was not made by the emulator | Move it away, then package again |
| `write_failed` | A file could not be written | Check that the project's folder is writable and the disk not full |

### Publishing to GitHub and sending to the catalog (stage 2)

| Code | What happened | What to do |
|---|---|---|
| `account_gone` | GitHub CLI has no sign-in for that account any more | Choose an account again |
| `bad_answer` | GitHub CLI showed a code or a page that is not GitHub's | Try again in a moment |
| `bad_catalog` | The `--catalog` value is not a GitHub repository | Write `owner/name`, or its address on github.com |
| `busy` | An upload is under way | Wait for it, or Cancel it |
| `canceled`, `upload_canceled` | The sign-in or the upload was stopped; the repository is as it was | Start again when you want |
| `catalog_closed` | The catalog repository cannot be seen (it is private, or not there) | Check the address, try again in a moment, or [send it by hand](first-app.md#sending-it-by-hand) |
| `catalog_empty` | The catalog repository has no files yet | Try again later, or send it by hand |
| `changed_outside`, `signed_in_other` | GitHub CLI was switched to another account outside the emulator | Sign in again and choose the account to publish with |
| `changed_since_upload` | The project changed after it was published | Publish to GitHub again, then send |
| `checklist_too_long` | The catalog's checklist has more than 50 items, or an item longer than 500 characters, so the emulator does not show it or send anything | Check that it is the catalog you mean, or send the app by hand (SUBMIT.md) |
| `choose_account` | GitHub CLI on this computer has accounts already | [Choose one](#publish-to-github-github-cli-on-this-computer-is-signed-in-as-login), or sign in with another |
| `denied` | The sign-in was canceled on GitHub | Sign in again when you want to publish |
| `expired` | The code expired before it was entered | Get a new code and enter it on GitHub |
| `forbidden` | GitHub refused it | Sign out, sign in again, then try once more |
| `fork_not_allowed` | The catalog cannot be forked from your account | Send it by hand |
| `fork_pending` | GitHub is still making your copy of the catalog | Try again in a minute |
| `github_unavailable` | The command line could not ask the emulator's app | Open the emulator, then try again |
| `keyring_refused` | The system's password store did not take the sign-in | [The password store](#the-systems-password-store-did-not-take-the-sign-in) |
| `name_taken` | You have a repository of that name, and this project was not published to it | Choose another name; a free one is offered |
| `network` | GitHub could not be reached | Check the connection, then try again |
| `no_ai_choice` | How AI was used is not said | Choose none, partly or full |
| `no_existing` | GitHub CLI has no such account on this computer | Sign in with another account |
| `no_files`, `no_license` | Nothing to publish, or no license yet | Look at Repository files; choose a license |
| `no_version` | The manifest has no id or version the catalog takes | Fix `src/appmeta/manifest.json`, then build and package again |
| `not_configured` | This build has no GitHub CLI | Send it by hand |
| `not_landed` | GitHub does not hold the files that were sent | Publish again |
| `not_packaged` | There is no catalog entry yet | Build and package first |
| `not_pushed` | The app is not on GitHub from this computer yet | Publish to GitHub first |
| `not_signed_in`, `not_signing_in`, `signing_in`, `unauthorized` | No sign-in, one already under way, or GitHub no longer takes it | Sign in to GitHub, or finish the sign-in under way |
| `not_ticked` | Not every item of the catalog's checklist is ticked (an optional one may stay unticked); nothing was sent | Tick each item that is true: [Send to catalog](from-zero-to-catalog.md#send-to-catalog) |
| `other_catalog` | The catalog is not BUSY's (busy-app/busy-apps-catalog or its dev copy), and you did not confirm its name | Send it to busy-app/busy-apps-catalog, or confirm the catalog by its name when the emulator asks |
| `outside`, `bad_path`, `too_large`, `too_many_files` | A file is outside the project, has a name GitHub refuses or is over 50 MB, or there are too many files | Keep it out in Repository files, or rename it |
| `rate_limited` | GitHub's limit of requests is reached for now | Try again at the time the message names |
| `refused` | You chose Cancel; nothing was sent | An agent should not ask again unless you say so |
| `secrets` | A file looks like a secret or personal data and would be published | Keep it out in Repository files, or choose Publish it anyway there |
| `unprocessable` | GitHub did not take it | Try again in a moment; if it says the same, send it by hand |

### Anything else

| Code | What happened | What to do |
|---|---|---|
| `internal` | A failure the emulator did not expect | [Report it](#reporting-a-problem), with the whole answer |
| `log_failed`, `bar_failed`, `press_failed`, `time_failed`, `settings_failed`, `restart_failed`, `uninstall_failed` | The emulated BUSY Bar did not answer as it should | Try again; if it repeats, quit the emulator and start it again |
| `no_management`, `person_only`, `port_refused` | `allow-local` could not ask you, or the port is the emulator's own | [Reaching a service on your computer](#my-app-cannot-reach-a-service-on-my-computer) |
| `no_project_folder`, `several_folders`, `trash_failed`, `not_deletable` | `uninstall --delete-files` cannot move the project's folder | [Delete keeps the folder](#delete-or-uninstall---delete-files-keeps-the-folder) |
| `quit_failed`, `quit_timeout` | The emulator did not end when asked | Choose Quit in its menu |
| `tool_timeout` | An MCP tool ran out of time and was stopped | Run it again |
| `unknown_command`, `usage` | No such command, or wrong options | `busy-emulator help` lists the commands and their options |

## Reporting a problem

Open an issue at https://github.com/busy-app/busybar-emulator/issues. Put in it:

- the output of `busy-emulator version` (the emulator's version, its firmware and the tools it uses; `--json` for an
  agent), and your system: the macOS version and whether the Mac has
  Apple Silicon or Intel, or the Windows version;
- what you did, what you expected and what happened: the command and its whole answer (with `--json`, if an agent
  ran it), or what you clicked in the window;
- a screenshot (`busy-emulator screenshot --scale 8`) or a clip (`busy-emulator record`) when it is about what the BUSY Bar
  shows;
- `logs/shell.log` from the data folder (`~/Library/Application Support/BUSY Bar Emulator/` on macOS,
  `%LOCALAPPDATA%\BUSY Bar Emulator\` on Windows), when the emulator stopped or did not start;
- if you can share it, the smallest project that shows the problem.

The log and the answers name the folders you work in, and so your user name: look through them before you attach
them. If your app behaves differently on a BUSY Bar, say so, with the BUSY Bar's firmware version: the BUSY Bar has the final word.
