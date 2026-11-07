"""
LightCraft Face: local, deterministic face reshaping (a Liquify built from face landmarks).

How it works
  * The browser finds 478 face landmarks (MediaPipe Face Landmarker) and stores them in the node.
  * Every slider becomes one or more "ops". An op is a soft round (Gaussian) region around a landmark that
    moves or scales the picture inside it:   sample_offset(p) = w(p) * (t + M (p - pivot)).
  * All ops are added into ONE smooth displacement field and the picture is sampled through it (bilinear).
    Outside the regions the field is exactly zero, so the rest of the frame is never touched.

The same ops are built in lc_face_tab.js and drawn by a WebGL shader, so the preview matches this code.
Pure numpy: no model, no network, no GPU needed for the final warp.
"""
import json
import math

import numpy as np

# MediaPipe face mesh landmark numbers used below (image-left = the subject's right side)
EYE_L = dict(outer=33, inner=133, top=159, bottom=145)      # the eye on the left of the picture
EYE_R = dict(outer=263, inner=362, top=386, bottom=374)     # the eye on the right of the picture
NOSE_TIP, NOSE_BRIDGE, NOSE_BASE, ALA_L, ALA_R = 1, 6, 2, 129, 358
MOUTH_L, MOUTH_R = 61, 291
LIP_TOP, LIP_IN_TOP, LIP_IN_BOT, LIP_BOT = 0, 13, 14, 17
JAW_L, JAW_R, CHIN, CHIN_TOP = 172, 397, 152, 175           # jaw corners, chin tip, just under the lower lip
CHEEK_L, CHEEK_R = 50, 280
BROW_L = dict(outer=70, inner=107, arch=105)               # the brow on the left of the picture
BROW_R = dict(outer=300, inner=336, arch=334)
FOREHEAD_TOP, FOREHEAD_MID = 10, 151
LANDMARKS = 478

# slider name -> (label, min, max, default). Every slider is -100..100 and 0 = untouched.
GROUPS = [
    ("eyes", "Eyes", [
        ("eye_size", "Size"), ("eye_width", "Width"), ("eye_open", "Openness"),
        ("eye_tilt", "Tilt"), ("eye_spacing", "Spacing")]),
    ("nose", "Nose", [
        ("nose_size", "Size"), ("nose_width", "Nostril width"), ("nose_bridge", "Bridge"), ("nose_tip", "Tip lift")]),
    ("lips", "Lips", [
        ("lip_fullness", "Fullness"), ("lip_upper", "Upper lip"), ("lip_lower", "Lower lip"),
        ("lip_width", "Width"), ("lip_corners", "Corners"), ("lip_height", "Mouth height")]),
    ("shape", "Face shape", [
        ("jaw_width", "Jaw width"), ("chin_length", "Chin length"), ("chin_width", "Chin width"), ("cheek_fullness", "Cheeks")]),
    ("brows", "Brows and forehead", [
        ("brow_height", "Brow height"), ("brow_tilt", "Brow tilt"), ("forehead_height", "Forehead")]),
]
SLIDERS = [k for _, _, rows in GROUPS for k, _ in rows]
MAX_OPS = 40
CUT = 4.5                                            # exp(-CUT) is where the soft region ends
_E0 = math.exp(-CUT)


def _lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _op(c, sx, sy, pivot=None, t=(0.0, 0.0), m=(0.0, 0.0, 0.0, 0.0)):
    return {"c": (float(c[0]), float(c[1])), "s": (float(sx), float(sy)),
            "pv": tuple(map(float, pivot if pivot is not None else c)), "t": (float(t[0]), float(t[1])), "m": tuple(map(float, m))}


def _scale(c, sx, sy, kx, ky, pivot=None):
    """Enlarge (k > 0) / shrink about `pivot`; the soft region sits on `c`."""
    return _op(c, sx, sy, pivot, (0, 0), (-kx, 0.0, 0.0, -ky))


def _move(c, sx, sy, dx, dy):
    """Move the content inside the region by (dx, dy) pixels."""
    return _op(c, sx, sy, None, (-dx, -dy), (0, 0, 0, 0))


