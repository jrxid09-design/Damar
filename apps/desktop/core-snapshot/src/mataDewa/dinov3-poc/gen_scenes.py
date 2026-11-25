"""Generate controlled test scenes for the change-detection PoC.

Self-made synthetic scenes (PIL drawing, fully deterministic) — no third
party imagery, no licensing questions. Scene family:
  base      : transmission-tower landscape (the watch-point archetype)
  same_jpg  : base re-encoded as JPEG q88 -> PNG (capture pipeline noise)
  near      : base with +5% brightness and slight sensor noise
  changed   : same scene, red truck added, one tree removed, smoke plume
  different : a completely different scene (coast/boat)
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenes")
SIZE = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_scene(truck=False, trees=3, smoke=False):
    img = Image.new("RGB", (SIZE, SIZE))
    d = ImageDraw.Draw(img)
    # sky gradient
    top, hor = (110, 180, 225), (215, 238, 250)
    for y in range(0, 640):
        d.line([(0, y), (SIZE, y)], fill=lerp(top, hor, y / 640))
    # sun + clouds
    d.ellipse([800, 60, 920, 180], fill=(255, 236, 160), outline=(250, 210, 90), width=4)
    for cx, cy, s in [(180, 120, 1.0), (520, 80, 0.7)]:
        for dx, dy, r in [(0, 0, 70), (60, 10, 50), (-60, 12, 46)]:
            d.ellipse([cx + dx * s - r * s, cy + dy * s - r * s * 0.55,
                       cx + dx * s + r * s, cy + dy * s + r * s * 0.55], fill=(248, 250, 252))
    # distant hills
    d.polygon([(0, 640), (260, 470), (520, 640)], fill=(140, 175, 140))
    d.polygon([(380, 640), (720, 440), (1024, 640)], fill=(125, 165, 130))
    # ground
    d.rectangle([0, 640, SIZE, SIZE], fill=(96, 160, 84))
    d.rectangle([0, 640, SIZE, 668], fill=(110, 175, 96))
    # road
    d.polygon([(0, 940), (1024, 900), (1024, 990), (0, 1024)], fill=(92, 92, 98))
    d.line([(0, 972), (1024, 940)], fill=(230, 220, 160), width=5)
    # transmission tower (lattice, center-left)
    tx, ty_top, ty_bot = 330, 250, 940
    d.line([(tx - 95, ty_bot), (tx - 28, ty_top)], fill=(52, 56, 64), width=9)
    d.line([(tx + 95, ty_bot), (tx + 28, ty_top)], fill=(52, 56, 64), width=9)
    for i in range(7):
        t0 = i / 7
        y0 = ty_bot - (ty_bot - ty_top) * t0
        w0 = 95 - 67 * t0
        t1 = (i + 1) / 7
        y1 = ty_bot - (ty_bot - ty_top) * t1
        w1 = 95 - 67 * t1
        d.line([(tx - w0, y0), (tx + w1, y1)], fill=(52, 56, 64), width=5)
        d.line([(tx + w0, y0), (tx - w1, y1)], fill=(52, 56, 64), width=5)
        d.line([(tx - w0, y0), (tx + w0, y0)], fill=(52, 56, 64), width=4)
    # cross arms + insulators + wires
    for ay, aw in [(300, 170), (370, 140)]:
        d.line([(tx - aw, ay), (tx + aw, ay)], fill=(52, 56, 64), width=8)
        for sx in (-aw + 18, aw - 18):
            d.line([(tx + sx, ay), (tx + sx, ay + 26)], fill=(30, 30, 36), width=5)
    d.line([(tx - 152, 300), (0, 330)], fill=(40, 42, 48), width=3)
    d.line([(tx + 152, 300), (1024, 260)], fill=(40, 42, 48), width=3)
    d.line([(tx - 122, 370), (0, 400)], fill=(40, 42, 48), width=3)
    d.line([(tx + 122, 370), (1024, 340)], fill=(40, 42, 48), width=3)
    # house (right)
    hx, hy = 720, 700
    d.rectangle([hx, hy, hx + 190, hy + 130], fill=(232, 222, 200))
    d.polygon([(hx - 14, hy), (hx + 95, hy - 74), (hx + 204, hy)], fill=(150, 70, 55))
    d.rectangle([hx + 118, hy - 58, hx + 148, hy - 6], fill=(120, 110, 105))  # chimney
    d.rectangle([hx + 30, hy + 46, hx + 76, hy + 130], fill=(110, 78, 52))
    d.rectangle([hx + 116, hy + 34, hx + 158, hy + 78], fill=(170, 205, 225), outline=(90, 90, 90), width=3)
    if smoke:
        for i, (sx, sy, r) in enumerate([(hx + 150, hy - 96, 26), (hx + 176, hy - 140, 36),
                                         (hx + 210, hy - 190, 48), (hx + 250, hy - 248, 60)]):
            d.ellipse([sx - r, sy - r * 0.7, sx + r, sy + r * 0.7], fill=(70, 70, 78))
    # trees
    tree_pos = [(120, 760, 1.0), (560, 800, 0.85), (950, 760, 1.1)]
    for i, (x, y, s) in enumerate(tree_pos[:trees]):
        d.rectangle([x - 9 * s, y, x + 9 * s, y + 90 * s], fill=(104, 76, 48))
        for dx, dy, r in [(0, -56, 62), (-44, -26, 44), (44, -26, 44)]:
            d.ellipse([x + dx * s - r * s, y + dy * s - r * s, x + dx * s + r * s, y + dy * s + r * s],
                      fill=(46, 120, 58))
    if truck:
        x, y = 600, 872
        d.rectangle([x, y, x + 210, y + 62], fill=(196, 44, 38))
        d.polygon([(x + 210, y + 8), (x + 262, y + 30), (x + 262, y + 62), (x + 210, y + 62)], fill=(168, 36, 32))
        d.rectangle([x + 218, y + 16, x + 248, y + 34], fill=(175, 210, 230))
        for wx in (x + 42, x + 178, x + 238):
            d.ellipse([wx - 21, y + 52, wx + 21, y + 94], fill=(28, 28, 32))
            d.ellipse([wx - 8, y + 65, wx + 8, y + 81], fill=(150, 150, 156))
    return img


def draw_different():
    img = Image.new("RGB", (SIZE, SIZE))
    d = ImageDraw.Draw(img)
    top, hor = (70, 130, 200), (170, 215, 240)
    for y in range(0, 560):
        d.line([(0, y), (SIZE, y)], fill=lerp(top, hor, y / 560))
    d.ellipse([90, 70, 200, 180], fill=(255, 240, 170))
    d.rectangle([0, 560, SIZE, 860], fill=(40, 110, 170))  # sea
    for i in range(9):  # wave strokes
        y = 600 + i * 30
        d.arc([40 + (i % 3) * 260, y, 220 + (i % 3) * 260, y + 26], 200, 330, fill=(210, 235, 250), width=4)
    d.rectangle([0, 860, SIZE, SIZE], fill=(232, 208, 150))  # sand
    # boat
    d.polygon([(420, 700), (640, 700), (600, 756), (460, 756)], fill=(140, 84, 44))
    d.line([(530, 700), (530, 560)], fill=(90, 64, 40), width=7)
    d.polygon([(530, 560), (530, 690), (618, 690)], fill=(245, 245, 240))
    d.polygon([(530, 580), (530, 690), (462, 690)], fill=(226, 232, 238))
    # palm
    d.line([(880, 880), (848, 660)], fill=(120, 88, 50), width=14)
    for a in range(5):
        import math
        x2 = 848 + int(120 * math.cos(a * 0.9 - 2.2))
        y2 = 660 + int(52 * math.sin(a * 0.9 - 2.2)) - 18
        d.arc([848 - 130, 660 - 60, 848 + 130, 660 + 80], 180 + a * 28, 250 + a * 28, fill=(52, 140, 66), width=9)
        d.line([(848, 660), (x2, y2)], fill=(52, 140, 66), width=7)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    base = draw_scene()
    base.save(os.path.join(OUT, "scene_base.png"))
    # near-identical #1: JPEG round-trip
    base.save(os.path.join(OUT, "_tmp.jpg"), quality=88)
    Image.open(os.path.join(OUT, "_tmp.jpg")).save(os.path.join(OUT, "scene_same_jpg.png"))
    os.remove(os.path.join(OUT, "_tmp.jpg"))
    # near-identical #2: brightness shift + light sensor noise
    near = ImageEnhance.Brightness(base).enhance(1.05)
    rng = np.random.default_rng(42)
    arr = np.asarray(near).astype(np.int16)
    arr = np.clip(arr + rng.normal(0, 3.0, arr.shape), 0, 255).astype(np.uint8)
    Image.fromarray(arr).save(os.path.join(OUT, "scene_near.png"))
    # visibly changed: truck added, one tree removed, smoke plume
    draw_scene(truck=True, trees=2, smoke=True).save(os.path.join(OUT, "scene_changed.png"))
    # entirely different scene
    draw_different().save(os.path.join(OUT, "scene_different.png"))
    print("scenes written to", OUT)
    for n in sorted(os.listdir(OUT)):
        print(" ", n, os.path.getsize(os.path.join(OUT, n)))


if __name__ == "__main__":
    main()
