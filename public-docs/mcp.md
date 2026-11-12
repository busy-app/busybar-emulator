# BUSY Bar Emulator in a chat client (MCP)

A chat client that cannot run commands (Claude Desktop, the chat of Cursor and others) can still make, run and look
at a BUSY Bar app: the emulator's command line has an MCP server, `busy-emulator mcp`. Add it to the client once, and
your assistant gets the emulator's commands as tools, sees the BUSY Bar's screen as a picture and reads the app's log.

An agent that can run commands (Claude Code, Codex, Cursor's agent) needs none of this: it uses the command line
directly, as [the agents' instructions](https://go.busy.app/agents) say. Adding the server to it works as well.

## What you need

BUSY Bar Emulator installed ([how](install.md)) and opened once: at every start it writes its command line to a fixed
path, which is what the client runs.

| | The command line |
|---|---|
| macOS | `~/.busy-emulator/bin/busy-emulator` |
| Windows | `%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe` |

Some clients do not expand `~` or `%LOCALAPPDATA%`: give them the whole path. The emulator writes it into the field
`cli` of `install.json`, in `~/Library/Application Support/BUSY Bar Emulator/` on macOS and in
`%LOCALAPPDATA%\BUSY Bar Emulator\` on Windows. The emulator need not be running when the client starts the server:
the assistant starts it with the `start` tool.

## Adding it

### Claude Desktop

Settings, Developer, Edit Config opens `claude_desktop_config.json`. Add the server under `mcpServers`, with your own
user name in the path, and restart Claude Desktop.

macOS:

```json
{
  "mcpServers": {
    "busy-bar": {
      "command": "/Users/<you>/.busy-emulator/bin/busy-emulator",
      "args": ["mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "busy-bar": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe",
      "args": ["mcp"]
    }
  }
}
```

### Claude Code

macOS:

```sh
claude mcp add --scope user busy-bar -- ~/.busy-emulator/bin/busy-emulator mcp
```

Windows, in PowerShell:

```powershell
claude mcp add --scope user busy-bar -- "$env:LOCALAPPDATA\busy-emulator\bin\busy-emulator.exe" mcp
```

### Cursor

Settings, MCP, Add new global MCP server opens `~/.cursor/mcp.json` (`.cursor/mcp.json` in a project is for that
project only). Add the same entry as for Claude Desktop:

```json
{
  "mcpServers": {
    "busy-bar": {
      "command": "/Users/<you>/.busy-emulator/bin/busy-emulator",
      "args": ["mcp"]
    }
  }
}
```

### VS Code

In a workspace, `.vscode/mcp.json`; for every workspace, the command MCP: Open User Configuration. VS Code names the
key `servers`, not `mcpServers`:

```json
{
  "servers": {
    "busy-bar": {
      "type": "stdio",
      "command": "/Users/<you>/.busy-emulator/bin/busy-emulator",
      "args": ["mcp"]
    }
  }
}
```

### Another client

A server on stdio: the command is the command line's whole path, its one argument `mcp`, no environment of its own.
It speaks MCP 2025-11-25 (and 2025-06-18, 2025-03-26 and 2024-11-05, when the client asks for one of them) with the
`initialize` handshake, and 2026-07-28 without it. Its log goes to stderr; it ends when the client closes its stdin.

### If the client cannot start it

Most often the path is wrong, or has `~` or `%LOCALAPPDATA%` in it, which the client did not expand. Run the same
command in a terminal: `busy-emulator mcp` waits for the client's messages and prints nothing on stdout until it gets
one; Ctrl+C ends it. If the terminal says the file is not there, open the emulator once and take the path from
`install.json` (above).

## What the assistant can do

Then ask, for example: "Make me a BUSY Bar app that counts down to my next meeting, and show me how it looks."

| Tool | What it does |
|---|---|
| `status`, `start` | Whether the emulator runs; start it |
| `create_app`, `list_examples` | A new project from the official template or from an example app |
| `refresh` | Build, install and start the app after a change (`build` and `run` do the steps alone) |
| `screenshot` | The front or back display, enlarged, as a picture the assistant sees; the PNG files too |
| `logs` | What the app printed, its errors, why it ended |
| `press` | The BUSY Bar's buttons and wheel |
| `settings_get`, `settings_set` | The app's settings, as its settings page sets them |
| `typecheck`, `stop` | The project's type check; stop the app |
| `time` | Set the BUSY Bar's clock or let time pass at once, so that a timer runs out now |
| `record` | A short clip of the app for a post |
| `check`, `submit` | The apps catalog's checks; the files of the catalog's pull request |
| `icon`, `catalog_texts` | The app's icons; its name, category and descriptions for the catalog |
| `publish` | The whole Publish path, one step a call: screenshots, README with How to use, license, the repository's files, package; then sign in to GitHub, the public repository, the pull request to the catalog, each of which you confirm in the emulator's window |
| `projects`, `uninstall` | The project folders the emulator knows; take an app off the emulated BUSY Bar |

Every tool has a time limit: half a minute to a minute for those that read, 15 minutes for `build`, `refresh` and
`typecheck`, 20 for `create_app`, up to 17 for a `publish` step that waits for you. Past it, or when the chat client cancels the request, the tool stops with
everything it started and answers `tool_timeout`. Tools that only read (`status`, `list_examples`, `projects`,
`logs`, `screenshot`, `settings_get`) answer while a build runs.

`trust` and `allow-local` have no tool: they are yours to run in a terminal. Publishing goes through the emulator's
window for what only you may decide: the assistant asks you for the license and how AI was used, and you sign in to
GitHub, choose the account, confirm the upload and the pull request, and tick the catalog's author checklist in the
emulator's own dialogs. The assistant cannot do these for you.

Two resources hold the short guide for the assistant: `busy-emulator://guide/start` and `busy-emulator://guide/project`,
the emulator's part of a project's `AGENTS.md`. The assistant writes the app's code itself; a chat client without file
tools needs a way to write files, such as a filesystem server of its own.

## What it may not do

The server grants nothing the command line does not:

- **Only the emulator's own projects.** The project tools take a folder the emulator made with `create_app` (or
  `create`) and a folder you trusted, nothing else. Building a project runs its code on your computer, so a folder
  made another way (cloned, copied, made with `npm create`) is refused with `untrusted_project`. Only you can trust
  it: run `busy-emulator trust <folder>` in a terminal and answer the emulator's dialog. No tool trusts a folder or
  asks for it.
- **No files of its choosing.** No tool reads or writes a file it does not name in its answer: the screenshots (in the
  project's `screenshots/`, or in the emulator's data folder), the project `create_app` makes, what `build`,
  `submit`, `icon`, `catalog_texts` and `publish` write in the project. A picture or screenshot a tool takes in
  (`icon`, `publish` screenshots) must be inside the project's folder; `uninstall` never moves your files.
- **No commands.** No tool runs a program or a shell command it is given. The programs the tools run are the
  project's own tools, as on the command line: `build` runs the project's `busy-cli` and its dependencies.
- **No way into your computer.** Apps on the emulated BUSY Bar may not reach your computer's own services (its
  `localhost` and its own addresses), and no tool can allow a port: a model can be steered by what it reads, and an
  app it sets up could read your services through the BUSY Bar. When your app needs a service of yours, you run
  `busy-emulator allow-local <port>` in a terminal; an assistant with a shell may run it too, and then the emulator
  asks you in its own dialog first. A port you allowed is open to the apps the assistant runs too,
  until the emulator quits: that is your choice.
- **No secrets back.** A setting marked `sensitive` in the app's `settings.json` (a token in a header) reads as
  `(hidden)` in the answers; the assistant can still set it. The command line shows it to you.

Your client asks you before a tool runs, unless you told it not to; allow `refresh`, `screenshot` and `logs` to save
yourself the most questions.