def _rotate(c, sx, sy, pivot, phi):
    """Turn the content about `pivot` by phi radians (y points down)."""
    co, si = math.cos(phi), math.sin(phi)               # sampling goes backwards: R(-phi) - I
    return _op(c, sx, sy, pivot, (0, 0), (co - 1.0, si, -si, co - 1.0))


def pose(P, zpx=None):
    """
    The face's own axes as seen by the camera. Returns (origin, A) where the columns of A are the picture-plane
    projections of the face's unit "right" and "down" directions. Roll turns them, yaw / pitch shorten them
    (a head turned 40 degrees shows its width at cos 40 = 77%). zpx: depth in pixels of landmarks 33, 263, 61, 291
    (MediaPipe's z, times the picture width); without it only the roll is known.
    """
    z = list(zpx) if zpx and len(zpx) >= 4 else [0.0, 0.0, 0.0, 0.0]
    L, R, ML, MR = P[33], P[263], P[61], P[291]
    r = (R[0] - L[0], R[1] - L[1], z[1] - z[0])
    em = ((L[0] + R[0]) / 2.0, (L[1] + R[1]) / 2.0, (z[0] + z[1]) / 2.0)
    d = ((ML[0] + MR[0]) / 2.0 - em[0], (ML[1] + MR[1]) / 2.0 - em[1], (z[2] + z[3]) / 2.0 - em[2])
    rn = math.sqrt(sum(a * a for a in r)) or 1.0
    u = tuple(a / rn for a in r)
    dot = sum(a * b for a, b in zip(d, u))
    d = tuple(a - b * dot for a, b in zip(d, u))
    dn = math.sqrt(sum(a * a for a in d))
    v = tuple(a / dn for a in d) if dn > 1e-6 else (-u[1], u[0], 0.0)
    A = [[u[0], v[0]], [u[1], v[1]]]
    det = A[0][0] * A[1][1] - A[0][1] * A[1][0]
    if abs(det) < 0.3:                                                       # an extreme turn: trust only the roll
        ln = math.hypot(r[0], r[1]) or 1.0
        ux, uy = r[0] / ln, r[1] / ln
        A = [[ux, -uy], [uy, ux]]
    return (em[0], em[1]), A


def _to_image(op, o, A, Ai):
    """An op made in the face's own (frontal) coordinates -> the same op in picture pixels."""
    mv = lambda M, p: (M[0][0] * p[0] + M[0][1] * p[1], M[1][0] * p[0] + M[1][1] * p[1])
    c = mv(A, op["c"]); pv = mv(A, op["pv"])
    t = mv(A, op["t"])
    m = op["m"]
    Mq = [[m[0], m[1]], [m[2], m[3]]]
    AM = [[sum(A[i][k] * Mq[k][j] for k in range(2)) for j in range(2)] for i in range(2)]
    Mp = [[sum(AM[i][k] * Ai[k][j] for k in range(2)) for j in range(2)] for i in range(2)]
    sx, sy = op["s"]
    G = [[Ai[0][0] / sx, Ai[0][1] / sx], [Ai[1][0] / sy, Ai[1][1] / sy]]
    return {"c": (o[0] + c[0], o[1] + c[1]), "pv": (o[0] + pv[0], o[1] + pv[1]), "t": t,
            "m": (Mp[0][0], Mp[0][1], Mp[1][0], Mp[1][1]), "g": (G[0][0], G[0][1], G[1][0], G[1][1])}


