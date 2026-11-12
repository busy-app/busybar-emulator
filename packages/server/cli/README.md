# cli

`busy-emulator`, the command line of BUSY Bar Emulator (ADR-0002 sections 7 and 7a, ADR-0010). Plain Node, nothing
from Electron. It lies inside the app at `<resources>/emulator/packages/server/cli/busy-emulator.mjs` and runs on the
Node inside the app; nobody needs a Node of their own.

How it is called:

| | macOS | Windows |
|---|---|---|
| Inside the app | `<app>/Contents/Resources/bin/busy-emulator` | `<app folder>\resources\bin\busy-emulator.exe` |
| At the fixed path, written by the app at every start | `~/.busy-emulator/bin/busy-emulator` | `%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe` |
| Named by | `~/Library/Application Support/BUSY Bar Emulator/install.json`, field `cli` | `%LOCALAPPDATA%\BUSY Bar Emulator\install.json`, field `cli` |

The entries are in `packages/app/launcher/`.

## Commands

```
busy-emulator start      start the emulator and wait until its BUSY Bar answers; bring its window to the front if it
                         is already running
busy-emulator status     whether the emulator runs, and where its BUSY Bar answers
busy-emulator quit       quit the emulator
busy-emulator version    the emulator's version, its Node, the firmware and the tools it is made of, and this command's own path, ready to paste
busy-emulator update [--check]
                         --check: whether a newer emulator is out and whether this copy can update itself; without
                         it, the update: the app asks the person in its dialog, then downloads, checks the release's
                         signature and restarts as the new version (codes no_update, cannot_update, refused,
                         window_hidden, busy, network)
busy-emulator screenshot [--back] [--out <path>] [--scale <n>]
                         save what the BUSY Bar's front display (or back, --back) shows now as a PNG for the catalog
busy-emulator record [--seconds <n>] [--fps <n>] [--out <path>] [--layout window|post|front|both] [--scale <n>] [--gif]
busy-emulator record --stop
                         a short video for a post: by default the emulator's window as you see it, an MP4 (H.264) in
                         media/; --layout post|front|both the BUSY Bar alone, --gif a GIF of the front display
busy-emulator create <folder> [--example <name>] [--icon <picture.png>] [--back-icon <picture.png>] [--author <name>] [--id <app id>] [--name <name>] [--description <text>] [--api-version <x.y.z>]
                         a new app project from the official template, or from an example app, with its dependencies
                         installed
busy-emulator create --examples [--pictures]
                         the example apps, a line each; --pictures adds each one's icon and a frame of its front
                         display as data: addresses (for the app's window)
busy-emulator build [<folder>]              busy-cli build of the project (its dependencies first, if missing)
busy-emulator install [<folder>]            busy-cli app install --addr <the emulated BUSY Bar>
busy-emulator run [<folder>]                installs the built package, then busy-cli app run --addr <the emulated BUSY Bar>;
                                            says whether the app runs, ended, or crashed (with the error's first line)
busy-emulator stop [<folder>]               busy-cli app stop --addr <the emulated BUSY Bar>: the app stops, not the emulator
busy-emulator dev [<folder>] [--once]
                         the development loop: build, install and start, then again on every save, printing the
                         build's errors and the app's console until Ctrl+C; --once does one round and ends
busy-emulator typecheck [<folder>]          the project's TypeScript check (its `typecheck` script, tsc)
busy-emulator press <up|down|ok|back|start> [--times <n>] [--hold <ms>] [--power-on]
                         a button of the BUSY Bar or a click of its wheel; --hold holds a button down (a long press)
busy-emulator restart-bar                   restart BUSY Bar, as holding Back and Start does on a real one, and wait until
                                            it answers again (how long it took); apps and their settings are kept
busy-emulator settings get|set|reset [<folder>] [<key>=<value> …] [--app <id>] [--restart]
                         an app's settings on the BUSY Bar: read them, set some (--restart starts the app again), reset
busy-emulator trust [<folder>] [--wait <seconds>]
                         ask the person, in a dialog of the app, to trust a folder the emulator did not create
busy-emulator projects [--add <folder>] [--forget <folder>] [--prune]
                         the app projects the emulator has worked with: the app's id, its folder, whether it is
                         built, on the BUSY Bar, running
busy-emulator uninstall <id|folder> [--delete-files]
                         remove an app from the emulator: stop it, take it off the BUSY Bar, forget its project; the
                         folder stays, or with --delete-files goes to the Trash (the Recycle Bin), only a project
                         folder of the emulator's list (codes not_deletable, no_project_folder, trash_failed)
busy-emulator check [<folder>] [--full]     what the catalog's checks would say about the project and its built package
busy-emulator submit [<folder>] [--catalog <owner/repo>] [--full]
                         check, then write submission/: the catalog's manifest.yml, the pull request's text, the steps
busy-emulator icon [<folder>] (--text <AB> | --from <picture.png>) [--back <picture.png>] [--color <#RRGGBB>] [--force]
                         the app's two icons, 8×8 front and 11×11 back, from one or two letters or a PNG
busy-emulator time [set <ISO or HH:MM> | advance <duration> | reset]
                         the emulated BUSY Bar's clock: show it, set it, let time pass at once, or make it the computer's
busy-emulator catalog-texts [get|set] [<folder>] [--name <name>] [--category <id>] [--short-description <text>] [--description <text>] [--changelog <text>]
                         the catalog's four texts of the app, in catalog.json: read them, or write some, each checked by
                         the catalog's rules
busy-emulator publish status|check|license|files|screenshots|readme|package|prepare|signin|signout|push|pr [<folder>] [options]
                         publishing: stage 1 makes ready in the project everything the public repository and the
                         catalog's pull request need; stage 2 (signin, push, pr) is done by the running app, which
                         holds the GitHub sign-in (see "publish" below)
busy-emulator allow-local [<port>] [--remove <port>]
                         let apps on the BUSY Bar reach a port of this computer until the emulator quits; --remove takes
                         it back; without a port, list the allowed ones
busy-emulator logs [--app <id> | --all] [--since-run] [--kind <kinds>] [--since <ms>] [--lines <n>] [--follow]
                         the BUSY Bar's log for this folder's app: its console.log output, its errors, why it ended
busy-emulator mcp      the commands as MCP tools on stdin and stdout, for chat clients that cannot run commands
busy-emulator help [<command>]
```

