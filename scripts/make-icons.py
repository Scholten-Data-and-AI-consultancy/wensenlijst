# Draws the app icon: a white gift with a gold ribbon on a cranberry tile.
import sys
from PIL import Image, ImageDraw
def icon(size, pad_ratio, path):
    S = size * 4
    img = Image.new('RGB', (S, S), '#a3243b')
    d = ImageDraw.Draw(img)
    pad = S * pad_ratio
    inner = S - 2 * pad
    x0, x1 = pad + inner * .1, S - pad - inner * .1
    lid_top, lid_bot = pad + inner * .32, pad + inner * .48
    box_bot = S - pad - inner * .04
    r = inner * .05
    d.rounded_rectangle([x0 + inner * .05, lid_bot - r, x1 - inner * .05, box_bot], radius=r, fill='#fffdf9')
    d.rounded_rectangle([x0, lid_top, x1, lid_bot], radius=r, fill='#fffdf9')
    cx, rw = S / 2, inner * .07
    d.rectangle([cx - rw, lid_top, cx + rw, box_bot], fill='#e0a43a')
    w = inner * .045
    for sx in (-1, 1):
        bx = cx + sx * inner * .17
        d.ellipse([bx - inner * .14, lid_top - inner * .22, bx + inner * .14, lid_top + inner * .02], outline='#e0a43a', width=int(w))
    d.ellipse([cx - rw * 1.3, lid_top - rw * 1.3, cx + rw * 1.3, lid_top + rw * 1.3], fill='#e0a43a')
    img.resize((size, size), Image.LANCZOS).save(path)
out = sys.argv[1]
icon(192, .12, f'{out}/icon-192.png')
icon(512, .12, f'{out}/icon-512.png')
icon(512, .22, f'{out}/icon-maskable-512.png')
icon(180, .1, f'{out}/apple-touch-icon.png')
