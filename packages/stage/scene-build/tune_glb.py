#!/usr/bin/env python3
"""Tunes the bar's model for the 3D view: the orange of the base color picture.

    python3 -I tune_glb.py <bar3.glb> <out.glb> [--orange RRGGBB]

The model's base color picture paints the orange parts (the wheel's ring, the edge of Start, the mode switch's
edge, Back) a dull brown-orange (about c8701a). Under the scene's light it reads as brown. The parts are orange
plastic on the bar; this paints them the orange of the bar's photo in the flat view. Nothing else of the file
changes: geometry, the other pictures and every node are copied as they are.
"""
import colorsys, io, json, struct, sys

from PIL import Image


def read_glb(path):
    data = open(path, "rb").read()
    magic, version, _ = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF" and version == 2, "not a GLB 2 file"
    json_len, json_type = struct.unpack("<I4s", data[12:20])
    assert json_type == b"JSON"
    doc = json.loads(data[20 : 20 + json_len])
    rest = 20 + json_len
    bin_len, bin_type = struct.unpack("<I4s", data[rest : rest + 8])
    assert bin_type == b"BIN\0"
    return doc, data[rest + 8 : rest + 8 + bin_len]


def write_glb(path, doc, views):
    """views: the bytes of every buffer view, in order; offsets are laid out anew, each on a 4-byte boundary."""
    body = bytearray()
    for view, content in zip(doc["bufferViews"], views):
        while len(body) % 4:
            body.append(0)
        view["byteOffset"] = len(body)
        view["byteLength"] = len(content)
        body += content
    while len(body) % 4:
        body.append(0)
    doc["buffers"] = [{"byteLength": len(body)}]
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    out = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(text) + 8 + len(body))
    out += struct.pack("<I4s", len(text), b"JSON") + text + struct.pack("<I4s", len(body), b"BIN\0") + bytes(body)
    open(path, "wb").write(out)


def repaint_orange(picture, target):
    """Every orange texel takes the target's hue and saturation; its lightness keeps its place relative to the paint."""
    image = Image.open(io.BytesIO(picture)).convert("RGB")
    pixels = image.load()
    th, ts, tv = colorsys.rgb_to_hsv(*(c / 255 for c in target))
    changed = 0
    for y in range(image.height):
        for x in range(image.width):
            r, g, b = pixels[x, y]
            if not (r > 120 and r > g * 1.35 and g > b * 1.6):
                continue  # not the orange paint: grays, black, white, the red BUSY mark
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if not (0.05 < h < 0.13 and s > 0.45):
                continue
            # The paint is about v = 0.78 in the picture; texels at its edges are blends with the neighbour.
            nv = min(1.0, v / 0.78 * tv)
            nr, ng, nb = colorsys.hsv_to_rgb(th, min(1.0, s / 0.87 * ts), nv)
            pixels[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255))
            changed += 1
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    return out.getvalue(), changed


def main():
    args = sys.argv[1:]
    orange = "f2600c"
    if "--orange" in args:
        i = args.index("--orange")
        orange = args[i + 1]
        del args[i : i + 2]
    source, target = args
    doc, body = read_glb(source)
    views = [body[v.get("byteOffset", 0) : v.get("byteOffset", 0) + v["byteLength"]] for v in doc["bufferViews"]]
    found = [im for im in doc["images"] if im.get("name") == "s_basecolor"]
    assert len(found) == 1, "the model has one base color picture named s_basecolor"
    image = found[0]
    picture, changed = repaint_orange(views[image["bufferView"]], tuple(int(orange[i : i + 2], 16) for i in (0, 2, 4)))
    views[image["bufferView"]] = picture
    image["mimeType"] = "image/png"
    write_glb(target, doc, views)
    print(f"   orange texels repainted: {changed}; base color picture: {len(picture)} bytes")


main()
