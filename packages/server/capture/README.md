# Capture: screenshots for the catalog

`png.mjs` turns a frame of the BUSY Bar's displays, exactly as the core holds it and `GET /api/screen` sends it, into a
PNG that the BUSY Apps Catalog accepts as a screenshot. `catalog-png.mjs` checks a PNG against the catalog's
screenshot rules: it says which check id rejects it, or that it passes and the catalog's build will accept it, or that
it passes the rules but the build is not vouched for. Both use Node's standard library only. The command
`busy-emulator screenshot` (`../cli/commands/screenshot.mjs`) uses both: it takes the frame from `GET /api/screen`,
encodes it in the command line's process, checks the file and prints the answer.

## What the encoder guarantees

- **Native size.** Front display 72×16, back display 160×80: one PNG pixel per LED or OLED pixel, no scaling.
  `encodeScaledScreenPng(name, frame, scale)` gives the same frame enlarged 2 to 32 times (`MAX_SCALE`), each pixel a
  square of its color with nothing blended, in the same format and with the same chunks; it is for people and for
  models that read pictures, not for the catalog.
- **Exact pixels.** Front: 8-bit RGB (color type 2); each pixel is the frame's B, G, R bytes in R, G, B order.
  Back: 8-bit grayscale (color type 0); 4-bit level `n` is written as `n × 17` (0, 17, … 255), the mapping the BUSY Bar's
  own local web uses to show this frame. The back display's rightmost 12 columns are the firmware's status bar and are
  part of the frame like any other pixels.
- **Nothing but the image.** Signature, `IHDR`, one `IDAT`, `IEND`, valid CRCs, nothing after `IEND`. No ancillary
  chunks: no time, software name, color profile or anything else about the machine that wrote the file.
- **Deterministic.** Every row uses filter 0 and the data is deflated at level 9, so the same frame gives the same
  bytes with the same zlib. Node 22.20 and 24.22 (zlib 1.3.1 and 1.3.2.1) gave identical bytes on 398 frames in a one-off check
  (no test pins the bytes); a Node built against system zlib 1.2.12 gave other bytes with the same pixels. Nothing reads the clock, the disk or
  the environment.
- **Why grayscale for the back display:** the OLED has one channel, the catalog's fix text asks for "an 8-bit PNG",
  and its build re-saves every screenshot as RGBA anyway, which turns gray `v` into `(v, v, v, 255)`. 8-bit gray
  rather than 4-bit keeps the file to one obvious format with the BUSY Bar's own 0..255 values in it.

## How it follows the catalog's rules

`catalog-png.mjs` is the only file here with ported code: its manifest-stage rules are a port to JavaScript of
`tools/check_png.py` of the BUSY Apps Catalog repository at commit `a98e2df09a5a` (`RULES_COMMIT`, the commit
`../readiness/catalog-registry.json` is pinned to), which is under the MIT License, Copyright (c) 2026 Flipper
Devices; the file carries the notice in full. It is published and shipped with the permission of the catalog's owner
(11 November 2026), with its tests (`catalog-png.test.mjs`) and the runner of the catalog's own checker
(`catalog-test-support.mjs`), which needs a checkout of the catalog's repository and the maintainers' registry tool,
and is skipped where they are not there. `CATALOG_ICON_RULES` gives the same checks the sizes of an app's icons (8×8
and 11×11, at most 64 KiB), for `busy-emulator check`. Everything else here works without the file: `png.test.mjs` and
`test-support.mjs` use nothing of the catalog, `png-bench.mjs` times the check only where the file is, and the
`screenshot` command of a copy that lacks it says that it did not check. The encoder (`png.mjs`) and the build-stage
part of the checker are the emulator's own code.

A screenshot is checked when the catalog reads the manifest (`screenshot_png`, `back_screenshot_png`) and again on
its copy during the build (`screenshot_final`, `back_screenshot_final`), which then re-saves the file as RGBA
through Pillow. Every rule reports the check's one id; the catalog stops at the first rule a file breaks. The
manifest-stage rules, in the order the catalog applies them:

