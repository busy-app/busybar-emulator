# Changelog

What changes in each release of BUSY Bar Emulator. The newest release is first.

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
