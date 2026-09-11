from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

BG = (15, 17, 21, 255)       # --bg
CELL_COLORS = [
    (255, 92, 138, 255),      # --accent
    (124, 139, 255, 255),     # --accent-2
    (255, 59, 59, 255),       # youtube-ish red
    (145, 70, 255, 255),      # twitch-ish purple
]


def rounded_square(size, radius, color):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=color)
    return img


def build_icon(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    bg_radius = int(size * (0.22 if not maskable else 0))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=bg_radius, fill=BG)

    # 2x2 grid of rounded tiles -> represents the multiview canvas.
    margin = size * (0.20 if maskable else 0.16)
    gap = size * 0.06
    avail = size - margin * 2
    cell = (avail - gap) / 2
    cell_radius = int(cell * 0.28)

    positions = [
        (margin, margin),
        (margin + cell + gap, margin),
        (margin, margin + cell + gap),
        (margin + cell + gap, margin + cell + gap),
    ]
    for (x, y), color in zip(positions, CELL_COLORS):
        tile = rounded_square(int(cell), cell_radius, color)
        img.alpha_composite(tile, (int(x), int(y)))

    return img


icon192 = build_icon(192, maskable=False)
icon192.save(os.path.join(OUT, "icon-192.png"))

icon512 = build_icon(512, maskable=False)
icon512.save(os.path.join(OUT, "icon-512.png"))

icon_maskable = build_icon(512, maskable=True)
icon_maskable.save(os.path.join(OUT, "icon-maskable-512.png"))

print("icons written to", OUT)
