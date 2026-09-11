#!/usr/bin/env python3
"""Emit a set of original, redistributable track icons.

    python3 make_icons.py path/to/img/icons

Why this exists: the worked example originally used a licensed icon pack, recoloured.
Recolouring does not change a licence, and most icon-pack licences forbid redistributing
the assets at all — even modified. So the shipped example uses these instead: plain
geometry, authored here, free to pass on with the skill.

They are deliberately simple. Swap them for a pack you are licensed to use (see
recolour_icons.py) the moment you have one.
"""
import pathlib
import sys

# track -> (hue, body geometry drawn in a 48x48 box)
ICONS = {
    'prompting':   ('#3E62A8', '<path d="M8 12h32v20H22l-8 8v-8H8z" fill="{d}"/>'
                               '<path d="M15 20h18M15 26h12" stroke="{l}" stroke-width="3" stroke-linecap="round"/>'),
    'agents':      ('#E2643C', '<circle cx="24" cy="18" r="9" fill="{d}"/>'
                               '<path d="M24 27v6M14 40h20a10 10 0 00-20 0z" fill="{m}"/>'
                               '<circle cx="20" cy="16" r="2" fill="{l}"/><circle cx="28" cy="16" r="2" fill="{l}"/>'),
    'ml-basics':   ('#5C7A4A', '<circle cx="12" cy="14" r="5" fill="{d}"/><circle cx="36" cy="14" r="5" fill="{m}"/>'
                               '<circle cx="24" cy="34" r="5" fill="{d}"/>'
                               '<path d="M14 18l8 12M34 18l-8 12M17 14h14" stroke="{l}" stroke-width="2.6" stroke-linecap="round"/>'),
    'automation':  ('#C9A227', '<circle cx="24" cy="24" r="8" fill="none" stroke="{d}" stroke-width="5"/>'
                               '<path d="M24 4v7M24 37v7M4 24h7M37 24h7M10 10l5 5M33 33l5 5M38 10l-5 5M15 33l-5 5" '
                               'stroke="{m}" stroke-width="4" stroke-linecap="round"/>'),
    'ai-safety':   ('#B33F3F', '<path d="M24 5l16 6v13c0 11-7 17-16 20-9-3-16-9-16-20V11z" fill="{d}"/>'
                               '<path d="M17 24l5 5 10-10" stroke="{l}" stroke-width="4" '
                               'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
    'vibe-coding': ('#7C8FA8', '<path d="M17 15L7 24l10 9M31 15l10 9-10 9" stroke="{d}" stroke-width="4.5" '
                               'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                               '<path d="M27 10l-6 28" stroke="{m}" stroke-width="4" stroke-linecap="round"/>'),
    'image-gen':   ('#1E2D4D', '<rect x="6" y="10" width="36" height="28" rx="4" fill="{d}"/>'
                               '<circle cx="17" cy="20" r="4" fill="{l}"/>'
                               '<path d="M9 34l10-10 7 7 6-6 7 7v2H9z" fill="{m}"/>'),
    'rag':         ('#3E62A8', '<ellipse cx="24" cy="12" rx="15" ry="6" fill="{d}"/>'
                               '<path d="M9 12v11c0 3 7 6 15 6s15-3 15-6V12" fill="{m}"/>'
                               '<path d="M9 25v11c0 3 7 6 15 6s15-3 15-6V25" fill="{d}"/>'),
    'fine-tuning': ('#C9A227', '<path d="M10 14h28M10 24h28M10 34h28" stroke="{m}" stroke-width="3.5" stroke-linecap="round"/>'
                               '<circle cx="18" cy="14" r="5" fill="{d}"/><circle cx="31" cy="24" r="5" fill="{d}"/>'
                               '<circle cx="15" cy="34" r="5" fill="{d}"/>'),
    'evals':       ('#5C7A4A', '<rect x="8" y="6" width="32" height="36" rx="4" fill="{d}"/>'
                               '<path d="M16 20l5 5 11-11" stroke="{l}" stroke-width="4" '
                               'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                               '<path d="M16 32h16" stroke="{m}" stroke-width="3.5" stroke-linecap="round"/>'),
    'voice':       ('#E2643C', '<rect x="19" y="6" width="10" height="20" rx="5" fill="{d}"/>'
                               '<path d="M13 22a11 11 0 0022 0" stroke="{m}" stroke-width="4" '
                               'stroke-linecap="round" fill="none"/>'
                               '<path d="M24 33v8M18 41h12" stroke="{m}" stroke-width="4" stroke-linecap="round"/>'),
    'data':        ('#B33F3F', '<rect x="7" y="26" width="8" height="16" rx="2" fill="{m}"/>'
                               '<rect x="20" y="16" width="8" height="26" rx="2" fill="{d}"/>'
                               '<rect x="33" y="7" width="8" height="35" rx="2" fill="{m}"/>'),
}


def ramp(base):
    """dark / mid / light stops of one hue — same idea as recolour_icons.py."""
    import colorsys
    h = base.lstrip('#')
    r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    hh, ll, ss = colorsys.rgb_to_hls(r, g, b)
    out = []
    for t in (0.82, 1.0, 1.45):
        c = colorsys.hls_to_rgb(hh, min(0.93, ll * t), ss * (1 - 0.25 * (t - 0.82)))
        out.append('#%02X%02X%02X' % tuple(round(x * 255) for x in c))
    return out          # dark, mid, light


if __name__ == '__main__':
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'img/icons')
    out.mkdir(parents=True, exist_ok=True)
    for name, (hue, body) in ICONS.items():
        d, m, l = ramp(hue)
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">'
               + body.format(d=d, m=m, l=l) + '</svg>')
        (out / f'{name}.svg').write_text(svg)
        print(f'  {name:12} {hue}')
    print(f'\n{len(ICONS)} original icons written to {out}')
