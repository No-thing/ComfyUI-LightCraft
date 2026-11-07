"""
Geometry for LightCraft Crop: straighten (angle), crop, resize to a megapixel budget.
Plain numpy + Pillow (no torch), so it can be tested on its own. Classic crop only: the crop
rectangle may leave the picture (turning it reveals gray corners; the Outpaint tab pads the canvas): everything that is
not picture is painted flat mid-gray and reported as a fill mask, so Qwen can paint it (the same idea as AusBoss's
Rotate + Outpaint). With `constrain_crop` on, the crop stays inside the picture as in a classic crop.

Crop coordinates are pixels on the *straightened canvas* (the picture rotated by `angle`, canvas
grown to hold it). A crop width/height of 0 means "automatic": the largest rectangle of the chosen
aspect ratio that fits inside the picture, centred.
"""
import math

import numpy as np
from PIL import Image, ImageFilter

RESIZE_METHODS = {
    "lanczos": Image.LANCZOS,
    "bicubic": Image.BICUBIC,
    "bilinear": Image.BILINEAR,
    "area": Image.BOX,
    "nearest": Image.NEAREST,
}

ASPECTS = ["free", "original", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]
ASPECT_NAMES = {
    "1:1": "Square", "2:3": "Portrait Photo", "3:2": "Photo", "3:4": "Portrait Standard",
    "4:3": "Standard", "9:16": "Portrait Widescreen", "16:9": "Widescreen", "21:9": "Ultrawide",
}


def aspect_value(name, src_w, src_h):
    """width / height for an aspect name, or None for 'free'."""
    if name == "free":
        return None
    if name == "original":
        return src_w / max(1, src_h)
    try:
        a, b = name.split(":")
        return float(a) / float(b)
    except (ValueError, ZeroDivisionError):
        return None


def canvas_size(w1, h1, angle):
    """Size of the canvas that holds a w1 x h1 picture rotated by `angle` degrees."""
    t = math.radians(angle)
    c, s = abs(math.cos(t)), abs(math.sin(t))
    return (max(1, math.ceil(w1 * c + h1 * s - 1e-6)),
            max(1, math.ceil(w1 * s + h1 * c - 1e-6)))


def auto_crop(w1, h1, angle, aspect=None):
    """(x, y, w, h) on the straightened canvas: centred, the largest that fits inside the picture."""
    w2, h2 = canvas_size(w1, h1, angle)
    if abs(angle) < 1e-6:
        if aspect is None:
            return 0, 0, w2, h2
        cw = min(w2, h2 * aspect)
        ch = cw / aspect
        return int((w2 - cw) / 2), int((h2 - ch) / 2), int(cw), int(ch)

    t = math.radians(angle)
    c, s = abs(math.cos(t)), abs(math.sin(t))
    if aspect is None:
        # max-area axis-aligned rectangle inside a rotated rectangle
        long_w = w1 >= h1
        side_long, side_short = (w1, h1) if long_w else (h1, w1)
        if side_short <= 2 * s * c * side_long or abs(s - c) < 1e-10:
            x = 0.5 * side_short
            cw, ch = (x / s, x / c) if long_w else (x / c, x / s)
        else:
            cos2 = c * c - s * s
            cw, ch = (w1 * c - h1 * s) / cos2, (h1 * c - w1 * s) / cos2
    else:
        k = min(w1 / (aspect * c + s), h1 / (aspect * s + c))
        cw, ch = k * aspect, k
    cw, ch = max(1, int(cw)), max(1, int(ch))
    return (w2 - cw) // 2, (h2 - ch) // 2, cw, ch


def target_size(w, h, megapixels, steps):
    steps = max(1, steps)
    scale = math.sqrt(max(0.01, megapixels) * 1_000_000 / (w * h))
    return (max(steps, int(round(w * scale / steps)) * steps),
            max(steps, int(round(h * scale / steps)) * steps))