1. The file is at most 2 MiB.
2. It starts with the PNG signature.
3. Chunks are read up to `IEND`: a chunk must not run past the end of the file, and every chunk's CRC must match.
4. The first chunk is `IHDR` with 13 bytes of data; there is no second `IHDR`.
5. The size is exactly 72×16 (front) or 160×80 (back).
6. Color type and bit depth are a pair PNG defines; compression and filter method 0; interlace 0 or 1.
7. The bit depth is not 16.
8. `IEND` is empty and is the last thing in the file; the file must reach `IEND` and have at least one `IDAT`.
9. A palette image has a `PLTE` chunk; a grayscale image under 8 bits has no `tRNS`.
10. The joined `IDAT` data is one complete zlib stream with nothing after it and inflates to at most 1 MiB (with a
    32 KiB window, whatever the stream's header declares).
11. Every row starts with a filter type 0–4, and the rows (Adam7 passes when interlaced) fill the data exactly.

Pillow, at the build stage, refuses some files these rules accept. The checker does not model Pillow; it vouches for
the build stage only for files made of these chunks, each well formed:

- `IHDR`, `IEND`, and `IDAT` chunks that follow one another with nothing between them;
- `PLTE` in a palette image only, once, before the image data, 1–256 colors, and every pixel's index inside it;
- `tRNS` once, before the image data: 2 bytes for grayscale, 6 for RGB, 1 up to the number of colors, after `PLTE`, for a
  palette image (none for grayscale or RGB with alpha);
- `pHYs` (9 bytes), `gAMA` (4), `cHRM` (32), `sRGB` (1, intent 0–3), `tIME` (7), each once, anywhere;
- `tEXt` with a keyword of 1–79 bytes; uncompressed `iTXt` with a keyword; in both, a keyword that is not one of
  the names Pillow keeps in an image's `info` (`PILLOW_INFO_KEYS` in `catalog-png.mjs`, taken from Pillow 12.2.0:
  a text chunk named `transparency`, `interlace` or `bbox` breaks the catalog's re-save);
- `eXIf` once;
- `iCCP` once, before `PLTE` and the image data, method 0, a profile that inflates to at most 1 MiB;
- `bKGD` once, before the image data, in the image's format (an index of the palette, 2 bytes for grayscale, 6 for
  RGB); `cICP` once, before `PLTE` and the image data, 4 bytes, matrix 0, full-range flag 0 or 1.

Anything else gets "unverified": `zTXt`, compressed `iTXt`, `sBIT`, `hIST`, `sPLT`, `mDCV`, `cLLI`,
APNG chunks (`acTL`, `fcTL`, `fdAT`), private and unknown chunks, chunk types that are not letters, a chunk between
two `IDAT` chunks, a suggested palette in a truecolor image, a malformed or misplaced chunk from the list above, and
a palette index outside the palette. Some of these the catalog's build accepts, some it rejects; the checker does
not say which.

`checkCatalogPng(bytes, "front" | "back")` returns:

- `{ verdict: "fail", id, reason, message }`: the manifest-stage check `id` rejects the file;
- `{ verdict: "unverified", id, reason: "build-unverified", detail, message }`: the manifest-stage rules pass, but
  the build check `id` may still reject the file. This is not "ready";
- `{ verdict: "pass" }`: the manifest-stage rules pass and the file is of the kind vouched for above. Only this
  means ready. A grayscale or RGB file with a transparency key (`tRNS`) gets `{ verdict: "pass", note }`: the
  catalog accepts it, but its copy makes every pixel of the key color transparent, and the note says so. The key has
  16 bits a sample; Pillow matches only its low byte with the 8-bit pixels (`rgbT2rgba` in its `Convert.c` takes
  `& 0xff`), so a key of `0x0100` makes black transparent, and the note names the color by the low byte too. A test
  checks, against the catalog's own re-save, that the pixels it makes transparent are exactly those of that color.

The build-stage claim rests on running the catalog's own code (commit `a98e2df09a5a`), on 10 and 11 November 2026:

- the tests build every file kind above (each color type and depth, interlaced or not, each listed chunk before and
  after the image data) and check that the catalog's build accepts each one;
- two fuzz rounds by an independent reviewer, regenerated from his seeds and run against the current checker: 55,407
  files of every kind, broken and not, and 51,416 files made only of the chunks listed above, with edge values;
  none of the files the checker calls "pass" was rejected by the catalog's build or re-saved with other pixels;
- `bKGD` and `cICP`, well formed, malformed and of the wrong length, on both displays and every color type: the
  catalog's build accepted all 532 files; the checker still vouches only for the well-formed ones.

