# The art pipeline

Generated image → shipping, scroll-driven scene. Five steps, in order.

---

## 1. Generate

Cast sheet, then model sheet, then every scene **against both** as image references. See `03-graphics.md` for the prompt rules that matter.

Save masters at full resolution somewhere outside `img/` — you will regenerate more often than you expect, and you want the original when you do.

## 2. Cut the background to alpha

Flood-fill inward from the border. Never a global colour match — a global match punches holes through every same-coloured pixel *inside* the drawing.

```python
near = (np.abs(arr - arr[0,0]).max(axis=2) < 26)   # tolerance, not equality
# BFS from every border pixel, alpha=0 on what you reach
```

Two traps:

- **PIL drops alpha on WebP** unless you pass `exact=True`.
- **A "transparent" generation may be 100% opaque** with a checkerboard painted into the pixels. Check before you trust it:

```python
print((np.array(im)[:,:,3] > 10).mean())   # 1.0 means no transparency at all
```

## 3. Decide: solo or scene

| | Use | Markup |
|---|---|---|
| **solo** | one character, one object, anything that must stay whole | `<img class="solo">` |
| **scene** | several separate objects that should drift apart | `.scene > .pc` sprites |

**A single character is always a solo.** Splitting one costs it an eye.

## 4. Split (scenes only)

```bash
python3 tools/split_layers.py
```

Tune per asset — `min_px` and `dilate` are the whole game:

```python
("mural",   "img/s9-mural.webp",   4500, 3)   # 13 objects
("hero",    "img/s1-hero.webp",   18000, 4)   #  3 objects
("collage", "img/s6-collage.webp",20000, 4)   #  4 objects
```

Raise `min_px` until the piece count matches the number of **things you can name** in the picture. If it reports 14 pieces and you can only name 9 objects, it is splitting inside objects.

The splitter merges sub-threshold fragments into the nearest kept sprite and asserts **zero pixels lost**. If it is not lossless, it is not a split — it is damage.

## 5. Emit the scene markup

```bash
python3 tools/build_scenes.py
```

Each sprite gets a radial vector from the scene's centre of mass:

```html
<img class="pc" src="img/layers/hero-00.webp"
     style="--l:29.7%;--t:29.4%;--w:67.6%;--ox:17.9px;--oy:9.9px;--rot:1.2deg">
```

`--l/--t/--w` are the sprite's original position as percentages, so the scene is resolution-independent. `--ox/--oy/--rot` are how far it travels. The page multiplies them by scroll distance.

**Budget: reach 22–68px, rotation ≤ 4.6°.** Beyond that the picture stops reading as a picture.

---

## Verify before you ship

```python
# recomposite every sprite and diff against the source
lost = ((src_alpha > 10) & ~(composite_alpha > 10)).sum()
assert lost == 0
```

Then check the scene is pristine when centred — at `--a: 0` the composite should be within a pixel of the original.

---

## Layering over a coloured band

If art overlaps a wave or curve, check the artwork's own bottom edge **first**:

```python
(np.array(im)[-1,:,3] > 10).mean()    # > 0.05 means the art is cut at the frame edge
```

If it is cut, either the band must cover the seam, or you need new art with complete figures. Flipping the z-order over a cropped asset only trades a soft wavy cut for a hard straight one.