def _resize(arr, size, method):
    planes = [np.asarray(Image.fromarray(np.ascontiguousarray(arr[..., c]), "F").resize(size, method),
                         dtype=np.float32) for c in range(arr.shape[2])]
    return np.stack(planes, axis=-1)


def straighten(src, angle, fill=0.5, edge=True):
    """Rotate the picture by `angle` degrees clockwise onto a canvas that holds all of it."""
    h1, w1 = src.shape[:2]
    if abs(angle) < 1e-6:
        return src
    w2, h2 = canvas_size(w1, h1, angle)
    m = 3 if edge else 0  # replicate the picture's edge pixels so interpolation never blends in the fill colour
    pad = np.pad(src, ((m, m), (m, m), (0, 0)), mode="edge") if m else src
    ph, pw = pad.shape[:2]
    W, H = max(w2 + 2 * m, pw), max(h2 + 2 * m, ph)
    ox, oy = (W - pw) // 2, (H - ph) // 2
    planes = []
    for c in range(src.shape[2]):
        big = np.full((H, W), fill, dtype=np.float32)
        big[oy:oy + ph, ox:ox + pw] = pad[..., c]
        im = Image.fromarray(big, "F").rotate(-angle, resample=Image.BICUBIC,
                                               center=(ox + pw / 2, oy + ph / 2), fillcolor=fill)
        planes.append(np.asarray(im, dtype=np.float32))
    rot = np.stack(planes, axis=-1)
    x0, y0 = (W - w2) // 2, (H - h2) // 2
    return rot[y0:y0 + h2, x0:x0 + w2]


def coverage(w1, h1, angle):
    """[h2, w2] float 0..1: 1 where the straightened canvas shows picture pixels, 0 on the gray corners."""
    if abs(angle) < 1e-6:
        return np.ones((h1, w1), np.float32)
    return np.clip(straighten(np.ones((h1, w1, 1), np.float32), angle, fill=0.0, edge=False)[..., 0], 0, 1)


def pads_of(p):
    """(left, top, right, bottom) margins the Outpaint tab added around the straightened canvas."""
    return tuple(max(0, int(p.get(k, 0) or 0)) for k in ("pad_left", "pad_top", "pad_right", "pad_bottom"))


def fill_crop(w1, h1, angle, aspect, pads=(0, 0, 0, 0)):
    """
    (x, y, w, h) on the padded canvas when the crop may leave the picture: the same frame the unturned picture had,
    centred (turning only reveals gray corners). With padding it is the whole padded canvas.
    """
    w2, h2 = canvas_size(w1, h1, angle)
    pl, pt, pr, pb = pads
    if pl or pt or pr or pb:
        return 0, 0, w2 + pl + pr, h2 + pt + pb
    if aspect is None or abs(aspect - w1 / max(1, h1)) < 1e-6:
        fw, fh = w1, h1
    else:
        fw = min(w1, h1 * aspect)
        fh = fw / aspect
    if abs(angle) < 1e-6 and aspect is None:
        return 0, 0, w2, h2
    fw, fh = max(1, int(fw)), max(1, int(fh))
    return (w2 - fw) // 2, (h2 - fh) // 2, fw, fh


FILL_MIN = 0.0004   # less than this share of the picture being gray is just an antialiased edge, not worth an outpaint