def build_ops(P, params, zpx=None):
    """P: sequence of (x, y) landmark positions in pixels (>= 468). params: slider name -> -100..100."""
    g = lambda k: float(params.get(k, 0) or 0) / 100.0
    org, A = pose(P, zpx)
    det = A[0][0] * A[1][1] - A[0][1] * A[1][0]
    Ai = [[A[1][1] / det, -A[0][1] / det], [-A[1][0] / det, A[0][0] / det]]
    # everything below is laid out in the face's own frame (x = along the eyes, y = down the face), where the face is
    # square-on; _to_image turns the finished ops back into the tilted / turned picture
    pt = lambda i: (Ai[0][0] * (float(P[i][0]) - org[0]) + Ai[0][1] * (float(P[i][1]) - org[1]),
                    Ai[1][0] * (float(P[i][0]) - org[0]) + Ai[1][1] * (float(P[i][1]) - org[1]))
    ops = []
    fs = max(_dist(pt(EYE_L["outer"]), pt(EYE_R["outer"])), 1.0)           # the face's scale: outer eye corner to outer eye corner

    # ---- eyes (each eye on its own)
    for eye in (EYE_L, EYE_R):
        o, i = pt(eye["outer"]), pt(eye["inner"])
        c = _lerp(_lerp(o, i, 0.5), _lerp(pt(eye["top"]), pt(eye["bottom"]), 0.5), 0.5)
        ew = max(_dist(o, i), 1.0)
        sgn = 1.0 if o[0] > i[0] else -1.0                                 # +1 = the outer corner is on the right
        sx, sy = 0.62 * ew, 0.42 * ew
        if g("eye_size"):
            ops.append(_scale(c, sx, sy, 0.22 * g("eye_size"), 0.22 * g("eye_size")))
        if g("eye_width"):
            ops.append(_scale(c, sx, sy, 0.22 * g("eye_width"), 0.0))
        if g("eye_open"):
            ops.append(_scale(c, sx, sy, 0.0, 0.40 * g("eye_open")))
        if g("eye_tilt"):                                                   # + = outer corner up, both eyes
            pivot = _lerp(i, o, 0.3)
            ops.append(_rotate(c, 0.66 * ew, 0.46 * ew, pivot, -sgn * 0.20 * g("eye_tilt")))
        if g("eye_spacing"):                                                # + = further apart
            ops.append(_move(c, 0.72 * ew, 0.62 * ew, sgn * 0.075 * fs * g("eye_spacing"), 0.0))

    # ---- nose
    tip, bridge = pt(NOSE_TIP), pt(NOSE_BRIDGE)
    al, ar = pt(ALA_L), pt(ALA_R)
    nw = max(_dist(al, ar), 1.0)
    nc = _lerp(bridge, tip, 0.62)
    if g("nose_size"):
        ops.append(_scale(nc, 0.50 * nw, 0.60 * nw, 0.12 * g("nose_size"), 0.12 * g("nose_size")))
    if g("nose_width"):
        ops.append(_scale(_lerp(al, ar, 0.5), 0.42 * nw, 0.30 * nw, 0.20 * g("nose_width"), 0.0))
    if g("nose_bridge"):
        ops.append(_scale(_lerp(bridge, tip, 0.35), 0.20 * nw, 0.45 * nw, 0.28 * g("nose_bridge"), 0.0))
    if g("nose_tip"):                                                       # + = tip turned up
        ops.append(_move(tip, 0.26 * nw, 0.26 * nw, 0.0, -0.10 * nw * g("nose_tip")))

    # ---- lips
    ml, mr = pt(MOUTH_L), pt(MOUTH_R)
    mw = max(_dist(ml, mr), 1.0)
    mc = _lerp(ml, mr, 0.5)
    t_out, t_in, b_in, b_out = pt(LIP_TOP), pt(LIP_IN_TOP), pt(LIP_IN_BOT), pt(LIP_BOT)
    mid = _lerp(t_in, b_in, 0.5)
    if g("lip_fullness"):
        ops.append(_scale(mid, 0.30 * mw, 0.20 * mw, 0.04 * g("lip_fullness"), 0.50 * g("lip_fullness")))
    if g("lip_upper"):
        ops.append(_scale(_lerp(t_in, t_out, 0.5), 0.34 * mw, 0.12 * mw, 0.0, 0.55 * g("lip_upper"), pivot=t_in))
    if g("lip_lower"):
        ops.append(_scale(_lerp(b_in, b_out, 0.5), 0.34 * mw, 0.14 * mw, 0.0, 0.55 * g("lip_lower"), pivot=b_in))
    if g("lip_width"):
        for m in (ml, mr):                                                  # the two corners move out / in: only the lips, never the cheeks or jaw
            ops.append(_move(m, 0.17 * mw, 0.15 * mw, (1.0 if m[0] > mc[0] else -1.0) * 0.065 * mw * g("lip_width"), 0.0))
    if g("lip_corners"):                                                    # + = smile (corners lifted)
        for m in (ml, mr):
            ops.append(_move(m, 0.17 * mw, 0.17 * mw, 0.0, -0.11 * mw * g("lip_corners")))
    if g("lip_height"):                                                     # + = mouth higher up
        ops.append(_move(mc, 0.62 * mw, 0.40 * mw, 0.0, -0.12 * mw * g("lip_height")))
    # ---- face shape: jaw corners, chin, cheeks
    chin, chin_top = pt(CHIN), pt(CHIN_TOP)
    if g("jaw_width"):                                                      # + = wider jaw
        for j in (pt(JAW_L), pt(JAW_R)):
            ops.append(_move(j, 0.21 * fs, 0.24 * fs, (1.0 if j[0] > chin[0] else -1.0) * 0.065 * fs * g("jaw_width"), 0.0))
    if g("chin_length"):                                                    # + = longer chin
        ops.append(_move(chin, 0.22 * fs, 0.21 * fs, 0.0, 0.08 * fs * g("chin_length")))
    if g("chin_width"):
        ops.append(_scale(_lerp(chin, chin_top, 0.4), 0.18 * fs, 0.16 * fs, 0.22 * g("chin_width"), 0.0))
    if g("cheek_fullness"):                                                 # + = fuller, - = slimmer
        for c in (pt(CHEEK_L), pt(CHEEK_R)):
            ops.append(_scale(c, 0.21 * fs, 0.20 * fs, 0.11 * g("cheek_fullness"), 0.11 * g("cheek_fullness")))

    # ---- brows and forehead
    for brow in (BROW_L, BROW_R):
        arch, bo, bi = pt(brow["arch"]), pt(brow["outer"]), pt(brow["inner"])
        sgn = 1.0 if bo[0] > bi[0] else -1.0
        if g("brow_height"):                                                # + = brows raised
            ops.append(_move(arch, 0.28 * fs, 0.14 * fs, 0.0, -0.05 * fs * g("brow_height")))
        if g("brow_tilt"):                                                  # + = outer end up
            ops.append(_rotate(arch, 0.32 * fs, 0.15 * fs, bi, -sgn * 0.16 * g("brow_tilt")))
    if g("forehead_height"):                                                # + = taller forehead
        fm, ft = pt(FOREHEAD_MID), pt(FOREHEAD_TOP)
        ops.append(_scale(_lerp(fm, ft, 0.5), 0.56 * fs, 0.32 * fs, 0.0, 0.085 * g("forehead_height"), pivot=fm))
    return [_to_image(op, org, A, Ai) for op in ops[:MAX_OPS]]


