# legacy-window

The device window: the page at `/emulator` that the server serves and the app shows in its main window. `index.html`,
`window.js` and `window.css` are the window itself (layout, controls, the app panel); `welcome.js` is the first run's
greeting (below); `create-app.js` is Create app's pop-up and `publish.js` the publishing flow. `actions.js` is the other half:
what the window can do to app projects. This file is the contract between the two; change it here first.

`title-bar.js` is the window's own title bar outside macOS: the app menu's menus, drawn from the shell's application
menu through the bridge's `menu.get` and run by `menu.run` (`packages/app/src/title-bar.mjs`); it calls the bridge itself,
not through `window.emulatorActions`, and does nothing on macOS or in a plain browser.

## `window.emulatorActions`

A global, provided by `actions.js` (loaded by `index.html` before `window.js`). It has no elements and no styling: the
page decides where a button is and what it shows.

The work is done by the app's main process, which runs the same code as the command line `busy-emulator`
(`packages/app/src/actions.mjs`). The page reaches it through the shell's bridge, which the app gives to its main
window only. In a plain browser there is no bridge.

- `available()` → `{ shell: boolean }`. True only in the app's main window. In a plain browser it is false, and every
  action below rejects with an `Error` whose `message` says so (`code: "no_shell"`).
- `projects.list()` → `Promise<[{ id, name, folder, shownFolder, exists, unavailable, trusted, built, installed, running, dependencies, job }]>`.
  The app projects the emulator has worked with, the latest first. `folder` is the project's folder (a full path),
  `shownFolder` the same from `~` on macOS. `dependencies`: `{ state, reason, message, retry }`, `state` one of
  `installed`, `missing` (never installed: a clone), `installing`, `failed` and `interrupted` (an install was cut off);
  for the last two `reason` says why in a few words ("no network", "no answer from the npm registry") and `retry`
  whether it is the network's, which `retryDependencies()` tries again.
  `installed` and `running`: its app is on the emulated BUSY Bar, and runs now. `job`: the kind of the job that runs on
  it now, or `null`. An app on the BUSY Bar whose id is in no project was installed from an archive: it has no project.
- `projects.examples()` → `Promise<[{ name, summary, title, icon, front }]>`. The example apps a new project can start
  from; `icon` (8×8) and `front` (a frame of its front display, 72×16) are PNGs as `data:` addresses, or `null`.
- `projects.create({ example })` → opens the system's folder dialog, where the person chooses or makes an empty folder
  anywhere on the disk; the project is created in that folder (the same code as `busy-emulator create`), from the
  example named or from the official template when `example` is `null`. Resolves to the project (an entry as in
  `list()`), or `null` when the person closed the dialog. Takes a while: it goes to the npm registry.
- `projects.create({ example, place: { parent, folder }, name?, id?, texts?, icon? })` → Create app's form: no dialog;
  the project is made in `parent/folder`, where `parent` is the default place (`~/BUSY Bar projects`) or one the
  person chose with `choosePlace`, never another, and `folder` a plain name (Latin letters, digits, spaces, `.`, `_`,
  `-`; the next free `folder-2` when it is taken). `name` and `id` go to `create --name --id`; `texts`
  (`{ category, short_description }`) to `catalog-texts set`, the short description to the manifest's description
  too; `icon` is `{ text, color }` (letters, `icon --text`) or `{ front?, back? }`, PNGs of 8×8 and 11×11 as `data:`
  addresses (`icon --from --back`; without `back` it is made from the front, without `front` the default one that
  create gave the project stays), checked for their size before anything runs. Without `icon` the project keeps the
  default icon `create` gives every project without icons of its own. A step after create that fails leaves the project, which resolves with `unfinished: [messages]`. Without the
  network the project is created all the same, without its dependencies: it resolves with `dependencies.state`
  `failed`, and its row says why and offers Retry.
- `projects.place({ parent, folder })` → `Promise<{ parent, shown, folder, path, shownPath, namespace }>`. Where Create
  app would make the folder now: `parent` `null` is the default place; `folder` the name asked for or the next free one;
  `shown` and `shownPath` from `~` on macOS; `namespace` the id's part the author gives (git's `user.name` read from the
  person's git settings, else the account's name). Reads only: no click needed. A `parent` the person did not choose is
  refused.