def process(src, p, is_mask=False):
    """
    src: float32 array [H, W, 3] in 0..1.  p: dict of parameters (see the node).
    Returns {"image": [h, w, 3], "width": int, "height": int, "fill": [h, w] 0..1 (1 = not picture, to be painted),
             "outpaint": bool}.  is_mask: a painted mask is carried through (its outside is 0, never gray).
    """
    src = np.clip(src, 0, 1).astype(np.float32)
    h1, w1 = src.shape[:2]
    angle = float(p.get("rotation_degrees", 0.0))
    constrain = bool(p.get("constrain_crop", False))
    pl, pt, pr, pb = (0, 0, 0, 0) if constrain else pads_of(p)
    if is_mask:
        canvas = straighten(src, angle, fill=0.0)
    else:
        canvas = straighten(src, angle)
    h2, w2 = canvas.shape[:2]
    cov = coverage(w1, h1, angle)
    if pl or pt or pr or pb:
        padw = ((pt, pb), (pl, pr))
        canvas = np.pad(canvas, padw + ((0, 0),), mode="constant", constant_values=0.0 if is_mask else 0.5)
        cov = np.pad(cov, padw, mode="constant", constant_values=0.0)
    H3, W3 = canvas.shape[:2]

    cx, cy = int(p.get("crop_x", 0)), int(p.get("crop_y", 0))
    cw, ch = int(p.get("crop_width", 0)), int(p.get("crop_height", 0))
    if cw <= 0 or ch <= 0:
        aspect = aspect_value(p.get("crop_aspect_ratio", "free"), w1, h1)
        if constrain:
            cx, cy, cw, ch = auto_crop(w1, h1, angle, aspect)
        else:
            cx, cy, cw, ch = fill_crop(w1, h1, angle, aspect, (pl, pt, pr, pb))
    cw, ch = max(1, min(cw, W3)), max(1, min(ch, H3))
    cx, cy = min(max(cx, 0), W3 - cw), min(max(cy, 0), H3 - ch)
    out = canvas[cy:cy + ch, cx:cx + cw]
    fill = 1.0 - cov[cy:cy + ch, cx:cx + cw]
    need = (not is_mask) and float((fill > 0.5).mean()) > FILL_MIN
    if not is_mask:
        if need:
            a = (1.0 - fill)[..., None]
            out = out * a + 0.5 * (1.0 - a)                      # flat gray where there is no picture
        else:
            fill = np.zeros_like(fill)                            # just an antialiased edge: leave the picture alone
            if pl or pt or pr or pb:
                pass

    mp = None
    if p.get("resize_to_megapixels"):
        mp = float(p.get("megapixels", 2.0))
    elif p.get("keep_input_size", False) and cw * ch > w1 * h1:           # a turn / canvas made it bigger than what came in: back to the input's pixel count
        mp = w1 * h1 / 1_000_000.0
    if mp is not None:
        width, height = target_size(cw, ch, mp, int(p.get("resolution_steps", 16)))
        if (width, height) != (cw, ch):
            method = RESIZE_METHODS.get(p.get("resize_method", "lanczos"), Image.LANCZOS)
            out = _resize(out, (width, height), method)
            fill = _resize_plane(fill, (width, height))
    height, width = out.shape[:2]
    xf = dict(w1=w1, h1=h1, w2=w2, h2=h2, angle=angle, pl=pl, pt=pt, cx=cx, cy=cy, cw=cw, ch=ch, width=width, height=height)   # where a point of the input ends up in the output (see map_points)
    return {"image": np.clip(out, 0, 1), "width": width, "height": height,
            "fill": np.clip(fill, 0, 1).astype(np.float32), "outpaint": bool(need), "xf": xf}


def map_points(pts, xf):
    """Pixels of the input picture -> pixels of the output picture (turn, outpaint margin, crop, resize), same maths as process()."""
    t = math.radians(xf["angle"])
    c, s = math.cos(t), math.sin(t)
    sx, sy = xf["width"] / max(1, xf["cw"]), xf["height"] / max(1, xf["ch"])
    out = []
    for x, y in pts:
        dx, dy = x - xf["w1"] / 2.0, y - xf["h1"] / 2.0
        u = xf["w2"] / 2.0 + dx * c - dy * s + xf["pl"] - xf["cx"]            # clockwise turn about the centre, onto the canvas
        v = xf["h2"] / 2.0 + dx * s + dy * c + xf["pt"] - xf["cy"]
        out.append((u * sx, v * sy))
    return out


