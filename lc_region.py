"""
Eyes / Face detail helpers: cut a region out of the picture, enlarge it so the model has plenty of pixels, and paste the
redrawn result back with a soft edge. The landmarks are the Face tab's (stored 0..1, so they fit a picture of ANY size,
which is why the same face data works on the small edit and on the big upscaled picture).
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .lc_face import parse

SIZES = {"Small 1024": 1024, "Medium 1280": 1280, "Big 1536": 1536, "Huge 2048": 2048, "Overkill 3072": 3072}
EYE_L_RING = (33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246)
EYE_R_RING = (263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466)
FACE_OVAL = (10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109)
BROWS = (70, 63, 105, 66, 107, 300, 293, 334, 296, 336)
MULT = 16                                                    # crop sides are rounded to a multiple of this (the model's latent grid)


def face_points(raw, w, h):
    """face_data JSON -> list of (x, y) pixels of the chosen face, or None."""
    d = parse(raw)
    faces = d["faces"]
    if not faces:
        return None
    lm = faces[min(max(d["sel"], 0), len(faces) - 1)]
    if lm and isinstance(lm[0], (list, tuple)):
        P = [(float(a) * w, float(b) * h) for a, b in lm]
    else:
        P = [(float(lm[i]) * w, float(lm[i + 1]) * h) for i in range(0, len(lm) - 1, 2)]
    return P if len(P) >= 468 else None


def region_box(P, kind, margin):
    """Pixel box (x0, y0, x1, y1) around the eyes (both, with brows) or the whole face."""
    if kind == "eyes":
        pts = [P[i] for i in EYE_L_RING + EYE_R_RING + BROWS]
    else:
        pts = P[:468]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    bw, bh = x1 - x0, y1 - y0
    if kind == "eyes":
        bh = max(bh, bw * 0.28)                                # a strip of eyes is wide and thin: keep some skin above and below
        cy = (y0 + y1) / 2
        y0, y1 = cy - bh / 2, cy + bh / 2
    mx, my = bw * margin, bh * margin
    return x0 - mx, y0 - my, x1 + mx, y1 + my


def make_region(w, h, P, kind, size, margin):
    """-> dict with the integer crop rectangle (inside the picture), the size it is redrawn at, and the kind."""
    x0, y0, x1, y1 = region_box(P, kind, margin)
    x0, y0 = max(0, int(np.floor(x0))), max(0, int(np.floor(y0)))
    x1, y1 = min(w, int(np.ceil(x1))), min(h, int(np.ceil(y1)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ValueError("The face is too small or outside the picture.")
    cw, ch = x1 - x0, y1 - y0
    s = size / max(cw, ch)                                      # long side of the crop becomes `size`
    tw = max(MULT, int(round(cw * s / MULT)) * MULT)
    th = max(MULT, int(round(ch * s / MULT)) * MULT)
    reg = dict(x0=x0, y0=y0, x1=x1, y1=y1, tw=tw, th=th, kind=kind, w=w, h=h)
    if kind == "eyes":                                           # only the eyes themselves come back: the skin and freckles around them stay as they were
        reg["polys"] = [[(P[i][0] - x0, P[i][1] - y0) for i in ring] for ring in (EYE_L_RING, EYE_R_RING)]
        reg["ew"] = float(np.hypot(P[33][0] - P[133][0], P[33][1] - P[133][1]))
    elif kind == "face":                                         # the face outline, not the box: hair, ears and background stay as they were
        reg["polys"] = [[(P[i][0] - x0, P[i][1] - y0) for i in FACE_OVAL]]
        xs = [P[i][0] for i in FACE_OVAL]
        reg["fw"] = float(max(xs) - min(xs))
    return reg


def _pil(arr):
    return Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8))


def crop(img, reg):
    """img float32 (h, w, 3) -> float32 (th, tw, 3), the region enlarged (Lanczos)."""
    c = img[reg["y0"]:reg["y1"], reg["x0"]:reg["x1"], :3]
    return np.asarray(_pil(c).resize((reg["tw"], reg["th"]), Image.LANCZOS), dtype=np.float32) / 255.0


def soft_mask(cw, ch, feather):
    """Rounded soft-edged mask (ch, cw): 1 in the middle, fading to 0 over `feather` (0..0.5) of the shorter side."""
    f = max(2.0, float(feather) * min(cw, ch))
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    d = np.minimum(np.minimum(xx + 0.5, cw - xx - 0.5), np.minimum(yy + 0.5, ch - yy - 0.5))   # distance to the nearest edge
    t = np.clip(d / f, 0, 1)
    return (t * t * (3 - 2 * t))[..., None]                     # smoothstep


def eye_mask(cw, ch, reg, feather):
    """Mask (ch, cw, 1) that is 1 on the eyes (a little beyond the lids, to take the lashes and the liner) and fades out softly."""
    if reg.get("kind") == "face":
        return face_mask(cw, ch, reg, feather)
    ew = max(8.0, reg.get("ew", 40.0))
    m = Image.new("L", (cw, ch), 0)
    d = ImageDraw.Draw(m)
    for poly in reg["polys"]:
        d.polygon([(float(x), float(y)) for x, y in poly], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(radius=max(1.0, 0.14 * ew)))                 # spread outward...
    a = np.clip(np.asarray(m, dtype=np.float32) / 255.0 * 2.6, 0, 1)                   # ...and push the half-way line out: a dilation
    a = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=max(1.0, (0.03 + 0.4 * feather) * ew))), dtype=np.float32) / 255.0
    return a[..., None]


def face_mask(cw, ch, reg, feather):
    """The face outline, filled white, with a soft inner edge (so the hairline, ears and background are never touched)."""
    fw = max(16.0, reg.get("fw", min(cw, ch)))
    m = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(m).polygon([(float(x), float(y)) for x, y in reg["polys"][0]], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(radius=max(2.0, (0.02 + feather * 0.35) * fw)))
    a = np.clip((np.asarray(m, dtype=np.float32) / 255.0 - 0.15) / 0.7, 0, 1)           # edge pulled inside the outline, solid white in the middle
    return a[..., None]


def match_color(new, ref, strength):
    """Pull the redrawn crop's mean/spread per channel toward the original's, so no colour seam shows."""
    if strength <= 0:
        return new
    mn, sn = new.mean((0, 1)), new.std((0, 1)) + 1e-4
    mr, sr = ref.mean((0, 1)), ref.std((0, 1)) + 1e-4
    out = (new - mn) / sn * sr + mr
    return np.clip(new * (1 - strength) + out * strength, 0, 1)


def region_mask(reg, feather=0.22):
    """The mask paste() uses, (ch, cw, 1) in the crop's own pixels: white = what the redraw replaces."""
    cw, ch = reg["x1"] - reg["x0"], reg["y1"] - reg["y0"]
    return eye_mask(cw, ch, reg, feather) if reg.get("polys") else soft_mask(cw, ch, feather)


