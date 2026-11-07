"""
Two finishing touches for a skin pass, pure numpy / PIL so they can be tested without ComfyUI.
keep_colour: gives the result the ORIGINAL's overall colour back and keeps the new fine detail (a skin pass often shifts the tone).
face_protect: pastes the ORIGINAL pixels back over the lips / eyes / brows (the Face tab's landmarks), with a soft edge.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .lc_region import EYE_L_RING, EYE_R_RING, BROWS, FACE_OVAL, face_points

LIPS = (61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185)   # outer lip ring (MediaPipe 478 points)
BROW_L, BROW_R = (70, 63, 105, 66, 107, 55, 65, 52, 53, 46), (300, 293, 334, 296, 336, 285, 295, 282, 283, 276)
WORK = 256                                                   # colour is compared on a picture this big (long side): colour is a low-frequency thing


def _fit(orig, shape):
    """orig (h, w, 3) float 0..1 -> the size of `shape` (Lanczos)"""
    h, w = shape[:2]
    if orig.shape[:2] == (h, w):
        return orig[..., :3]
    im = Image.fromarray((np.clip(orig[..., :3], 0, 1) * 255 + 0.5).astype(np.uint8)).resize((w, h), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def _gauss(a, sigma):
    """separable gaussian blur of an (h, w, c) float array (edges repeated)"""
    r = int(max(1, round(sigma * 3)))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-(x * x) / (2 * sigma * sigma)); k /= k.sum()
    p = np.pad(a, ((r, r), (r, r), (0, 0)), mode="edge")
    p = sum(k[i] * p[i:i + a.shape[0], :, :] for i in range(len(k)))
    p = sum(k[i] * p[:, i:i + a.shape[1], :] for i in range(len(k)))
    return p


def _small(a, w, h):
    return np.stack([np.asarray(Image.fromarray(a[..., c]).resize((w, h), Image.BOX if a.shape[1] > w else Image.BICUBIC), dtype=np.float32) for c in range(3)], -1)


def keep_colour(result, orig, amount=0.7, softness=0.06):
    """result, orig: float 0..1 (h, w, 3). amount 0 = untouched, 1 = the overall colour is the original's.
    softness = the blur (fraction of the long side) that separates 'colour' from 'detail'."""
    amount = float(np.clip(amount, 0, 1))
    if amount <= 0:
        return result
    res = np.clip(result[..., :3], 0, 1).astype(np.float32)
    org = _fit(np.clip(orig, 0, 1), res.shape).astype(np.float32)
    h, w = res.shape[:2]
    k = WORK / float(max(h, w))
    sw, sh = max(8, int(round(w * k))), max(8, int(round(h * k)))
    sig = max(1.0, float(softness) * WORK)
    d = _gauss(_small(org, sw, sh), sig) - _gauss(_small(res, sw, sh), sig)          # the colour shift, smooth
    big = np.stack([np.asarray(Image.fromarray(d[..., c]).resize((w, h), Image.BICUBIC), dtype=np.float32) for c in range(3)], -1)
    return np.clip(res + amount * big, 0, 1)


def protect_mask(w, h, P, lips=True, eyes=True, brows=False, grow=0.02, feather=0.03):
    """soft mask (h, w) float 0..1: 1 on the protected parts. grow / feather are fractions of the face width."""
    fx = [P[i][0] for i in FACE_OVAL]
    fw = max(1.0, max(fx) - min(fx))
    rings = []
    if lips:
        rings.append(LIPS)
    if eyes:
        rings += [EYE_L_RING, EYE_R_RING]
    if brows:
        rings += [BROW_L, BROW_R]
    m = Image.new("L", (w, h), 0)
    dr = ImageDraw.Draw(m)
    for ring in rings:
        dr.polygon([P[i] for i in ring], fill=255)
    if not rings:
        return np.zeros((h, w), np.float32)
    g, f = max(0.0, grow * fw), max(0.5, feather * fw)
    if g > 0.5:
        m = m.filter(ImageFilter.GaussianBlur(g * 0.6))
        m = m.point(lambda v: 255 if v > 40 else int(v * 255 / 40))     # blur + lift = the shape grown outwards
    m = m.filter(ImageFilter.GaussianBlur(f))
    return np.asarray(m, dtype=np.float32) / 255.0


def face_protect(result, orig, raw_face, lips=True, eyes=True, brows=False, grow=0.02, feather=0.03, amount=1.0):
    """returns (image, mask, note). No face found -> the result untouched and a note."""
    res = np.clip(result[..., :3], 0, 1).astype(np.float32)
    h, w = res.shape[:2]
    P = face_points(raw_face, w, h)
    if P is None:
        return res, np.zeros((h, w), np.float32), "no face data: nothing protected (press Find face in the Edit Page's Face tab)"
    org = _fit(np.clip(orig, 0, 1), res.shape).astype(np.float32)
    m = protect_mask(w, h, P, lips, eyes, brows, grow, feather) * float(np.clip(amount, 0, 1))
    return res * (1 - m[..., None]) + org * m[..., None], m, "ok"
