# Your first app on the emulated BUSY Bar

From an installed emulator to your own app on its BUSY Bar and a screenshot of it. Everything here runs on the Node
inside the emulator: you need no Node and no npm of your own. `<cli>` is the path of the command line:
`~/.busy-emulator/bin/busy-emulator` on macOS, `%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe` on Windows
(the install sequence prints it as `cli=<path>`). On Windows write it with forward slashes and no quotes,
`C:/Users/you/AppData/Local/busy-emulator/bin/busy-emulator.exe`, and it runs in PowerShell, Git Bash and cmd alike;
a path with a space needs quotes, and in PowerShell `&` before them.

Every command takes `--json` and then prints one line: `{"ok":true,…}` or `{"ok":false,"code":…,"message":…,"hint":…}`.
The hint names the next command to run.

## In the window

**Create app** (at the top of the Apps list, or File → New App…) opens over the window with these ways to start:

- **Templates**: the official template or one of the three examples, with a picture of each; then the app's name and
  Location, the folder its project goes in (`~/BUSY Bar projects` unless you change it).
- **Empty app**: the name, the short description, the category, the icon (letters made from the name, a drawn pixel
  icon, or your own PNGs of 8×8 and 11×11) and Location. The fields are checked by the catalog's rules as you type.
- **Open existing**: an app project already on this computer; the emulator asks whether you trust its folder first.
- **Import from GitHub**: a repository on github.com, downloaded into a new folder and opened as a project. A
  repository that has no app project but has the app's `.tgz` in its latest release is offered as **Install the
  release package**, which works as below.
- **Install a package (.tgz)**: a ready app package someone built (`busy-cli build` makes one). The emulator reads
  its manifest and checks it the way the BUSY Bar does, then shows you the app's name, id and version and where the
  file came from, and installs and starts it only when you choose Install. It is listed in Apps as installed from a
  package, with no project folder. From a terminal: `busy-emulator install <file.tgz> --check` only looks at a
  package; `busy-emulator install <file.tgz>` installs one from a folder you trusted.

Create makes the project as `create` does, builds it, puts it on the BUSY Bar and starts it. Then edit `src/main.ts` and
press the app's **Refresh**. A name you already have is said, with Open it to go to that app.

Each row of the Apps list has a menu (right-click, or the More button on the row): Start or Stop, Show in Finder (Show
in Explorer on Windows) and **Delete…**, which takes the app off the emulator and forgets its project, and, if you
choose Remove and delete its files, moves its folder to the Trash (the Recycle Bin on Windows). The command line's
`uninstall` does the same.

Without the network, Create app still makes the project: its row says "Dependencies not installed: no network" with
**Retry**, which tries again by itself once the computer is online. A project whose packages a past create fetched is
made from npm's cache, without the network.

## The sequence

```text
<cli> start                                  # the emulator, if it is not running
<cli> create my-app                          # a project from the official template, dependencies installed
cd my-app
                                             # edit src/main.ts: what the app draws
<cli> build                                  # dist/<app id>.tgz
<cli> run                                    # installs what build made and starts it; says whether it runs
<cli> logs                                   # the app's console.log output and errors, when the BUSY Bar shows nothing
<cli> screenshot --scale 8                   # screenshots/front-1.png (72×16) and front-1@8x.png, enlarged, to look at
<cli> record                                 # media/clip-1.mp4: 5 s of the app on the BUSY Bar, a video to post
<cli> press ok                               # a button: ok, start, back; up and down turn the wheel one click
<cli> time advance 25m                       # 25 minutes pass at once: the app's timers that were due fire now
<cli> settings set hour24=false --restart    # change a setting of the app and start it again with it
<cli> typecheck                              # the project's TypeScript check
<cli> stop                                   # the app stops; the emulator stays
```

After a change: `build`, then `run`. The project commands also take the project's folder (`<cli> build my-app`,
`<cli> run "my folder/my app"`), so they need no `cd`. `install` alone puts the built package on the BUSY Bar without
starting it. `screenshot` writes into `screenshots/` of the folder you call it from and replaces no file there;
`--back` takes the back display (160×80), `--out <file.png>` names the file.

## The development loop: `dev`

One command instead of `build` and `run` after every edit:

```text
<cli> dev                                    # build, install, start; then again on every save, until Ctrl+C
<cli> dev --once                             # one round, then it ends: exit code 0 the app runs, 1 it does not
```

`dev` watches the project's files (not `dist/`, `node_modules/`, `screenshots/`, `media/` or names that start with a dot).
When you save, it builds, installs and starts the app again: about 0.5 s for the template. It prints one line for
each round with the time it took, and the app's console as it comes: what the app prints with `console.log`, and the
runtime's errors.