- `projects.choosePlace({ from })` → the system's folder dialog (a new folder can be made in it) for the place of the
  new project's folder. It opens at `from` when that is a place, or at the folder the place goes in when the place is
  not made yet (the default one before the first app); `{ parent, shown }`, or `null` when the person closed it. The place is remembered until the app
  quits, for `place` and `create`.
- `projects.open()` → opens the system's folder dialog to choose an existing project folder. A folder the emulator
  did not create (a clone, a project made by hand) goes through the app's trust dialog, once. Resolves to the
  project, or `null` when the person closed the dialog or chose "Don't Trust".
- `projects.find({ pick })` → Create app's Open existing: the system's dialog for the app's folder or any file in it
  (`pick` `"any"`; macOS takes a folder or a file in one dialog, elsewhere `"any"` is a folder and the page offers
  `"folder"` and `"file"` as two buttons). The desktop app walks up from the choice to the nearest project of BUSY's
  tools (a `package.json` that names `@busy-app/cli`), never to the home folder or above it, never into
  `node_modules`, and refuses a `package.json` or manifest that is a link out of its folder. Opens nothing: resolves
  to `{ found: true, folder, shownFolder, id, name, listed, trusted, chosen, shownChosen }`, or `{ found: false,
  message, chosen, shownChosen }`, or `null` when the person closed the dialog.
- `projects.import(folder)` → Open existing's Open: only a folder `find` found. As `open`: the trust dialog for a folder
  the emulator does not trust yet, then the list; then one Refresh (build, install, start), its answer in
  `refreshed`. `null` after "Don't Trust".
- `projects.refresh(folder)` → `Promise<{ ok, code?, message?, hint? }>`. The one action after the person changed the
  project's files: build, install, start again (one round of `busy-emulator dev --once`). When the build fails,
  `ok` is false, `message` is the build's error, and the version on the BUSY Bar goes on running.
- `projects.dependencies(folder)` → `Promise<{ ok, code?, message?, hint? }>`. Retry for a project created without the
  network: its dependencies installed when they are needed (`busy-emulator build --dependencies-only`). When a Refresh
  had stopped at them, that Refresh follows (build, install, start); a project only created is not started.
- `projects.retryDependencies()` → `Promise<{ started: [folders] }>`. The same (the Refresh that followed included), by itself and without a click, for every
  project whose install failed for the network or was cut off, each no more often than every 20 s: the window calls it
  when the network may be back (it came online, the window got the focus, every 30 s while such a row is there).
  No click needed.
- `projects.build(folder)`, `projects.run(folder)`, `projects.stop(folder)` → `Promise<{ ok, code?, message?, hint? }>`.
  The single steps; `run` installs the built package and starts it; `stop` stops the app, not the emulator.
- `projects.dev.start(folder)`, `projects.dev.stop(folder)` → `Promise<{ ok, code?, message?, hint? }>`. The watch
  loop: refresh on every save. It goes on until it is stopped, the window closes or the app quits.
