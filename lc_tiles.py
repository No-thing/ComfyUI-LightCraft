"""
Tile split / merge for the skin pass test. Pure numpy (the nodes convert at the edges), so the maths can be tested without ComfyUI.
split: cuts the picture into overlapping tiles of equal size (the last ones sit flush with the edge, so nothing is left over).
merge: puts the (redrawn) tiles back, blending only where two tiles overlap, with a smooth ramp, so no seam shows.
"""
import numpy as np

MULT = 16


def _c16(v):
    return int(-(-int(v) // MULT) * MULT)


def _starts(total, t, n):
    if n <= 1 or total <= t:
        return [0]
    return [int(round(i * (total - t) / (n - 1))) for i in range(n)]


def layout(w, h, tile, overlap, zoom=1.0, count=0):
    """count = 0: tiles of `tile` px (by size). count = 2 or 4: the picture is cut into exactly 2 (along its long side) or 4 (2 x 2) tiles that always fit it,
    whatever its size (`tile` and `zoom` are then ignored).
    zoom > 1 (by size only) cuts SMALLER pieces of the picture (tile / zoom) and enlarges them to `tile`, so the model draws pores and fine hairs at a size it knows.
    The picture is padded (edge copy) up to a multiple of 16 so no strip is left over; merge cuts the padding off again."""
    pw, ph = _c16(w), _c16(h)
    count = int(count or 0)
    if count in (2, 4):
        nx, ny = (2, 2) if count == 4 else ((2, 1) if pw >= ph else (1, 2))
        ov = int(max(0, overlap))
        tw = min(pw, _c16(-(-(pw + ov * (nx - 1)) // nx)))
        th = min(ph, _c16(-(-(ph + ov * (ny - 1)) // ny)))
        ov = int(min(ov, tw // 2, th // 2))
        return dict(w=w, h=h, pw=pw, ph=ph, tw=tw, th=th, ov=ov, xs=_starts(pw, tw, nx), ys=_starts(ph, th, ny), out=max(tw, th), zoom=1.0, count=count)
    zoom = max(1.0, float(zoom or 1.0))
    src = max(MULT, int(round(int(tile) / zoom / MULT)) * MULT)
    tw, th = max(MULT, min(src, pw)), max(MULT, min(src, ph))
    ov = int(max(0, min(overlap, tw // 2, th // 2)))

    def starts(total, t):
        if total <= t:
            return [0]
        n = int(np.ceil((total - ov) / float(t - ov)))
        n = max(n, 2)
        return [int(round(i * (total - t) / (n - 1))) for i in range(n)]
    return dict(w=w, h=h, pw=pw, ph=ph, tw=tw, th=th, ov=ov, xs=starts(pw, tw), ys=starts(ph, th), out=int(tile), zoom=zoom, count=0)


def split(img, lay):
    ph, pw = lay.get("ph", lay["h"]), lay.get("pw", lay["w"])
    if (ph, pw) != img.shape[:2]:                               # pad to a multiple of 16 by copying the edge pixels
        img = np.pad(img, ((0, ph - img.shape[0]), (0, pw - img.shape[1]), (0, 0)), mode="edge")
    tiles = [img[y:y + lay["th"], x:x + lay["tw"], :3] for y in lay["ys"] for x in lay["xs"]]
    if lay.get("zoom", 1.0) > 1.0001:                           # enlarge each piece so the long side is `out` (Lanczos)
        from PIL import Image
        k = lay["out"] / float(max(lay["tw"], lay["th"]))
        ow, oh = max(MULT, int(round(lay["tw"] * k / MULT)) * MULT), max(MULT, int(round(lay["th"] * k / MULT)) * MULT)
        tiles = [np.asarray(Image.fromarray((np.clip(t, 0, 1) * 255 + 0.5).astype(np.uint8)).resize((ow, oh), Image.LANCZOS), dtype=np.float32) / 255.0 for t in tiles]
    return np.stack(tiles, 0)


def _ramp(n, ov, lo, hi):
    """weights along one axis of a tile: smooth ramp over `ov` px on a side that touches a neighbour, 1 elsewhere"""
    a = np.ones(n, np.float32)
    if ov > 0:
        t = (np.arange(ov, dtype=np.float32) + 0.5) / ov
        s = t * t * (3 - 2 * t)
        if lo:
            a[:ov] = s
        if hi:
            a[n - ov:] = np.minimum(a[n - ov:], s[::-1])
    return a


def merge(tiles, lay):
    w, h, tw, th, ov = lay.get("pw", lay["w"]), lay.get("ph", lay["h"]), lay["tw"], lay["th"], lay["ov"]
    th_, tw_ = tiles.shape[1:3]
    if (th_, tw_) != (th, tw):                                  # the tiles came back at another size: bring them to the layout's size
        from PIL import Image
        tiles = np.stack([np.asarray(Image.fromarray((np.clip(t, 0, 1) * 255 + 0.5).astype(np.uint8)).resize((tw, th), Image.LANCZOS), dtype=np.float32) / 255.0 for t in tiles], 0)
    acc = np.zeros((h, w, 3), np.float32)
    wsum = np.zeros((h, w, 1), np.float32)
    k = 0
    for yi, y in enumerate(lay["ys"]):
        for xi, x in enumerate(lay["xs"]):
            wy = _ramp(th, ov, yi > 0, yi < len(lay["ys"]) - 1)
            wx = _ramp(tw, ov, xi > 0, xi < len(lay["xs"]) - 1)
            m = (wy[:, None] * wx[None, :])[..., None]
            acc[y:y + th, x:x + tw] += tiles[k][..., :3] * m
            wsum[y:y + th, x:x + tw] += m
            k += 1
    out = np.clip(acc / np.maximum(wsum, 1e-6), 0, 1)
    return out[:lay["h"], :lay["w"]]                            # cut the padding off