The current checker was run on Pillow 12.2.0 (Python 3.12); the `bKGD` and `cICP` files also on Pillow 12.0.0
(Python 3.14), with the same result, and the reviewer ran his rounds on both against earlier versions of the
checker. The catalog pins Pillow 11.3.0, on which nothing has been run.

The checker runs synchronously and its time grows with the file. A 2 MiB file of 12-byte chunks took a median of
34–116 ms and up to 235 ms on an Apple Silicon Mac busy with other processes (the reviewer measured at load
average 32 on 12 cores); an idle machine is faster, but the bound to plan for is hundreds of milliseconds.
Do not call it on the BUSY Bar's tick path; read the file and check it off the tick.

## Speed

`png-bench.mjs` measures 1000 runs. On an Apple Silicon Mac under heavy load from other processes, a random frame
(the worst case for deflate) took a median 0.07 ms (front) and 0.10 ms (back) to encode, with CPU time at most 6 ms
for the worst run; wall time of single runs reached 110 ms when the system preempted the process. Levels 1, 6 and 9
take the same time within noise on images this small (3.5 KB and 12.9 KB of raw data), so level 9 costs nothing. An
enlarged copy at 8 times took a median of 0.5 ms for the front display and 30 ms for a random back frame (0.8 MB of
image data at level 9; 1.7 ms for a black one) on an Apple Silicon Mac at load average 13. The `screenshot` command
encodes in its own process, never in the server's: all the BUSY Bar's tick shares a process with is the server's answer to
`GET /api/screen`. With the command run back to back (about 9 a second, front and back in turn, each with an enlarged
copy at 8 times) beside an app that animates, the meter `test/ticks.mjs` counted 125.0 ticks a second, none missing,
and a lateness of 4.2 ms at the 99th percentile, as without it (5.3 ms), on 11 November 2026.

## Tests

```
node --test "emulator/packages/server/capture/*.test.mjs"
```

The tests decode every file with a separate reader and compare it pixel by pixel with the frame, including frames
from `GET /api/screen` of an emulator the test starts (and the BUSY Bar's golden frames for the same scenes), and check
one broken file per rule. They are part of `npm test` and `npm run test:unit` (from `emulator/`). To compare with the catalog's own checker, set `BUSY_CATALOG_CHECKOUT` to a checkout of
the catalog repository and have Python 3 (with Pillow for the build stage); the tests run its code from the pinned
commit, exported to a temporary folder, print the Python and Pillow versions, and skip with a message otherwise. A
test fails when the registry snapshot names another catalog commit than `RULES_COMMIT`: the rules must then be
re-derived.

The live test needs the engine's build of the default firmware (`packages/engine/build/`, in the repository; no
firmware checkout) and a free port: any, or with `BUSY_CAPTURE_TEST_PORT` the first free one of the nine from it. Without them it is skipped with a warning; set
`BUSY_CAPTURE_LIVE=required` (in CI) to make that a failure.

## Clips for a post

`record.mjs` answers `POST /_emu/record` on the management address (`busy-emulator record`): it records a take of both
displays, stepping the held clock by the clip's frame times and pacing the steps in real time, and has the app's window
encode the MP4 (`packages/app/src/capture-window.mjs`); `POST /_emu/record/stop` ends the take under way early, and
its clip is made of the frames it has (the window's Record button and `record --stop`). `gif.mjs` is the emulator's own GIF89a encoder (LZW, a palette
of the frame's exact colors when there are 256 or fewer, equal frames merged), and `led-raster.mjs` draws the front
display as LED dots in whole pixels for it. Neither uses anything but Node's standard library. A take's GIF is made
by `encodeFrontGif` from the BUSY Bar's own 72×16 frames, on a thread of its own (`gif-worker.mjs`), so that the BUSY Bar and the
window go on answering: each distinct frame is indexed once at the display's size, spread over the dots and
compressed once, and a step that repeats the one before only lengthens its delay; no step is drawn in RGB. A GIF has
at most 750 frames (seconds × fps) and frames × scale × scale at most 96000 (`clip-limits.mjs`, which the command
line checks too): at scale 26 that is 142 frames. At worst, a screen that changes in every LED at every step, such
a file is some 20 MB, encoded in 2 to 3 s. `gif.test.mjs` decodes the GIF with a decoder of its own and checks every
pixel against the RGB way (`encodeGif` of `renderFront`).