- `projects.check(folder)` → `Promise<{ ok, checks: [{ id, title, answer: "passes"|"fails"|"unchecked", message, blocking }], built, code?, message?, hint? }>`.
  What the catalog's checks say. `ok` is false when a blocking check fails; a failing check with `blocking: false`
  is a warning. `built: false`: the checks of the package wait for a build. A project without `catalog.json` gets the
  empty form at the first check (the command line's `check` makes it), and the failing check names the fields to fill.
- `projects.submit(folder)` → `Promise<{ ok, folder?, message?, code?, hint? }>`. Checks, then writes `submission/`
  into the project (`folder` is that folder). It pushes nothing and sends nothing.
- `apps.delete({ id, withFiles })` → `Promise<{ ok, id, trashed, kept, message } | { ok: false, code, message, hint? }>`.
  Delete in the Apps list's menu: the app is stopped, taken off the emulated BUSY Bar and its projects leave the list
  (`busy-emulator uninstall <id>`); the folders stay (`kept`). With `withFiles: true` the app's one project folder goes
  to the Trash (the Recycle Bin on Windows) by the system's own call (`trashed`): only a folder of the emulator's list,
  by its real path, never a link to another place, the home folder, the root of a disk or the data folder.
- `publish.status(folder)` → `Promise<{ ok, steps, name, id, version, check, texts, screenshots, readme, license, files, package, by_hand, catalog }>`.
  Where each step of publishing (stage 1) stands for the project: `busy-emulator publish status --json`. It only
  reads, so it needs no click.
- `publish.check(folder)` → the catalog's checks grouped for stage 1 (`publish check`): `passed`, `built`, `fails`,
  `warnings` (each `{ id, title, found, step, todo }`: `step` names the step of the flow that puts it right), `stage2`
  (what the repository on GitHub passes), `unchecked` (`{ id, title, why }`), `passes`, `total`.
- `publish.texts({ folder, name?, texts })` → writes the app's name into its manifest and the catalog's four texts
  into catalog.json (`catalog-texts set`) and answers `{ ok, name, name_problem, texts, taken, problems, warnings,
  rules }`.
- `publish.screenshots({ folder, take?: "front"|"back", upload?: true, order?: { front, back }, remove?: path })` →
  takes one from the BUSY Bar (with an enlarged copy for the README), brings in PNGs the person chooses in the system's
  dialog (`upload`: 72×16 or 160×80, or an exact enlargement, made small again; `uploaded`, and `refused` with why;
  null when they chose none), writes the order into catalog.json, or moves one into `.busy/removed/`; answers the
  lists with each picture as a `data:` address and what the catalog says of it.
- `publish.readme({ folder, readme: { mode: "fields"|"markdown", title, intro, usage, markdown } })` → writes
  README.md from the README step (`publish readme set`); refused while How to use is empty or the template's text is
  in it.
- `publish.license({ folder, license: "MIT"|"Apache-2.0"|"GPL-3.0"|"other", author })` → writes LICENSE with the name
  and the year; never over a license file that is there.
- `publish.files({ folder, write?, keepOut?, keepIn?, readme?: "replace" })` → what the public repository will hold
  (`published`, `left`), what looks like a secret (`findings`), and with `write` the README and the lines of
  .gitignore made.
- `publish.package(folder, { build })` → the checks, then `submission/` (`publish package`); the project must be built
  first (`projects.build`), or `build: true` builds it first in the same action (Build and package); a failed build
  answers with `step: "build"`.
- `reveal(path)` → `Promise<boolean>`. Show in Finder or Explorer: a project's folder, something inside one, or
  inside the emulator's data folder. A folder is opened, its files in view; a file is selected in its folder.
  Anything else is `false`.
- `open(path)` → `Promise<boolean>`. Opens a `.json`, `.md` or `.txt` file of a project of the list in the system's
  app for it (src/appmeta/manifest.json, settings.json). Anything else is `false`.
- `copy(text)` → `Promise<boolean>`. Puts a text on the clipboard. At most 64 KiB; a longer text is `false`.
- `capture.screenshot({ folder, name, displays })` → `Promise<{ ok, saved: [{ display, file, relative?, width, height }], folder?, message, code?, hint? }>`.
  The top bar's Screenshot module: what the ticked displays show now; `displays` is `["front"]`, `["back"]` or both
  (both when left out; anything else is `bad_displays`). `folder` is the running app's project (as in `list()`): the
  files go into its `screenshots/` as `front-<n>.png` (72×16) and `back-<n>.png` (160×80), the next number not taken,
  each with an enlarged copy `<name>@8x.png`: the files Publish takes. `folder: null` (an app with no project): the
  system's Save dialog asks where the first picture goes, and the back display's goes beside the front's (`… back.png`,
  never over a file); `saved` is empty when the person closed it. A folder that is no project of the list is refused
  (`unknown_project`).
- `capture.record.start({ folder, name, layout })` → `Promise<{ ok, layout, startedAt, maxSeconds, code?, message? }>`.
  The choice in the Record button's menu: `layout` is `window` (the app's window as the person sees it, at most
  1920×1080), `post` (1080×1920, the BUSY Bar and its back display) or `front` (the front display, 1080×240), as `busy-emulator
  record --layout` records them (H.264 MP4 with a silent AAC track), at most `maxSeconds` (120); then it stops by
  itself. Resolves once the take has begun. One recording at a time (`busy`); another layout is `bad_layout`.
