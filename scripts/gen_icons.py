#!/usr/bin/env python3
"""Generate the GgMusicMaker app icons.

Pure-Python PNG encoder (no third-party deps) so icons can be regenerated
anywhere, including in CI. Draws a chunky mixer-fader motif echoing the Hasbro
"Play It Now" toy's physical sliders: three faders at different positions on a
dark beveled panel with a magenta border, over a green waveform baseline.

Rendered at 64x64 then nearest-neighbour scaled, so it stays crisp and pixelated
at every size.
"""
import os
import struct
import zlib

S = 64  # source canvas

# Palette (matches src/ui/theme.css)
BG        = (14, 13, 22, 255)
PANEL     = (27, 26, 41, 255)
PANEL_HI  = (42, 40, 64, 255)
MAGENTA   = (255, 60, 160, 255)
GREEN     = (90, 240, 150, 255)
CYAN      = (60, 200, 255, 255)
AMBER     = (255, 207, 60, 255)
DARK      = (10, 9, 18, 255)


def new_canvas():
    return [[(0, 0, 0, 0)] * S for _ in range(S)]


def rect(px, x0, y0, w, h, color):
    for y in range(y0, y0 + h):
        if 0 <= y < S:
            for x in range(x0, x0 + w):
                if 0 <= x < S:
                    px[y][x] = color


def frame(px, x0, y0, w, h, color, t=1):
    rect(px, x0, y0, w, t, color)
    rect(px, x0, y0 + h - t, w, t, color)
    rect(px, x0, y0, t, h, color)
    rect(px, x0 + w - t, y0, t, h, color)


def draw() -> list:
    px = new_canvas()

    # Panel with a magenta bezel and a lighter inner bevel.
    rect(px, 2, 2, S - 4, S - 4, MAGENTA)
    rect(px, 4, 4, S - 8, S - 8, PANEL)
    frame(px, 5, 5, S - 10, S - 10, PANEL_HI, 1)

    # Three faders: recessed track + chunky knob at different heights.
    # Knob heights differ so the icon reads as "a mixer", not "a barcode".
    for i, (cx, knob_y, knob_col) in enumerate(
        ((17, 34, GREEN), (32, 22, CYAN), (47, 40, AMBER))
    ):
        rect(px, cx - 2, 12, 4, 34, DARK)          # track
        rect(px, cx - 1, 13, 2, 32, (20, 19, 32, 255))
        rect(px, cx - 6, knob_y, 12, 7, PANEL_HI)  # knob body
        rect(px, cx - 6, knob_y, 12, 2, knob_col)  # knob cap (lit)
        rect(px, cx - 6, knob_y + 6, 12, 1, DARK)  # knob shadow

    # Waveform baseline along the bottom.
    heights = (2, 5, 3, 7, 4, 8, 3, 6, 2, 5, 3, 4)
    for i, h in enumerate(heights):
        x = 7 + i * 4
        rect(px, x, 54 - h // 2, 2, h, GREEN)

    return px


def build_rgba(px, size: int) -> bytes:
    scale = max(1, size // S)
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter type 0 (None)
        sy = min(S - 1, y * S // size) if scale * S != size else y // scale
        for x in range(size):
            sx = min(S - 1, x * S // size) if scale * S != size else x // scale
            r, g, b, a = px[sy][sx]
            rows += bytes((r, g, b, a))
    return bytes(rows)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, px, size: int) -> None:
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(build_rgba(px, size), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")


def main() -> None:
    out = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
    os.makedirs(out, exist_ok=True)
    px = draw()
    for name, size in {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }.items():
        write_png(os.path.join(out, name), px, size)


if __name__ == "__main__":
    main()