```text
12:08:00  watch    /Users/you/my-app (app.your_name.my-app) for the emulated BUSY Bar at 127.0.0.1:8640. Ctrl+C stops watching; the app stays on the BUSY Bar.
12:08:00  build    the project as it is
12:08:01  ready    app.your_name.my-app was started on the BUSY Bar (0.56 s: build 0.24 s, install 0.20 s, start 0.12 s)
12:08:01  log      hello from my app
12:08:03  build    src/main.ts changed
12:08:03  failed   busy-cli build failed with exit code 1:
…                  (what busy-cli says: the file, the line, the error)
12:08:03  watch    still watching: save a file to try again. The app on the BUSY Bar is as it was.
12:08:09  build    src/main.ts changed
12:08:10  ready    app.your_name.my-app was started on the BUSY Bar (0.43 s: build 0.16 s, install 0.17 s, start 0.11 s)
12:08:10  error    [JsRunner] Error running script: ReferenceError: draw is not defined
12:08:10  exited   the app stopped: error running main.js: Error running script: ReferenceError: draw is not defined
```

- A build that fails does not stop the loop, and the BUSY Bar keeps the last version that built. Fix the file and save.
- Saves while a round runs make one more round after it; rounds never overlap.
- Ctrl+C stops the watching, not the app. `<cli> stop` stops the app.
- The emulator must be running (`not_running` otherwise: `<cli> start`). When it quits, `dev` ends.
- It takes the project's folder too: `<cli> dev my-app`.