- `capture.record.stop()` → `Promise<{ ok, file, name?, seconds, limit? }>`. The second press: stops, and the system's
  Save dialog asks where the video goes (the project's `media/`, or Movies or Videos); `file` is `null` when the
  person chose Cancel, and the take is deleted.
- `capture.record.state()` → `Promise<{ recording, saving, layout, startedAt, maxSeconds }>`. Needs no click.
- `capture.reveal(file)` → `Promise<boolean>`. Shows in Finder or Explorer a file these tools saved; any other is
  `false`.
- `on("capture", cb)` → what a recording does by itself: `cb({ kind: "recording", state: "recording"|"saving"|"saved"|"discarded"|"failed", reason?, file?, name?, limit?, message? })`;
  `reason: "limit"` when it stopped at its longest.
- `terminalInfo()` → `Promise<{ available, name, label, why }>`. Whether the console can be opened in the system's
  terminal: `name` is `"Terminal"` on macOS and `"cmd"` on Windows, `label` the button's words ("Open in Terminal",
  "Open in cmd"); `available` is false, with `why`, when the app has no `busy-emulator` launcher (a run from the
  source folder, a test variant without one). Reads only: no click needed.
- `openTerminal({ app, folder, kinds, since })` → `Promise<{ opened }>`. Opens the system's terminal (Terminal.app;
  a new `cmd.exe` window) running `busy-emulator logs --follow` with the console's state: `app` an app's id or `null`
  for every app's lines (`--app`/`--all`), `kinds` some of `"console"`, `"lifecycle"`, `"build"`, `"system"`
  (`--kind`), `since` the moment of the last Clear in Unix ms or `null` (`--since`), and `folder` the chosen project's
  folder to start in, or `null` for the home. Its first line says whose lines, which kinds and from when; after
  Ctrl+C the terminal stays there, with `busy-emulator` on its PATH. Refused (it rejects) with `unknown_app` (an id
  that is neither a project's nor on the BUSY Bar), `unknown_project`, `folder_unavailable`, `bad_request` (a kind not of
  the four, a `since` that is not a whole number, a key it does not know) or `no_cli`. The command is built by the
  app from these checked parts and its own launcher's full path; nothing the page sends is written into a shell as
  text (`packages/app/src/terminal.mjs`).
- `welcome.get()` → `Promise<{ show, way, platform, cli }>`. The first run's greeting (EMU-207): `show` is true until
  the person has answered it; `way` is the way they chose last time (`code`, `agent`) or `null`; `platform` is the system the app runs on (`darwin`, `win32`); `cli` is the command line's
  path for the text for agents, from the pointer file `install.json` (on macOS from `~` when it lies in the home
  folder), or `null` in a run from the source folder.
- `welcome.seen({ way }?)` → `Promise<boolean>`. Writes down, in the app's settings in its data folder
  (`app-settings.json`, never in a project), that the greeting was answered: it does not come by itself again. `way`,
  `code` or `agent`, is kept too (`welcomeWay`); anything else is not written.
- `report.preview(fields)` → `Promise<{ title, body, length, limit, fits, over, lines: { shown, of }, repository }>`.
  Report a Bug (EMU-277, `report-bug.js`): the new issue's text exactly as `report.open` would open it, scrubbed by
  the app (home folder, user and computer names, tokens and passwords, Wi-Fi names, serials, MAC and e-mail
  addresses: `packages/app/src/scrub.mjs`). `fields` is `{ title, what, expected, log, screenshot }`; `log` false
  leaves the log's lines out. The log's newest lines are taken while the address fits (2000 characters on Windows,
  8000 elsewhere); the text then says the whole log is in the diagnostics archive. `fits` false: what the person wrote
  is `over` characters too long.
- `report.open(fields)` → `Promise<{ opened, url, screenshot, lines }>`. Opens that text in GitHub's new issue form
  of `busy-app/busybar-emulator` in the browser; the person sends it there. With `screenshot` and `image` (the BUSY Bar's
  screenshot as a PNG `data:` address) the picture is put on the clipboard, to paste. Rejects with `too_long`.
- `report.save(fields)` → `Promise<{ saved, file, shown, files }>`. Save diagnostics: the system's Save dialog, then a
  .zip with `report.md`, `about.json`, the logs and the run state of the data folder, and `screenshot.png` when ticked,
  all scrubbed the same way. `{ saved: false }` when the dialog was closed. `report.reveal()` shows that archive in
  Finder or Explorer.
- `on("menu", cb)` → the app menu's items for the page: `cb("create")` when the person chose New App…, which opens
  Create app's pop-up as its button does. Without the device window the menu opens the folder dialog instead.
  `cb("report")` when they chose Help, Report a Bug…: the page opens its dialog (`window.openReportBug()`).