def _weight(dx, dy, gm):
    a = gm[0] * dx + gm[1] * dy
    b = gm[2] * dx + gm[3] * dy
    r2 = a * a + b * b
    w = (np.exp(-0.5 * r2) - _E0) / (1.0 - _E0)
    return np.where(r2 < 2.0 * CUT, np.maximum(w, 0.0), 0.0).astype(np.float32)


def field(ops, w, h):
    """The sampling offset (h, w, 2) for a w x h picture, and the pixel box it touches (x0, y0, x1, y1)."""
    off = np.zeros((h, w, 2), np.float32)
    box = None
    for o in ops:
        g = o["g"]                                                           # the region is the ellipse |g (p - c)|^2 < 2 CUT
        det = g[0] * g[3] - g[1] * g[2]
        rx = math.sqrt(2 * CUT) * math.sqrt((g[3] ** 2 + g[1] ** 2)) / abs(det)
        ry = math.sqrt(2 * CUT) * math.sqrt((g[2] ** 2 + g[0] ** 2)) / abs(det)
        x0, x1 = max(int(math.floor(o["c"][0] - rx - 1)), 0), min(int(math.ceil(o["c"][0] + rx + 1)), w)
        y0, y1 = max(int(math.floor(o["c"][1] - ry - 1)), 0), min(int(math.ceil(o["c"][1] + ry + 1)), h)
        if x1 <= x0 or y1 <= y0:
            continue
        px = (np.arange(x0, x1, dtype=np.float32) + 0.5)[None, :]
        py = (np.arange(y0, y1, dtype=np.float32) + 0.5)[:, None]
        wt = _weight(px - o["c"][0], py - o["c"][1], o["g"])
        qx, qy = px - o["pv"][0], py - o["pv"][1]
        m = o["m"]
        off[y0:y1, x0:x1, 0] += wt * (o["t"][0] + m[0] * qx + m[1] * qy)
        off[y0:y1, x0:x1, 1] += wt * (o["t"][1] + m[2] * qx + m[3] * qy)
        box = (x0, y0, x1, y1) if box is None else (min(box[0], x0), min(box[1], y0), max(box[2], x1), max(box[3], y1))
    return off, box


