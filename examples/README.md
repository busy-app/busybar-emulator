# Example apps

Three small, finished apps for the BUSY Bar to start your own from. Each is a whole project in the layout of the
official template: the app in `src/`, a settings page (`src/appmeta/settings.json`), both icons, and a README with a
picture of each display.

```sh
busy-emulator create --examples                       # lists them
busy-emulator create my-app --example focus-timer     # a project of your own from one, dependencies installed
```

| Example | What it is |
| --- | --- |
| [focus-timer](focus-timer/README.md) | A focus session you can see: a tree grows while you work, wilts if you give up, and joins a forest when you finish |
| [meeting-cost](meeting-cost/README.md) | What this meeting has cost so far: a stack of money on fire and a counter that ticks every second |
| [status-board](status-board/README.md) | Is it up? A heartbeat for a site, a build or anything that answers JSON, with honest words for every way a request fails |

`create --example` makes the project with the official generator first, so its id, name and author are set as for any
new project, then puts the example's files in place of the template's. The template's `AGENTS.md` stays in the project.

All three were made for a BUSY Bar on firmware 1.3.1 and checked at a BUSY Bar's speed in the emulator: they keep to a 96 KiB
heap, leave the animation to the firmware (`.anim` files, `countdown` elements) and send only the elements that
changed. `test/examples.test.mjs` creates, builds, installs and runs each of them.

## The pictures

Every `.png` and `.anim` of the examples is drawn by `tools/make-art.py`, pixel by pixel, from fixed seeds. It packs
the animations with the firmware's own encoder, so it needs a copy of
[busybar-firmware](https://github.com/busy-app/busybar-firmware) and Pillow:

```sh
FIRMWARE=../busybar-firmware python3 examples/tools/make-art.py
```
