"""Render the Corsen Connector icon (same design as the dashboard logo.svg) to PNG sizes.

Usage: python3 -I scripts/generate-icons.py   (needs Pillow; output is committed, so contributors
rarely need to run it). Drawn at 1024 px then downsampled for clean anti-aliasing.
"""
from pathlib import Path
from PIL import Image, ImageDraw

VIOLET = (139, 92, 246)
CYAN = (34, 211, 238)
INK = (13, 18, 32)
OUT = Path(__file__).resolve().parent.parent / "packages" / "extension" / "public" / "icons"


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient(size):
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            pixels[x, y] = lerp(VIOLET, CYAN, t) + (255,)
    return image


def render(size):
    scale = 1024
    s = scale / 64
    canvas = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    grad = gradient(scale)
    # rounded square body + gradient border
    mask_outer = Image.new("L", (scale, scale), 0)
    ImageDraw.Draw(mask_outer).rounded_rectangle([2 * s, 2 * s, 62 * s, 62 * s], radius=16 * s, fill=255)
    canvas.paste(grad, (0, 0), mask_outer)
    inner = Image.new("L", (scale, scale), 0)
    ImageDraw.Draw(inner).rounded_rectangle([5 * s, 5 * s, 59 * s, 59 * s], radius=13.5 * s, fill=255)
    canvas.paste(Image.new("RGBA", (scale, scale), INK + (255,)), (0, 0), inner)
    # "C" arc
    arc = Image.new("L", (scale, scale), 0)
    width = 7 * s if size <= 32 else 6 * s
    ImageDraw.Draw(arc).arc([19 * s, 19 * s, 45 * s, 45 * s], start=45, end=315, fill=255, width=round(width))
    canvas.paste(grad, (0, 0), arc)
    # brain (violet) and hands (cyan) dots
    if size >= 32:
        dots = ImageDraw.Draw(canvas)
        dots.ellipse([41.5 * s, 17.5 * s, 50.5 * s, 26.5 * s], fill=VIOLET + (255,))
        dots.ellipse([41.5 * s, 37.5 * s, 50.5 * s, 46.5 * s], fill=CYAN + (255,))
    return canvas.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48):
        render(size).save(OUT / f"icon-{size}.png", optimize=True)
        print(f"wrote icon-{size}.png")
    # The Store takes its icon from this file: 96x96 artwork, 16 px of transparent padding per side
    # (developer.chrome.com/docs/webstore/images). Toolbar sizes above stay full-bleed.
    store = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    store.paste(render(96), (16, 16))
    store.save(OUT / "icon-128.png", optimize=True)
    print("wrote icon-128.png (96 px artwork, 16 px transparent padding)")
