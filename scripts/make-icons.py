#!/usr/bin/env python3
"""Draw the app's icons.

    python3 scripts/make-icons.py

A ledger: three entry rules with a rule under the last one, white on black. Black
and white rather than the terminal's accent, so the mark does not change meaning
when the theme does. Drawn rather than exported, so it can be redrawn at every size.

Outputs into assets/icons/, which Trunk copies to /icons/:

  favicon.svg          the vector mark, crisp at any size
  favicon-16/32/48.png the raster copies older browsers ask for
  apple-touch-icon.png 180px, for an iOS home screen
  icon-192/512.png     the manifest icons
"""

from PIL import Image, ImageDraw

BACKGROUND = (0, 0, 0)
INK = (255, 255, 255)

# The mark sits inside the middle 80%, so the same file works as a maskable icon
# on Android without its corners being cropped.
INSET = 0.20

# The mark, in fractions of its own box: two entries, then a total under a rule.
# Each entry is a long "account" bar and a short "amount" bar on the right. Two
# entries rather than three, so the gaps survive a 16 pixel favicon.
ROWS = (0.00, 0.30)
AMOUNT_LEFT = 0.70
RULE_TOP = 0.62
TOTAL_TOP = 0.84
TOTAL_LEFT = 0.42


def draw(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size), BACKGROUND)
    pen = ImageDraw.Draw(image)

    box = size - 2 * INSET * size
    left = INSET * size
    # Bars are at least one pixel, so the mark survives a 16 pixel favicon.
    thick = max(1, round(box * 0.16))

    def bar(x0: float, x1: float, top: float) -> None:
        y = left + box * top
        pen.rectangle(
            [(left + box * x0, y), (left + box * x1 - 1, y + thick - 1)],
            fill=INK,
        )

    for row in ROWS:
        bar(0.0, 0.52, row)
        bar(AMOUNT_LEFT, 1.0, row)
    # The rule, thinner than a bar, and the total sitting under it.
    rule = max(1, round(thick * 0.5))
    y = left + box * RULE_TOP
    pen.rectangle([(left, y), (left + box - 1, y + rule - 1)], fill=INK)
    bar(TOTAL_LEFT, 1.0, TOTAL_TOP)
    return image


def svg() -> str:
    """The same mark as the PNGs, in a 100-unit box."""
    left = INSET * 100
    box = 100 - 2 * INSET * 100
    thick = box * 0.16
    rule = thick * 0.5

    bars = []

    def bar(x0: float, x1: float, top: float, height: float) -> None:
        bars.append(
            f'    <rect x="{left + box * x0:.1f}" y="{left + box * top:.1f}" '
            f'width="{box * (x1 - x0):.1f}" height="{height:.1f}"/>'
        )

    for row in ROWS:
        bar(0.0, 0.52, row, thick)
        bar(AMOUNT_LEFT, 1.0, row, thick)
    bar(0.0, 1.0, RULE_TOP, rule)
    bar(TOTAL_LEFT, 1.0, TOTAL_TOP, thick)
    shapes = "\n".join(bars)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="hledger-anywhere">
  <rect width="100" height="100" rx="22" fill="#000000"/>
  <g fill="#ffffff">
{shapes}
  </g>
</svg>
"""


def main() -> None:
    names = {
        16: "favicon-16.png",
        32: "favicon-32.png",
        48: "favicon-48.png",
        180: "apple-touch-icon.png",
        192: "icon-192.png",
        512: "icon-512.png",
    }
    for size, name in names.items():
        path = f"assets/icons/{name}"
        draw(size).save(path, "PNG", optimize=True)
        print(f"wrote {path}")
    path = "assets/icons/favicon.svg"
    with open(path, "w", encoding="utf-8") as file:
        file.write(svg())
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