`time` is the emulated BUSY Bar's clock. `time advance 25m` (also `90s`, `2h`, `1h30m`; 24 h at most) lets the time pass
at once: the BUSY Bar's clock and the app's `Date.now()` move on, the app's `setTimeout` and `setInterval` count from the
new time (what was due in between fires now, earliest first; an interval once, not once a period), and the firmware
lives through every 8 ms tick of it, so a `countdown` element and animations move too. The app's network requests are
not hurried. `time set 14:59:50` (today, in the BUSY Bar's time zone) or `time set 2026-12-31T23:59:50` sets the clock as
the BUSY Bar's `POST /api/time/timestamp` does: timers keep their waits. `time reset` makes it the computer's time again.
`time` alone shows it and how far it is from the computer's. A BUSY Bar that is off answers `bar_off`.

`icon` writes `src/appmeta/icon_front_8x8.png` (8-bit RGBA) and `icon_back_11x11.png` (8-bit gray and alpha: the
back display's menu paints the shape in its own color) from `--text` (one or two letters or digits, `--color` for
their color) or `--from` (a PNG of any size, scaled down); `--back` gives the back icon a picture of its own, drawn at
11×11 and taken pixel for pixel. Both are checked against the catalog's icon rules before
they are written; icons that are there are kept unless `--force` is given (`icon_exists`).

The shortest way from an idea to a running app: `create my-app`, then in the folder `build` and `run`, and when the
BUSY Bar shows nothing, `logs`. `--help` and `-h`, alone or with a command, print the help and end with 0; no command at
all prints it too and ends with 2.

`--json` prints one line: `{"ok":true,"command":…,…}` or `{"ok":false,"command":…,"code":…,"message":…,"hint":…}`.
With `--json` a command says nothing else; `--json --progress` also prints to standard error what a long command is
doing (installing, building), a line each: the app's window shows these lines while it waits for the answer.
Exit codes: 0 done, 1 the command failed, 2 a wrong call. The codes of failures: `usage`, `unknown_command`,
`blocked_network` (a sandbox closes 127.0.0.1 to this process), `blocked_file` (a sandbox closes the data folder),
`no_app` (run from the source folder, there is no app around it), `start_failed`, `start_timeout`, `start_interrupted`
(the app ended before its BUSY Bar was ready: a `quit` came while it was starting, a person closed it, or it failed),
`port_busy`,
`server_failed`, `move_app`, `quit_failed`, `quit_timeout`, `not_running` (`screenshot`, `record`, `install`, `run`, `stop`,
`dev`, `logs`, `press`, `restart-bar`, `settings`, `trust`, `allow-local`: the emulator is not running, or its BUSY Bar is not ready; only
`start` starts it; `dev` also when the emulator quits while it watches), `app_crashed` (`dev --once`: the app was built, installed and started, and stopped at
once; `error` is the runtime's first error), `watch_failed` (`dev`: the system would not watch the folder), `no_management`
(`allow-local`: the running server's management address or key cannot be read or does not answer), `port_refused`
(`allow-local`: the port is the emulator's own), `person_only` (`allow-local` called by the MCP server: allowing a
port is the person's step), `local_refused`, `local_no_answer`, `local_unavailable`, `local_busy` (`allow-local`: what
the person answered in the app's dialog, or why they could not be asked), `not_a_project` (the folder has no package.json
that names `@busy-app/cli`), `untrusted_project` (the hint names `trust <folder>`), `trust_needs_person` (`--trust`
was given: it trusts nothing), `trust_refused`, `trust_refused_recently`, `trust_no_answer`, `trust_busy`,
`trust_refused_path`, `trust_unavailable` (`trust`: the person chose "Don't Trust"; they did so less than 30 s ago and
are not asked again yet; nobody answered in time; another question is open; the folder's path cannot be shown to a
person as it is; the emulator has no dialog or no window to ask in),
`settings_invalid` (`build`, `dev`, `run`, `settings`: the app's settings file is one the BUSY Bar refuses; `field` and
`problem` say where and what), `no_settings`, `not_installed`, `settings_refused`, `settings_failed`, `restart_failed`,
`no_app_named` (`settings`), `press_failed`, `bar_off` (`press`: the BUSY Bar is powered off; `--power-on` turns it on), `no_typecheck`, `typecheck_failed` (`typecheck`; `errors` holds
`file`, `line`, `column`, `code`, `message`), `folder_not_empty` (`create`; `holds` and `suggestion`),
`no_dependencies` (`install`, `run`,
`stop` before the first `build`), `not_built` (`run`: the app is not on the BUSY Bar and the project has no built package;
the hint says `build`), `app_crashed` (`run`: the app was started and ended with an error within a second; `error` is
the error's first line, `log` the run's lines, the hint names `logs`), `log_failed` (`logs`: what listens at the BUSY Bar's
address gave no log), `tool_failed` (the generator, npm or busy-cli ended with another code than 0: its own
words, with `tool`, `exit_code` and `output`, the end of what it printed, npm's stack lines left out), `interrupted` (the
tool was stopped by a signal, Ctrl+C), `network_failed` (npm could not reach the registry; `create` names the project it
made in `folder` and says to run `build` in it), `no_node_tools` (an incomplete app), `screen_failed` (the BUSY Bar gave no frame: it is off, or
answered something else), `write_failed` (the file could not be written; `file` names it), `catalog_check` (the file
was saved, but the catalog's rules refuse it; never expected of the emulator's own files), `check_failed` (`check`,
`submit`: a check of the catalog fails; the answer carries what needs something, `--full` the whole list), `not_built` (`submit` before `build`),
`submission_exists` (`submit`: a folder `submission/` of the author's own is in the way), `time_failed`, `bar_off`
(`time`), `icon_exists`, `picture_unreadable` (`icon`), `fast_mode` (`record`: the
emulator runs at the computer's speed, and a clip would show the app faster than a BUSY Bar), `record_busy` (another clip is
being recorded), `encode_failed` (`record`: the app could not encode the video; `missing` names what this machine
lacks), `window_hidden` (`record`: the emulator's window could not be shown to be recorded), `window_loading` and `no_frames` (`record`: the window was still loading, or is on the screen but gave no frames), `record_failed` (the emulator's management address cannot be read or did not answer), `internal`.

`record` asks the running emulator for the clip (`POST /_emu/record` on its management address with its key,
`../capture/record.mjs`). By default (`--layout window`) the app records its main window as the person sees it: it
shows the window (and opens it again if it was closed), takes the window's own frames as its compositor draws them
(`webContents.beginFrameSubscription`: no Screen Recording permission on macOS, the same on Windows, and frames even
when other windows cover it) at the window's size in device pixels, 30 a second in real time, and streams them to its
hidden encoding page, which draws each one on a canvas made smaller to fit 1920×1080 (1080×1920 for a window taller
than wide): H.264 level 4, video range (yuv420p), as the networks take a clip. The pointer is not in these frames. A window resized during the take keeps its first size. For
the other layouts the server holds the BUSY Bar's clock and steps it by the clip's frame times, paced in real time,
reading both displays at each step: what the firmware animates is exact and repeatable, what the app's own JS draws
is taken when the frame is due (`late_frames` counts the frames taken late). The app's main process encodes the MP4
in a hidden page with a closed network (`packages/app/src/capture-window.mjs`, `pages/capture/`, the file written by
`capture-mp4.mjs`); a GIF the server encodes itself, on a thread of its own (`../capture/gif.mjs`, `gif-worker.mjs`),
within the limits of `../capture/clip-limits.mjs`, which the command checks before it asks (a wrong call, code 2). The file is written to the data folder's
`captures/` and moved by the command where it was asked to go. An MP4 is at most 120 s and has no sound: its audio
track (AAC-LC, 48 kHz, stereo) holds silence, as the networks' upload specifications name an AAC track. `record
--stop` (`POST /_emu/record/stop`) ends a take of the bar being recorded now, the one another `record` or the window's
Record button started: its clip is made of the frames it has (`stopped: true` in that `record`'s answer); with no
take of the BUSY Bar under way it is `not_recording`. A clip of the window runs to its `--seconds`.

`screenshot` takes the frame from the BUSY Bar's own `GET /api/screen` and encodes it in this process
(`../capture/png.mjs`), so the server does nothing for it but answer that request. The file is the display's own size,
72×16 RGB or 160×80 gray, 8 bits, and holds only `IHDR`, `IDAT` and `IEND`: no time, name or software. Without
`--out` it goes to `screenshots/` in the current folder as `front-<n>.png` or `back-<n>.png`, `n` the next number not
taken there (an enlarged copy's name counts too), and nothing is replaced; `--out` names a `.png` file, which is
replaced whole (the text says "Replaced", the JSON `replaced: true`), or a folder, which is numbered the same way. A
relative `--out` is taken from the current folder. On Windows a `"` in `--out` is refused with what happened: PowerShell
5.1 passes `--out "C:\my dir\" --json` as one argument with the quote in it and the words after it swallowed; the
answer is JSON if `--json` was among them, and it says to end a folder with `/`.
`--scale <n>` (2 to 32) also writes the frame enlarged `n` times beside it as `<name>@<n>x.png`, for people and models
that read pictures, not for the catalog. On exFAT and FAT macOS puts an AppleDouble file (`._<name>`, the attributes it
gives every file a process writes) beside each new file and folder; the command removes those that came with its own,
so that they do not go into the author's repository. The file is then checked by the catalog's rules (`../capture/catalog-png.mjs`)
and the answer printed, with the catalog's note when it has one; a copy that lacks that file says it did not check. `--json` gives `display`, `width`, `height`, `file`, `replaced`, `bytes`, `sha256`, `scaled`
(`file`, `replaced`, `scale`, `width`, `height`, `bytes`, or null) and `catalog` (`verdict`, `id`, `note`, `message`, or
null). It does not start the emulator: the first screen after a start is never the one wanted, and a window coming up
is no side effect of a picture. When the emulator is not running, or its BUSY Bar not ready, the answer is `not_running`
with the hint to run `start`.

`allow-local` (EMU-256) is how a person or an agent lets an app reach a service on this computer — the app's console
names it when it refuses a request (ADR-0012 section 5): the desktop app takes no `--allow-local` at its start.
`allow-local 3000` allows port 3000, `allow-local --remove 3000` takes it back, `allow-local` lists the allowed ports.
With the desktop app, allowing is the person's click: the app asks in a dialog of its own ("Don't Allow" the default),
as for `trust`, and the command waits up to 120 s (`local_refused`, also for 30 s after a refusal; `local_no_answer`;
`local_unavailable`: no window to ask in; `local_busy`: another question is open). The key alone does not allow a port
there, since any program on this computer can read it, an agent's shell too. A server without the app takes the key's
word;
`--json` gives `action` (`allowed`, `removed`, `listed`), `port`, `was_allowed` (with `--remove`) and `ports`, all the
ports allowed now. A port stays allowed until the emulator quits, as with the server's `--allow-local`; nothing is
kept in the data folder. The command reads the management address from the lock of the server that uses the data folder
(`run/server.lock`, `control.port`) and the server's key from the file `key` there, and sends the key to 127.0.0.1
alone, never printing it; the server refuses the same request from a page. A port that is not one (or 80, the BUSY Bar's
own API) is a wrong call; the emulator's own two ports are `port_refused`, in the server's words. It does not start
the emulator.

`ensureRunning(ctx, sys, { bringForward })` starts an emulator that is not running and waits until its BUSY Bar answers. One
that runs and is ready is left as it is, unless `bringForward` (only `start` sets it): then the app is started again,
which brings its window to the front. A command an agent calls again and again must not pull the window forward.

`start` starts the app as the system starts an app a person opens: on macOS with `open` (Launch Services), on Windows
through Explorer, so that it does not belong to the caller and outlives it (a process a Node starts on Windows stays in
the caller's job object). The app gets no arguments: a release takes none (ADR-0016). `quit` sends a terminate
signal on macOS, which Electron turns into Quit; Windows has no such signal, and there the process is ended — the
server goes with it before it can clear up, so `quit` then removes what a quit from the menu leaves no trace of: the
app's `run/emulator.json` and the server's `run/server.lock` and `key`, once the server's process is gone and only if
they are still the ones read before the app was ended. Before it ends anything it checks that the process started before
the emulator wrote its state: a number taken over by another program is left alone. Both are stand-ins until the
emulator has its control address (ADR-0012, EMU-024, EMU-025).

A `quit` that races a `start` leaves nothing running and no start waiting (the release rehearsal: a quit 0.2 s after
a start said "not running" and the emulator then came up; one 0.5 s after ended the app, and the start waited its
whole minute). Three things together, all in `lifecycle.mjs`:

- `start` leaves a mark while it waits, `run/starting.json` in the data folder (`{ pid, at }`: its own process), and
  removes it when it ends. A `quit` that finds no app but such a mark, whose process is alive, waits until the app has
  named itself in its mirror and ends it then; it answers `was_running: true, during_start: true` and writes
  `quit: true` into the mark.
- `start` watches the app it waits for: once the mirror has named the process and that process is gone, or once its
  mark says `quit` (a quit ended the app between two looks), it ends with `start_interrupted` at once.
- A `quit` that finds neither an app nor a mark leaves a note, `run/quit-asked.json` (`{ at }`). A `start` whose
  process began before that moment (Node takes a moment to start: it had not left its mark yet) ends the app it
  started as soon as that names itself, and answers `start_interrupted`. A `start` that begins later ignores the note.

Both files are notes between two runs of the command line, never read by the app; like the mirror they are only data
(a mark counts only while its process is alive and it is younger than a start can last).

What the command line reads is `run/emulator.json` in the data folder — `{ pid, exe, started, port, url, state,
detail, since }`, written by the app at every change of its state, removed when it quits — and the BUSY Bar's own address
(`GET /api/status` on 127.0.0.1); `allow-local` and `trust` also read `run/server.lock` and `key`, the server's own. It sends
the app no command through files. What it writes: the screenshots it is
asked for, the two notes of `start` and `quit` in `run/` (above), and, for the project commands, in the data folder
`npm-cache`, `tools/` (the generator, `tools/bin`) and
`projects/trusted.json`, and in the project what its tools write there (node_modules, dist).

## The project commands

`create`, `build`, `install`, `run` and `stop` (EMU-217) are thin: the official generator (`@busy-app/create-app`) and
the project's own `busy-cli` do the work, on the Node inside the app (`../projects/node-tools.mjs`, EMU-206), so the
author needs no Node or npm of their own; one they have is never used. `create` installs the generator into the data
folder (`tools/create-app`, the range `^0.5.0`), runs it without questions (`--no-install`; what is not given takes the
generator's default, the author from git) and installs the dependencies with the bundled npm, without install scripts.
The author, and so the id (`app.<author>.<app>`): `--author`, else the GitHub login (the desktop app's sign-in, else
GitHub CLI's active account, read from gh's hosts.yml: `../../projects/author.mjs`), else git's `user.name` (the
generator reads it), else the name of the account the command runs under. A name many computers share ("User",
"admin": `GENERIC_AUTHORS` in `../readiness/rules.mjs`), or an account's name package.json cannot take as it is, is
never taken: `create` makes nothing and answers `author_required` (the release dry run, 12.11: a Windows account "User"
gave `app.user.my_app` to everyone). The generator refuses a project without an author before it writes anything, so
`create` runs it a second time with the account's name. The answer names the author it used: `author` in the JSON is
`{ name, from, change }`, `from` one of `option`, `github`, `git`, `account`; for the last `change` and a line of the text say where the author is written
(`"author"` in package.json and in src/appmeta/manifest.json) and that the app's id was made from it.
`--author`, `--name` and `--description` may not hold `"`, `\` or control characters (`usage`): the generator writes
them into package.json unescaped (busy-tools issue 11).
`create <folder> --example <name>` starts the project from one of the emulator's example apps (`../../../examples/<name>`,
in the app `<resources>/emulator/examples/<name>`; `examples.mjs`): the generator runs as always, so the id, the author
and the package name come out as for any new project, then the template's `src/` is removed and the example's files are
copied over the project — its app, settings, icons, `shared/`, `README.md` and pictures — and the generator's id and
author are written into the example's manifest and package.json. The example's name and description stay unless
`--name` or `--description` is given. The template's `AGENTS.md` and its workflows stay. `create --examples` lists the
examples from their manifests (`examples` in the JSON: `name`, `title`, `description`); it needs no folder, no network
and no emulator. A name that is not an example is a wrong call (`usage`) that names the ones there are, before anything
is downloaded.
`build` installs the dependencies first when the project has none (`npm ci` with a lock file, `npm install` without),
then runs `busy-cli build`. `install`, `run` and `stop` run `busy-cli app <command> --addr 127.0.0.1:<the bar's port>`
in the project's folder; the emulator must be running.

After the build, `build` and `dev` read the sources for a font the build could not bundle (`../projects/font-check.mjs`):
busy-lib's layout (`render`, `measure`) needs a font's metrics, and busy-cli bundles them only for a font named as a
string literal under `src/`. A font from a variable, the short form `{ font }`, or a literal only in `shared/` builds
and then fails as the app runs (`font "…" has no metrics loaded`). The answer gets `warnings: [{ code:
"font_not_bundled", message, places }]` (in `dev` a `build_warning` event) that says to register only the fonts used,
with `registerFontMaps()`: registering all nine runs out of the app's 128 KiB heap. A warning, never a failure.

`run` does two things of its own around busy-cli (the release rehearsal: an agent trips without them). It installs
first: when the project has a built package (`dist/<id>.tgz`), `busy-cli app install` puts it on the BUSY Bar before the
launch, so the BUSY Bar runs what was built last and `run` before `install` is no dead end (`installed` in the JSON);
without a package the app the BUSY Bar already has is started, and when the BUSY Bar (`GET /api/apps/list`) does not have it
either the answer is `not_built`. And it looks at what came of the launch, because the BUSY Bar answers "launched" for a
script that throws on its first line: for one second it reads the BUSY Bar's log (`app-log.mjs`) for the lines of this run.
An app that ended with an error, or whose engine failed, is `app_crashed` (exit code 1); one whose script ran to its
end without an error is told so (`running: false`, `exited: "finished"`, still `ok`); otherwise `running: true`. The
JSON carries `running` (null when the log could not be read: nothing is claimed), `exited`, `errors` and `log`, the
run's own lines.

`logs` prints the BUSY Bar's log, the latest 50 lines (`--lines <n>` for another number): what apps print with the console
(`<id> log: …`, kind `log`, `info`, `warn`, `error` or `debug`), the runtime's errors (`<id> [JsRunner] Error running
script: …`, kind `error`), an app's life (`Launch <id>`, `App <id> exited: <reason>`, kind `app`) and the BUSY Bar's own
lines (kind `system`). Two kinds of line are the emulator's own notes, which a BUSY Bar does not write:
`App <id>: emulator: unhandled rejection: <reason>, at <file:line:column>` (kind `error`), and `App <id>: emulator:
<method> <path> refused: <status> <the BUSY Bar's error text>` (kind `warn`, once for each refusal in a run). The server keeps the latest 500 lines since it started and gives them to whoever opens its
stream of events (`GET /_emu/events` on the BUSY Bar's address, `device-window.mjs`); the command reads them there, writes
nothing and does not start the emulator. `--json` gives `lines`, each `{ time, kind, text }` with the time in ISO 8601,
`kept`, how many the server holds, `app` and `since_run`.

The log is the whole BUSY Bar's, every app that ran since the emulator started, so `logs` shows one app's lines: in a
project's folder its app's, with the BUSY Bar's own (the clock set, time passed, a restart); `--app <id>` another app's;
`--all`, or a call outside a project, every line. `--since-run` starts at the app's latest launch (outside a project,
the app launched last). `--follow` prints the latest lines and then every new one as it comes, until
the emulator closes the stream or the command is stopped (Ctrl+C); with `--json` every line is one JSON object and the
usual answer comes last.

In a project's folder `logs` shows that project's app and the BUSY Bar's own lines; `--app <id>` names another app, `--all`
every app's, `--since-run` starts at the app's latest launch. `--kind` chooses lines as the filters of the window's
console do, some of `console` (what apps print, warnings and errors), `lifecycle` (kind `app`: installed, launched,
exited), `build` and `system`, with commas between; without it every kind but `build`. `build` lines are what the
desktop app's window ran from its buttons (build, install, start, the checks): the app keeps them in the data folder
(`run/build-lines.jsonl`, emptied when it starts; `build-feed.mjs`), and `logs` puts them among the BUSY Bar's lines in the
order they came. `--since <ms>` shows only lines after that moment, Unix milliseconds by the computer's clock (the
server stamps each line with it, `at`, besides the BUSY Bar's `time`). With `--follow`, a person's output starts with one
line that says whose lines, which kinds and from when. The window's "Open in Terminal" (macOS) and "Open in cmd"
(Windows) run `logs --follow --all --kind <the filters that are on> [--since <its last Clear>] --lines 2000` in the
system's terminal, in the chosen project's folder (`packages/app/src/terminal.mjs`). The JSON answer carries `kinds`
and `since`. A folder argument names the project; without one it is the
current folder; every hint names it as it was given. The tool's output is printed (`output` in the JSON); while a tool works, a person sees on stderr what
runs. A tool that fails gives its own message and exit code; the command exits with 1.

npm's cache is `npm-cache` in the data folder, and Node's compile cache, which npm turns on, `node-compile-cache` there
(nothing in `~/.npm`, `%LOCALAPPDATA%\npm-cache` or the system's temporary folder); neither is ever cleaned yet. npm
reads the person's own `~/.npmrc` (registry, proxy, `cafile`) as always, and from the environment the network
settings (`npm_config_registry`, the proxies, `HTTPS_PROXY`), the certificates (`npm_config_ca`, `cafile`, `cert`, `key`,
`NODE_EXTRA_CA_CERTS` — which a release's launchers remove before the command line starts, so there it does not reach
npm) and `npm_config_userconfig`. The other variables an npm, pnpm or yarn that ran the caller leaves behind, and the
caller's `BUSY_EMULATOR_*`, are not passed on. npm runs with `--no-workspaces`: the project is its own root, also inside
someone else's npm workspace, whose `.npmrc` would otherwise apply. Scripts of the project that call `node`, `npm` or
`npx` get the bundled ones: `tools/bin` of the data folder and the bundled Node's folder are first on PATH (then, so
that busy-cli's `tar` is the system's, System32 on Windows, not GNU tar of Git Bash, and `/usr/bin` on macOS, not GNU
tar of Homebrew). On Windows the busy-cli 0.6.0
fonts path bug is fixed in the project (that one expression in `node_modules/@busy-app/cli/dist/lib/fontMapsPlugin.js`);
the JSON of `create` and `build` says so in `fix`. On macOS `COPYFILE_DISABLE=1` keeps AppleDouble files out of the
package.

Trust (ADR-0012 §4): building runs code from the project's folder (its node_modules, its .npmrc, its build settings).
A project `create` made is trusted; any other folder only after the person says so, once, and in one way only: their
click in the dialog of the running app, which `trust <folder>` asks for (below). Nothing on the command line trusts
a folder. `--trust`, which the project commands once took from "a person at a terminal", trusts nothing any more:
a terminal was told by `isTTY`, and any program can give a command a pseudo-terminal (`script -q /dev/null
busy-emulator build <folder> --trust </dev/null` trusted and built with nobody there; the security review of pull
request 59). The option is still parsed, so that an old instruction gets an answer: `trust_needs_person`, with the
hint of `untrusted_project`. That hint names `trust <folder>`, and `start` for an emulator that is not running;
no usage line and no hint names `--trust`. `untrusted_project` says in one line why: the folder was not created by
this emulator's `create`.

`trust [<folder>]` only asks. With the server's key (as `allow-local`) it sends `POST /_emu/trust?folder=<real
path>&wait=<ms>` to the management address; the server passes the question to the app over its supervisor's channel,
and the app's main process shows a dialog of the system's: the folder's real path as the server resolved it, that
building it runs its code on this computer, the buttons "Don't Trust" (the default, and what closing the dialog means)
and "Trust". The dialog always hangs on the app's main window, which is first opened again, restored and brought to
the front: on macOS a dialog without a window cannot be taken away when the time is over, a late click on "Trust"
would land on a request that is gone, and later questions would wait behind it; with no window to hang it on, nobody
is asked (`trust_unavailable`). A "Trust" within a second of the dialog's appearing is not taken (the dialog took the
focus from what the person was doing): the question is shown again, three times at most. The answer is the click there: neither the server nor this command line has anything that takes an
answer, a page is refused whatever right it holds, and the BUSY Bar's address has no such path. A yes is written to
`projects/trusted.json` by the server, for that very folder if it is still at its place; the command then checks
that it reads the folder as trusted from its own data folder. A no is `trust_refused`; it is written nowhere, but for
30 s after it the server does not put the same folder before the person again (429, `trust_refused_recently`, with
`retry_after_s`): a caller in a loop asked 40 times in 14 ms, each question bringing the app to the front.
One question at a time (`trust_busy`); it waits `--wait` seconds (120; 5 to 600), then the dialog is taken away
(`trust_no_answer`), as it is when the command is stopped. A path the person could not read as it is, is refused
before anybody is asked (`trust_refused_path`, with the reason and the character): control characters and line
separators, every format character of Unicode (category Cf: the marks that turn the direction of text, zero-width
spaces and joiners, the soft hyphen, tag characters, annotation marks), more than one space in a row, more than 1024
characters (`unshowable()` in `../projects/trust.mjs`). `trust_unavailable`: the emulator runs hidden, has no window to
show, or runs from the source folder without its app (the server answers 501). The command does not start the emulator. Outside a release
the tests stand in for the click with `BUSY_EMULATOR_TEST_TRUST_ANSWER=trust|refuse` in the app's environment; a
release never reads it. Trust is remembered for the folder, not the path, in
`projects/trusted.json` of the data folder: its real path (`realpathSync.native`) with the folder's device and inode
numbers. A folder deleted or renamed, and another put at its path, is not trusted. Nor is a trusted project that was
moved or renamed: trust is for the folder at its place. That case is told apart (the list holds the folder's number
under another path): `untrusted_project` and `trust_needs_person` then carry `reason: "moved"` and `trusted_as`, the
old place, the message says that this is the project the emulator created or trusted there, and the hint names
`trust <folder>` — or moving the folder back, which needs nobody. Any other folder
has `reason: "unknown_folder"`; a copy or a clone is one. A command given to an agent outside
its sandbox can still run code the agent wrote into a trusted project: allowing `busy-emulator build` is allowing that
(ADR-0010).

### What `create` puts right in the template

A project fresh from the template has two things an agent trips on (the field test with a real agent, 11.11), and
`create` fixes both once, when it makes the project (`../projects/template-fixes.mjs`; `template` in its JSON says
what was done). A later version of the emulator does not rewrite old projects.

- **`shared/settings.ts`.** The template's helper reads a global `Settings` the released firmware does not have: its
  `loadValues()` is always `null`, so every settings page made with it is dead. It is replaced by one with the same
  exported names (`SettingsValues`, `loadValues`, `saveValues`) that asks the BUSY Bar's API,
  `device.AppsSettingsGet({ app_id })`: the BUSY Bar answers with every field, the saved value or the default of
  `settings.json`. `saveValues()` saves nothing and says so on the console: an app may only read its settings. Only
  the template's own broken helper is replaced.
- **`AGENTS.md`.** A section of the emulator's own, between `<!-- busy-emulator:begin -->` and
  `<!-- busy-emulator:end -->`, goes in before the template's first heading: the commands to use (`dev --once`, `build`,
  `run`, `typecheck`, `logs`, `screenshot`, `press`, `time`, `settings`, `stop`, `icon`, `check`), the format of `settings.json` with the
  smallest valid file and how to read the values, the BUSY Bar's API in short (drawing, fonts and the layout's font trap,
input, timers, `fetch`, storage; every line checked on the emulator), that `create` needs a new folder name, that nothing needs a question
  to the person, and what to do on `not_running` and `untrusted_project`. The template's lines that say `npm run
  build|typecheck|app:install|app:run|app:stop` are rewritten to the emulator's commands, and its line about
  `saveValues()` to what is true. The section names the command line by its fixed path with `~` and
  `%LOCALAPPDATA%`, never a path of this computer: the file goes into the author's public repository. A project
  without a `typecheck` script gets a section that does not name `typecheck`.

`create .` works in an empty folder (one with nothing but `.git` and `.DS_Store`). In a folder with files it answers
`folder_not_empty` with what is in the way (`holds`) and a command with a name that is not taken (`suggestion`).

### The settings file

`build`, `dev` and `run` check the project's `src/appmeta/settings.json` before anything else, as the firmware checks
it when it loads the app's settings (`../projects/settings-schema.mjs`, a port of `js_app_settings_parse()` of
firmware 1.3.1: the same order, the first problem, the firmware's words). busy-cli packs any file, a BUSY Bar then shows
only "Settings file is invalid." and still answers the launch with OK; here the failure is `settings_invalid` with
`file`, `field` (`"group.field"`, null for the file's own keys), `problem`, and a hint that says what to change and
shows the smallest valid file. The emulated BUSY Bar runs the firmware's own parser; `emulator/test/server/agent-hands.test.mjs`
launches an app with each of the broken files of `../projects/test/settings-cases.mjs` and holds the check to what
that parser logs. Stricter than the firmware in one place: a fraction where a whole number belongs is a problem (the
firmware cuts it off). A file whose JSON nests deeper than 32 levels is refused by its text, before it is parsed or
walked (a schema needs 13; twenty thousand nested groups were a stack overflow in the BUSY Bar's settings API, now 503).
Not checked: two fields with one id on one level. `run` also looks after the launch: when the
BUSY Bar's log shows no launch and `GET /api/apps/settings` answers 503, the app was not started because of its package's
settings file, and the answer is `settings_invalid` with the firmware's line (a package built some other way).

### The agent's hands: `press`, `settings`, `typecheck`

An agent often may run this command line and nothing else: in the field test every `curl` to the BUSY Bar and every `npm
run typecheck` was refused by the agent's permissions, so buttons, settings pages and types went unchecked.

`press <key>` sends `POST /api/input?key=<key>` to the BUSY Bar, the BUSY Bar's own input API: `ok`, `back`, `start`, and `up`
and `down`, one click of the wheel (an app gets the key `encoder`). `--times <n>` (1 to 100) repeats it. `--hold <ms>`
(1 to 10000; buttons only) holds the button down that long through the emulator's `POST /_emu/key`: from 300 ms an
app gets `long`, then `repeat`; a long Back is the firmware's own and force-quits the app. A BUSY Bar that is powered off
(from its settings, or with an empty battery) answers nothing over its API, and the answer is `bar_off`; on a BUSY Bar a press
of one of its buttons turns it on and reaches no app, and `--power-on` does that (the mode switch at OFF is not this:
the BUSY Bar is on there and takes keys).

`settings get|set|reset` is the BUSY Bar's `/api/apps/settings`, as its web page uses it. The app: `--app <id>`, else the
project in the folder given or in the caller's folder, else (outside a project) the app that runs. `set` takes
`key=value` pairs, a field of a group as `group.field=value`; each value is read by the kind of the value it replaces
(`true`/`false`, a whole number, JSON for a geolocation, otherwise the text). The BUSY Bar takes the whole document or
refuses it with "Bad Request"; the emulated BUSY Bar writes the reason into its log, and `settings_refused` carries it.
`--restart` stops the app that runs and starts this one again, then looks at it for a second as `run` does:
`restarted`, `running`, `log`. An app reads its settings when it asks, which apps do at their start.

`typecheck` runs the project's `typecheck` script (`tsc` in the template) with the bundled npm (`npm run --silent
--no-workspaces typecheck`). It runs the project's code, so it asks for trust as `build` does and installs missing
dependencies first. No type errors: exit code 0. Errors: `typecheck_failed` with the compiler's lines and `errors`.
A project without the script: `no_typecheck`.

## The development loop

`dev [<folder>]` (`commands/dev.mjs`) is the three project commands in a row, again and again: `busy-cli build`,
`busy-cli app install --addr <the bar>`, `busy-cli app run --addr <the bar>`, each the project's own busy-cli on the
Node inside the app, then a watch on the project's files. Around 0.5 s a round for the template. It asks for trust as
`build` does, installs the dependencies when they are missing, and does not start the emulator (`not_running`).

- **Watching** (`../projects/watch.mjs`): `fs.watch`, recursive, on the project's folder. The system's notification
  only says "look": what changed is found by comparing the files (size, time, then content) with the last look, so a
  notification about nothing starts nothing, and a save through a temporary file and a rename is the change of the
  file. A round starts when nothing was saved for 150 ms (at the latest 2 s after the first save). Not watched:
  `dist/` and `screenshots/` at the top, `node_modules/` anywhere, every name that starts with `.` (`.git`, `.busy`,
  `._*`) or ends with `~`. Links are not followed.
- **One round at a time**: saves during a round make one more round after it, however many they were.
- **A step that fails** prints the tool's text and the loop goes on; nothing is installed after a failed build, so the
  BUSY Bar keeps the last version that built. Only `--once` ends with it (`tool_failed`, with `tool`, `exit_code`, `output`).
- **The app's console** (`bar-console.mjs`): the BUSY Bar's stream of events (`GET /_emu/events`, the "log" events), the
  lines written from the command's start on, those about the project's app: what it prints, the runtime's errors (a
  script that throws or does not parse), the end of its run. The end of the run a round replaces is not told. While
  `busy-cli app run` works the lines are held back, so that the round's own line always comes before what the app said.
- **Ctrl+C** stops the watching and ends with 0. The app stays on the BUSY Bar as the last round left it; `stop` stops it.
- **`--once`**: one round without watching, then a look at the app for a second. Exit code 0: the app runs, or its
  script ran to its end without an error (`running`, `exited`, `errors`, `log` and the times in the answer); 1:
  a step failed, or the app stopped at once (`app_crashed`).

For a person each event is a line: the time of day, a word (`watch`, `build`, `ready`, `failed`, `exited`, or the
console's level: `log`, `info`, `warn`, `error`, `debug`) and the text; a round that came through says how long it
took. With `--json` each event is one line of JSON on standard output, `{"event":…,"time":<ISO 8601>,…}`, and the
command's answer (`{"ok":…}`, no `event`) is the last line:

| `event` | when | fields |
|---|---|---|
| `watching` | once, before the first round (not with `--once`) | `folder`, `id`, `address` |
| `build_started` | a round begins | `cycle` (1, 2, …), `changed` (the files, relative; empty for the first round) |
| `build_failed`, `install_failed`, `run_failed` | the step failed; the round is over | `cycle`, `tool`, `exit_code`, `output` (the tool's text), `bar` (the BUSY Bar's own error lines, when it said why), `hint` (only for a failure the emulator knows the way out of: on Windows, a project whose path the system's tar.exe cannot take), `watching` |
| `installed` | the package is on the BUSY Bar | `cycle`, `id`, `ms` |
| `running` | the app was started; the round is over | `cycle`, `id`, `ms`, `build_ms`, `install_ms`, `run_ms` |
| `app_log` | the app printed (`console.log`, `.info`, `.debug`), or the BUSY Bar warns about it | `level`, `text` |
| `app_error` | `console.error`, or the runtime's error | `text` |
| `app_exited` | the app's run ended by itself or was stopped by someone else | `reason` (`finished`, `quit`, `error running main.js: …`), `crashed` |

An app that fails when it starts gives `running`, then `app_error` and `app_exited` with `crashed: true`.

`sys.followConsole`, `sys.watchProject` and `sys.onInterrupt`, when a stand-in system has them, replace the stream,
the watch and the signals.

## The emulator's projects

The emulator keeps a list of the app projects it has worked with: which app (by its id) is which folder. `create`,
`build`, `install`, `run`, `dev` and `stop` note the project they work on, the app's window too (its actions run the
same commands). The list is `projects/registry.json` in the data folder, beside the trusted folders, and gives no
rights: what may be built is the trusted folders' to say.

```
busy-emulator projects [--json]
```

lists them, the latest first. With `--json`: `projects: [{ id, name, folder, exists, unavailable, trusted, built,
installed, running, seen }]` and `bar` (`ready` or `not_running`). `installed` and `running` say whether the app is
on the emulated BUSY Bar and runs now; both are `null` when the emulator is not running. An app installed on the BUSY Bar from
an archive is in no project and is not listed.

- `projects --add <folder>` notes a project nobody has built yet. Only a trusted one: for another, `trust <folder>`
  asks the person first (`untrusted_project`).
- `projects --forget <folder>` takes a folder out of the list. Nothing on the disk or on the BUSY Bar changes.
- `projects --prune`: the app in the emulator is its project folder. For every project whose folder was deleted or
  moved away, the project leaves the list, and its app is stopped and removed from the emulated BUSY Bar when this project
  installed it: the list notes the id and a mark of the app's files after every `install`, `run` and `dev` round from
  the project, and the app goes only when the BUSY Bar still holds that same app and no other project that is still there
  has its id. Otherwise the app stays (`uninstalled: false`); `removed: [{ id, folder, uninstalled }]` says what left. The emulator's
  app does this by itself: when its window lists the projects, when it starts, and when a look at the folders every
  few seconds finds one gone. Without a running emulator `--prune` removes nothing.

A folder that is gone with its disk (an external disk unplugged, a share offline) is unavailable, not deleted:
`exists: false, unavailable: true`. `--prune` leaves it and its app alone, and it works again when the disk is back.
The disk is the place the folder's file system is mounted at, noted when the project was last worked on (on Windows:
the root of its drive or share). Nothing inside a project folder is ever deleted by any of this.

## check and submit

`check [<folder>]` answers every check of the BUSY Apps Catalog for the project and its built package
(`../readiness/`, whose README lists what is decided and what is not): **passes**, **fails** — with the catalog's own
words for the problem where this copy has them, what was found here and what to change — or **cannot be checked
here**, with why. The text names the failures first, then the catalog's warnings (it takes the app with them), then
what is unchecked, then how many pass. `--json` gives a short object an agent can read whole: `result`, `built`,
`package`, `counts`, `rules`, `firmware`, `notes` (plain lines: the one step left that is the person's, a license
nobody has chosen), and only the checks that need something: `failing`, `warnings` and `unchecked`, each with `id`,
`title`, `message` and `fix`, and `waiting`, the ids of the checks that wait for those. `--json --full` gives one object: `result` (`pass` or `fail`), `built`, `package`,
`counts` (`total`, `fail`, `warning`, `unchecked`, `not_applicable`, `pass`), `rules` (the catalog commit and date the
rules were read at, `catalog_texts`), `firmware` (the released firmware of this emulator, whose API version
`api_version` is compared with) and `checks`: `id` (the catalog's), `stage`, `title`, `blocking`, `applies`, `status`
(`pass`, `fail`, `unchecked`), `found`, `change`, `why`, `waits` (unchecked only until a failure above it, the build
or the author's texts are put right), `catalog` (`problem`, `fix`, or null). Exit code 0 when no
blocking check fails; otherwise 1 and `{"ok":false,"code":"check_failed",…}` with the same fields. It writes one file
only: `catalog.json`, the empty form for the author's texts, when the project has none (`made_details` names it; the
check of those texts then names the fields to fill; a folder it may not write to is only told the file is missing).
Otherwise it reads only: the emulator need not run, and nothing of the project is run (its scripts are parsed in a
short process of the bundled Node), so the folder need not be trusted. A project that is not built gets the answers its source
gives, and its package's checks say "Run busy-emulator build first".

`submit [<folder>]` runs the same checks and, when none fails and the project is built, writes `submission/` in the
project: `applications/<id>/manifest.yml` (the one file the catalog's pull request adds: the source from the project's
git repository, the author's texts, the screenshots' paths), `PR-DESCRIPTION.md` (the fields of the catalog's
template, no box ticked, and a "Device testing" part that says the app was built and run on the emulator, with which
firmware, and not on a physical BUSY Bar) and `SUBMIT.md` (what to make sure of first — everything committed and pushed,
the repository public, each check that could not be decided here — and the steps to the pull request). The texts the
catalog asks of the author are read from `catalog.json` in the project (`category`, `short_description`,
`description`, `changelog`; optionally `screenshots` and `back_screenshots`); when the file is not there `submit` (as
`check`) makes it, empty, says what each field takes, and fails with `check_failed`: nothing is guessed. Nor is the
license: a project without one is told that the choice is the author's, with the licenses the catalog recognizes, and
no file is written. `--catalog
<owner/repo>` (for development and tests) names another catalog repository than `busy-app/busy-apps-catalog`, the
default, in the steps. The folder is made
again at every run and ignores itself in git; a `submission/` the command did not make is left alone
(`submission_exists`). Nothing is pushed, opened or sent. `--json` adds `submission` (`folder`, `files`, `catalog`,
`origin`, `commit`, `pushed`, `to_check_by_hand`) and `made_details`.

## catalog-texts and publish

`catalog-texts [get|set] [<folder>]` reads or writes the four texts the catalog asks of the author, in `catalog.json`
(`--category`, `--short-description`, `--description`, `--changelog`; give a text that starts with "-" as
`--description=<text>`), and the app's name in its manifest (`--name`; a name the catalog would not take is refused,
`bad_name`; `name` and `name_problem` in the answer). Each is checked by `../readiness/texts.mjs`, the same rules as `check` applies and the
window's form loads: `--json` gives `texts`, `taken` (the catalog takes all four), `problems` and `warnings` by field
(null when taken), and `rules` (the categories and the lengths). A text the catalog would refuse is written all the
same. Every other field of `catalog.json` is kept.

`publish <step> [<folder>]` is stage 1 of publishing an app (`../publish/`): on this computer, nothing sent, the
public repository on GitHub and the pull request left to stage 2, which is not there yet. The window's Publish dialog
is the same steps.

- `status`: where each step stands (`steps`: `check`, `texts`, `screenshots`, `readme`, `license`, `files`, `package`,
  each `done` or `todo`), and what the window shows of each; `by_hand` is the steps to the pull request by hand.
- `check`: the catalog's checks, grouped: `fails` (each with `step`, the step that puts it right, and `todo`),
  `warnings`, `stage2` (the checks of the source on GitHub, and those that fail only because a file is not committed
  yet), `unchecked`; `passed` is true when nothing fails.
- `license --license MIT|Apache-2.0|GPL-3.0|other [--author <name>] [--year <n>]`: writes LICENSE, the standard text
  with the name and the year (the name defaults to git's `user.name`, else the app's author). The license is never
  chosen for the author, and a license file that is there is kept. The catalog's check flags the GPL 3.0 text itself
  (its word "noncommercially"): a moderator reads it then.
- `files [--write] [--keep-out <path>] [--keep-in <path>] [--readme replace]`: what `git add -A` would publish under
  the project's .gitignore (`published`, each with why; `left`), the lines .gitignore lacks (`node_modules/`, `dist/`,
  `.busy/`, `submission/` and the systems' own files), and `findings`: what looks like a secret or personal data
  (keys and tokens of the known services, values given to keys named like secrets, `.env` and key files, paths of a
  home folder), by file, kind and line, never by value. `--write` adds the lines, the paths given with `--keep-out`,
  and makes `README.md` again as `readme` made it, with the project as it is now; a README the author wrote (or changed
  after the flow made it) is kept unless `--readme replace`. `--keep-in` takes back a line the flow added; a file
  kept in on purpose is marked `kept_in` and does not hold `ready` back.
- `readme [get|set|preview] [--mode fields|markdown] [--title <text>] [--intro <text>] [--usage <text>] [--markdown
  <text>]`: the public repository's README (`../publish/readme.mjs`). From the fields: the title, a paragraph (from
  the description), the screenshots, How to use (the author's own words; required), the settings of `settings.json`,
  how to build it, the license. Or the author's own Markdown (`--mode markdown`; a README of their own opens so). The
  template's README is never kept: what is left of it (`left`: its opening line, its text about the keys, its
  sections for developers) holds the step back. `get` answers `config`, `facts`, `markdown`, `problem`, `state` and
  `ready`; `preview` the same with the options given, writing nothing; `set` writes README.md (`readme_incomplete`
  while `problem` is not null).
- `screenshots [--take front|back] [--upload <files>] [--order <json>] [--remove <path>]`: the screenshots in the
  catalog's order, each with its picture and what the catalog says of it; `--take` saves what the BUSY Bar's display shows
  now (with an enlarged copy for the README), `--upload` brings in PNGs made before (a JSON list of paths, or paths
  joined as in PATH): 72×16 is a front one, 160×80 a back one, and an exact enlargement of either is made small again
  pixel for pixel; each is written as the next `front-<n>.png` or `back-<n>.png` with its `@8x` copy (`uploaded`;
  `refused` says why a file was not taken; `not_screenshots` when none was), `--order '{"front": [...], "back": [...]}'` writes the order into `catalog.json` (the first
  front one is the cover), `--remove` moves one, with its enlarged copy, into `.busy/removed/`.
- `package`: the checks, then `submission/`, as `submit` writes it, but without a repository on GitHub: the
  manifest's `origin` and `commit_sha` are marked "Filled in Stage 2", and `SUBMIT.md` holds the steps by hand.
  Fails with `check_failed` (the groups of `check`) or `not_built`.
- `prepare --license <id> [--author <name>]`: license, files, build and package in one go, for an agent.

Stage 2 is done by the emulator's app through the GitHub CLI inside it, which holds the person's GitHub token
(`packages/app/src/github/`); the command asks the app through the server's management address (`POST /_emu/github`,
with the server's key, never from a page) and fails with `not_running` or `github_unavailable` without it:

- `signin`: when GitHub CLI on this computer is signed in, `choose_account` (with `existing`, its login): the person
  chooses. `signin --use-existing` publishes with that account as it is (`gh api user` must answer for it);
  `signin --new-account` (or `signin` when GitHub CLI has none) prints a code to enter on github.com/login/device on
  stderr and waits up to 16 minutes; the account is added to GitHub CLI on this computer, which goes on using the
  account it used before (the app's calls go as the new one, each with its own token).
  `not_configured` in a build without gh.
- `signout`: forgets the sign-in in the app; GitHub CLI's accounts are left as they are (the window offers to sign it
  out or switch it back). The answer's `revokePage` is GitHub's page where the person revokes GitHub CLI's access.
- `push [--name <repository>]`: the app asks the person in its own dialog, then publishes the files of `files` to
  their public repository in one commit, reads it back and notes it (`pushed`). `.github/workflows/` is left out.
- `pr --ai none|partly|full [--catalog <owner/name>]`: the pull request goes to `busy-app/busy-apps-catalog`; `--catalog`
  is for development and tests (a catalog that is not BUSY's needs the person's second confirmation). The app asks the
  person in its own dialog, which shows the
  catalog's author checklist as its pull request template has it (read then, or the copy bundled with the app), and
  where they tick that every item is true (nothing ticks it for them); then it opens the pull request with the
  checklist ticked and notes it (`requested`). `not_ticked` when they do not tick it.
- `pushed --owner --repo --commit` and `requested --pr --catalog`: what the app notes in the project after those; not
  for people. They write only the project's files: what the app may replace or send is decided by its own record in
  its data folder (`github/published.json`), never by the project's `.busy/publish.json`.

What the flow notes (the steps done, the license chosen, the README it made, the repository and the request) is in
`.busy/publish.json` of the project; `.busy/` has a `.gitignore` of its own that keeps it out of git.

## The MCP server

`busy-emulator mcp` (`mcp/`, ADR-0010) is the entry for chat clients that cannot run commands: the client starts it
and speaks the Model Context Protocol on its stdin and stdout, one JSON-RPC 2.0 message per line; the log goes to
stderr, and whatever else in the process would write to stdout goes there too. It ends when stdin ends, after it has
answered what it was asked. No SDK: `mcp/protocol.mjs` is the protocol, written to the specification, both eras of it:
2025-11-25 with the `initialize` handshake (and 2025-06-18, 2025-03-26, 2024-11-05 when the client asks for one of
them; any other version is answered with 2025-11-25), and 2026-07-28, where every request names its version in
`_meta["io.modelcontextprotocol/protocolVersion"]`, `server/discover` answers and every result says `resultType:
"complete"`. Before `initialize`, a request without that `_meta` gets only `ping` and `server/discover`; others are
`-32600`. A canceled request (`notifications/cancelled`) gets no answer, and its tool is stopped as at its timeout (below). Batches
are refused. JSON-RPC's errors: `-32700` for a line that is no JSON, `-32600` for a message that is no request,
`-32601` for an unknown method, `-32602` for params of the wrong shape and an unknown tool, `-32002` for an unknown
resource, `-32022` for a modern version it does not have.

Each tool is a command (`mcp/tools.mjs`): the tool's arguments are checked against its input schema (a wrong one is
the tool's answer `usage`, `isError`), become the command's words, and `main()` runs them in this process with
`--json`, so the parsing, the checks, the codes and the hints are the command line's. `main()` gives the answer to its
`answer` callback; the tool's result is that answer as `structuredContent`, the command's text (with the JSON after it
when that is under 8000 characters) as text, and `isError` for a failure. `screenshot` adds the PNG as an image
block: the enlarged copy (8 times for the front, 4 for the back, unless `scale` says; 1 is the exact frame). The tools
that change something run one at a time; `status`, `list_examples`, `projects`, `logs`, `screenshot` and
`settings_get` run at once, beside them, so that a long build does not hold them up. Every tool has a time (`timeout`
in `mcp/tools.mjs`: half a minute to a minute for those that read, 15 minutes for `build`, `refresh` and `typecheck`,
20 for `create_app`): past it, or when its request is canceled, every program its command started is killed with
whatever that one started in turn (its own process group on macOS and Linux, `taskkill /T /F /PID` of our child on
Windows; `projects/node-tools.mjs`), the answer is `tool_timeout`, and the next tool starts once the command has
ended or after 5 s. The commands get a stand-in of the caller's folder that is no project, the data folder: a client
starts the server in any folder, and a project there must not be acted on.

| Tool | Command |
|---|---|
| `status`, `start`, `logs`, `press`, `check`, `submit`, `build`, `run`, `stop`, `typecheck` | the same name |
| `create_app`, `list_examples` | `create <folder>`, `create --examples` |
| `refresh` | `dev <folder> --once` |
| `screenshot` | `screenshot [--back] [--scale <n>] --out <folder>/` |
| `settings_get`, `settings_set` | `settings get`, `settings set <key>=<value> … [--restart]` |
| `restart_bar` (destructive: the running app stops) | `restart-bar` |
| (none) | `allow-local [<port>] [--remove <port>]`: the person's step only; the command refuses with `person_only` when the MCP server calls it |
| `projects` | none: the list in `projects/trusted.json`, read only |

The server grants nothing the command line does not, and takes less:

- A tool that takes a project folder takes an absolute path of one the emulator knows (`projects/trusted.json`):
  created by `create` or trusted by the person, at its place. Any other is refused before the command runs with the
  command line's `untrusted_project` (`requireTrust`), also for `check`, `submit`, `settings` and `screenshot`, which
  on the command line take any folder; the answer adds `mcp_hint`, the command the person runs. `create_app` takes a
  new or empty folder, as `create` does.
- No tool trusts a folder, and none asks the person to (`trust` has no tool): the person runs `trust` themselves.
- No tool reads or writes a file it does not name: screenshots go to the project's `screenshots/` or to
  `mcp/screenshots/` in the data folder. No tool runs a program or a shell command it is given.
- No tool lets an app reach this computer (`allow-local` has no tool, and refuses `ctx.mcp`): a model steered by what
  it reads could otherwise have an app read the person's local services and scan their ports. A port the person
  allowed is reachable by the apps a model runs too; that is the person's decision.
- `settings get` and `settings set` hide the values of string fields marked `sensitive` in the app's schema (read
  from the BUSY Bar, `/api/storage/read`) as `(hidden)` when the MCP server calls them (`ctx.mcp`); with the schema
  unreadable, every text value. A person in a terminal sees them: they can read the BUSY Bar's settings file anyway.

Resources: `busy-emulator://guide/start` (`mcp/resources.mjs`, the steps with the tools) and
`busy-emulator://guide/project`, the section `create` writes into a project's `AGENTS.md`. How a person adds the
server to a client: `public-docs/mcp.md`. Tests: `test/mcp-protocol.test.mjs` (the session without a process) and
`emulator/test/server/mcp.test.mjs` (the process, against a server it starts, with a project from the real generator).

## Adding a command

One file in `commands/`, found by the folder's listing. A command's own options are named in `options` — a flag
(`"--back": { key: "back" }`) or one with a value (`"--out": { key: "out", value: "<path>" }`, given as `--out x` or
`--out=x`) — and come to `run` as `options`. An option given twice, a flag with a value, a value missing, or a value
that starts with `-` and is not given after `=` is a wrong call (`usage`), told before the command runs:

```js
export default {
  name: "build",
  summary: "Build the project in this folder",
  usage: "build",
  maxArguments: 0,
  options: { "--release": { key: "release" } },
  async run(ctx, sys, { args, options, commands }) {
    const { status } = await ensureRunning(ctx, sys); // from ../lifecycle.mjs, when the command needs the emulator; no window comes forward
    return { data: { … }, text: "…" };                // or throw new CliError(code, message, hint)
  },
};
```

`ctx` (`context.mjs`) says where things are; `sys` (`system.mjs`) is everything that touches the system, replaced in
the tests (`test/commands.test.mjs`). A command that goes on printing before its answer (`logs --follow`) gets
`print(line)` beside `progress`.

## Development and tests

From the source folder the command line runs as `node emulator/packages/server/cli/busy-emulator.mjs …`; it has no
app around it, so `start` answers `no_app`. Outside a release (no `build.json` beside the resources, or one that says
`test`) it also reads `BUSY_EMULATOR_DATA` (the data folder) and `BUSY_EMULATOR_TEST_LAUNCH` (a JSON array: the
program a test starts instead of going through the system, which would put a window on the screen). A release reads
only `BUSY_EMULATOR_CLI_PATH`, which its launchers set to say how it was called, and prints it (the desktop app sets
it to `busy-emulator` for its own runs and says the hints in the window's words).

```
node --test "emulator/packages/server/cli/test/*.test.mjs"
```

`test/screenshot.test.mjs` runs `screenshot` against a stand-in of the system; `emulator/test/server/screenshot.test.mjs`
runs the command line itself against a server it starts (`npm run test:server`), with a stand-in mirror in a data
folder of its own. `allow-local` has the same two: `test/allow-local.test.mjs` and
`emulator/test/server/allow-local.test.mjs`, where an app on the BUSY Bar reaches a service of the test's once the command
allowed its port. `run` and `logs` the same way: `test/run-logs.test.mjs` and `emulator/test/server/run-logs.test.mjs`,
whose apps are real scripts on the emulated BUSY Bar (one that runs, one that throws, one that ends). The removal of
AppleDouble files is seen only with the temporary folder on exFAT or FAT
(`TMPDIR=/Volumes/<exFAT disk>/<folder>` on macOS); elsewhere there are none to remove.

`test/sandbox.test.mjs` runs the command line inside `sandbox-exec` on macOS. The tests run with the server's under
`npm run test:unit` and listen on the last two ports of `EMU_TEST_PORTS` (8719 and 8718 unless set); the server's
tests take its first free ones. Programs are started through `packages/engine/programs.mjs` or by an absolute path
(`/bin/ps`, `/usr/bin/open`; on Windows Explorer and PowerShell under the Windows folder the `.exe` launcher reads
from the system and hands over as `BUSY_EMULATOR_WINDOWS_DIR`), never by a bare name.
