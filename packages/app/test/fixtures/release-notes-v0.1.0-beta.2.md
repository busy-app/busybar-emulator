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

## Files

- `busybar-emulator-mac-arm64.dmg`: macOS on Apple Silicon, for people, 207 MB
- `busybar-emulator-mac-arm64.zip`: the same app zipped, for agents, 210 MB
- `busybar-emulator-mac-x64.dmg`: macOS on Intel, for people, 216 MB
- `busybar-emulator-mac-x64.zip`: the same app zipped, for agents, 219 MB
- `busybar-emulator-win-x64-setup.exe`: Windows x64, installs for the current user, 247 MB
- `SHA256SUMS`: the SHA-256 of each file above
- `install-macos.sh`, `install-windows.ps1`: the install sequences of the docs as scripts
- `update.json`, `update.json.sig`: what the emulator's built-in update reads, signed with the release's key

This release is not notarized by Apple and not signed on Windows: the system warns once, at the first start. The steps, and what is downloaded and from where: [public-docs/install.md](https://github.com/busy-app/busybar-emulator/blob/v0.1.0-beta.2/public-docs/install.md).

Source of this release: the tag `v0.1.0-beta.2`. Licenses: `THIRD_PARTY_NOTICES.md` in the repository and inside the app.