def refine_mask(m, grow=0, smooth=0, fill_holes=False):
    """
    Clean up a painted / picked mask: fill enclosed holes, grow (+) or shrink (-) it by `grow` pixels,
    round off its outline by `smooth` pixels. Works on the 50% outline; untouched when all are off.
    """
    if not grow and not smooth and not fill_holes:
        return m
    b = m > 0.5
    try:
        from scipy import ndimage as ndi
    except ImportError:
        ndi = None
    if fill_holes:
        if ndi is not None:
            b = ndi.binary_fill_holes(b)
        else:  # flood the outside from a padded corner; whatever it does not reach is a hole
            from PIL import ImageDraw
            im = Image.fromarray(np.pad(b, 1).astype(np.uint8) * 255, "L")
            ImageDraw.floodfill(im, (0, 0), 128)
            b = (np.asarray(im)[1:-1, 1:-1] != 128)
    g = int(grow)
    if g > 0:
        if ndi is not None:
            b = ndi.distance_transform_edt(~b) <= g
        else:
            im = Image.fromarray(b.astype(np.uint8) * 255, "L")
            for _ in range(g):
                im = im.filter(ImageFilter.MaxFilter(3))
            b = np.asarray(im) > 127
    elif g < 0:
        if ndi is not None:
            b = ndi.distance_transform_edt(b) > -g
        else:
            im = Image.fromarray(b.astype(np.uint8) * 255, "L")
            for _ in range(-g):
                im = im.filter(ImageFilter.MinFilter(3))
            b = np.asarray(im) > 127
    if smooth and smooth > 0:
        im = Image.fromarray(b.astype(np.uint8) * 255, "L").filter(ImageFilter.GaussianBlur(float(smooth)))
        b = np.asarray(im) > 127
    return b.astype(np.float32)


def process_mask(mask, p, feather=0, grow=0, smooth=0, fill_holes=False):
    """
    Carry a painted mask through the same straighten / crop / resize as the picture, then tidy it.
    mask: float32 [H, W] in 0..1, the SAME size as the source picture (1 = change this).
    Returns float32 [h, w] matching process()'s image.
    """
    q = dict(p)
    q["resize_method"] = "bilinear"
    out = process(np.clip(mask, 0, 1)[..., None].astype(np.float32), q, is_mask=True)["image"][..., 0]      # one plane, not three
    out = refine_mask(out, grow, smooth, fill_holes)
    if feather and feather > 0:
        im = Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "L")
        out = np.asarray(im.filter(ImageFilter.GaussianBlur(float(feather))), dtype=np.float32) / 255.0
    return np.clip(out, 0, 1).astype(np.float32)


def limit_megapixels(arr, max_mp):
    """Shrink (never enlarge) a picture so it has at most max_mp megapixels. max_mp <= 0 means off."""
    h, w = arr.shape[:2]
    if not max_mp or max_mp <= 0 or w * h <= max_mp * 1_000_000:
        return arr
    k = math.sqrt(max_mp * 1_000_000 / (w * h))
    return _resize(arr, (max(1, int(round(w * k))), max(1, int(round(h * k)))), Image.LANCZOS)


# ---------------------------------------------------------------- crop around the mask / paste back
def _resize_plane(plane, size, method=Image.BILINEAR):
    return np.asarray(Image.fromarray(np.ascontiguousarray(plane.astype(np.float32)), "F").resize(size, method),
                      dtype=np.float32)


def _blur(plane, radius):
    if radius <= 0:
        return plane
    im = Image.fromarray((np.clip(plane, 0, 1) * 255 + 0.5).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(float(radius)))
    return np.asarray(im, dtype=np.float32) / 255.0


