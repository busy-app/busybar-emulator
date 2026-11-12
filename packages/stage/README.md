# The 3D view of the bar

The device window can show the bar as a model in depth instead of the flat picture: the emulator's live frames on
both displays, the buttons, the wheel and the mode switch usable on the model, the bar turned by hand or flown to
one of four quick views. The
flat view stays the default and the fallback: the 3D view is a module of its own, and nothing else depends on it.

| Folder | What it is |
| --- | --- |
| `frame/` | What the view's frame loads, served by the emulator at `/emulator/stage3d/frame/`: its page (`stage.html`, `stage.css`, `stage.js`, `leds.js`), the player (`player/`) and the scene (`scene/`). This folder, and nothing else of the package, ships in the app |
| `frame/player/` | The Tride web player 0.16.0, its files unmodified, with the player's `LICENSE` and `THIRD_PARTY_NOTICES.md`. The player is under the Tride Players Licence 1.2, not under the emulator's license; get the player from https://github.com/trideapp/tride-web, not from here |
| `frame/scene/` | `bar.trd`, the scene: the model of the BUSY Bar (Copyright Flipper FZCO), lit and wired to inputs; `bar.json`, which node of the scene is which control; `scene.json`, the scene's contract with the page |
| `scene-build/` | The model as GLB (a maintainer's tools) and `record.mjs`, which installs and records a scene delivery |
| `versions.json` | Which player and which scene these are, with the checksum of every file |
| `test/` | The pictures of the displays, and the files against `versions.json` |

The other half is in the server's package: `packages/server/stage3d.mjs` serves the frame's files, and
`packages/server/legacy-window/stage3d/mount.js` is the window's side, `window.emulatorStage3D`.

## The parts and what each may do

```
the device window (its page)                         the frame (sandboxed, no origin)
  legacy-window/stage3d/mount.js   -- messages -->     frame/stage.js + the Tride player
  reads /_emu/events, posts keys   <-- messages --     draws; knows nothing of the server
```

- **The frame** is an `<iframe sandbox="allow-scripts">`. It has no origin, so nothing of the server is its own: no
  API, no storage, no cookies. Its policy, sent with every one of its files, is
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; connect-src 'self'; style-src 'self';
  base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`. After it has loaded its own
  files it makes no request at all.
- **The server** lets a page without an origin read the files under `/emulator/stage3d/frame/` with GET, and refuses
  it everything else, as it refuses every page that is not its own (`packages/server/entry-guard.mjs`). The files are
  the same for everybody and say nothing of the bar or the computer.
- **The window's side** is the frame's only link to the bar. It reads the same stream the flat view reads and sends
  the same requests the flat view's controls send.

## For the window: `window.emulatorStage3D`

The page loads `/emulator/stage3d/mount.js` with one `<script>` tag.

| | |
| --- | --- |
| `available()` | `Promise<boolean>`: WebGL2 is there and so are the view's files. When `false`, `reason` is a short text for a tooltip (`3D view needs WebGL2`) |
| `mount(box, { view, onCamera })` | Puts the view into `box`, an element of the page; the view fills it (give the box a size). Resolves once the bar is drawn, seen from `view` (`front` when left out). Rejects, leaving nothing in the page, when the view does not come up: keep the flat view then. `onCamera(view)` hears where the camera went by the person's hand: `null` once the bar is turned away from the quick view, a view's name after a double click took it back there |
| `camera(view)` | The camera flies to `front`, `back`, `top` or `side` (`views`), at the views' distance; `view` says where it is or is going, `null` once the bar is turned by hand |
| `inset({ left, right, top, bottom })` | What the page covers over the view's sides, CSS pixels: the bar is framed clear of it, in the middle across, and in the middle of what is left clear between the top and the bottom |
| `unmount()` | Takes the view away |
| `mounted` | `true` while the view is in the page |

The page hides its flat picture while the view is mounted and shows it again after `unmount()`; the keyboard and the
window's own controls go on working as they are.

## The messages

Every message is an object with a `type`, sent with `postMessage`. The window's side accepts messages only from its
frame, the frame only from the page that holds it; both ignore what they do not know.

### To the frame

| `type` | Fields | Meaning |
| --- | --- | --- |
| `frame` | `front`: `ArrayBuffer`, 72x16 pixels, 3 bytes each, blue, green, red (as `/api/screen` gives display 0); `back`: `ArrayBuffer`, 160x80 pixels, 4 bits each, two pixels a byte, the first in the low half (display 1). Either may be left out when it has not changed | The displays' pictures. The frame draws the front one as LEDs, the way the flat view does |
| `state` | `mode`: `busy`, `custom`, `off`, `apps` or `settings` | Where the mode switch stands |
| `lights` | `preset`: `off`, `static`, `fade`, `rainbow`, `blink` or `notification`; `color`: `"#rrggbb"`; `brightness`: 0 to 1 | The bar's two RGB LEDs at the ends of Start, as the window's event `lights` gives them (the flat view's strips show the same). Each message starts the preset again. The frame writes the scene's `led_left`, `led_right` (linear RGB, `[r, g, b]`) and `led_left_level`, `led_right_level` (0 to 1) from it, moving them as the firmware's presets do, and only when they change |
| `key` | `key`: `start`, `back`, `ok`, `up` or `down`; `action`: `press` or `release` | A button the bar took, from anywhere (the keyboard, the window's own controls, the command line): the model's button goes down and up. `up` and `down` are clicks of the wheel, clockwise and counterclockwise |
| `view` | `visible`, `focused`: booleans | Nobody can see the view (it rests and draws nothing), or the window is not the one in front (the displays are redrawn ten times a second) |
| `camera` | `view`: `front`, `back`, `top` or `side`; `atOnce`: boolean | The camera flies to the view (eased, 0.75 s; a new one starts from where the camera is), or is there at once |
| `inset` | `left`, `right`, `top`, `bottom`: CSS pixels | What the page covers over the frame's sides: the bar keeps clear of the larger of each pair; across it stays in the middle, up and down it stands in the middle of what the top and the bottom leave clear (over the page's controls) |
| `reset` | | The front view |
| `look` | `turn`, `tilt`: radians; `zoom`: the distance as a share of the views' (1 when left out) | A view by its angles, at once, for screenshots and checks |
| `probe`, `pick` | `id`; `probe` also `full` (boolean), `pick` also `x`, `y` in the frame's pixels | For checks: what is on the canvas (its size, mean color, the share of lit pixels, the box the bar takes as shares of the frame, the view the camera rests at, the camera's inputs and zoom, the LEDs' inputs (`lights`), the problems the player reported; with `full`, all its pixels, RGBA, and the front display's picture as given to the scene), and which control is under a point and whether the bar is. Answered with the same `type` and `id` |

### From the frame

| `type` | Fields | Meaning | What the window's side does |
| --- | --- | --- | --- |
| `ready` | `build`: the player's version | The bar is drawn | `mount()` resolves; the state and the newest pictures are sent |
| `error` | `message` | The view did not come up | `mount()` rejects and the frame is removed |
| `key` | `key`: `start`, `back` or `ok`; `action`: `down` or `up` | A button pressed or released on the model (`ok` is the wheel pressed) | `POST /_emu/key?key=<key>&action=<action>` |
| `wheel` | `direction`: `up` (clockwise) or `down` | One click of the wheel: a detent passed while dragging it, or a step of scrolling | `POST /api/input?key=<direction>` |
| `mode` | `position` | The mode switch moved to a position | `POST /api/input?key=<position>`, unless the bar is there already |
| `keyboard` | `event`: `keydown` or `keyup`; `key`, `code`, `repeat`, `shiftKey` | A key pressed while the frame has the focus | The same event is dispatched in the page, so the page's own shortcuts work wherever the focus is |
| `camera` | `view`: `null`, or `front`, `back`, `top`, `side` | The person turned the bar away from the quick view (`null`), or a double click took the camera back to one | `view` follows; `onCamera(view)` (the window lights that view's button, or none) |
| `problem` | `message` | Something the player or the frame's policy reported | Kept for checks (`window.emulatorStage3D.problems`) |

## On the model

- **Start, Back:** press and hold as on the bar.
- **The wheel:** drag it round to turn it (24 clicks a turn), click it for OK, hold it for a long OK. Scrolling
  over the bar turns it too, as in the flat view.
- **The mode switch:** drag the lever to a position, or click it for the next one (with Shift, the one before).
- **The bar itself:** a drag anywhere beside the controls (on its body or the background) turns it round and leans
  it, from straight above down to just below its middle (never under the desk); round, it turns without end.
  Scrolling off the bar or a pinch (anywhere) brings it nearer or takes it farther, from half to twice the views'
  distance. A double click beside the controls goes back to the last quick view. The window's buttons Front, Back,
  Top and Side are the quick views: the camera flies there, and a drag goes on from there. The first view is in the
  frame's address, `stage.html#top`.

## The camera

A long lens, 7.2 degrees high (a 190 mm lens on full frame), far enough away to take the whole bar: the bar keeps its
proportions, with none of the bulge of a wide lens. The bar stands on a turntable (`turn`, `tilt`); at every angle
the page places the camera (`distance`, `lift`, `shift`) so that the bar takes 67 % of the frame across or up (that
divided by the person's zoom) and its picture's middle is the frame's middle, and again after every resize. Between
views the page eases `turn`, `tilt` and the zoom over 0.75 s and frames every step of the way; a drag sets them
directly, and the scene's stiff springs (400/40) smooth both.

## Drawing only what changes

A still bar costs nothing: the frame draws when a picture comes, while something moves, and after a resize. Pictures
arrive as raw pixels (`setImagePixels`), at most as often as the bar's displays change. While the page is hidden
nothing is drawn; the newest pictures are shown when it comes back.

## The look

The scene's look (the lights, the glass, how bright the displays glow, the lens) is the Tride agent's; the rest is in `frame/stage.js` (the camera's views, the lens the page frames with, how much of the frame the bar takes). The LED look is
`frame/leds.js`, the same shapes as the flat view's.

## Changing the player or the scene

The player's files are never edited: a new release replaces them all. The scene is changed by the Tride agent; ask for
changes through it (one message: what, why, how we know it's done). Install a delivery with
`node scene-build/record.mjs --delivery <folder> --install`; it writes `versions.json`, and
`node --test packages/stage/test/*.test.mjs` says whether the folder, the record and the contract agree. See
`scene-build/README.md`.
