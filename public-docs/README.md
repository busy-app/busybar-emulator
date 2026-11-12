<img src="images/emulator-logo.png" width="96" height="96" alt="The BUSY Bar Emulator's icon: the BUSY logo on a blueprint grid">

# BUSY Bar Emulator

A BUSY Bar on your computer: write a BUSY Bar app, run it, take its screenshots and a clip, and get it ready for the
catalog, all without a BUSY Bar.

This is the first trial release, 0.1.0-beta.1.

| | Download | |
|---|---|---|
| **macOS**, Apple Silicon (M1 and later) | **[busybar-emulator-mac-arm64.dmg](https://github.com/busy-app/busybar-emulator/releases/latest/download/busybar-emulator-mac-arm64.dmg)** | about 210 MB |
| **macOS**, Intel | **[busybar-emulator-mac-x64.dmg](https://github.com/busy-app/busybar-emulator/releases/latest/download/busybar-emulator-mac-x64.dmg)** | about 215 MB |
| **Windows** (x64) | **[busybar-emulator-win-x64-setup.exe](https://github.com/busy-app/busybar-emulator/releases/latest/download/busybar-emulator-win-x64-setup.exe)** | about 250 MB |

Which Mac is yours: Apple menu → About This Mac says "Chip: Apple M…" on Apple Silicon and "Processor: … Intel …" on
Intel. [SHA256SUMS](https://github.com/busy-app/busybar-emulator/releases/latest/download/SHA256SUMS) lists the checksum of
each file.

The app is not notarized by Apple and not signed for Windows yet, so the system warns you the first time you open it:
[what to do](install.md#opening-it-for-the-first-time). It installs for your user only, without administrator rights.
Node, npm and the BUSY Bar tools are inside it.

## Two ways to start

The first time it opens, the emulator's window asks which of the two you will do. "I'll write the code" opens
Create app: a template or an empty app, its name, icon and folder; the app is then built and running on the BUSY Bar. "My
AI agent will" gives you a text to paste into your agent, with the command line's path on your computer. Answered
once, the question does not come back by itself; "Getting started", at the foot of the Apps list, shows it again.

### I'll do it myself

1. Download the file for your system. On macOS, drag BUSY Bar Emulator to Applications; on Windows, run the setup.
   Open the app: its window shows the BUSY Bar.
2. In a terminal, make a project from the official app template and run it on the emulated BUSY Bar.

   macOS:

   ```sh
   cli=~/.busy-emulator/bin/busy-emulator
   "$cli" create my-app --author "Your Name"
   cd my-app
   "$cli" build
   "$cli" run
   ```

   Windows, in PowerShell:

   ```powershell
   $cli = "$env:LOCALAPPDATA\busy-emulator\bin\busy-emulator.exe"
   & $cli create my-app --author "Your Name"
   cd my-app
   & $cli build
   & $cli run
   ```

3. Change `src/main.ts`, then `build` and `run` again: `run` installs what `build` made, starts it and says whether
   it runs. Or leave `dev` running: it does both on every save and shows the app's console. In the window, the
   app's Refresh builds, installs and starts it once.

   | Command | What it does |
   |---|---|
   | `dev` | Builds, installs and starts the app again on every save, and shows its console |
   | `logs` | Shows what the app printed with `console.log`, and why it stopped if it did |
   | `screenshot` | Saves the front display as a PNG in the catalog's format (`--back` for the back display) |
   | `record` | Records a short clip of the app on the BUSY Bar, an MP4 to post (`--gif` for a GIF) |
   | `check`, `submit` | Check the project against the catalog's rules and prepare its pull request |
   | `publish`, `catalog-texts` | Make the project ready for its public repository and the catalog, step by step |
   | `help` | Lists every command |

`create` downloads the template and its dependencies from the npm registry; the other commands need no internet. The
project's own `busy-cli` does the building and installing, so with Node 24 of your own
`npx busy-cli app install --addr 127.0.0.1:8640` works as well.

### My AI agent will do it

Give an agent that can run commands (Claude Code, Codex, Cursor) these lines, with your idea:

```text
Make me a BUSY Bar app: <your idea>.
Follow https://go.busy.app/agents. I have no BUSY Bar, so use BUSY Bar Emulator as that page says.
```

The agent installs the emulator if it is missing, makes the project, runs it and checks the screenshots. It asks you
first:

- to download the emulator from this repository's releases on GitHub (the sizes above) and install it for your user;
- to run `busy-emulator` commands. Allowing them lets the agent start the emulator and build and run your project's
  code on your computer.

How the agent installs it: [install.md](install.md#for-agents-install-and-start-the-emulator).

A chat client that cannot run commands, such as Claude Desktop, gets the emulator as MCP tools instead:
[BUSY Bar Emulator in a chat client](mcp.md).

## What you get

- **The BUSY Bar in a window.** Both displays and, centered under the BUSY Bar, its controls: the mode switch, Start / Pause
  with its two status LEDs, Back and the wheel. Flat, or as a 3D model you turn and zoom by hand, with quick views
  from the front, the back, the top and the side. Beside it your apps (Create app, and a menu on each row with
  Delete), the chosen app with its settings, and its console.
- **The BUSY Bar's own code.** The JavaScript runtime, the drawing, the system screens and the BUSY Bar's local web are the
  code of firmware 1.3.1, compiled to WebAssembly. Their frames are compared with a BUSY Bar's, pixel by pixel. The local
  web, with your app's settings page, opens from App settings in the app's section of the window (or BUSY Bar → App
  Settings in the menu, Cmd+, or Ctrl+,), or at http://127.0.0.1:8640 in a browser.
- **The BUSY Bar's speed and limits.** Your app's JavaScript takes the time it would take on a BUSY Bar, and the same memory,
  `fetch` and API limits apply. What is slow or too big here is slow or too big on a BUSY Bar.
- **Screenshots for the catalog.** PNG files of 72×16 and 160×80 pixels with nothing in them but the pixels: from
  Screenshot over the BUSY Bar in the window, with Front, Back or both ticked (Cmd+Shift+S, Ctrl+Shift+S on Windows), or
  from `screenshot` on the command line.
- **A clip for your post.** **Record** in the window's top bar, or `record` on the command line, makes an MP4 of the
  emulator's window or of the BUSY Bar alone; `record --gif` makes a GIF of the front display:
  [a clip for your post](first-app.md#a-clip-for-your-post).
- **The catalog's checks before you submit.** `check` says what the BUSY Apps Catalog would say about your project;
  `submit` writes the files its pull request needs.
- **Publish, step by step.** **Publish** in the window, or `publish` on the command line, takes you from the
  catalog's texts, the screenshots, the README, a license and the repository's files through a pre-flight check and
  the package; then it publishes the app to a public GitHub repository of yours and opens the pull request to the
  catalog. It signs in through GitHub CLI, which is inside the app
  ([how](first-app.md#publishing-step-by-step)).
- **A command line for people and agents.** `busy-emulator`, with `--json` on every command.

Create app starts a project from a template, an empty app, a folder you have, a repository on GitHub (Import from
GitHub) or an app package (.tgz): [in the window](first-app.md#in-the-window). A BUSY Bar has the final word:
[how the emulator differs from a BUSY Bar](differences.md).

## More

- [From zero to a catalog submission](from-zero-to-catalog.md): the whole way, by hand in the window or with an AI
  agent, from the download to the pull request
- [Your first app on the emulated BUSY Bar](first-app.md): create a project, build it, run it and take a screenshot;
  then [submit it to the catalog](first-app.md#submitting-to-the-catalog)
- [agents.md](agents.md): instructions for AI agents making an app without a BUSY Bar
- [Installing BUSY Bar Emulator](install.md): what is downloaded from where, the first open, the install sequence
  for agents, removing it
- [BUSY Bar Emulator in a chat client (MCP)](mcp.md): the emulator's tools for Claude Desktop, Cursor and others
- [Problems and ideas](troubleshooting.md#reporting-a-problem): what to put in a report
- [What the emulator does on the network and on disk](network-and-disk.md)
- [Troubleshooting](troubleshooting.md), with a section for Windows and [every code](troubleshooting.md#every-code-a-to-z)
- [How the emulator differs from a BUSY Bar](differences.md)
- Writing the app itself: the `AGENTS.md` and `README.md` in your project, and the
  [BUSY Bar HTTP API](https://docs.busy.app/bar/dev/http-api)

BUSY Bar Emulator is free software under GPL-2.0-or-later, © Flipper FZCO.
