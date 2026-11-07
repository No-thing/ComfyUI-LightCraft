"""
Person mask from the Face tab's face points + ComfyUI's own SAM3_Detect (point prompts, the same call the old Mask tab used).
The face points say WHICH person: a few positive points are laid from the face down the body, so a background person is never picked.
The mask is then grown (generous padding) and feathered, so a skin pass can be blended over the original with no visible edge.
"""
import json

import numpy as np
from PIL import Image, ImageFilter

from . import lc_region as R


def person_points(P, w, h, rows=(0.0, 0.7, 1.7, 2.9)):
    """Pixel points (x, y) on the person the face belongs to: the nose, then down the neck and chest along the face's own axis."""
    top, chin, nose = np.array(P[10], float), np.array(P[152], float), np.array(P[1], float)
    L = float(np.hypot(*(chin - top)))
    if L < 4:
        return []
    d = (chin - top) / L
    pts = [nose] + [chin + d * L * r for r in rows[1:]]
    out = []
    for p in pts:
        x, y = int(round(p[0])), int(round(p[1]))
        if 0 <= x < w and 0 <= y < h:
            out.append((x, y))
    return out


def sam_mask(model, image, pts):
    """float32 [H, W] (1 = the picked person) from SAM3_Detect point prompts."""
    import nodes
    cls = nodes.NODE_CLASS_MAPPINGS.get("SAM3_Detect")
    if cls is None:
        raise RuntimeError("this ComfyUI has no SAM3_Detect node - please update ComfyUI")
    fn = getattr(cls(), getattr(cls, "FUNCTION", "execute"))
    out = fn(model=model, image=image, positive_coords=json.dumps([{"x": x, "y": y} for x, y in pts]), negative_coords="[]",
             threshold=0.5, refine_iterations=2, individual_masks=False)
    res = getattr(out, "result", out)
    masks = res[0]
    m = masks[0] if getattr(masks, "ndim", 3) >= 3 else masks
    if hasattr(m, "detach"):
        m = m.detach().cpu().numpy()
    return np.clip(np.asarray(m, dtype=np.float32), 0, 1)


def grow_feather(m, grow_px, feather_px):
    """Dilate by grow_px, then fade the edge over feather_px (both in picture pixels). Works on a small copy: fast on 8 MP pictures."""
    h, w = m.shape
    s = min(1.0, 1024.0 / max(w, h))
    tw, th = max(8, int(round(w * s))), max(8, int(round(h * s)))
    im = Image.fromarray((np.clip(m, 0, 1) * 255 + 0.5).astype(np.uint8), "L").resize((tw, th), Image.BILINEAR)
    r = int(round(grow_px * s))
    if r >= 1:
        im = im.filter(ImageFilter.MaxFilter(2 * min(r, 60) + 1))
        if r > 60:                                           # a very wide grow: repeat the filter
            for _ in range(int(r // 60)):
                im = im.filter(ImageFilter.MaxFilter(2 * 60 + 1))
    f = feather_px * s / 2.0
    if f >= 0.5:
        im = im.filter(ImageFilter.GaussianBlur(radius=f))
    a = np.asarray(im.resize((w, h), Image.BILINEAR), dtype=np.float32) / 255.0
    return np.clip(a, 0, 1)


def person_mask(model, image_arr, image_t, face_data, grow_px, feather_px):
    """-> (mask [H, W] float32, note, ok). With no face points the whole picture is used (so a first run never stops); ok is False then."""
    h, w = image_arr.shape[:2]
    P = R.face_points(face_data, w, h)
    if P is None:
        return np.ones((h, w), np.float32), "no face points (press Find face in the Edit Page): the whole picture is used", False
    pts = person_points(P, w, h)
    if not pts:
        return np.ones((h, w), np.float32), "could not place points on the person: the whole picture is used", False
    m = sam_mask(model, image_t, pts)
    if m.shape != (h, w):
        m = np.asarray(Image.fromarray((m * 255 + 0.5).astype(np.uint8), "L").resize((w, h), Image.BILINEAR), dtype=np.float32) / 255.0
    if m.max() < 0.5:
        return np.ones((h, w), np.float32), "SAM 3 found nothing at those points: the whole picture is used", False
    return grow_feather(m, grow_px, feather_px), f"person found, grown {grow_px}px, feathered {feather_px}px", True
