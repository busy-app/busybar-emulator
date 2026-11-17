# Changelog

What changes in each release of BUSY Bar Emulator. The newest release is first.

## 0.1.0-beta.6

The emulated BUSY Bar runs firmware 1.4.1, and switches to 1.3.1 and back while it runs.

Firmware:

- Firmware 1.4.1 (API 27.15.0) is the default. 1.3.1 (API 27.14.0) stays for BUSY Bars that have not updated.
- For apps, 1.4.1 adds `/api/storage` for files in `/ext/data`, and `console.warn`.
- In 1.4.1, `fetch` encodes the URL, does not send `#...` to the server, refuses `user:password@` and rejects a failed
  request with a `TypeError`.
- A response header with an empty value no longer restarts the BUSY Bar
  ([#1](https://github.com/busy-app/busybar-emulator/issues/1)).
- A short Back keeps an app's screen.
- The firmware `dev` is gone: 1.4.1 has everything it had.
- One BUSY Bar for both firmwares. Switching keeps the apps, their data and their settings, as an update does. The
  emulator starts on the firmware it last ran.
- At the first start the data folder moves to a new layout. The apps of the BUSY Bar on 1.3.1 stay. Apps installed on
  `dev` go, untouched, to `set-aside/format-1-bars-<time>/`. Older versions of the emulator cannot open the folder
  after that.

The window:

- "Firmware 1.4.1" under the BUSY Bar's name opens the list of firmwares. A new choice takes effect at the BUSY Bar's
  next restart. Until then Restart BUSY Bar is the primary button, and "Next: firmware 1.3.1" is under the uptime.
  While the BUSY Bar is not on the latest firmware, the label is highlighted.
- An app whose `api_version` is newer than the API of the firmware that runs says "Needs firmware 1.4.1" in the Apps
  list. Its Run offers to switch and run it, or to open its manifest. The emulator never edits the manifest.
- The local web and the API documentation at `/docs/` are those of the firmware that runs.
- The BUSY Bar's card is one row. The back display is on the left. Next to it are the name, the firmware and the API,
  with Restart BUSY Bar and the uptime below them. On the right are the address with Copy and Local Web, and the four
  settings.
- The window is at least 1140 px wide (it was 880), so the card keeps its row.
- The top bar shows the emulator's logo without a name. Report a Bug and the documentation links keep their words
  while no one is signed in.
- The Apps column and the stage no longer change their spacing in steps when the window is resized.
- The icon blocks of Publish and Create app fit narrow windows.
- One size of button and field across the window and its dialogs: the BUSY Bar card's, 40 px tall. The main action
  is white, the others gray. Publish and Create app use the window's white primary button instead of blue.
- An app's buttons in the Apps list stand over the end of its row while they show. While they are hidden, the name
  has the whole row.
- An update that fails is one "Update failed" button in the top bar. Its menu says why and has Try again and the
  download page. The top bar no longer runs out of the window while an update downloads or after it fails.
- The project folder's field always shows the end of the path, the folder's own name.
- The two LEDs beside Start / Pause go dark after an app's notification (`led_notification_color`): in 2D they used to
  stay lit. In 2D and in 3D they blink, fade and turn through the rainbow at the firmware's own pace, and a window
  opened, or a 3D view shown, in the middle of a notification shows where it is. `busy-emulator time advance` no
  longer cuts a notification short.

The command line and MCP:

- `busy-emulator firmware` names the firmware the BUSY Bar runs and the others, with their API.
- `busy-emulator firmware use latest`, `previous` or a version switches the firmware. It answers once the BUSY Bar is
  up. In MCP these are `firmware_get` and `firmware_use`.
- `status`, `version` and MCP's `status` name the firmware that runs. In JSON it is `firmware: { version, api, alias }`.
- `api_mismatch` names both API numbers and both ways out. Lower `api_version` if the app needs nothing newer, or
  switch the firmware.
- `check` hints when the code uses `/api/storage` or `console.warn` with `api_version` 27.14.0, and when
  `api_version` is 27.15.0 with no use for it.
- `busy-emulator install <file.tgz>` installs the package again. 0.1.0-beta.5 refused every package.
- A new project's `AGENTS.md` says when to raise `api_version` and how to check the app on 1.3.1.

## 0.1.0-beta.5

A timer fix and a release with its source: the code of the signed macOS builds is in this repository again.

- With the emulator at the computer's speed, a timer the computer ran late could fire twice in one millisecond of the app's clock; a BUSY Bar never does, and now neither does the emulator.
- The release checks are steadier on a busy computer, so fixes reach you sooner.

## 0.1.0-beta.4

The macOS downloads are signed and notarized by Apple: they open with no security warning.

- On macOS the app opens straight from the dmg or the zip; Windows still shows SmartScreen on the first start.
- To remove the macOS app, drag it to the Trash: macOS keeps other programs from deleting a notarized app.

## 0.1.0-beta.3

The emulator now looks for a new version every time it starts, so a fix reaches you the next time you open it.

- A new version is looked for at every start, not once a day; while the emulator stays open, once a day as before.
- The update's pop-up shows the first points of the release's notes and its whole title.

## 0.1.0-beta.2

The window:

- A new app column: the project's folder with Copy and Open in Finder, Copy prompt for AI, and one Run button that
  builds every time and is called Refresh while the app runs. The app's id is in the descriptor of its name; a click
  on the name copies it. Tabs Settings, Catalog and Files: Catalog shows what Publish asks for and how much is ready,
  one row a field that opens in place. A crash says so under the app's name, with the error and Show in Console.
- A new dashboard for the BUSY Bar: its name and address with Copy, a larger back display, Restart BUSY Bar and Open in
  Local Web, the four switches and sliders as one group. "Reconnecting…" shows only while the window has lost the
  emulator.
- Square buttons and one kind of hover descriptor across the window; icons that change with the state no longer blink.
- The account menu has Switch account… and Add account…, which open Publish on Choose a GitHub account.
- The examples' settings say what they do in a line each.

Publish and agents:

- Through an agent, `publish pr` lets you tick the catalog checklist's optional items, so an app sent by an agent can
  enter the BUSY JS Apps Contest.
- A new project's `AGENTS.md` says where the real reason is when a call to the BUSY Bar fails with "Expected a
  function" (busylib's error path).

The command line:

- On Windows the command line prints plain ASCII, so its output reads right in any console.
- `create` points to `dev --once` next; the Windows install script removes its temporary files.

## 0.1.0-beta.1

The first trial release of BUSY Bar Emulator: a BUSY Bar on your computer. Write an app, run it, take screenshots and a
clip for your post, and get it ready for the BUSY Apps Catalog, all without a BUSY Bar. A desktop app for macOS (Apple
Silicon and Intel) and Windows x64, with Node, npm and the BUSY Bar tools inside. Start here:
[download and start](https://github.com/busy-app/busybar-emulator/blob/v0.1.0-beta.1/public-docs/README.md).

### What is in it

The BUSY Bar, for firmware 1.3.1: the firmware's own code compiled to WebAssembly, with its HTTP API, JavaScript runtime,
system programs and local web. Apps run at a BUSY Bar's speed, with a BUSY Bar's memory and `fetch` limits.

The window:

- A new layout: all your apps and the open app on the side, the BUSY Bar with its controls and LEDs, the console below.
- 2D and 3D views of the BUSY Bar; the 3D view turns, zooms and flies to the front, back, top or side.
- Create app: from the official template, an example app or an empty app, built and running in seconds.
- Open existing and Import from GitHub bring in a project you already have.
- Screenshot and Record make the PNGs and the MP4 or GIF for your post, in the window's layouts or the BUSY Bar alone.
- Report a Bug fills in a GitHub issue for you, with a diagnostics file, personal data removed.

Publish:

- Fill in Application Info and How to use; the emulator writes the README for you.
- Choose a license file; the emulator checks the files for secrets and personal data.
- Send to catalog sends to the public BUSY Apps Catalog (busy-app/busy-apps-catalog). The full catalog checklist comes from the catalog itself, with a pre-flight check before you send.
- Update an app that is already in the catalog, or publish into your own repository.
- Several GitHub accounts: choose the one to publish with. GitHub CLI inside the app signs you in.

Agents:

- The `busy-emulator` command line and `busy-emulator mcp` do everything the window does, up to the catalog request.
- An agent reference and a parity table show which command matches which button.

Also:

- Update to a new version from the window: Update, then Restart.
- Build the emulator from source with the public guide, proved from zero on macOS and Windows.

### How it differs from a BUSY Bar

The emulator is stricter where your computer's safety asks for it: other sites' web pages may not call it, and apps may
not reach your computer's services unless you allow a port. An app whose JavaScript runs 2 s without returning is
stopped. Speed is a model of a BUSY Bar's. All of it:
[how the emulator differs from a BUSY Bar](https://github.com/busy-app/busybar-emulator/blob/v0.1.0-beta.1/public-docs/differences.md).
A BUSY Bar has the final word.

### Known issues

- The app is not notarized by Apple or signed for Windows. The first time you open it, use Open Anyway on macOS or
  More info, Run anyway in SmartScreen.
  [What to do](https://github.com/busy-app/busybar-emulator/blob/v0.1.0-beta.1/public-docs/install.md#opening-it-for-the-first-time).
- Two items of the catalog checklist need a BUSY Bar: tested on a BUSY Bar, and screenshots taken from the BUSY Bar. Tick only
  what is true; say in the request what you could not.
- `fetch` follows a BUSY Bar's limits: no redirects, 5 s without data, a small JavaScript heap (96 KiB).
- The 3D view needs WebGL2; without it the flat view stays.
- Windows: `build` fails when the project's path has letters outside the system's code page. Use a Latin-only path.

### Reporting a problem

Use Report a Bug in the window, or open an issue at https://github.com/busy-app/busybar-emulator/issues with the
version (`busy-emulator version`), your system, what you did and what happened:
[what to put in a report](https://github.com/busy-app/busybar-emulator/blob/v0.1.0-beta.1/public-docs/troubleshooting.md#reporting-a-problem).