def inpaint_box(mask, context=1.6, min_side=64):
    """
    The window to hand to the editing model: the mask's bounding box, `context` times bigger, kept
    inside the picture. Returns (x0, y0, x1, y1) or None when the mask is empty.
    """
    h, w = mask.shape[:2]
    ys, xs = np.nonzero(mask > 0.02)
    if len(xs) == 0:
        return None
    bx0, bx1, by0, by1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    cw = max(min_side, (bx1 - bx0) * max(1.0, context))
    ch = max(min_side, (by1 - by0) * max(1.0, context))
    cw, ch = min(cw, w), min(ch, h)
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    x0 = int(round(min(max(cx - cw / 2, 0), w - cw)))
    y0 = int(round(min(max(cy - ch / 2, 0), h - ch)))
    return x0, y0, min(w, x0 + int(round(cw))), min(h, y0 + int(round(ch)))


def inpaint_prepare(images, mask, context=1.6, target_mp=1.5, steps=16, grow=8, edge=3, method="bicubic"):
    """
    images: list of float32 [H, W, 3] (same size); mask: float32 [H, W] (1 = change).
    Cuts a window around the mask, brings it to ~target_mp megapixels, and remembers how to paste
    the result back. Returns (crops, crop_mask, stitch). An empty mask means "the whole picture".
    """
    h, w = images[0].shape[:2]
    box = inpaint_box(mask, context) if mask is not None else None
    if box is None:
        return list(images), np.ones((h, w), np.float32), {"full": True, "size": (w, h)}
    x0, y0, x1, y1 = box
    rw, rh = x1 - x0, y1 - y0
    tw, th = target_size(rw, rh, target_mp, steps)
    rm = mask[y0:y1, x0:x1]
    paint = _resize_plane(rm, (tw, th))
    paint = refine_mask(paint, grow=grow)
    paint = _blur(paint, edge)
    meth = RESIZE_METHODS.get(method, Image.BICUBIC)
    crops = [_resize(np.ascontiguousarray(im[y0:y1, x0:x1]), (tw, th), meth) if (tw, th) != (rw, rh)
             else np.ascontiguousarray(im[y0:y1, x0:x1]) for im in images]
    blend = _blur(_resize_plane(paint, (rw, rh)), max(2.0, edge * rw / tw))
    return [np.clip(c, 0, 1) for c in crops], np.clip(paint, 0, 1), {
        "full": False, "size": (w, h), "box": (x0, y0, x1, y1), "blend": np.clip(blend, 0, 1).astype(np.float32)}


def inpaint_paste(base, edited, stitch):
    """Put the edited window (or the whole edited picture) back into `base` ([H, W, 3] float32)."""
    h, w = base.shape[:2]
    if stitch.get("full"):
        if edited.shape[:2] != (h, w):
            edited = _resize(edited, (w, h), Image.LANCZOS)
        return np.clip(edited, 0, 1).astype(np.float32)
    x0, y0, x1, y1 = stitch["box"]
    rw, rh = x1 - x0, y1 - y0
    if edited.shape[:2] != (rh, rw):
        edited = _resize(edited, (rw, rh), Image.LANCZOS)
    a = stitch["blend"][..., None]
    out = base.copy()
    out[y0:y1, x0:x1] = edited * a + base[y0:y1, x0:x1] * (1 - a)
    return np.clip(out, 0, 1).astype(np.float32)


def outpaint_blend(canvas, painted, fill, blend=24):
    """
    canvas, painted: float32 [H, W, 3]; fill: float32 [H, W] (1 = gray, to be painted).
    The painted picture replaces the gray area; just inside its edge it fades into the original over about `blend` pixels.
    """
    h, w = canvas.shape[:2]
    if painted.shape[:2] != (h, w):
        painted = _resize(painted, (w, h), Image.LANCZOS)
    if fill.shape != (h, w):
        fill = _resize_plane(fill, (w, h))
    a = np.clip(fill, 0, 1)
    if blend and blend > 0:
        a = np.maximum(a, _blur(a, blend / 2.0))
    a = a[..., None]
    return np.clip(painted * a + canvas * (1 - a), 0, 1).astype(np.float32)
