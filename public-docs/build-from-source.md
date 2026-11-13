# Building from source

This repository holds everything a release of BUSY Bar Emulator is built from. The files a release publishes (the
disk images and zips for macOS, the setup for Windows) are built from the release's tag here, with the commands
below. A build you make yourself is the same app, unsigned: the releases' macOS files are also signed with a
Developer ID and notarized by Apple, which needs the maintainer's certificate.

Each system builds its own files: a Mac the macOS ones, a Windows PC the setup.

## What you need

| | macOS (Apple Silicon or Intel) | Windows 10 or 11 (x64) |
|---|---|---|
| Node | 22 or later, with npm | 22 or later, with npm |
| git | from the Xcode Command Line Tools (`xcode-select --install`) or any other git | [Git for Windows](https://git-scm.com/download/win) |
| Other programs | none: `codesign`, `hdiutil`, `ditto` and `plutil` are part of macOS | none: the C# compiler of .NET Framework 4 (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`), which builds the setup and the command line's launcher, is part of Windows |
| Free disk | 6 GB for a build of the release, 2 GB for the test variant | the same |
| Network | yes, for the downloads below | the same |

The build downloads three things, each pinned to one version and checked against its SHA-256 before it is used:
Electron 45.2.3 (by `npm ci`, from Electron's releases on GitHub), the Node that goes inside the app, 24.22.2 (from
nodejs.org; `packages/app/bundled-node.json`), and GitHub CLI 2.103.3 (from its releases on GitHub;
`packages/app/bundled-gh.json`). They are kept in a cache outside the repository, so the next build downloads
nothing: `~/Library/Caches/busy-emulator-build` on macOS, `%LOCALAPPDATA%\busy-emulator-build` on Windows.

## Build the app

From the repository's top folder:

```sh
cd packages/app
npm ci                                    # Electron and the build's tools
node node_modules/electron/install.js     # Electron's program for this system, if npm ci did not fetch it
npm run dist -- --arch arm64              # macOS, Apple Silicon (--arch x64: Intel; no --arch: both)
npm run dist                              # Windows
```

A build is made from a commit: `npm run dist` refuses a working tree with changes, and the app records the commit it
was built from. The files land outside the repository:

| | Where | What |
|---|---|---|
| macOS | `~/Library/Caches/busy-emulator-build/dist/release/` | `busybar-emulator-mac-arm64.dmg` and `.zip` (and the `x64` ones for Intel) |
| Windows | `%LOCALAPPDATA%\busy-emulator-build\dist\release\` | `busybar-emulator-win-x64-setup.exe` |

`--out <folder>` puts them elsewhere, but never inside the repository. A build takes under a minute once the
downloads are in the cache: one architecture on a Mac, the setup on Windows.

**Your build is not signed.** On macOS it carries the ad hoc signature only, where a release is signed with a
Developer ID and notarized; on Windows neither is signed. A file you built on your own computer carries no
"downloaded from the internet" mark, so macOS and Windows open it without a warning there. Copied to another computer
through a browser, a chat or a mail, it gets the mark, and the first start asks what an unsigned build needs: **System
Settings → Privacy & Security → Open Anyway** on macOS (as for
[releases before 0.1.0-beta.4](install.md#macos)), **More info → Run anyway** on Windows.

## Check the build

The smoke test starts a built app through its own command line, installs an app on its BUSY Bar, runs it and compares the
front display with the expected frame. It runs the test variant, a build that takes its folders from the test and not
from your own, so it never touches your data folder or a running emulator:

```sh
cd packages/app
npm run dist -- --kind test               # the test variant, for this computer
cd ../..
npm run smoke                             # starts it on port 8770 (--port <n> for another)
```

## Run the tests

From the repository's top folder, after `npm ci` in `packages/app`:

```sh
node test/gate.mjs
```

It runs every test of this repository, starts emulators of its own on free ports with temporary folders, and ends
with one summary. Exit code 0 is "all green". The summary names the tests that do not run on this computer, and
where they do run: Windows' tests on Windows, the tests of a release's own files during a release. It takes about 10
minutes on a recent Mac and 15 on Windows; nothing else should load the computer meanwhile, since some suites measure
the emulator's speed.

## The firmware's WebAssembly

The emulator runs the BUSY Bar firmware's own code: `packages/engine/build/<firmware>/runtime.wasm` (the JavaScript
runtime) and `screen.wasm` (the displays, the GUI, the system programs) are compiled from the open firmware,
[busy-app/busybar-firmware](https://github.com/busy-app/busybar-firmware). They are committed, so building the app
does not compile them. To build them again and see that they are the same bytes:

- the firmware commit of each module is in `packages/engine/firmware.json` (`1.3.1`: `8edd2da42ed2`, `dev`:
  `4d1c24ac38e4`) and in `packages/engine/build/<firmware>/build-info.json`;
- the compiler is the Emscripten SDK of the version `firmware.json` names, 7.0.0;
- what the emulator changes in the firmware's code is all in `packages/engine/patches.mjs`, applied to copies during
  the build; what it puts in place of the firmware's OS layer, storage and network is `packages/engine/native/`;
- the build script is `packages/engine/build.mjs` (`--help` says what it compiles and what it replaces).

On macOS, beside the repository's folder:

```sh
git clone https://github.com/emscripten-core/emsdk.git
emsdk/emsdk install 7.0.0
emsdk/emsdk activate 7.0.0
source emsdk/emsdk_env.sh                 # puts emcc on PATH and sets EMSDK

git clone https://github.com/busy-app/busybar-firmware.git
cd busybar-firmware
git checkout 8edd2da42ed2facbab73796c456746e7dcbed2e7
git submodule update --init --recursive lib/jerryscript lib/lvgl lib/mongoose lib/cjson lib/stb/stb_repo lib/heatshrink \
  fbt_layers/core_libs fbt_layers/fbtng
cd ../busybar-emulator

node packages/engine/build.mjs --firmware-repo ../busybar-firmware
git status --short packages/engine/build  # prints nothing: the same bytes as committed
```

The API documentation of BUSY Bar (`build/<firmware>/docs`, served at `/docs/`) is made by two of the firmware's own
scripts, as its build makes it: they need Python 3 with PyYAML and colorlog (`python3 -m pip install pyyaml
colorlog`).

Both firmware versions pin the same commits of these eight libraries, so one checkout builds both. The build ends
with `nothing in build/ changed` when every module came out byte for byte as committed: it rewrites a file only when
its bytes differ. The output does not depend on the folder or the day of the build (paths are mapped, the date and
time macros are refused); it does depend on the compiler, and with another Emscripten version the build warns that
the modules will differ. The committed modules are built on macOS. The build takes under a minute on a recent Mac;
the firmware with its libraries takes 1.1 GB of disk, the SDK 2 GB.

## The 3D view's player

The 3D view of the BUSY Bar draws with the Tride web player 0.16.0, the one part of the emulator that is not open source.
It is under the Tride Players Licence 1.2 of Tride Labs Ltd, not under the emulator's license. Its files are
committed unmodified in `packages/stage/frame/player/`, beside the player's `LICENSE` and `THIRD_PARTY_NOTICES.md`;
`packages/stage/versions.json` records the SHA-256 of each, and the tests compare them. The build downloads nothing
for it. This repository is not a place to get the player from: https://github.com/trideapp/tride-web is.

The model of the BUSY Bar (`packages/stage/frame/scene/bar.trd`) is © Flipper FZCO, all rights reserved, and is shipped for
the emulator's own 3D view.

Nothing else depends on the 3D view. Without the player's files (removed from a fork, say) the 3D view does not come
up and the window keeps the flat view, which is its default; everything else works the same.
