#!/usr/bin/env python3
"""Emit layered scene markup with SCROLL-DRIVEN geometry.

Nothing animates on its own. Each object carries a radial vector away from the scene's
centre of mass; the page multiplies it by how far that scene sits from the middle of the
viewport. So the art is perfectly composited — the untouched original — when the scene is
centred, and the objects drift apart as you scroll away from it, in either direction.
Scroll stops, motion stops.
"""
import json, math

D = json.load(open("img/layers/layers.json"))


def build(name, spread=1.0):
    d = D[name]
    ps = d["pieces"]
    amax = max(p["area"] for p in ps)
    # centre of mass, so things spread from where the picture actually sits
    tw = sum(p["area"] for p in ps)
    mx = sum(p["cx"] * p["area"] for p in ps) / tw
    my = sum(p["cy"] * p["area"] for p in ps) / tw

    out = []
    for i, p in enumerate(ps):
        vx, vy = p["cx"] - mx, p["cy"] - my
        n = math.hypot(vx, vy) or 1.0
        # light objects travel further — parallax depth, not a uniform explosion
        rel = p["area"] / amax
        reach = (22 + 46 * (1 - math.sqrt(rel))) * spread
        ox = round(vx / n * reach, 1)
        oy = round(vy / n * reach * 0.78, 1)          # flatter vertically, reads calmer
        rot = round(((-1) ** i) * (1.2 + 3.4 * (1 - rel)) * spread, 2)
        out.append(
            f'<img class="pc" src="img/layers/{p["file"]}" alt="" aria-hidden="true" '
            f'style="--l:{p["left"]}%;--t:{p["top"]}%;--w:{p["w"]}%;'
            f'--ox:{ox}px;--oy:{oy}px;--rot:{rot}deg">'
        )
    return d["srcW"], d["srcH"], out


if __name__ == "__main__":
    for n, sp in (("mural", 0.9), ("hero", 1.0), ("collage", 0.8)):
        w, h, layers = build(n, sp)
        print(f'<!-- {n} -->\n<div class="scene" style="--ar:{w}/{h}">\n      '
              + "\n      ".join(layers) + "\n</div>\n")
