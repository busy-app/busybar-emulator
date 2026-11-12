#!/usr/bin/env python3
"""
Draws the pictures and animations of the example apps: every .png and .anim under examples/<name>/src.

    python3 examples/tools/make-art.py [focus-timer|meeting-cost|status-board ...] [--sheets <folder>]

Everything is drawn by this code, pixel by pixel, from fixed seeds: a run writes the same bytes again. The animations
are packed with the firmware's own encoder (scripts/seq2anim.py of github.com/busy-app/busybar-firmware), so the script
needs a copy of the firmware and Pillow:

    FIRMWARE=<path to busybar-firmware> python3 examples/tools/make-art.py

Without FIRMWARE it looks for busybar-firmware beside the emulator's folder. --sheets also writes every animation as
one enlarged picture, a row per second, to look at without a bar.

Why animations at all: an app's JavaScript draws a whole 72x16 frame about 3.5 times a second on a bar. A .anim file
is played by the firmware itself, 25 frames a second, and the app only says which section of it to play.
"""

import json
import math
import os
import random
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
EXAMPLES = HERE.parent
FIRMWARE = Path(os.environ.get("FIRMWARE", EXAMPLES.parent.parent / "busybar-firmware"))

# 25 frames a second is the rate a bar on firmware 1.3.1 keeps exactly; a 30 fps file plays as 25 there.
FPS = 25

SHEETS = None


def rgba(hex_color, alpha=255):
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(4))


def ramp(stops, t):
    """A color on a ramp of (position, color) stops, positions rising from 0 to 1."""
    t = max(0.0, min(1.0, t))
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if t <= p1:
            return mix(c0, c1, (t - p0) / (p1 - p0) if p1 > p0 else 0)
    return stops[-1][1]


def over(under, top):
    """One pixel drawn over another."""
    a = top[3] / 255
    if a <= 0:
        return under
    out_a = a + under[3] / 255 * (1 - a)
    if out_a <= 0:
        return (0, 0, 0, 0)
    rgb = [round((top[i] * a + under[i] * under[3] / 255 * (1 - a)) / out_a) for i in range(3)]
    return (*rgb, round(out_a * 255))


