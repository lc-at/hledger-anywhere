#!/usr/bin/env python3
"""Draw the app's icons.

    python3 scripts/make-icons.py

A terminal prompt: an amber chevron and an underscore on black, the same colours
the terminal itself uses. Drawn rather than exported so the icons can be
regenerated if the palette ever changes, and kept simple enough to stay legible at
48 pixels, which is where a home-screen icon actually lives.

Outputs into assets/icons/, which Trunk copies to /icons/.
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


def main() -> None:
    for size in (192, 512):
        path = f"assets/icons/icon-{size}.png"
        draw(size).save(path, "PNG", optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