- `on("job", cb)` → progress. `cb({ id, kind, folder, state: "running"|"done"|"failed", line? })`. Every action that
  takes time reports through it: `kind` is `create`, `open`, `refresh`, `dependencies`, `build`, `run`, `stop`, `dev`,
  `check`, `submit` or `publish`; `line` is one line for a log. Two more kinds tell that the list changed by itself, each once with
  `state: "done"`: `removed` (a project's folder was deleted, see below) and `changed` (a folder's disk went or came
  back). After a job ends, call `projects.list()` again. `on` returns a function that takes the listener away.

"Create app" (the Apps section, the empty list, the first run's "I'll write the code") opens `create-app.js`: a dialog
in the middle of the dimmed window, as tall as what it holds, with four ways to start as one row of tabs under its
title and a line under them that says what the chosen one offers. Templates: the official template and the examples,
each a card with its icon, a line and a frame of its front display; one is chosen, then its name (the id made from it
is shown, and written by hand under Advanced) and Location. Empty app: the name, the id, the short description, the
category and Location, then the icons: the icon block (below), the default icon unless something is uploaded. Open existing: Choose (on Windows and Linux
Choose Folder and Choose File) takes the project's folder or any file in it, the pop-up shows the project found
around it (name, id, folder) or says that none is there, and Open opens it as Open App Folder does, the trust dialog
included, then starts it. Import from GitHub: the account the repository is read as (GitHub CLI's
accounts to choose from, or a sign-in by a code), the repository (its address or owner/name; another host's address is
refused) with what it is, and Location; Import downloads its default branch through the app's GitHub CLI into a new
folder there (`github.import`), then opens it as Open existing does. The fields are checked as they are typed, by the catalog's own rules (`rules.mjs` and
`texts.mjs` from `/emulator/readiness/`); Create is not there to be pressed until they pass and says why in its
tooltip. Escape, the cross and Cancel close it; Tab stays inside it; the arrow keys move between the tabs. The new
app is listed and chosen; what a step after create could not do is said in the list.

The icon block, `icon-block.js` (`window.emulatorIconBlock`), is the app's two icons in Create app and in Publish's
Application Info: Front and Back side by side, each its picture enlarged and pixel-crisp, its requirements as a short
list and its own Upload. The rules and the conversion are the command line's, `capture/icon-rules.mjs`, served at
`/emulator/capture/icon-rules.mjs`: an upload is checked as `create --icon` and `icon` check a picture; a requirement
it breaks turns red in the list with the next step, and when the conversion mends it, one button converts it and
shows the result. What the block hands over is always a PNG drawn at the icon's size; an upload that breaks a rule is
never used.

"Publish" (top right) and Publish… (in the opened app's More) open the publishing flow, `publish.js`: a dialog of steps
over the window, for the chosen project, gone through in order. Prepare: Catalog texts (the name too), Screenshots
(taken from the BUSY Bar or uploaded), README, License, Repository files, Pre-flight check, Build and package; Publish:
Publish to GitHub, Send to catalog. Pre-flight check builds the app and checks its types before the catalog's checks
(`publish check`); it and Build and package record a fingerprint of the files that get published or built
(`publish/fingerprint.mjs`). Next from the check on, opening a later step, coming back to the window, Publish to
GitHub and Send to catalog compare it with the project (`publish status`): when a file changed, the flow goes back to
the step that no longer holds, which says "Changed since the check" (or the package), and the check runs again
(stale-check). The shell compares again, and the very bytes it uploads, before it sends anything (`publish verify`).

Record's first press opens the menu of what to record (Window, Post, Front display; the record-menu section of
window.js, positioned under the button); `RECORD_BUTTON` turns it off in one place.

The controls are flat vectors of the BUSY Bar's top from the owner's drawing (Figma `H5dJXvQa1JVhjRHXi9VLEW`, node
`6904:623`): the shapes are files of `controls/`, used as CSS masks so that their grays are the style sheet's. The
mode switch is a key-shaped knob (`#lever`) whose tip points at the position the BUSY Bar is at, the five named on an arc
round its pivot, 20° apart (a click on a name, a drag round the knob, the arrows); Start / Pause is a trapezoid with
the two RGB LEDs (`#led-left`, `#led-right`) along its slanted sides; Back a small round key; the wheel a large
circle with a dot that turns a detent a click and small ticks round it, OK in its middle.

