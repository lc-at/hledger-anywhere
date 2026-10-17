#!/usr/bin/env python3
"""Draw the app's icons.

    python3 scripts/make-icons.py

A terminal prompt: an amber chevron and an underscore on black, the same colours
the terminal itself uses. Drawn rather than exported so the icons can be
regenerated if the palette ever changes, and kept simple enough to stay legible at
16 pixels, which is where a favicon actually lives.

Outputs into assets/icons/, which Trunk copies to /icons/:

  favicon.svg          the vector mark, crisp at any size
  favicon-16/32/48.png the raster copies older browsers ask for
  apple-touch-icon.png 180px, for an iOS home screen
  icon-192/512.png     the manifest icons
"""

from PIL import Image, ImageDraw

BACKGROUND = (0, 0, 0)
ACCENT = (255, 159, 28)  # --term-accent

# The mark sits inside the middle 80%, so the same file works as a maskable icon
# on Android without its corners being cropped.
INSET = 0.20


def draw(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(image)

    left = INSET * size
    right = size - INSET * size
    # Fractions of the box, so every size is the same mark rather than a redraw.
    width = max(2, int(size * 0.075))

    # The chevron: two strokes meeting in the middle of its own box.
    chevron_right = left + (right - left) * 0.42
    middle = (left + right) / 2
    draw.line([(left, left), (chevron_right, middle)], fill=ACCENT, width=width, joint="curve")
    draw.line([(chevron_right, middle), (left, right)], fill=ACCENT, width=width, joint="curve")

    # The underscore beside it.
    bar_top = right - width
    draw.rectangle(
        [(left + (right - left) * 0.62, bar_top), (right, right)],
        fill=ACCENT,
    )
    return image


def svg() -> str:
    """The same mark as the PNGs, in a 100-unit box."""
    left = INSET * 100
    right = 100 - INSET * 100
    width = 8
    chevron_right = left + (right - left) * 0.42
    middle = (left + right) / 2
    bar_left = left + (right - left) * 0.62
    bar_top = right - width
    amber = "#ff9f1c"
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="hledger-anywhere">
  <rect width="100" height="100" rx="22" fill="#000000"/>
  <path d="M{left:.1f},{left:.1f} L{chevron_right:.1f},{middle:.1f} L{left:.1f},{right:.1f}"
        fill="none" stroke="{amber}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="{bar_left:.1f}" y="{bar_top:.1f}" width="{right - bar_left:.1f}" height="{width}" fill="{amber}"/>
</svg>
"""


def main() -> None:
    for size in (16, 32, 48, 180, 192, 512):
        name = {
            16: "favicon-16.png",
            32: "favicon-32.png",
            48: "favicon-48.png",
            180: "apple-touch-icon.png",
            192: "icon-192.png",
            512: "icon-512.png",
        }[size]
        path = f"assets/icons/{name}"
        draw(size).save(path, "PNG", optimize=True)
        print(f"wrote {path}")
    path = "assets/icons/favicon.svg"
    with open(path, "w", encoding="utf-8") as file:
        file.write(svg())
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