def warp(img, ops):
    """img: float32 (h, w, c). Returns the picture sampled through the ops' field (a copy)."""
    h, w = img.shape[:2]
    off, box = field(ops, w, h)
    if box is None:
        return img
    x0, y0, x1, y1 = box
    out = img.copy()
    px = np.arange(x0, x1, dtype=np.float32)[None, :] + 0.5
    py = np.arange(y0, y1, dtype=np.float32)[:, None] + 0.5
    sx = px + off[y0:y1, x0:x1, 0] - 0.5                                      # source position in pixel-centre units
    sy = py + off[y0:y1, x0:x1, 1] - 0.5
    sx = np.clip(sx, 0, w - 1)
    sy = np.clip(sy, 0, h - 1)
    ix, iy = np.floor(sx).astype(np.int32), np.floor(sy).astype(np.int32)
    ix1, iy1 = np.minimum(ix + 1, w - 1), np.minimum(iy + 1, h - 1)
    fx, fy = (sx - ix)[..., None], (sy - iy)[..., None]
    a = img[iy, ix] * (1 - fx) + img[iy, ix1] * fx
    b = img[iy1, ix] * (1 - fx) + img[iy1, ix1] * fx
    out[y0:y1, x0:x1] = (a * (1 - fy) + b * fy).astype(img.dtype)
    return out


def parse(raw):
    """face_data JSON -> dict(faces=[landmark lists], sel=int, p={slider: value}); never raises."""
    try:
        d = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
    except Exception:
        d = {}
    if not isinstance(d, dict):
        d = {}
    p = {k: float((d.get("p") or {}).get(k, 0) or 0) for k in SLIDERS}
    return {"faces": d.get("faces") or [], "sel": int(d.get("sel") or 0), "p": p, "on": d.get("on", True) is not False,
            "src": str(d.get("src") or ""), "zs": d.get("zs") or [], "pic": str(d.get("pic") or "")}


def picture_id(img):
    """The same 16-hex id the Edit Page gives the picture it shows (lc_src_<id>.png): md5 of its 8-bit pixels."""
    import hashlib
    return hashlib.md5((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes()).hexdigest()[:16]


def active(d):
    return d["on"] and any(abs(v) > 1e-6 for v in d["p"].values()) and bool(d["faces"])


def apply_state(img, raw, require_pic=False):
    """Apply a face_data JSON to a float32 (h, w, 3) picture. Landmarks are stored 0..1 (x / width, y / height)."""
    d = parse(raw)
    if not active(d):
        return img
    faces = d["faces"]
    lm = faces[min(max(d["sel"], 0), len(faces) - 1)]
    if len(lm) < 468 * 2 and not (lm and isinstance(lm[0], (list, tuple))):
        return img
    h, w = img.shape[:2]
    if d["src"] and d["src"] != f"{w}x{h}":                                  # the landmarks belong to a different-sized picture
        return img
    if lm and isinstance(lm[0], (list, tuple)):                              # [[x, y], ...]
        P = [(float(a) * w, float(b) * h) for a, b in lm]
    else:                                                                    # flat [x0, y0, x1, y1, ...]
        P = [(float(lm[i]) * w, float(lm[i + 1]) * h) for i in range(0, len(lm) - 1, 2)]
    if len(P) < 468:
        return img
    if (d["pic"] or require_pic) and picture_id(img) != d["pic"]:                              # a different picture (a new random roll): these landmarks are not its face
        return img
    sel = min(max(d["sel"], 0), len(faces) - 1)
    zs = d["zs"][sel] if sel < len(d["zs"]) and isinstance(d["zs"][sel], (list, tuple)) and len(d["zs"][sel]) >= 4 else None
    zpx = [float(v) * w for v in zs[:4]] if zs else None                     # MediaPipe's z is measured like x: in picture widths
    return warp(img, build_ops(P, d["p"], zpx))