def paste(img, redrawn, reg, feather=0.22, color_match=0.8):
    """img float32 (h, w, 3), redrawn float32 (any size) -> img with the region replaced, soft edge."""
    x0, y0, x1, y1 = reg["x0"], reg["y0"], reg["x1"], reg["y1"]
    cw, ch = x1 - x0, y1 - y0
    new = np.asarray(_pil(redrawn[..., :3]).resize((cw, ch), Image.LANCZOS), dtype=np.float32) / 255.0
    old = img[y0:y1, x0:x1, :3]
    if reg.get("polys"):                                         # eyes: carry the original's soft colours over (kills colour halos), keep the new fine detail
        r = max(2.0, 0.22 * max(8.0, reg["ew"])) if reg.get("kind") == "eyes" else max(2.0, 0.06 * reg.get("fw", 200.0))
        blur = lambda a: np.stack([np.asarray(_pil(a[..., c:c + 1].repeat(3, 2)).filter(ImageFilter.GaussianBlur(radius=r)), dtype=np.float32)[..., 0] / 255.0 for c in range(3)], -1)
        new = np.clip(new + (blur(old) - blur(new)) * color_match, 0, 1)
    else:
        new = match_color(new, old, color_match)
    m = eye_mask(cw, ch, reg, feather) if reg.get("polys") else soft_mask(cw, ch, feather)
    out = img.copy()
    out[y0:y1, x0:x1, :3] = old * (1 - m) + new * m
    return out


def iris_colour(img, P):
    """Reads the colour of the irises from the picture (MediaPipe's iris points 468-477) -> a plain name like "hazel", or None.
    Only the visible iris is used: inside the eye opening, away from the pupil and the rim, without the catchlights."""
    import colorsys
    if len(P) < 478:
        return None
    h, w = img.shape[:2]
    pix = []
    for c, edge, ring in ((468, (469, 470, 471, 472), EYE_R_RING), (473, (474, 475, 476, 477), EYE_L_RING)):
        cx, cy = P[c]
        r = float(np.mean([np.hypot(P[e][0] - cx, P[e][1] - cy) for e in edge]))
        if r < 2:
            continue
        x0, x1, y0, y1 = max(0, int(cx - r) - 1), min(w, int(cx + r) + 2), max(0, int(cy - r) - 1), min(h, int(cy + r) + 2)
        if x1 - x0 < 3 or y1 - y0 < 3:
            continue
        opening = Image.new("L", (w, h), 0)
        ImageDraw.Draw(opening).polygon([(float(P[i][0]), float(P[i][1])) for i in ring], fill=255)
        op = np.asarray(opening, dtype=np.float32)[y0:y1, x0:x1] > 127
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        d = np.hypot(xx - cx, yy - cy)
        sel = op & (d >= 0.45 * r) & (d <= 0.9 * r)
        if sel.sum() >= 6:
            pix.append(img[y0:y1, x0:x1, :3][sel])
    if not pix:
        return None
    a = np.concatenate(pix, 0)
    lum = a.mean(1)
    lo, hi = np.percentile(lum, [12, 90])
    keep = a[(lum >= lo) & (lum <= hi)]
    if len(keep) < 4:
        keep = a
    r_, g_, b_ = [float(v) for v in np.median(keep, 0)]
    hh, ss, vv = colorsys.rgb_to_hsv(r_, g_, b_)
    hd = hh * 360.0
    if ss < 0.14:
        return "grey" if vv > 0.35 else "dark brown"
    if 170 <= hd <= 260:
        return "ocean blue" if (ss > 0.45 and vv > 0.55) else "blue"
    if 70 <= hd < 170:
        return "green"
    if vv < 0.30:
        return "dark brown"
    if 45 <= hd < 70 and ss > 0.25:
        return "hazel green"
    if 25 <= hd < 45 and ss > 0.72 and vv > 0.5:
        return "amber"
    return "brown" if vv < 0.45 else "hazel"
