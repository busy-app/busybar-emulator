- **Firmware 1.4.1.** The emulated BUSY Bar runs the firmware BUSY Bars get with auto-update.
  - Switch to 1.3.1 and back in the window or with `busy-emulator firmware use previous`. Apps, their data and settings stay.
  - Apps can keep files with `/api/storage` and log with `console.warn` (needs `api_version` 27.15.0).
  - The emulator tells you when an app needs a newer firmware than the one running.
- **Cleaner window.**
  - The BUSY Bar's card fits in one row.
  - Buttons look the same everywhere.
  - A failed update is one clear button.
- **LEDs beside Start / Pause** blink and go dark as on a real BUSY Bar. They no longer stay lit after a notification.
- **Fixes**
  - An empty response header no longer restarts the BUSY Bar ([#1](https://github.com/busy-app/busybar-emulator/issues/1)).
  - `busy-emulator install` works again.
- **New data folder layout** on first start. Older versions of the emulator can't open it after that.
  - The firmware `dev` is gone: 1.4.1 has everything it had. Apps installed on it are set aside, untouched, in
    `set-aside/format-1-bars-<time>/`.

## Files

- **macOS**, signed and notarized by Apple: `busybar-emulator-mac-arm64.dmg` (Apple Silicon, 208 MB), `busybar-emulator-mac-x64.dmg` (Intel, 216 MB)
- **Windows**: `busybar-emulator-win-x64-setup.exe` (247 MB). Not signed yet, so SmartScreen warns once on the first start.
- **How to install:** [install.md](https://github.com/busy-app/busybar-emulator/blob/v0.1.0-beta.6/public-docs/install.md)
- **For agents and scripts:** `busybar-emulator-mac-arm64.zip`, `busybar-emulator-mac-x64.zip`, `install-macos.sh`, `install-windows.ps1`
- **For checks and the built-in update:** `SHA256SUMS`, `update.json`, `update.json.sig`
- **Source:** the tag `v0.1.0-beta.6`. Licenses: `THIRD_PARTY_NOTICES.md` in the repository and inside the app.