The RGB LEDs follow the event `lights` of `/_emu/events`, `{ preset, color, brightness }`: `preset` is the firmware's
status-lights preset, one of `off`, `static`, `fade`, `rainbow`, `blink`, `notification`; `color` is `"#rrggbb"`;
`brightness` 0 to 1 (a notification is at full brightness). Until it comes they are off. The emulator does not send
it yet: its firmware build takes the status lights' calls and only logs their color.

## The rules behind it

- Only the page of the app's main window may ask: not the local web's window, not a frame, not a page in a browser.
- The page names no folder to work on. A new or opened folder is chosen by the person in the system's dialog. The
  `folder` an action takes is only looked up in the emulator's list of projects: one that is not there is refused
  (`unknown_project`), and so is one that is not trusted (`untrusted_project`).
- Trust comes from the app's trust dialog alone.
- One job for a project at a time: a second one is refused with `busy`.
- Only the person starts work: everything but reading the list, the examples and `publish.status` needs their click or
  key in the window just before (`no_gesture`). A script alone builds nothing, runs nothing and puts nothing on the
  clipboard.
- The app in the emulator is its project folder. When the folder is deleted or moved away, the project leaves the
  list. Its app is stopped and removed from the BUSY Bar only when this project installed it and the BUSY Bar still holds what
  the project put there (a later install from an archive or another project under the same id stays); the app looks at the folders when the page lists them, when
  the emulator starts and every few seconds. When the folder's disk is not there (an external disk unplugged, a share
  offline), nothing is removed: the project stays with `exists: false, unavailable: true`, its actions are refused
  with `folder_unavailable`, and it works again when the disk is back. Nothing inside a project folder is deleted.

The command line has the list too: `busy-emulator projects [--json]` (`packages/server/cli/README.md`).

## The first run's greeting (`welcome.js`)

With no project yet and the greeting never answered (`welcome.get()`), the window asks "How will you make your app?"
in a card over the window, which waits behind it (inert, and no key reaches the BUSY Bar; Escape closes the card).

- "I'll write the code" is the window's own Create app (`emulatorWindow.createApp`, from `window.js`): the examples,
  then the system's folder dialog. The app it creates gets three steps at the top of its section (edit `src/main.ts`,
  with Show in Finder/Explorer, which opens the project's folder; Refresh; Publish) until the person hides them: `window.js` tells `welcome.js` of the app (`emulatorWelcome.created`)
  and asks it for the steps (`emulatorWelcome.hintFor`).
- "My AI agent will" shows a text to paste into an agent that runs commands, built by `emulatorWelcome.agentText`
  for the system the app runs on (macOS: the path as a word of the shell; Windows: the path with forward slashes and
  no quotes, which runs in PowerShell, Git Bash and cmd alike, or, when it needs quotes, PowerShell's `& '<path>'`
  in the steps and the Git Bash and cmd forms in a line under it), with
  Copy, "Create the project folder first" (`projects.create` from the official template; the text then names the
  folder, and Show in Finder/Explorer opens it), a line on allowing the command in the agent's permissions, and a link
  to the MCP guide for chat apps.

Answered or closed, the greeting is written down (`welcome.seen()`) with the way chosen, and does not come by itself
again; "Getting started" at the foot of the Apps section opens it on that way: the text for the agent, or "Write the
code yourself" (where the code is, what the BUSY Bar can do, Refresh; and Create app). Back leads to the question. In a plain browser there is neither.

## The update's pop-up (`update-popup.js`)

When the app offers a newer version (`update.state()` is `available`), a dialog over the window says "BUSY Bar
Emulator <version> is available", which version the person is on, and two or three lines of the release's notes
(`packages/app/src/update-check.mjs` `releaseSummary`, plain text). Update now is the top bar's Update to <version>:
the progress shows in the dialog, then Restart to update; Later or Esc closes it, and the top bar's notice stays.
Where the copy cannot replace itself, it says why and offers Download, the release page. It waits for the first run's
greeting (`emulatorWelcome.decided`) and any other dialog (`[aria-modal="true"]`); the app (`update.popup()`, once
per version in a run, again a day later; never while it builds, runs a development loop, publishes or records, nor in
a hidden run or under a test that did not ask for it: `packages/app/src/update-popup.mjs`) has the last word.
