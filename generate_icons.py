"""Icon generator for The Hunt PWA — Tactical HUD emblem (crosshair/radar).
Matches the in-app SVG emblem in index.html. Run with: python3 generate_icons.py
"""
from PIL import Image, ImageDraw
import os, math

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(BASE, exist_ok=True)

BG = (10, 14, 20, 255)          # --surface-base
GREEN = (0, 255, 135, 255)      # --primary-container / rarity-common
CYAN = (0, 229, 255, 255)       # --rarity-uncommon / secondary

def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2
    pad = size * 0.03

    d.ellipse([pad, pad, size - pad, size - pad], fill=BG)

    tick_len = size * 0.12
    tick_gap = size * 0.34
    tick_w = max(2, int(size * 0.028))
    for angle in (0, 90, 180, 270):
        rad = math.radians(angle)
        x1 = cx + tick_gap * math.sin(rad)
        y1 = cy - tick_gap * math.cos(rad)
        x2 = cx + (tick_gap + tick_len) * math.sin(rad)
        y2 = cy - (tick_gap + tick_len) * math.cos(rad)
        d.line([x1, y1, x2, y2], fill=GREEN, width=tick_w)

    r_outer = size * 0.30
    d.arc([cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer], 0, 330, fill=CYAN, width=max(2, int(size * 0.02)))

    r_inner = size * 0.20
    d.ellipse([cx - r_inner, cy - r_inner, cx + r_inner, cy + r_inner], outline=GREEN, width=max(2, int(size * 0.02)))

    r_core = size * 0.06
    d.ellipse([cx - r_core, cy - r_core, cx + r_core, cy + r_core], fill=GREEN)

    return img

for size in (192, 512):
    make_icon(size).save(os.path.join(BASE, f"icon-{size}.png"))
    print(f"wrote icon-{size}.png")
