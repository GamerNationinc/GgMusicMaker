#!/usr/bin/env python3
"""Generate placeholder pixel-art icons for the Tauri bundle.

Pure-Python PNG encoder (no third-party deps) so the repo can build icons
anywhere. Draws a chunky retro "play" glyph on a dark panel with a magenta
border — the ProfitPals DAW toy-DAW vibe. Replace with real art later.
"""
import struct
import zlib
import os

# 16x16 low-res master sprite; scaled up with nearest-neighbour for each size.
# 0 = transparent panel bg, 1 = panel, 2 = magenta accent, 3 = green play glyph
SPRITE = [
    "1111111111111111",
    "1222222222222221",
    "1211111111111121",
    "1211111111111121",
    "1211133111111121",
    "1211133311111121",
    "1211133333111121",
    "1211133333311121",
    "1211133333311121",
    "1211133333111121",
    "1211133311111121",
    "1211133111111121",
    "1211111111111121",
    "1211111111111121",
    "1222222222222221",
    "1111111111111111",
]

PALETTE = {
    "1": (24, 22, 34, 255),      # dark panel
    "2": (255, 60, 160, 255),    # magenta accent
    "3": (90, 240, 150, 255),    # green play glyph
}


def build_rgba(size: int) -> bytes:
    src = 16
    scale = size // src
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter type 0 (None) per scanline
        sy = y // scale
        for x in range(size):
            sx = x // scale
            r, g, b, a = PALETTE[SPRITE[sy][sx]]
            rows += bytes((r, g, b, a))
    return bytes(rows)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, size: int) -> None:
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(build_rgba(size), 9)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")


def main() -> None:
    out = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
    os.makedirs(out, exist_ok=True)
    targets = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }
    for name, size in targets.items():
        write_png(os.path.join(out, name), size)


if __name__ == "__main__":
    main()