class Canvas:
    def __init__(self, width, height, fill=(0, 0, 0, 0)):
        self.w, self.h = width, height
        self.px = [[fill] * width for _ in range(height)]

    def copy(self):
        c = Canvas(self.w, self.h)
        c.px = [row[:] for row in self.px]
        return c

    def set(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = color

    def put(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = over(self.px[y][x], color)

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < self.w and 0 <= y < self.h else (0, 0, 0, 0)

    def rect(self, x, y, w, h, color):
        for j in range(y, y + h):
            for i in range(x, x + w):
                self.put(i, j, color)

    def rows(self, x, y, rows, colors):
        """Pixel art from text: each character of `rows` names a color in `colors`; '.' is left as it is."""
        for j, row in enumerate(rows):
            for i, ch in enumerate(row):
                if ch != ".":
                    self.put(x + i, y + j, colors[ch])

    def image(self):
        im = Image.new("RGBA", (self.w, self.h))
        im.putdata([p for row in self.px for p in row])
        return im


def save_png(canvas, path, mode="RGBA"):
    path.parent.mkdir(parents=True, exist_ok=True)
    im = canvas.image()
    if mode == "LA":
        im = im.convert("LA")
    im.save(path, optimize=True)
    print(f"  {path.relative_to(EXAMPLES)}")


def save_anim(frames, sections, path):
    """Packs frames (Canvas) into a .anim with named sections [(name, first, last)]."""
    sys.path.insert(0, str(FIRMWARE / "scripts"))
    try:
        from seq2anim import BSBAnimConverter
    except ImportError as e:
        raise SystemExit(f"The firmware's encoder was not found in {FIRMWARE / 'scripts'} ({e}). Set FIRMWARE to a copy of busybar-firmware.")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="example-art-") as tmp:
        folder = Path(tmp)
        for i, frame in enumerate(frames):
            frame.image().save(folder / f"frame_{i}.png")
        meta = {"fps": FPS, "color_mode": "argb8888", "sections": [{"name": n, "start": a, "end": b} for n, a, b in sections]}
        (folder / "meta.json").write_text(json.dumps(meta))
        BSBAnimConverter().convert_dir(folder, path)
    print(f"  {path.relative_to(EXAMPLES)}: {len(frames)} frames, {path.stat().st_size} bytes, sections {', '.join(n for n, _, _ in sections)}")
    if SHEETS:
        sheet(frames, SHEETS / f"{path.parent.parent.parent.name}-{path.stem}.png")


def sheet(frames, path, scale=6, step=1):
    """Frames side by side on black, a row per second, enlarged: to look at an animation as a picture."""
    frames = frames[::step]
    per_row = max(1, FPS // step)
    w, h = frames[0].w, frames[0].h
    rows = math.ceil(len(frames) / per_row)
    out = Image.new("RGB", (per_row * (w * scale + 4), rows * (h * scale + 4)), (30, 30, 46))
    for i, frame in enumerate(frames):
        im = Image.new("RGBA", (w, h), (0, 0, 0, 255))
        im.alpha_composite(frame.image())
        out.paste(im.convert("RGB").resize((w * scale, h * scale), Image.NEAREST), ((i % per_row) * (w * scale + 4), (i // per_row) * (h * scale + 4)))
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path)


def loop(frames, blend):
    """Makes frames[blend:] loop: its first `blend` frames fade in from the frames that follow the last one."""
    n = len(frames) - blend
    out = []
    for i in range(n):
        if i < blend:
            a, b, t = frames[n + i], frames[i], i / blend
            c = Canvas(a.w, a.h)
            for y in range(a.h):
                for x in range(a.w):
                    c.px[y][x] = mix(a.px[y][x], b.px[y][x], t)
            out.append(c)
        else:
            out.append(frames[i])
    return out


# ---------------------------------------------------------------------------------------------------- meeting-cost

FIRE = [
    (0.00, rgba("#000000", 0)),
    (0.12, rgba("#5A0A00", 120)),
    (0.30, rgba("#C81E00", 230)),
    (0.52, rgba("#FF6A00")),
    (0.74, rgba("#FFC21A")),
    (0.90, rgba("#FFF3A0")),
    (1.00, rgba("#FFFFFF")),
]


def money(canvas, charred=True):
    """A stack of banknotes, 14 px wide, on the bottom five rows; its top edge is charred where the fire sits."""
    colors = {"g": rgba("#1F8A45"), "G": rgba("#35C16B"), "d": rgba("#0F5229"), "l": rgba("#9AF0B8"), "k": rgba("#2A1608"), "o": rgba("#7A2E08")}
    canvas.rows(
        1,
        11,
        [
            "kokkgGGGGgkkok" if charred else "dGGGGGGGGGGGGd",
            "dGGGGGllGGGGGd",
            "dgggggllgggggd",
            "dGGGGGGGGGGGGd",
            "dddddddddddddd",
        ],
        colors,
    )


def fire_frames(count, cooling, seed, sparks=0.0, surge=None):
    """
    The classic fire: heat rises from the top of the banknotes, drifts sideways and cools. `cooling` is how fast it
    cools (lower is a taller flame); `surge(i)` scales the heat of frame i (a flare).
    """
    rnd = random.Random(seed)
    w, h, base = 16, 12, 11
    heat = [[0.0] * w for _ in range(h)]
    embers = []
    frames = []
    warm = 30
    for i in range(-warm, count):
        k = surge(i) if surge and i >= 0 else 1.0
        for x in range(w):
            edge = min(x - 1, 14 - x)  # the stack spans x 1..14
            heat[base][x] = 0.0 if edge < 0 else min(1.0, (0.55 + 0.45 * rnd.random()) * (0.6 + 0.2 * min(edge, 3)) * k)
        for y in range(1, h):
            for x in range(w):
                r = rnd.randrange(3)
                tx = min(w - 1, max(0, x + r - 1))
                heat[y - 1][tx] = max(0.0, heat[y][x] - rnd.random() * cooling / k)
        for e in embers:
            e[1] -= e[2]
            e[0] += rnd.choice((-1, 0, 0, 1)) * 0.5
            e[3] -= 0.09
        embers = [e for e in embers if e[3] > 0 and e[1] >= 0]
        if rnd.random() < sparks * k:
            embers.append([rnd.uniform(4, 11), 8.0, rnd.uniform(0.4, 0.8), 1.0])
        if i < 0:
            continue
        c = Canvas(16, 16)
        money(c)
        for y in range(h):
            for x in range(w):
                # The flames fade out towards the sides and the top of their 16x16 box instead of being cut by it.
                fade = min(1.0, (x + 0.5) / 3.0, (15.5 - x) / 3.0, (y + 1) / 3.0)
                color = ramp(FIRE, heat[y][x] * fade)
                if color[3]:
                    c.put(x, y, color)
        for ex, ey, _, life in embers:
            c.put(round(ex), round(ey), rgba("#FFD27A", round(255 * min(1.0, life))))
        frames.append(c)
    return frames


def meeting_cost(out):
    # The fire moves every other frame (12.5 times a second): calmer on LEDs, and half the file.
    twice = lambda frames: [f for f in frames for _ in (0, 1)]
    calm = twice(loop(fire_frames(31, 0.3, 11), 6))  # 25 steps: two seconds
    hot = twice(loop(fire_frames(31, 0.17, 12, sparks=0.2), 6))
    flare = twice(fire_frames(16, 0.17, 13, sparks=0.6, surge=lambda i: 1.0 + 1.6 * math.exp(-((i - 3) / 4.0) ** 2)))
    frames = calm + hot + flare
    save_anim(frames, [("calm", 0, 49), ("hot", 50, 99), ("flare", 100, 131)], out / "src/animations/fire.anim")

    # Before the meeting the money is whole.
    whole = Canvas(16, 16)
    money(whole, charred=False)
    save_png(whole, out / "src/images/money.png")

    # The currency signs, 7x9, in the weight of the bar's bold font: its fonts are ASCII, so the euro, the pound and
    # the yen have to be pictures, and the dollar is one too, to match them.
    signs = {
        "usd": ["...#...", ".#####.", "##.#...", "##.#...", ".#####.", "...#.##", "...#.##", ".#####.", "...#..."],
        "eur": [".......", "..####.", ".##..##", "####...", ".##....", "####...", ".##..##", "..####.", "......."],
        "gbp": [".......", "..###..", ".##.##.", ".##....", "####...", ".##....", ".##....", "#######", "......."],
        "jpy": [".......", "##..##.", "##..##.", ".####..", "######.", "..##...", "######.", "..##...", "......."],
    }
    for name, rows in signs.items():
        sign = Canvas(7, 9)
        sign.rows(0, 0, rows, {"#": rgba("#FFFFFF")})
        save_png(sign, out / f"src/images/sign_{name}.png")

    # The APPS menu icons. Front: 8x8 in color. Back: 11x11, drawn by the menu in its text color from the alpha
    # channel alone, so the shape is in the transparency.
    front = Canvas(8, 8)
    front.rows(
        0,
        0,
        [
            "...y....",
            "..yo.y..",
            "..oOoo..",
            ".oOYOo..",
            ".rOYOr..",
            "GGGGGGGG",
            "GllGGllG",
            "dddddddd",
        ],
        {"y": rgba("#FFC21A"), "o": rgba("#FF6A00"), "O": rgba("#FF8F1A"), "Y": rgba("#FFF3A0"), "r": rgba("#C81E00"), "G": rgba("#35C16B"), "l": rgba("#9AF0B8"), "d": rgba("#0F5229")},
    )
    save_png(front, out / "src/appmeta/icon_front_8x8.png")
    back = Canvas(11, 11)
    back.rows(
        0,
        0,
        [
            "....#......",
            "...##..#...",
            "...###.#...",
            "..####.##..",
            "..#######..",
            "...#####...",
            "###########",
            "#.........#",
            "#...###...#",
            "#.........#",
            "###########",
        ],
        {"#": rgba("#FFFFFF")},
    )
    save_png(back, out / "src/appmeta/icon_back_11x11.png", "LA")


# ---------------------------------------------------------------------------------------------------- status-board

PULSE_W, PULSE_H = 72, 16
BASELINE = 12

# One heartbeat, 24 px: where the line is above (+) or below (-) the baseline. P wave, QRS spike, T wave.
BEAT = [0, 0, 0, 1, 1, 0, 0, -1, 4, 7, 1, -3, -1, 0, 0, 1, 2, 2, 1, 0, 0, 0, 0, 0]


def trace(beats):
    """The line's height above the baseline for each of the 72 columns, with `beats` heartbeats across."""
    line = [0] * PULSE_W
    for b in range(beats):
        start = round((b + 0.5) * PULSE_W / beats - len(BEAT) / 2)
        for i, v in enumerate(BEAT):
            line[(start + i) % PULSE_W] = v
    return line


def pulse_frames(color, beats, count=50, alarm=None):
    """
    A patient monitor: a bright dot sweeps left to right once in `count` frames and draws the line; what it drew
    fades behind it, and a dark gap runs ahead of it. Every column's brightness depends only on how long ago the dot
    passed, so the last frame runs into the first. `alarm`: a color the whole strip flashes with, twice a sweep.
    """
    line = trace(beats)
    head = rgba("#FFFFFF")
    frames = []
    for f in range(count):
        c = Canvas(PULSE_W, PULSE_H)
        if alarm:
            # The whole screen glows and flashes twice a sweep, in a few steps, so most frames repeat the one before
            # and cost nothing in the file.
            wave = max(0.0, math.sin(2 * math.pi * 2 * f / count))
            level = round(wave * 4) / 4
            c.rect(0, 0, PULSE_W, PULSE_H, (*alarm[:3], round(45 + 95 * level)))
        at = f * PULSE_W / count
        for x in range(PULSE_W):
            age = ((at - x) % PULSE_W) / PULSE_W  # 0 just drawn, 1 about to be drawn again
            if age > 0.9:
                continue  # the gap ahead of the dot
            glow = max(0.0, 1.0 - age / 0.9) ** 1.6
            glow = math.ceil(glow * 10) / 10  # fade in steps: fewer pixels change from frame to frame
            y0 = BASELINE - line[x]
            y1 = BASELINE - line[(x - 1) % PULSE_W]
            top, bottom = min(y0, y1), max(y0, y1)
            # A vertical stroke joins this column to the one before it, as the dot would have drawn it.
            for y in range(top, bottom + 1):
                if y != y1 or top == bottom or y == y0:
                    c.put(x, y, (*color[:3], round(80 + 175 * glow)))
            if age < 0.03:
                c.set(x, y0, head)
            elif age < 0.07:
                c.set(x, y0, mix(color, head, 0.5))
        frames.append(c)
    return frames


def status_board(out):
    green, amber, red, gray = rgba("#22E06A"), rgba("#FFB020"), rgba("#FF3B30"), rgba("#6F8098")
    up = pulse_frames(green, 2)
    slow = pulse_frames(amber, 1)
    down = pulse_frames(red, 0, alarm=red)
    wait = pulse_frames(gray, 0)
    save_anim(up + slow + down + wait, [("up", 0, 49), ("slow", 50, 99), ("down", 100, 149), ("wait", 150, 199)], out / "src/animations/pulse.anim")

    front = Canvas(8, 8)
    front.rows(
        0,
        0,
        [
            "........",
            "...g....",
            "...g....",
            "..gGg...",
            "GGg.g.GG",
            "....gG..",
            "....g...",
            "........",
        ],
        {"g": green, "G": rgba("#8CF5B4")},
    )
    save_png(front, out / "src/appmeta/icon_front_8x8.png")
    back = Canvas(11, 11)
    back.rows(
        0,
        0,
        [
            "...........",
            "....#......",
            "....#......",
            "....#......",
            "...###.....",
            "####.#.####",
            ".....###...",
            "......#....",
            "......#....",
            "...........",
            "...........",
        ],
        {"#": rgba("#FFFFFF")},
    )
    save_png(back, out / "src/appmeta/icon_back_11x11.png", "LA")


# ----------------------------------------------------------------------------------------------------- focus-timer

TREE_W, TREE_H = 24, 15
STAGES = 12
SWAY_FRAMES = 75  # three seconds: a gust of wind once in each

# The canopy at full size: lumps (dx, dy, radius) around the top of the trunk.
LUMPS = [(0.0, -1.6, 4.7), (-5.3, 0.4, 3.3), (5.3, 0.2, 3.2), (-2.9, -3.3, 3.1), (3.1, -3.5, 3.0)]

TREES = {
    # light to dark, then what blooms on it
    "apple": {"leaves": ["#C9F57A", "#6FD63F", "#35A532", "#1D6E2B"], "bloom": "#FF4A3A", "petal": "#FF9A8A"},
    "sakura": {"leaves": ["#FFE9F3", "#FFA9D0", "#EB70AE", "#A84B84"], "bloom": "#FFFFFF", "petal": "#FFC4E0"},
    "maple": {"leaves": ["#FFE07A", "#FFA02E", "#E4581E", "#9C3012"], "bloom": "#FFF2A8", "petal": "#FFB04A"},
}
WILTED = ["#B79C5E", "#8E6C3C", "#6C4B2B", "#493220"]
TRUNK, TRUNK_DARK = "#9A6634", "#5E3B1B"


def noise(x, y, salt=0):
    """A fixed pseudo-random number in [0, 1) for a pixel: the same on every run."""
    n = (x * 374761393 + y * 668265263 + salt * 2147483647) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65536


def tree(growth, kind, sway=0, wilted=False, bloom=None):
    """
    The tree at `growth` 0..1 on a 24x15 canvas, standing on the bottom row. `sway`: the upper canopy leans this many
    pixels. `wilted`: what is left when the session was given up. `bloom`: 0..1, the phase of the twinkle of its
    flowers or fruit, on a full-grown tree.
    """
    c = Canvas(TREE_W, TREE_H)
    look = TREES[kind]
    leaves = [rgba(h) for h in (WILTED if wilted else look["leaves"])]
    ground = TREE_H - 1
    if growth <= 0:
        # A sprout: a stem and two leaves.
        c.set(11, ground, rgba(TRUNK))
        c.set(11, ground - 1, leaves[2])
        c.set(10, ground - 2, leaves[1])
        c.set(12, ground - 2, leaves[0] if not wilted else leaves[2])
        return c

    scale = 0.24 + 0.76 * growth
    height = 1.5 + 5.6 * growth
    ax, ay = 11.5, ground - height + 0.5 + (1 if wilted else 0)

    # The trunk: thicker as the tree grows, with a wider foot at the end.
    width = 1 if growth < 0.35 else 2
    top = round(ay)
    for y in range(top, ground + 1):
        for i in range(width):
            c.set(11 + i - (width - 1), y, rgba(TRUNK_DARK if i == width - 1 and width > 1 else TRUNK))
    if growth >= 0.75:
        c.set(9, ground, rgba(TRUNK))
        c.set(12, ground, rgba(TRUNK_DARK))
    if growth >= 0.5:
        # Two boughs into the canopy.
        reach = round(2 + 2 * growth)
        for i in range(1, reach + 1):
            c.set(10 - i, top + 2 - i // 2 - 1, rgba(TRUNK))
            c.set(11 + i, top + 2 - i // 2 - 1, rgba(TRUNK_DARK))

    def inside(x, y):
        for dx, dy, r in LUMPS[: 1 if growth < 0.3 else 3 if growth < 0.55 else 5]:
            if (x + 0.5 - (ax + dx * scale)) ** 2 + (y + 0.5 - (ay + dy * scale)) ** 2 <= (r * scale) ** 2:
                return True
        return False

    lean_above = ay - 1.2 * scale
    mask = set()
    for y in range(TREE_H):
        for x in range(TREE_W):
            if inside(x, y) and not (wilted and noise(x, y, 7) < 0.45):
                mask.add((x + (sway if y + 0.5 < lean_above else 0), y))
    for x, y in mask:
        # Lit from the upper left; the lowest leaves are in the shade.
        light = (x + 0.5 - ax) / (9 * scale) * 0.55 + (y + 0.5 - (ay - 1.6 * scale)) / (5.2 * scale) + (noise(x, y) - 0.5) * 0.5
        shade = 0 if light < -0.62 else 1 if light < -0.05 else 2 if light < 0.62 else 3
        if (x, y + 1) not in mask and shade < 3 and y + 1 < ground:
            shade += 1
        c.set(x, y, leaves[shade])
    if wilted:
        for x in (6, 9, 14, 17):
            if noise(x, 3, round(growth * 100)) < 0.7:
                c.set(x, ground, leaves[1])
    if bloom is not None:
        spots = sorted(((x, y) for x, y in mask if 1 <= x < TREE_W - 1 and (x, y - 1) in mask), key=lambda p: noise(p[0], p[1], 3))
        chosen = []
        for spot in spots:
            if all(abs(spot[0] - o[0]) + abs(spot[1] - o[1]) > 3 for o in chosen):
                chosen.append(spot)
            if len(chosen) == 9:
                break
        for i, (x, y) in enumerate(chosen):
            phase = (bloom + i / len(chosen)) % 1.0
            c.set(x, y, mix(rgba(look["bloom"]), rgba("#FFFFFF"), 0.7 if phase < 0.18 else 0.0))
        # Petals, or leaves, come down one after another.
        for i in range(3):
            fall = (bloom + i / 3) % 1.0
            x = round(4 + 7.5 * i + 2 * math.sin(fall * 6.283 + i))
            y = round(7 + fall * 7)
            if (x, y) not in mask and y <= ground:
                c.set(x, y, rgba(look["petal"], round(255 * (1 - fall * 0.5))))
    return c


def gust(frame):
    """How far the upper canopy leans at a frame of the three-second loop: still, then one short gust."""
    return 1 if 34 <= frame < 46 else 0


def focus_timer(out):
    for kind in TREES:
        frames, sections = [], []
        for stage in range(STAGES):
            growth = stage / (STAGES - 1)
            first = len(frames)
            # Small trees stand still: there is not enough of them to lean.
            frames += [tree(growth, kind, sway=gust(f) if stage >= 4 else 0) for f in range(SWAY_FRAMES)]
            sections.append((f"grow{stage}", first, len(frames) - 1))
        first = len(frames)
        frames += [tree(1.0, kind, sway=gust(f), bloom=f / SWAY_FRAMES) for f in range(SWAY_FRAMES)]
        sections.append(("bloom", first, len(frames) - 1))
        for stage in range(STAGES):
            frames.append(tree(stage / (STAGES - 1), kind, wilted=True))
            sections.append((f"wilt{stage}", len(frames) - 1, len(frames) - 1))
        save_anim(frames, sections, out / f"src/animations/tree_{kind}.anim")

        # The forest: a small tree for every session finished, 7x8.
        small = Canvas(7, 8)
        leaves = [rgba(h) for h in TREES[kind]["leaves"]]
        small.rows(
            0,
            0,
            [
                "..01...",
                ".0112..",
                "011122.",
                "1112223",
                ".12223.",
                "...t...",
                "...t...",
                "..tT...",
            ],
            {"0": leaves[0], "1": leaves[1], "2": leaves[2], "3": leaves[3], "t": rgba(TRUNK), "T": rgba(TRUNK_DARK)},
        )
        small.set(2, 2, rgba(TREES[kind]["bloom"]))
        small.set(4, 4, rgba(TREES[kind]["bloom"]))
        save_png(small, out / f"src/images/small_{kind}.png")

    front = Canvas(8, 8)
    leaves = [rgba(h) for h in TREES["apple"]["leaves"]]
    front.rows(
        0,
        0,
        [
            "..0011..",
            ".001112.",
            "00111222",
            "01112223",
            ".112223.",
            "...tT...",
            "...tT...",
            "..ttTT..",
        ],
        {"0": leaves[0], "1": leaves[1], "2": leaves[2], "3": leaves[3], "t": rgba(TRUNK), "T": rgba(TRUNK_DARK)},
    )
    front.set(2, 2, rgba("#FF4A3A"))
    front.set(5, 3, rgba("#FF4A3A"))
    save_png(front, out / "src/appmeta/icon_front_8x8.png")
    back = Canvas(11, 11)
    back.rows(
        0,
        0,
        [
            "...#####...",
            "..#######..",
            ".#########.",
            "###########",
            "###########",
            ".#########.",
            "..#######..",
            "....###....",
            "....###....",
            "....###....",
            "..#######..",
        ],
        {"#": rgba("#FFFFFF")},
    )
    save_png(back, out / "src/appmeta/icon_back_11x11.png", "LA")


# ------------------------------------------------------------------------------------------------------------ main

MAKERS = {"focus-timer": focus_timer, "meeting-cost": meeting_cost, "status-board": status_board}


def main():
    global SHEETS
    args = sys.argv[1:]
    if "--sheets" in args:
        i = args.index("--sheets")
        SHEETS = Path(args[i + 1])
        del args[i : i + 2]
    names = args or sorted(MAKERS)
    for name in names:
        if name not in MAKERS:
            raise SystemExit(f"No example {name}: {', '.join(sorted(MAKERS))}")
        print(f"{name}:")
        MAKERS[name](EXAMPLES / name)


if __name__ == "__main__":
    main()