**For an agent.** `<cli> dev --json` prints one line of JSON for each event, each with `event` and `time`:
`watching`, `build_started` (`changed`: the files), `build_failed` (`output`: busy-cli's text; also `install_failed`,
`run_failed`), `installed`, `running` (the round's times in `ms`), `app_log` (`level`, `text`), `app_error` (`text`),
`app_exited` (`reason`, `crashed`). After a save, read until `running` or one of the `…_failed` events. An app that
fails when it starts gives `running`, then `app_error` and `app_exited` with `"crashed":true`.

An agent that cannot keep a process running uses `<cli> dev --once --json` after each edit: the same event lines for
one round, then the answer as the last line. `{"ok":true,…,"running":true}` and exit code 0: the app runs.
`{"ok":false,"code":"tool_failed",…}`: the build failed, `output` is busy-cli's text. `{"ok":false,"code":"app_crashed",…}`:
the app was started and stopped at once, `error` is the runtime's first error and `log` what the app printed.

## What each command does

- **`create` makes the folder.** It takes a name that is not taken, or an empty folder: `<cli> create my-app`.
  `<cli> create .` works only in an empty folder. In a folder with files, such as one with an `AGENTS.md`, the answer
  is `folder_not_empty`, with what is in the way and a command to run instead.
- **`create` takes the author from `--author "Your Name"`, else from git (`user.name`), else the name of your
  account.** When you did not choose it, the answer says which author it used (`author` in the JSON) and where to
  change it: `"author"` in `package.json` and in `src/appmeta/manifest.json`. The app's id is made from the author
  and the folder, `app.your_name.my-app`; `--id` names another.
- **`create` needs the npm registry.** The template and the project's dependencies come from there: about 60 MB in
  the project, and npm's cache, about 110 MB, in the emulator's data folder. `build` needs the registry only when
  the dependencies are missing; `<cli> build --dependencies-only` installs them and builds nothing. When the
  registry does not answer, npm is stopped after 45 s with `network_stalled` instead of waiting minutes, and a
  project made without its dependencies is listed with the reason. In a sandbox without network the answer is
  `blocked_network`.
- **Only `start` starts the emulator.** `install`, `run`, `stop`, `dev`, `logs`, `screenshot`, `record`, `press`,
  `settings`, `uninstall` and `trust` answer `not_running` without it: run `<cli> start` first.
- **`run` installs the built package, starts the app and watches it for a second.** Before the first `build` it
  answers `not_built`. `"running": true` means the app runs. An app whose script fails at once answers `ok: false`
  with the code `app_crashed`, exit code 1, and the error's first line:

  ```json
  {"ok":false,"command":"run","code":"app_crashed","message":"app.your_name.my-app started on the emulated BUSY Bar and stopped at once: [JsRunner] Error running script: ReferenceError: draw is not defined","hint":"Its console and the error are in <cli> logs. Fix the script, then <cli> build and <cli> run again.","running":false}
  ```

  The answer also carries `error`, `exited`, `log` and busy-cli's `output`. A script that runs to its end without an
  error and keeps nothing going is `ok` with `"running": false, "exited": "finished"`: the BUSY Bar is back on the app's
  card in the APPS menu.
- **`logs` shows the app's console.** What the app prints with `console.log` and `console.error`, the runtime's
  errors and why the app ended, for the app of the folder you call it from (with the BUSY Bar's own lines; `--app <id>`
  names another app, `--all` shows every app's, `--since-run` only its latest launch): the latest 50 lines (`--lines 200` for more, `--json` for
  `{"lines":[{"time":…,"kind":…,"text":…}]}`):

  ```text
  12:04:31  app     Launch app.your_name.my-app (heap 128 KiB)
  12:04:31  log     app.your_name.my-app log: hello from my app
  12:04:31  error   app.your_name.my-app [JsRunner] Error running script: ReferenceError: draw is not defined
  12:04:31  app     App app.your_name.my-app exited: error running main.js: …
  ```

  `<cli> logs --follow` goes on printing new lines until you stop it. The emulator keeps the latest 500 lines while
  it runs. The same lines, with everything else the emulator says, are in `logs/shell.log` in its data folder
  (macOS `~/Library/Application Support/BUSY Bar Emulator/`, Windows `%LOCALAPPDATA%\BUSY Bar Emulator\`).

  `--kind` chooses lines as the filters of the window's Console do: some of `console` (what apps print, their
  warnings and errors), `lifecycle` (installed, launched, exited), `build` (what the window's buttons ran: build,
  install, start, the checks) and `system` (the BUSY Bar's own lines), with commas between. Without it you get every kind
  but `build`. `--since <ms>` shows only the lines after a moment, in Unix milliseconds by the computer's clock.

  ```text
  <cli> logs --kind console,lifecycle --since-run    # what the app printed and its life, from its latest launch
  <cli> logs --all --kind build --lines 200          # what the window's buttons ran, for every app
  ```

  In the emulator's window, the Console's "Open in Terminal" button ("Open in cmd" on Windows) opens this log in the
  system's terminal, in your project's folder, with the filters that are on in the window and from its last Clear.
- **`typecheck` checks the types; `build` does not.** It names each error's file and line (`typecheck_failed`, with
  `errors` in the JSON).
- **The project's `AGENTS.md` has a section for the emulator.** `create` writes it between
  `<!-- busy-emulator:begin -->` and `<!-- busy-emulator:end -->`: the commands to use, the format of
  `settings.json`, how to read the settings. It also rewrites the template's lines there that said `npm run …`. The
  project's `README.md` is the template's and still speaks of `npm run …` and of a BUSY Bar on USB:

  | The template's README says | Use |
  |---|---|
  | `npm run build` | `<cli> build` |
  | `npm run app:install` | `<cli> install` |
  | `npm run app:run` | `<cli> run` (it installs first) |
  | `npm run app:stop` | `<cli> stop` |
  | `npm run typecheck` | `<cli> typecheck` |

- **Settings work in a new project.** Describe them in `src/appmeta/settings.json`; the BUSY Bar draws their screen
  (APPS, the app's card, Setup) and their page in its local web. The smallest valid file:

  ```json
  {"format_version":1,"version":1,"fields":{"hour24":{"type":"boolean","label":"24-hour clock","default":true}}}
  ```

  `fields` is a map keyed by each field's id, not a list. Every field has `type` (`boolean`, `integer`, `string`,
  `enum`, `color`, `time`, `geolocation`, `group`), `label` and `default`. `build`, `dev` and `run` check the file as
  the firmware does and name the field at fault (`settings_invalid`: `field`, `problem`); a BUSY Bar would show only
  "Settings file is invalid." The app reads the values with `loadValues()` from `@shared/settings`:

  ```ts
  import { loadValues } from "@shared/settings";

  const values = (await loadValues()) ?? {};
  const hour24 = values.hour24 !== false;
  ```

  `create` replaces the template's helper, whose `loadValues()` always gave `null` on the released firmware, with one
  that asks the BUSY Bar (`GET /api/apps/settings`). The BUSY Bar answers with every field: the saved value, or the file's
  `default`. An app reads its settings when it asks, so ask at the start. An app cannot write them.
- **`settings` reads and changes an app's settings**, as the BUSY Bar's web page does: `<cli> settings get`,
  `<cli> settings set minutes=45 theme=blue --restart` (a field of a group is `group.field=value`),
  `<cli> settings reset`. `--restart` starts the app again so that it reads them, and says whether it runs. Outside
  the project's folder, name the folder or the app: `<cli> settings get my-app`,
  `<cli> settings get --app app.your_name.my-app`. A value the BUSY Bar refuses is `settings_refused`, with the reason.
- **`press` presses the BUSY Bar's buttons**: `<cli> press ok`, `<cli> press start`, `<cli> press back`. `<cli> press up`
  and `<cli> press down` turn the wheel one click (an app gets the key `encoder`). `--times 3` repeats;
  `<cli> press start --hold 800` holds the button down for 800 ms, a long press. Then look:
  `<cli> screenshot --scale 8`, `<cli> logs`.
- **`time` moves the BUSY Bar's clock**, so a 25-minute timer or a change on the hour is checked without waiting.
  `<cli> time advance 25m` (also `90s`, `2h`, `1h30m`) lets the time pass at once: the BUSY Bar's clock and the app's
  `Date.now()` move on, every `setTimeout` and `setInterval` due in between fires now (an interval once), and the
  firmware's `countdown` elements and animations move with it; network requests are not hurried.
  `<cli> time set 14:59:50` sets the clock as the BUSY Bar's own API does, without hurrying timers; `<cli> time reset`
  makes it this computer's time again; `<cli> time` shows it.
- **Keep the project where `create` made it.** The emulator builds a project it created, or one you trusted, and it
  trusts the folder at its place. A project that was moved or renamed answers `untrusted_project` with
  `"reason": "moved"` and the old place in `trusted_as`: move it back, or trust it again. A copy, a clone, or a
  project made with `npm create` is a folder the emulator does not know (`"reason": "unknown_folder"`).
  `<cli> trust <folder>` makes the emulator ask you in a dialog on its window; your click there is the only thing
  that trusts a folder. The command waits 120 s for it (`--wait <seconds>`, up to 600) and needs the emulator
  running. The rest is in [Troubleshooting](troubleshooting.md#untrusted_project).
- **`uninstall` takes an app off the emulator.** `<cli> uninstall app.your_name.my-app` (or the project's folder,
  `<cli> uninstall ./my-app`) stops the app, removes it from the emulated BUSY Bar and forgets its project; the folder
  stays. `--delete-files` also moves the project's folder to the Trash (the Recycle Bin on Windows).
- **`quit` right after `start` leaves nothing running.** A `quit` that comes while a `start` is still waiting ends the
  app as soon as it is up, and that `start` answers `start_interrupted`.

## Start from an example

Three small, finished apps come with the emulator. Each is a whole project in the template's layout: the app, a
settings page, both icons, and a README with a picture of each display. Start your own from one instead of the
template's "Hello".

```text
<cli> create --examples                               # the examples, a line each
<cli> create my-app --example focus-timer             # your project, made from one; then build and run as above
```

| Example | What it shows on the BUSY Bar | What to take from it |
| --- | --- | --- |
| `focus-timer` | A tree that grows through a focus session, wilts if you give up, and joins a forest when you finish | An animation with a section for each state, a countdown the firmware runs, one timer, `localStorage` |
| `meeting-cost` | A stack of money on fire and what the meeting has cost, going up every second | A counter that costs two small elements a tick, the wheel changing a number, pictures where the fonts have no glyph |
| `status-board` | A heartbeat for an address that answers JSON: a green pulse, or a red flat line with the reason | `fetch` with every way it fails named on screen, timeouts, small answers, the BUSY Bar's light |

`create --example` makes the project as `create` always does, with the same id from the author and the folder and
the same `--author`, `--id`, `--name` and `--description`, then puts the example's app in place of the template's.
The project's `README.md` is the example's: what it shows, its controls, what each setting changes, and how it is
made.

What the examples have in common, because a BUSY Bar asks for it:

- **The firmware animates.** A BUSY Bar draws a whole 72×16 frame from JavaScript about 3.5 times a second. The motion in
  the examples is in `.anim` files and `countdown` elements, which the firmware plays by itself; the app says which
  section to play and sends only the elements that changed (`shared/screen.ts`).
- **A settings page that changes what the app does.** The BUSY Bar has no keyboard: everything is set on its web page,
  under Apps. `src/appmeta/settings.json` describes the fields; the app reads the saved values once, at its start,
  with the BUSY Bar's HTTP API (`shared/settings.ts`: the template's own `loadValues()` reads a global that firmware 1.3.1
  does not have), and the page offers Restart after a save.
- **Both displays.** The front one (72×16, color) faces the room; the back one (160×80, gray) faces the person at the
  desk and says what the controls do. An element with `display: "back"` goes there.
- **A 96 KiB heap**, set in the manifest (`heap_size_kib`): what an app gets when a BUSY Bar starts it from its command
  line. The emulator ends an app that outgrows its heap, as a BUSY Bar does.

## Network and memory

An app that shows data from the internet meets the BUSY Bar's limits first. The emulator makes requests the way the BUSY Bar's
firmware makes them, so it meets them too. Measured on 12 November 2026 with six small apps against public APIs
(Open-Meteo, GitHub's status page, Frankfurter, the BBC's RSS feed, httpbin) and with a service on this computer:

- **Ask a small endpoint, for only the fields you show.** The app's heap is 128 KiB by default. `res.json()` parsed
  about 70 KiB of JSON in it, `res.text()` about 120 KiB of text; a larger response crashes the app ("JS heap
  overflow"), and a BUSY Bar restarts. GitHub's `incidents.json` (290 KiB) crashed it; `status.json` (200 bytes) did
  not. Use the API's own filters: `?fields=`, or Open-Meteo's `current=temperature_2m` (320 bytes) rather than a
  16-day hourly forecast. `heap_size_kib` in the manifest raises the heap up to 512 KiB, where about 275 KiB of JSON
  fitted.
- **Read a big body piece by piece.** `res.body.getReader()` gives the body as it arrives, a couple of kilobytes at
  a time; keep only what you need from each piece, or cut the text you need out with `indexOf` and `slice`. There is
  no `TextDecoder`: for ASCII, `String.fromCharCode(...bytes)` turns a piece into text.
- **Use the final address.** A BUSY Bar does not follow redirects: `http://feeds.bbci.co.uk/news/rss.xml` answered 302
  and the app got an empty body; `api.frankfurter.app` answered 301 and `res.json()` failed. Write the `https://`
  address the redirect points to. The emulator's log names it.
- **5 seconds without data end a request** with `"Inactivity timeout"`, counted from the start of the request, so a
  server that thinks longer before it answers fails on a BUSY Bar. In the middle of a stream the reader does not throw:
  `reader.read()` gives `{ done: true, value: "Inactivity timeout" }`, so check `value` when `done` comes early.
- **HTTPS takes about 1.5 s on a BUSY Bar**, most of it the TLS handshake on the BUSY Bar's processor; plain HTTP about 0.1 s.
  Every https request in the test apps took 1.43 s, as on a BUSY Bar. Refresh no more often than the data changes: a
  status every minute, weather every 15 minutes, a currency rate every hour.
- **Certificates.** The BUSY Bar trusts the certificate authorities in its firmware's list (Mozilla's, October 2026), and
  so does the emulator. A site whose certificate chain ends at a root outside that list fails with `"Failed to
  establish TLS connection"`.
- **Your own computer is not the BUSY Bar's.** On a BUSY Bar `localhost` is the BUSY Bar itself, so a request to a service on your
  computer is refused. Allow its port for testing: `<cli> allow-local 8080`.

A request that fails, or an answer the BUSY Bar would not handle as you expect, gets a line from the emulator in
`<cli> logs`: the address, what happened, and what the app sees. The BUSY Bar says none of this; see
[what the log says](differences.md#what-the-log-says-of-an-apps-mistakes).

## A clip for your post

A short clip is handy for a post about your app. In the window, press **Record** in the top bar and choose Window,
Post (1080×1920) or Front display; press it again to stop, and the Save dialog asks where the MP4 goes. It stops by
itself after 2 minutes. From the command line, run the app, then:

```text
<cli> record                                 # media/clip-1.mp4: 5 s of the emulator's window, as you see it
<cli> record --seconds 10                    # longer: up to 120 s
<cli> record --layout post                   # 1080×1920: the BUSY Bar alone, for a vertical post
<cli> record --gif                           # media/clip-1.gif: the front display, for places that take no video
```

By default the clip is the emulator's whole window, like a screen recording of it: the BUSY Bar, its buttons, the back
display, the Apps list and the Console, as they change while it records. Click, turn the wheel and press Start in the
window during the take (or have an agent run `<cli> press start`): the clip shows it. It is the window's size in
pixels (on a Retina screen twice its size in points), H.264 at 30 frames a second (`--fps` from 1 to 60). The mouse
pointer is not in it. `record` brings the window to the front first and opens it if you closed it; if you resize the
window while it records, the clip keeps the first size.

`--layout post` (1080×1920), `both` (1920×1080) and `front` (the front display alone, `--scale`) show only the BUSY Bar,
drawn from its displays, and need no window on the screen. In them every frame is stepped on the BUSY Bar's own clock, so
what the firmware animates (`.anim` files, scrolling text, `countdown` elements) is exact; what your app's own
JavaScript draws is taken in real time. QuickTime, Windows Media Player, X, Instagram, Telegram and Discord take the
MP4 as it is. A GIF is the front display, 25 frames a second at `--scale 8` unless you say (`--fps` up to 50): it
has at most 750 frames (30 s at 25 a second), fewer at a larger scale (142 at `--scale 26`, about 5 s); the command
says what fits. `--out <file>` names the file (`.mp4`, or `.gif`), `--out <folder>/` the folder. The clip is taken at
the BUSY Bar's speed (the emulator refuses to record with `--fast`), and it has no sound.

## Submitting to the catalog

The BUSY Apps Catalog takes an app as a pull request that adds one file, `applications/<app id>/manifest.yml`. The
file names your public GitHub repository at a commit; the catalog builds the app from it and checks it. Two commands
say beforehand what those checks will find, and write the file:

```text
<cli> build                                  # the checks read the built package
<cli> check                                  # every check of the catalog: passes, fails, or cannot be checked here
<cli> submit                                 # the same checks, then submission/ with the manifest and the steps
```

Both take the project's folder, like `build` (`<cli> check my-app`). Neither needs the emulator running, and neither
sends anything anywhere.

In the emulator's window, **Publish** (over the BUSY Bar, or Prepare PR in the app's section) does the same step by step:
the catalog's texts, the screenshots, the README, a license you choose, the public repository's files with a warning
for anything that looks like a secret, the catalog's checks, the build and `submission/`; then it publishes the
project to a public GitHub repository of yours and opens the pull request to the catalog. From the command line the
same steps are `<cli> publish` (`<cli> help publish`), and `<cli> catalog-texts set` writes the texts.
[Publishing, step by step](#publishing-step-by-step).

`check` lists the failures first: for each one the catalog's own words, what it found in your project, and what to
change. Then come the catalog's warnings (it takes the app with them), then what cannot be checked from your folder
and why, then how many checks pass. It exits with 0 when nothing fails and with 1 (`check_failed`) otherwise. With
`--json` the answer is short: `counts`, `notes`, and only what needs something, `failing`, `warnings` and `unchecked`,
each with `id`, `title`, `message` and `fix`. `--json --full` lists every check, each with `id`, `status` (`pass`,
`fail`, `unchecked`), `found`, `change` and `why`. The ids are the catalog's: its bot names the same ones on your pull
request.

What a new project still lacks, and how to add each:

- **The catalog's texts.** `<cli> check` (and `submit`) makes `catalog.json` in the project, empty. Write in it:
  `category` (one of `productivity`, `clocks`, `info-feeds`, `social`, `dev-monitoring`, `music`, `art`, `games`,
  `smart-home`, `utilities`), `short_description` (one line, 10 to 120 characters), `description` (50 to 4000
  characters; level 1–2 headings, bold, italic, lists and http(s) links are taken, `\n` is a new line) and
  `changelog` (10 to 4000 characters). The emulator never writes these for you; `<cli> catalog-texts set` writes
  the ones you give it, checked as the catalog checks them.

  ```json
  {
    "category": "clocks",
    "short_description": "A large clock with the date for the desk.",
    "description": "# Desk Clock\n\nA **large** clock with the date.\n\n- Wheel: brightness\n- OK: 12 or 24 hours",
    "changelog": "The first public version."
  }
  ```

- **A screenshot.** Run the app and take `<cli> screenshot`, or press Screenshot over the BUSY Bar in the window (Front
  and Back ticked by default; Cmd+Shift+S, Ctrl+Shift+S on Windows): `screenshots/front-1.png`, 72×16, is the app's cover
  in the catalog; up to ten are taken, in the order of their numbers, and `<cli> screenshot --back` adds back
  screenshots (160×80). To choose or order them yourself, list the files in `catalog.json` as `"screenshots"` and
  `"back_screenshots"`. The enlarged copies (`front-1@8x.png`) are not for the catalog and are left out.
- **A license.** A `LICENSE` file with the unchanged text of an open source license (MIT, Apache-2.0, GPL and the
  others `check` names) in the project or at the top of its repository. Which one is your choice: the emulator never
  picks one, and an agent should ask you rather than pick. Once you chose, `<cli> publish license --license MIT`
  writes the standard text with your name and the year.
- **The icons.** `<cli> icon --text AB` draws one or two letters (`--color "#FF5533"` for their color), or
  `<cli> icon --from logo.png` scales a picture of any size down. It writes `src/appmeta/icon_front_8x8.png` and
  `icon_back_11x11.png`, checked against the catalog's icon rules; `--force` replaces icons that are there.
- **The source on GitHub.** The project in a public GitHub repository, committed and pushed, with its
  `package-lock.json`, its screenshots and the license in the commit. `check` runs no git: it reads the repository's
  folder, so it knows the commit, the remote and which files git keeps, but not whether your last changes are
  committed. When your copy has not seen the commit on the remote, `source_commit` says so and asks you to push.
- **The name and the id.** The app's `name` in `src/appmeta/manifest.json` has at most 32 characters, Latin letters,
  digits and a few signs; the `id` is lower-case and has at least two dots (`io.github.<your-github-user>.<app>`);
  the whole `manifest.json` is at most 512 bytes in the package, and `"debug": true` is refused.

When no check fails, `submit` writes the folder `submission/` in the project:

- `applications/<app id>/manifest.yml`: the catalog's manifest, with your repository, the commit, your texts and the
  screenshots' paths. The screenshots themselves stay in your repository, where the catalog reads them.
- `PR-DESCRIPTION.md`: the text for the pull request's description, with the fields of the catalog's template. No box
  is ticked for you. It says that the app was built and run on the emulator, with which firmware, and that it was not
  run on a physical BUSY Bar; if you did run it on one, say so there.
- `SUBMIT.md`: what to make sure of first (everything committed and pushed, the repository public, each check the
  emulator could not decide) and the steps: fork the catalog, add the one file, open the pull request, tick the
  author's box before you open it.

`submission/` ignores itself in git and is made again at every `submit`: after another commit, run `submit` again,
because the manifest names the commit. What stays unchecked until the catalog looks: its own build of your commit
(in a container without network, with `npm ci` and no install scripts), whether the version is above the published
one, and the pull request itself.

## Publishing, step by step

Publishing goes in two stages. Stage 1 makes ready, in your project, everything the public repository and the
catalog's pull request need; nothing is sent anywhere. Stage 2 signs you in to GitHub, makes your public repository,
publishes the project to it and opens the pull request to the catalog.

In the emulator's window, **Publish** (over the BUSY Bar, or **Prepare PR** in the app's section) opens the steps for the
chosen app. Prepare, where nothing leaves the computer:

1. **Application Info**: the app's icon and name, the category, the short description, the description and what's new.
2. **Screenshots**: Take from the BUSY Bar, or **Upload…** PNG files you made (72×16 for the front, 160×80 for the back,
   or an exact whole-number enlargement of one). Reorder and remove them; the first front one is the cover.
3. **README**: fields (title, about, how to use) or Markdown, with a preview. The screenshots, the settings, how to
   build and the license line are added for you. Text left from the template keeps Next off.
4. **License**: MIT, Apache 2.0 or GPL 3.0, each said in plain words, or your own LICENSE file; nothing is chosen for
   you.
5. **Repository files**: what goes public, the `.gitignore` lines, and anything that looks like a secret.
6. **Pre-flight check**: the app built and its types checked, then the catalog's checks; anything left names its
   step, with Go to, or its file and line. A file changed after it makes it run again.
7. **Build and package**: the build and `submission/`.

Then Publish: **Publish to GitHub** and **Send to catalog** (below). **Next** saves what the step holds; it is off,
with the reason in the footer, until the step is complete, and a step opens only after the ones before it. Done
steps are ticked and can be opened again. The window remembers the steps done in `.busy/publish.json` of the project
(`.busy/` keeps itself out of git) and opens at the first step not done.

The same steps on the command line, for you or an agent:

```text
<cli> publish status                                 # where each step stands
<cli> publish check                                  # builds, checks types, then the catalog's checks
<cli> catalog-texts set --category clocks --short-description "A large clock with the date for the desk."
<cli> publish screenshots --take front               # what the front display shows now, for the catalog
<cli> publish readme set --usage "Turn the wheel."    # the README's how to use; readme preview shows it
<cli> publish license --license MIT --author "Your Name"
<cli> publish files                                  # what the repository will hold, and what looks like a secret
<cli> publish files --write                          # the missing .gitignore lines, and README.md
<cli> build
<cli> publish package                                # the checks, then submission/
```

`<cli> publish prepare --license MIT --author "Your Name"` does the license, the files, the build and the package in
one go: for an agent, once you have chosen the license. Each command takes the project's folder after the step
(`<cli> publish status my-app`) and `--json`.

- **`catalog-texts`** reads (`get`) or writes (`set`) the four texts in `catalog.json`: `--category`,
  `--short-description`, `--description` and `--changelog`. Each is checked by the catalog's rules; a text the
  catalog would refuse is written all the same, and the answer says what is wrong with it. Give a text that starts
  with "-" as `--description=<text>`. `--name` changes the app's name in its manifest, and refuses a name the catalog
  would not take.
- **`publish license`** writes `LICENSE`: the standard text of `MIT`, `Apache-2.0` or `GPL-3.0` with the name
  (`--author`, else git's `user.name`, else the app's author) and the year (`--year`), or `other` for one you add
  yourself. It never chooses for you, and it keeps a license file that is there. The catalog's check warns about the
  GPL 3.0 text itself (`license_unrecognised`): a moderator reads it then.
- **`publish files`** lists what `git add -A` would publish under the project's `.gitignore`, the lines
  `.gitignore` lacks (`node_modules/`, `dist/`, `.busy/`, `submission/` and the systems' own files), and what looks
  like a secret or personal data: tokens of known services, values given to keys named like secrets, `.env` and key
  files, paths of a home folder. It names the file, the kind and the line, never the value. `--write` adds the
  lines, keeps out what you name with `--keep-out <path>`, and makes `README.md` from the catalog's texts, the
  screenshots and the license. A README of your own is kept unless you add `--readme replace`; `--keep-in <path>`
  takes back a line it added.
- **`publish readme`** shows (`get`), writes (`set`) or previews (`preview`) README.md: `--mode fields` with
  `--title`, `--intro` and `--usage` (how to use the app, which only you can write), or `--mode markdown` with
  `--markdown <text>`. A README of your own is opened as Markdown and kept as it is.
- **`publish screenshots`** lists them in the catalog's order, each with what the catalog says of it. `--take front`
  or `--take back` saves what the display shows now, with an enlarged copy for the README; `--upload <files>` adds
  PNG files you made (paths joined as in `PATH`, or a JSON list), checked for their size; `--order` sets the order
  (`'{"front": ["screenshots/front-2.png", "screenshots/front-1.png"]}'`; the first front one is the cover);
  `--remove <path>` moves one into `.busy/removed/`.
- **`publish package`** needs a build. It runs the checks, then writes `submission/` as `submit` does; until the
  project is on GitHub, the manifest's repository and commit say "Filled in Stage 2". The checks that only a
  repository on GitHub can pass are listed apart, as stage 2's, and do not stop the package.

### Stage 2: GitHub and the catalog

**Publish to GitHub** signs in through GitHub CLI (`gh`, made by GitHub, inside the app), which shares its accounts
with GitHub CLI on your computer:

- If GitHub CLI on this computer is signed in, the window asks "Use <login>?". **Use <login>** publishes with that
  account as it is: nothing new is signed in, and signing out in the emulator only forgets it there.
- **Sign in with another account**, or the first sign-in when GitHub CLI has none: the window shows a code, you open
  github.com/login/device, enter it and authorize GitHub CLI. The account is added to GitHub CLI on this computer and
  becomes the one it uses, also in your terminal; its earlier account stays signed in. When you sign out in the
  emulator you can switch GitHub CLI back to it, or tick **Also sign out GitHub CLI on this computer**.

GitHub CLI asks for access to your repositories (public and private), your organizations' membership and your gists:
that is what it always asks for, more than publishing needs; the emulator uses it to create one public repository and
the request to the catalog. Neither the emulator nor GitHub CLI sees your password, and the emulator never holds the
token: GitHub CLI keeps it in your system's password store (the login keychain on macOS, Credential Manager on
Windows) and makes every call to GitHub.

This sign-in belongs to GitHub CLI on this computer: other programs, including AI agents, can use it too. The
emulator's confirmations cover only its own commands. When the emulator signed GitHub CLI in and it had no account
before, Also sign out GitHub CLI on this computer starts ticked when you sign out.

Then it makes a public repository of yours (named after the app; you can change the name) and publishes the files of
Repository files to it in one commit, without git. It reads the commit back from GitHub and shows its link and its
commit. The folder `.github/workflows/` is not published. Publishing again updates the same repository; a name you
have already gets a free one offered. The manifest in `submission/` now names the repository and the commit.

**Send to catalog** opens the pull request that adds `applications/<app id>/manifest.yml` to the catalog. It shows
the catalog's author checklist as the catalog's template has it: you tick every item that is true, and you choose
how AI was used. Nothing is sent until every item is ticked, except an item the catalog marks as optional (such as
taking part in the BUSY JS Apps Contest), which may stay unticked. The request's description is the catalog's own
template with the boxes you ticked and the one line you chose. It comes from your fork of the catalog, or from a
branch in it if you may push there. If the project changed since you published it, publish again first: the catalog
builds exactly that commit. Sending again for the same version adds the change to the open request; a new version
opens a new one.

Send to catalog sends the request to the BUSY Apps Catalog, https://github.com/busy-app/busy-apps-catalog; the step
names it. The command line's `--catalog <owner/name>` names another catalog, for development and tests.

**Sign out** forgets the sign-in in the emulator. An account GitHub CLI had before stays signed in to it; one the
emulator signed in stays too, unless you tick Also sign out GitHub CLI on this computer. GitHub keeps the access until
you revoke it: on github.com/settings/applications, under Authorized OAuth Apps, revoke **GitHub CLI**. That signs out
GitHub CLI everywhere you use it with this account, not only in the emulator.

The same from the command line, with the emulator's app running (it holds the sign-in and asks you before it sends):

```text
<cli> publish signin --use-existing        # GitHub CLI's account on this computer, as it is
<cli> publish signin --new-account         # prints the code and waits until you have entered it on GitHub
<cli> publish push                         # the app asks you to confirm, then publishes
<cli> publish pr --ai none                 # the app asks you to confirm the checklist; optional items stay unticked
<cli> publish status                       # stage 1's steps, the repository and the request
<cli> publish signout
```

### Sending it by hand

If you would rather use git yourself, Build and package in Publish ("Rather by hand? Show the steps") and
`submission/SUBMIT.md` list these steps with the commands for your project:

1. In the project's folder, commit everything that is to be published: `git add -A`, then `git commit`.
2. On github.com, create a new public repository with no README, license or .gitignore: the project has them.
3. Connect the project to it and push: `git remote add origin https://github.com/<your-github-user>/<repository>.git`,
   then `git push -u origin main`.
4. Package again: Build and package in the window, or `<cli> publish package`. The manifest now names the repository
   and the commit, and `SUBMIT.md` holds the steps to the pull request.
5. Fork https://github.com/busy-app/busy-apps-catalog and add `submission/applications/<app id>/manifest.yml` there
   as `applications/<app id>/manifest.yml`, changing nothing else.
6. Open a pull request into its main branch with the text of `submission/PR-DESCRIPTION.md`, and tick the boxes that
   are true.

After another commit, package again before you update the pull request: the manifest names the commit.
