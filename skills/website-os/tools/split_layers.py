#!/usr/bin/env python3
"""Split a flat alpha-cut illustration into its separate objects.

The art is a single PNG, so a CSS loop can only move the whole picture — which is why
the mural and the owl read as "a stale image sliding around" rather than a scene with life
in it. Every object in these illustrations is already an island of opaque pixels on a
transparent field, so we can recover them losslessly: label the connected components of the
alpha channel, crop each one, and emit it as its own sprite plus the % position it came from.

Nothing is redrawn or restyled. Identical pixels, just addressable individually.

No scipy/cv2 on this machine and pip is externally managed, so the labelling is a plain
iterative flood fill over a numpy mask.
"""
import json, sys
from collections import deque
import numpy as np
from PIL import Image

MIN_PX = 900        # ignore specks
DILATE = 2          # default: bridge antialiasing gaps so an object does not split in two


def dilate(mask, n):
    m = mask.copy()
    for _ in range(n):
        p = np.pad(m, 1, constant_values=False)
        m = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | m)
    return m


def components(mask):
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    cur = 0
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys, xs):
        if lab[sy, sx]:
            continue
        cur += 1
        q = deque([(sy, sx)])
        lab[sy, sx] = cur
        while q:
            y, x = q.popleft()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur
                    q.append((ny, nx))
    return lab, cur


def split(name, src, outdir, min_px=MIN_PX, dil=DILATE):
    im = Image.open(src).convert("RGBA")
    arr = np.array(im)
    W, H = im.size
    alpha = arr[:, :, 3]
    solid = alpha > 40
    grown = dilate(solid, dil) if dil else solid

    lab, n = components(grown)

    # Every component, with its stats. NOTHING is discarded — a component too small to be
    # its own sprite is MERGED into the nearest kept one, so the composite stays lossless.
    # (Dropping them is what tore the scroll and chipped the star in the first build.)
    stats = {}
    for i in range(1, n + 1):
        m = lab == i
        area = int((m & solid).sum())
        if not area:
            continue
        ys, xs = np.nonzero(m)
        stats[i] = dict(area=area, cy=(ys.min() + ys.max()) / 2, cx=(xs.min() + xs.max()) / 2)

    keep = [i for i, v in stats.items() if v["area"] >= min_px] or list(stats)
    group = {i: i for i in keep}
    for i, v in stats.items():
        if i in group:
            continue
        host = min(keep, key=lambda k: (stats[k]["cx"] - v["cx"]) ** 2 + (stats[k]["cy"] - v["cy"]) ** 2)
        group[i] = host

    merged = {}
    for i, host in group.items():
        merged.setdefault(host, np.zeros_like(solid))
        merged[host] |= (lab == i)

    pieces = []
    for host, m in merged.items():
        ys, xs = np.nonzero(m)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        cut = arr[y0:y1, x0:x1].copy()
        cut[~m[y0:y1, x0:x1]] = 0
        pieces.append({
            "img": Image.fromarray(cut, "RGBA"),
            "area": int((m & solid).sum()),
            "left": round(x0 / W * 100, 3), "top": round(y0 / H * 100, 3),
            "w": round((x1 - x0) / W * 100, 3),
            "cx": round((x0 + x1) / 2 / W * 100, 3), "cy": round((y0 + y1) / 2 / H * 100, 3),
        })

    pieces.sort(key=lambda p: -p["area"])
    meta = []
    for idx, p in enumerate(pieces):
        fn = f"{name}-{idx:02d}.webp"
        p["img"].save(f"{outdir}/{fn}", "WEBP", quality=88, method=6)
        meta.append({k: p[k] for k in ("area", "left", "top", "w", "cx", "cy")} | {"file": fn})
    return {"source": name, "srcW": W, "srcH": H, "pieces": meta}


if __name__ == "__main__":
    out = {}
    for name, src, mp, dl in [("mural", "img/s9-mural.webp", 4000, 3),
                              ("hero", "img/s1-hero.webp", 18000, 4),
                              ("collage", "img/s6-collage.webp", 20000, 4)]:
        r = split(name, src, "img/layers", mp, dl)
        out[name] = r
        print(f"{name}: {len(r['pieces'])} objects  areas={[p['area'] for p in r['pieces'][:12]]}")
    json.dump(out, open("img/layers/layers.json", "w"), indent=1)
