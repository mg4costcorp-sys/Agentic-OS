#!/usr/bin/env python3
"""Recolour a set of icons into your brand palette instead of redrawing them.

Most icon packs are lovely drawings on a palette that is nothing like yours. Rather than
redraw, keep the artwork and remap the colour: every unique fill in an icon is ranked by
luminance and mapped onto a three-stop ramp of that track's semantic hue. Shading
relationships survive, the palette becomes yours, and the set still reads as one family
because every icon goes through the same ramp.

    ICON_LIB=~/path/to/your/icons python3 recolour_icons.py

BRING YOUR OWN ICONS. Point ICON_LIB at a pack **you are licensed to use** and edit TRACKS
to match its filenames. Recolouring does not change a licence — check what your pack permits
for commercial use and whether it requires attribution.
"""
import os, re, pathlib, colorsys

LIB = pathlib.Path(os.environ.get("ICON_LIB", "./icons")).expanduser()
OUT = pathlib.Path(__file__).parent.parent / "img/icons"
OUT.mkdir(parents=True, exist_ok=True)

# (output name, path to the source SVG inside your pack, semantic hue)
# Replace these paths with the ones in your own library.
TRACKS = [
    ("prompting",   "svg/speech-bubble.svg",   "#3E62A8"),
    ("agents",      "svg/brain.svg",           "#E2643C"),
    ("ml-basics",   "svg/elearning.svg",       "#5C7A4A"),
    ("automation",  "svg/gear.svg",            "#C9A227"),
    ("ai-safety",   "svg/firewall.svg",        "#B33F3F"),
    ("vibe-coding", "svg/binary-code.svg",     "#7C8FA8"),
    ("image-gen",   "svg/image.svg",           "#1E2D4D"),
    ("rag",         "svg/data-protection.svg", "#3E62A8"),
    ("fine-tuning", "svg/light-bulb.svg",      "#C9A227"),
    ("evals",       "svg/idea.svg",            "#5C7A4A"),
    ("voice",       "svg/voice-message.svg",   "#E2643C"),
    ("data",        "svg/database.svg",        "#B33F3F"),
]


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def rgb2hex(r, g, b):
    return "#%02X%02X%02X" % tuple(max(0, min(255, round(c * 255))) for c in (r, g, b))


def ramp(base, t):
    """t in 0..1 -> dark..light variant of the base hue, keeping it inside the brand feel."""
    h, l, s = colorsys.rgb_to_hls(*hex2rgb(base))
    # darkest 0.72x the base lightness, lightest lifted toward paper but never washed out
    nl = l * (0.68 + 0.95 * t)
    ns = s * (1.0 - 0.42 * t)
    return rgb2hex(*colorsys.hls_to_rgb(h, min(0.93, nl), max(0.05, ns)))


def lum(h):
    r, g, b = hex2rgb(h)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def recolour(src, base):
    svg = pathlib.Path(src).read_text()
    fills = sorted(set(re.findall(r'#[0-9A-Fa-f]{6}', svg)), key=lum)
    if not fills:
        return None, 0
    n = len(fills)
    for i, f in enumerate(fills):
        t = i / max(1, n - 1)
        svg = svg.replace(f, ramp(base, t))
    # strip fixed size so CSS controls it
    svg = re.sub(r'\s(?:height|width)="\d+"', "", svg, count=2)
    return svg, n


if __name__ == "__main__":
    for name, rel, hue in TRACKS:
        p = LIB / rel
        if not p.exists():
            print(f"MISSING {name}: {rel}")
            continue
        svg, n = recolour(p, hue)
        (OUT / f"{name}.svg").write_text(svg)
        print(f"{name:12} {hue}  {n} colours remapped  <- {p.name}")
