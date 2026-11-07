"""
LightCraft Grade  - colour grading with 50 look presets (on/off switch + dropdown + sliders)
LightCraft FX     - lens distortion, chromatic aberration, glow, halation, light leak,
                    Instagram-style filters, vignette and film grain
"""
import math
import os
import random

import torch
import torch.nn.functional as F

from .lc_presets import FX, GRADE, GRAIN, LENS, NONE, names
from .lc_sliders import FX_ANALOG, FX_BASE, FX_FILM, FX_SLIDERS, GRADE_SLIDERS, GRAIN_SLIDERS, LENS_SLIDERS
from .lightcraft_nodes import (
    _blur, _device, _grade3, _hue_rgb, _lin_to_srgb, _luma, _sat_vib,
    _smooth, _srgb_to_lin, _vignette,
)

# name: (type, min, max, default, step)









# ----------------------------------------------------------------------------- shared bits
def _wb_exposure(x, t, ti, ev):
    """Temperature / tint / exposure in linear light, with a soft highlight shoulder."""
    if not (t or ti or ev):
        return x
    lin = _srgb_to_lin(x)
    if t or ti:
        gains = torch.tensor(
            [2 ** (0.45 * t), 2 ** (-0.30 * ti), 2 ** (-0.45 * t)], device=x.device, dtype=x.dtype
        )
        gains = gains / (0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2])
        lin = lin * gains.view(1, 3, 1, 1)
    if ev:
        lin = lin * (2.0 ** ev)
    x = _lin_to_srgb(lin)
    return torch.where(x > 0.8, 0.8 + 0.2 * torch.tanh((x - 0.8) / 0.2), x)


def _contrast(x, c):
    if not c:
        return x
    xs = x.clamp(0, 1)
    return x + c * ((xs * xs * (3 - 2 * xs)) - xs)


def _fade(x, f):
    if not f:
        return x
    return f * 0.2 + x * (1 - f * 0.25)


def _screen(x, layer):
    return 1 - (1 - x.clamp(0, 1)) * (1 - layer.clamp(0, 1))


# ----------------------------------------------------------------------------- grade
def grade(img, p):
    x = _wb_exposure(img, p["temperature"] / 100.0, p["tint"] / 100.0, p["exposure"])
    x = _contrast(x, p["contrast"] / 100.0)
    x = _fade(x, p["fade"] / 100.0)
    x = _sat_vib(x, p["saturation"] / 100.0, p["vibrance"] / 100.0)
    if p["bw"]:
        lum = _luma(x)
        x = x + (lum - x) * (p["bw"] / 100.0)
    x = _grade3(x, p)
    x = x.clamp(0, 1)
    s = p["strength"] / 100.0
    return img + (x - img) * s if s < 1.0 else x


# ----------------------------------------------------------------------------- fx
def _lens(x, dist, ca):
    if not (dist or ca):
        return x
    _, _, h, w = x.shape
    ys = torch.linspace(-1, 1, h, device=x.device, dtype=x.dtype)
    xs = torch.linspace(-1, 1, w, device=x.device, dtype=x.dtype)
    gy, gx = torch.meshgrid(ys, xs, indexing="ij")
    k = dist / 100.0 * 0.5
    base = 1 + k * (gx * gx + gy * gy)
    if k > 0:
        base = base / (1 + 2 * k)  # zoom in so barrel distortion doesn't expose the edges
    s = ca / 100.0 * 0.015
    chans = []
    for ci, a in enumerate((s, 0.0, -s)):  # red spreads outward, blue pulls inward
        f = base * (1 + a)
        grid = torch.stack((gx * f, gy * f), dim=-1).unsqueeze(0)
        chans.append(
            F.grid_sample(x[:, ci:ci + 1], grid, mode="bilinear", padding_mode="border", align_corners=True)
        )
    return torch.cat(chans, dim=1)


def _hblur(x, sigma):
    """Horizontal-only gaussian (analog video smears sideways, not up and down)."""
    if sigma < 0.3:
        return x
    r = max(1, int(math.ceil(sigma * 3)))
    t = torch.arange(-r, r + 1, device=x.device, dtype=x.dtype)
    k = torch.exp(-(t * t) / (2 * sigma * sigma))
    k = (k / k.sum()).view(1, 1, 1, -1).repeat(x.shape[1], 1, 1, 1)
    return F.conv2d(F.pad(x, (r, r, 0, 0), mode="replicate"), k, groups=x.shape[1])


def _analog(x, p, seed):
    """Old TV / CRT / damaged tape: colour bleed, ghosting, line wobble, dropouts, static, scanlines, phosphor mask, curved glass."""
    if not any(p[k] for k in FX_ANALOG if k != "tv_scan_size"):
        return x
    h, w = x.shape[-2:]
    dev, dt = x.device, x.dtype
    gen = torch.Generator(device="cpu")
    gen.manual_seed(int(seed) & 0x7FFFFFFFFFFFFFFF)
    rnd = random.Random(int(seed))

    v = p["tv_bleed"] / 100.0
    if v:                                                     # composite video: colour smears sideways far more than brightness
        y = _luma(x)
        c = x - y
        x = _hblur(y, v * 0.002 * w) + _hblur(c, v * 0.012 * w)

    v = p["tv_ghost"] / 100.0
    if v:                                                     # weak echo of the picture a little to the right
        x = x * (1 - 0.28 * v) + torch.roll(x, shifts=max(2, int(w * (0.006 + 0.012 * v))), dims=3) * (0.28 * v)

    v = p["tv_wobble"] / 100.0
    if v:                                                     # every line slips sideways a little, with a drifting tracking band
        rows = torch.arange(h, device=dev, dtype=dt)
        ph = torch.rand(3, generator=gen).tolist()
        off = (torch.sin(rows * 0.045 + ph[0] * 6.28) * 0.5 + torch.sin(rows * 0.31 + ph[1] * 6.28) * 0.25) * 0.012 * v
        off = off + (torch.rand(h, generator=gen).to(dev, dt) - 0.5) * 0.006 * v
        band = (ph[2] * 0.8 + 0.1) * h
        off = off + torch.exp(-(((rows - band) / (h * 0.06)) ** 2)) * 0.05 * v * torch.sin(rows * 0.8)
        ys = torch.linspace(-1, 1, h, device=dev, dtype=dt).view(h, 1).expand(h, w)
        xs = torch.linspace(-1, 1, w, device=dev, dtype=dt).view(1, w).expand(h, w) + off.view(h, 1)
        x = F.grid_sample(x, torch.stack((xs, ys), dim=-1).unsqueeze(0), mode="bilinear", padding_mode="border", align_corners=True)

    v = p["tv_dropouts"] / 100.0
    if v:                                                     # white tape dropouts and a noisy band along the bottom
        m = torch.zeros(h, w)
        for _ in range(int(4 + v * 40)):
            yy, x0 = rnd.randrange(h), rnd.randrange(w)
            ln, th = int(w * (0.03 + 0.22 * rnd.random())), max(1, int(h / 540.0 * (1 + 2 * rnd.random())))
            m[yy:yy + th, x0:x0 + ln] = 0.55 + 0.45 * rnd.random()
        m = m.to(dev, dt).view(1, 1, h, w)
        x = x * (1 - m) + m
        bh = max(2, int(h * (0.01 + 0.05 * v)))
        nz = torch.rand((1, 1, bh, w), generator=gen).to(dev, dt)
        x = torch.cat([x[:, :, : h - bh], x[:, :, h - bh:] * 0.35 + nz * 0.65], dim=2)

    v = p["tv_noise"] / 100.0
    if v:                                                     # static: stretched sideways, like real analog snow
        cw = max(2, w // 3)
        n = torch.randn((1, 1, h, cw), generator=gen).to(dev, dt)
        n = F.interpolate(n, size=(h, w), mode="bilinear", align_corners=False)
        x = x + n * (0.30 * v)

    v = p["tv_scanlines"] / 100.0
    if v:
        n_lines = 480.0 - 3.2 * p["tv_scan_size"]
        period = max(2.0, h / n_lines)
        rows = torch.arange(h, device=dev, dtype=dt)
        lines = 0.5 + 0.5 * torch.cos(rows * (2 * math.pi / period))       # 1 on the line, 0 in the gap
        x = x * (1 - v * 0.7 * (1 - lines)).view(1, 1, h, 1)

    v = p["tv_mask"] / 100.0
    if v:                                                     # red / green / blue phosphor stripes
        k = max(1, int(round(w / 1000.0)))
        col = ((torch.arange(w, device=dev) // k) % 3)
        m = torch.stack([(col == i).to(dt) for i in range(3)], dim=0).view(1, 3, 1, w)
        x = x * (1 - v * 0.55 * (1 - m)) * (1 + v * 0.35)

    v = p["tv_curve"] / 100.0
    if v:                                                     # bulging glass: curved edges, black rounded corners, darker rim
        gy, gx = torch.meshgrid(torch.linspace(-1, 1, h, device=dev, dtype=dt), torch.linspace(-1, 1, w, device=dev, dtype=dt), indexing="ij")
        r2 = gx * gx + gy * gy
        k = 0.16 * v
        f = (1 + k * r2) / (1 + k)
        x = F.grid_sample(x, torch.stack((gx * f, gy * f), dim=-1).unsqueeze(0), mode="bilinear", padding_mode="zeros", align_corners=True)
        x = x * (1 - 0.35 * v * _smooth(0.6, 1.4, torch.sqrt(r2))).view(1, 1, h, w)
    return x


def _glow(x, amount, radius, thr, size):
    if not amount:
        return x
    lum = _luma(x).clamp(0, 1)
    t = thr / 100.0
    bright = x.clamp(0, 1) * _smooth(t, t + 0.3, lum)
    g = _blur(bright, (0.01 + 0.07 * radius / 100.0) * size)
    return _screen(x, g * (amount / 100.0) * 1.2)


def _halation(x, amount, size):
    if not amount:
        return x
    lum = _luma(x).clamp(0, 1)
    g = _blur(x.clamp(0, 1) * _smooth(0.7, 0.95, lum), 0.05 * size)
    tint = torch.tensor([1.0, 0.3, 0.1], device=x.device, dtype=x.dtype).view(1, 3, 1, 1)
    return x + g * tint * (amount / 100.0) * 0.9


def _noise_field(h, w, cells, gen, dev, dt):
    """Smooth random field (zero mean, unit spread) with roughly `cells` blobs along the long side."""
    m = max(h, w)
    gh, gw = max(2, round(cells * h / m)), max(2, round(cells * w / m))
    n = torch.randn((1, 1, gh, gw), generator=gen).to(dev, dt)
    n = F.interpolate(n, size=(h, w), mode="bicubic", align_corners=False)
    return (n - n.mean()) / (n.std() + 1e-6)


def _smoothstep(a, b, t):
    t = ((t - a) / (b - a)).clamp(0, 1)
    return t * t * (3 - 2 * t)


_LEAK_COLS = [(1.0, 0.42, 0.12), (1.0, 0.2, 0.08), (1.0, 0.66, 0.16), (1.0, 0.24, 0.46), (1.0, 0.85, 0.3)]
_SIDES = {"l": (-1.15, None), "r": (1.15, None), "t": (None, -1.15), "b": (None, 1.15),
          "tl": (-1.1, -1.1), "tr": (1.1, -1.1), "bl": (-1.1, 1.1), "br": (1.1, 1.1)}


def _leak(x, amount, seed=0):
    """Light leaks: 1-3 soft coloured glows creeping in from the frame edges. The seed picks where, how big, what colour."""
    if not amount:
        return x
    h, w = x.shape[-2:]
    dev, dt = x.device, x.dtype
    rnd = random.Random("leak:%d" % int(seed))
    gen = torch.Generator(device="cpu")
    gen.manual_seed((int(seed) * 2654435761 + 11) & 0x7FFFFFFFFFFFFFFF)
    yy = torch.linspace(-1, 1, h, device=dev, dtype=dt).view(h, 1)
    xx = torch.linspace(-1, 1, w, device=dev, dtype=dt).view(1, w)
    total = torch.zeros((1, 3, h, w), device=dev, dtype=dt)
    for _ in range(rnd.choice([1, 1, 2, 2, 3])):
        side = rnd.choice(list(_SIDES))
        cx, cy = _SIDES[side]
        if cx is None:
            cx = rnd.uniform(-0.7, 0.7)
        if cy is None:
            cy = rnd.uniform(-0.7, 0.7)
        vertical = side in ("l", "r")
        sx, sy = (rnd.uniform(0.3, 0.7), rnd.uniform(0.5, 1.4)) if vertical else (rnd.uniform(0.5, 1.4), rnd.uniform(0.3, 0.7))
        ang = rnd.uniform(-0.6, 0.6)
        dx, dy = xx - cx, yy - cy
        u = dx * math.cos(ang) + dy * math.sin(ang)
        v = -dx * math.sin(ang) + dy * math.cos(ang)
        m = torch.exp(-((u / sx) ** 2 + (v / sy) ** 2))
        m = m * (1 + 0.18 * _noise_field(h, w, 4, gen, dev, dt)[0, 0]).clamp(0.4, 1.4)
        col = torch.tensor(rnd.choice(_LEAK_COLS), device=dev, dtype=dt).view(1, 3, 1, 1)
        white = torch.tensor([1.0, 0.95, 0.85], device=dev, dtype=dt).view(1, 3, 1, 1)
        hot = (m ** 3).view(1, 1, h, w) * 0.45                    # the middle of a leak runs hot, nearly white
        total = total + (col * (1 - hot) + white * hot) * m.view(1, 1, h, w) * rnd.uniform(0.6, 1.0)
    return _screen(x, total * (amount / 100.0) * 1.5)


def _small(x, long_side):
    h, w = x.shape[-2:]
    if max(h, w) <= long_side:
        return x
    k = long_side / max(h, w)
    return F.adaptive_avg_pool2d(x, (max(4, round(h * k)), max(4, round(w * k))))


def _pixsort(x, p):
    """Pixel sorting: runs of pixels whose brightness sits between the two thresholds get sorted by brightness."""
    amt = p.get("sort_amount", 0)
    if not amt:
        return x
    lo, hi = sorted((p.get("sort_low", 25) / 100.0, p.get("sort_high", 85) / 100.0))
    y = x.transpose(-1, -2) if p.get("sort_vertical", 0) >= 1 else x
    _, c, hh, ww = y.shape
    lum = _luma(y).clamp(0, 1)[:, 0]                                   # (1,H,W)
    m = ((lum >= lo) & (lum <= hi)).long()
    run = max(8, int(ww * (0.04 + 0.96 * amt / 100.0)))                # the amount sets how long a streak may get
    idx = torch.arange(ww, device=y.device).view(1, 1, ww)
    prev = torch.cat([torch.zeros_like(m[..., :1]), m[..., :-1]], dim=-1)
    start = ((m != prev) | (m == 0) | (idx % run == 0)).long()          # a new run starts at every edge of the mask; pixels outside it stay alone
    seg = start.cumsum(-1)
    q = (lum * 1023).long()
    if p.get("sort_reverse", 0) >= 1:
        q = 1023 - q
    order = (seg * 1024 + q).argsort(dim=-1)
    ys = y.gather(-1, order.unsqueeze(1).expand(-1, c, -1, -1))
    mix = min(1.0, amt / 25.0)
    out = y + (ys - y) * mix
    return out.transpose(-1, -2) if p.get("sort_vertical", 0) >= 1 else out


def _anamorphic(x, p):
    """Anamorphic streaks: only the bright lights smear sideways into a long blue line, like an oval-lens flare."""
    a = p.get("ana_streak", 0)
    if not a:
        return x
    h, w = x.shape[-2:]
    thr = p.get("ana_threshold", 80) / 100.0
    lum = _luma(x)
    hl = x * _smoothstep(thr, min(1.0, thr + 0.2) + 1e-3, lum)          # the light that is strong enough to flare
    s = _small(hl, 768)
    sw = s.shape[-1]
    sig = (0.02 + 0.30 * p.get("ana_length", 50) / 100.0) * sw / 2.5
    tail = 0.45 * _hblur(s, sig * 0.4) + 0.35 * _hblur(s, sig) + 0.2 * _hblur(s, sig * 3.0)         # a bright core with a long soft tail
    tail = _blur(tail, 1.5)
    streak = F.interpolate(tail, size=(h, w), mode="bilinear", align_corners=False)
    t = p.get("ana_blue", 70) / 100.0
    white = torch.tensor([1.0, 1.0, 1.0], device=x.device, dtype=x.dtype).view(1, 3, 1, 1)
    blue = torch.tensor([0.35, 0.62, 1.0], device=x.device, dtype=x.dtype).view(1, 3, 1, 1)
    return _screen(x, streak * (white * (1 - t) + blue * t) * (a / 100.0) * 3.2)


def _bokeh(x, p):
    """Lens bokeh: every bright highlight blooms into a disc (round, or a polygon from the aperture blades). Brighter lights = brighter discs."""
    a = p.get("bokeh_amount", 0)
    if not a:
        return x
    h, w = x.shape[-2:]
    dev, dt = x.device, x.dtype
    s = _small(x, 640)
    hs, ws = s.shape[-2:]
    thr = p.get("bokeh_threshold", 78) / 100.0
    lum = _luma(s)
    r = max(3, int((0.012 + 0.058 * p.get("bokeh_size", 40) / 100.0) * min(hs, ws)))
    spot = ((lum - _blur(lum, r * 0.6)) * 3).clamp(0, 1)                 # small bright spots, not big bright areas (a window is not a point light)
    src = s * (((lum - thr) / (1.0 - thr + 1e-3)).clamp(0, 1) ** 1.5 * spot)   # only highlights, strongest lights count most
    lin = torch.arange(-r, r + 1, device=dev, dtype=dt)
    yy, xx = lin.view(-1, 1), lin.view(1, -1)
    rr = torch.sqrt(xx * xx + yy * yy) / r
    n = int(p.get("bokeh_blades", 0))
    if n >= 3:                                                           # polygon aperture
        ang = torch.atan2(yy, xx) % (2 * math.pi / n)
        lim = math.cos(math.pi / n) / torch.cos(ang - math.pi / n)
    else:
        lim = torch.ones_like(rr)
    k = (rr <= lim).to(dt) * (0.65 + 0.35 * (rr / lim.clamp(min=1e-3)).clamp(0, 1) ** 3)   # a slightly brighter rim, like real discs
    k = k / k.max()
    k = k.view(1, 1, 2 * r + 1, 2 * r + 1).repeat(3, 1, 1, 1)
    area = float((k[0, 0] > 0).sum())
    bok = F.conv2d(F.pad(src, (r, r, r, r), mode="replicate"), k, groups=3) / max(1.0, area ** 0.5) * 2.6
    bok = F.interpolate(bok, size=(h, w), mode="bilinear", align_corners=False)
    return _screen(x, bok * (a / 100.0))


# ----------------------------------------------------------------------------- lens dirt / bokeh overlay
_DIRT_CACHE = {}


def _dirt_files():
    d = os.path.join(os.path.dirname(__file__), "overlays")
    try:
        return sorted(os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
    except OSError:
        return []


def _dirt_tex(idx):
    """Texture number idx (1-based, alphabetical; drop your own images into the overlays folder), as a CPU float tensor."""
    files = _dirt_files()
    if not files:
        return None
    path = files[(int(idx) - 1) % len(files)]
    if path not in _DIRT_CACHE:
        from PIL import Image
        import numpy as np
        a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0
        _DIRT_CACHE[path] = torch.from_numpy(a).permute(2, 0, 1).unsqueeze(0).contiguous()
    return _DIRT_CACHE[path]


def _lensdirt(x, p):
    """Lens dirt: a bokeh / dirt texture that only shows where the picture has bright light (luminance mask), screen-blended,
    optionally tinted, and optionally nudging the image a hair like real glass does (refraction)."""
    a = p.get("dirt_amount", 0)
    if not a:
        return x
    tex = _dirt_tex(p.get("dirt_texture", 1))
    if tex is None:
        return x
    dev, dt = x.device, x.dtype
    tex = tex.to(dev, dt)
    h, w = x.shape[-2:]
    th, tw = tex.shape[-2:]
    # where is the light? a soft mask that spreads out around bright areas
    s = _small(x, 480)
    lum = _luma(s)
    thr = p.get("dirt_threshold", 60) / 100.0
    m = ((lum - thr) / (1.0 - thr + 1e-3)).clamp(0, 1)
    sp = p.get("dirt_spread", 35)
    m = _blur(m, (0.01 + 0.07 * sp / 100.0) * max(s.shape[-2:]))
    m = 1.0 - torch.exp(-m * (5.0 + 0.1 * sp) * 3.0)                 # small lights still light the dirt, big ones cap out
    m = F.interpolate(m, size=(h, w), mode="bilinear", align_corners=False)
    # place the texture: cover the frame, scale, rotate
    ar_i, ar_t = w / float(h), tw / float(th)
    k = max(ar_i / ar_t, 1.0)
    z = max(0.2, p.get("dirt_scale", 100) / 100.0)
    ang = math.radians(p.get("dirt_rotate", 0))
    gy, gx = torch.meshgrid(torch.linspace(-1, 1, h, device=dev, dtype=dt), torch.linspace(-1, 1, w, device=dev, dtype=dt), indexing="ij")
    px, py = gx * ar_i, gy
    c, sn = math.cos(ang), math.sin(ang)
    u = (px * c - py * sn) / (ar_t * k * z)
    v = (px * sn + py * c) / (k * z)
    grid = torch.stack([u, v], dim=-1).unsqueeze(0)
    t = F.grid_sample(tex, grid, mode="bilinear", padding_mode="reflection", align_corners=False)
    tl = _luma(t)
    keep = p.get("dirt_colour", 100) / 100.0
    t = tl + (t - tl) * keep
    hs = p.get("dirt_hue_shift", 0)
    if hs:                                                          # spin the texture's own colours around the wheel
        th_ = math.radians(hs)
        cs, sn_ = math.cos(th_), math.sin(th_)
        rm = torch.tensor([
            [0.299 + 0.701 * cs + 0.168 * sn_, 0.587 - 0.587 * cs + 0.330 * sn_, 0.114 - 0.114 * cs - 0.497 * sn_],
            [0.299 - 0.299 * cs - 0.328 * sn_, 0.587 + 0.413 * cs + 0.035 * sn_, 0.114 - 0.114 * cs + 0.292 * sn_],
            [0.299 - 0.300 * cs + 1.250 * sn_, 0.587 - 0.588 * cs - 1.050 * sn_, 0.114 + 0.886 * cs - 0.203 * sn_]],
            device=dev, dtype=dt)
        t = torch.einsum("ij,bjhw->bihw", rm, t).clamp(0, 1)
    tint = p.get("dirt_tint", 0) / 100.0
    if tint:
        col = _hue_rgb(float(p.get("dirt_tint_hue", 30)))
        mx = max(col) or 1.0
        cv = torch.tensor([col[0] / mx, col[1] / mx, col[2] / mx], device=dev, dtype=dt).view(1, 3, 1, 1)
        t = t * (1 - tint) + tl * cv * tint * 1.4
    d = p.get("dirt_displace", 0)
    if d:                                                           # the dirt bends the picture a tiny bit where it is thick
        g = _blur(tl, 1.5)
        gxx = F.pad(g[..., :, 2:] - g[..., :, :-2], (1, 1, 0, 0), mode="replicate")
        gyy = F.pad(g[..., 2:, :] - g[..., :-2, :], (0, 0, 1, 1), mode="replicate")
        amt = (d / 100.0) * 0.012 * m
        off = torch.cat([gxx, gyy], dim=1).permute(0, 2, 3, 1) * amt.permute(0, 2, 3, 1) * 6.0
        base = torch.stack([gx, gy], dim=-1).unsqueeze(0)
        x = F.grid_sample(x, base + off, mode="bilinear", padding_mode="border", align_corners=False)
    return _screen(x, t * m * (a / 100.0) * 1.6)


def _dust(x, p, seed):
    """Dust specks (bright and dark) and long vertical scratches. The seed makes a different print every time."""
    d, sc = p.get("film_dust", 0), p.get("film_scratches", 0)
    if not (d or sc):
        return x
    h, w = x.shape[-2:]
    dev, dt = x.device, x.dtype
    m = float(max(h, w))
    gen = torch.Generator(device="cpu")
    gen.manual_seed((int(seed) * 1103515245 + 12345) & 0x7FFFFFFFFFFFFFFF)
    bright = torch.zeros((1, 1, h, w), device=dev, dtype=dt)
    dark = torch.zeros((1, 1, h, w), device=dev, dtype=dt)
    if d:
        for sig, share in ((max(0.8, 0.0006 * m), 1.0), (max(1.6, 0.0016 * m), 0.12)):
            n = int((d / 100.0) * h * w * 4e-5 * share) + 2
            for tgt, frac in ((bright, 0.6), (dark, 0.4)):
                k = max(1, int(n * frac))
                pos = torch.randint(0, h * w, (k,), generator=gen)
                val = (0.35 + 0.65 * torch.rand((k,), generator=gen)).to(dev, dt)
                pts = torch.zeros(h * w, device=dev, dtype=dt)
                pts[pos.to(dev)] = val
                blob = _blur(pts.view(1, 1, h, w), sig) * (2 * math.pi * sig * sig)
                tgt += _smoothstep(0.12, 0.5, blob)
    if sc:
        yy = torch.linspace(0, 1, h, device=dev, dtype=dt).view(h, 1)
        xx = torch.arange(w, device=dev, dtype=dt).view(1, w)
        rnd = random.Random("scr:%d" % int(seed))
        for _ in range(1 + int(sc / 100.0 * 9)):
            x0 = rnd.uniform(0, w)
            y0 = rnd.uniform(0, 0.7)
            y1 = min(1.0, y0 + rnd.uniform(0.15, 0.9))
            wob = rnd.uniform(0.0, 0.003) * m * torch.sin(yy * rnd.uniform(3, 14) + rnd.uniform(0, 6))
            sg = max(0.55, 0.0005 * m)
            line = torch.exp(-((xx - x0 - wob) ** 2) / (2 * sg * sg)) * _smoothstep(y0, y0 + 0.03, yy) * (1 - _smoothstep(y1 - 0.05, y1, yy))
            bright = bright + (line * rnd.uniform(0.35, 0.9)).view(1, 1, h, w)
    x = x * (1 - dark.clamp(0, 1) * 0.55)
    return _screen(x, bright.clamp(0, 1) * torch.tensor([1.0, 0.97, 0.9], device=dev, dtype=dt).view(1, 3, 1, 1) * 0.85)


def _shift(x, dx, dy):
    """Move the picture by whole pixels without wrapping (edges repeat)."""
    dx, dy = int(round(dx)), int(round(dy))
    if not (dx or dy):
        return x
    h, w = x.shape[-2:]
    pl, pr, pt, pb = max(dx, 0), max(-dx, 0), max(dy, 0), max(-dy, 0)
    y = F.pad(x, (pl, pr, pt, pb), mode="replicate")
    return y[..., pb:pb + h, pr:pr + w]


def _cells(h, w, cell, angle, dev, dt):
    """Distance from the centre of each rotated grid cell (0 in the middle, ~0.7 in the corners)."""
    yy = torch.arange(h, device=dev, dtype=dt).view(h, 1)
    xx = torch.arange(w, device=dev, dtype=dt).view(1, w)
    a = math.radians(angle)
    u = (xx * math.cos(a) + yy * math.sin(a)) / cell
    v = (-xx * math.sin(a) + yy * math.cos(a)) / cell
    fu, fv = u - torch.floor(u) - 0.5, v - torch.floor(v) - 0.5
    return torch.sqrt(fu * fu + fv * fv)


def _dots(d, radius, aa):
    return 1 - _smoothstep(radius - aa, radius + aa, d)


def _comic(x, p):
    """Comic / anime / Spider-Verse: halftone dots that follow brightness, diagonal hatching in the shadows, white dots in the lights,
    print misregistration (colour offset) and a touch of posterising."""
    dots, light, hatch, off, poster = (p.get("comic_dots", 0), p.get("comic_light_dots", 0), p.get("comic_hatch", 0),
                                       p.get("comic_offset", 0), p.get("comic_poster", 0))
    if not (dots or light or hatch or off or poster):
        return x
    h, w = x.shape[-2:]
    dev, dt = x.device, x.dtype
    m = float(max(h, w))
    if poster:
        n = max(3.0, 12.0 - 0.09 * poster)
        x = x + (torch.round(x * n) / n - x) * min(1.0, poster / 30.0)
    if off:                                                       # the red and blue plates land a little off the green one
        k = off / 100.0 * 0.006 * m
        x = torch.cat([_shift(x[:, 0:1], k, k), x[:, 1:2], _shift(x[:, 2:3], -k, -k)], dim=1)
    cell = max(4.0, (0.0035 + 0.017 * p.get("comic_dot_size", 35) / 100.0) * m)
    lum = _luma(x).clamp(0, 1)
    lc = _blur(lum, cell * 0.6)                                   # brightness at the size of one dot
    aa = 1.0 / cell
    if dots:
        thr = max(0.05, p.get("comic_dot_below", 55) / 100.0)
        t = ((thr - lc) / thr).clamp(0, 1)
        mk = _dots(_cells(h, w, cell, p.get("comic_dot_angle", 45), dev, dt), 0.62 * torch.sqrt(t), aa)
        x = x * (1 - mk * (dots / 100.0)) + x * 0.1 * mk * (dots / 100.0)
    if hatch:
        dens = p.get("comic_hatch_density", 50) / 100.0
        period = (0.022 - 0.016 * dens) * m
        yy = torch.arange(h, device=dev, dtype=dt).view(h, 1)
        xx = torch.arange(w, device=dev, dtype=dt).view(1, w)
        s = (xx + yy) / (period * 1.4142)
        dist = (s - torch.floor(s) - 0.5).abs() * 2                # 1 on the line, 0 between
        t = ((0.42 - lc) / 0.42).clamp(0, 1)
        mk = _dots(1 - dist, 0.5 * torch.sqrt(t) * 0.9, 1.5 / period)
        x = x * (1 - mk * (hatch / 100.0) * 0.85)
    if light:
        thr = min(0.95, p.get("comic_light_above", 75) / 100.0)
        t = ((lc - thr) / (1 - thr)).clamp(0, 1)
        mk = _dots(_cells(h, w, cell * 0.8, p.get("comic_dot_angle", 45) + 30, dev, dt), 0.6 * torch.sqrt(t), aa)
        x = x + (1 - x) * mk * (light / 100.0)
    return x


def fx(img, p, seed=0):
    h, w = img.shape[-2:]
    size = float(min(h, w))
    x = _lens(img, p["lens_distortion"], p["chromatic_aberration"])

    if p["sharpen"]:
        x = x + (p["sharpen"] / 100.0) * 1.5 * (x - _blur(x, max(0.8, 0.0015 * size)))

    # filter colour
    x = _wb_exposure(x, p["filter_warmth"] / 100.0, 0.0, 0.0)
    x = _contrast(x, p["filter_contrast"] / 100.0)
    x = _sat_vib(x, p["filter_saturation"] / 100.0, 0.0)
    x = _fade(x, p["filter_fade"] / 100.0)
    if p["tint_amount"]:
        col = _hue_rgb(float(p["tint_hue"]))
        ly = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2]
        tv = torch.tensor([col[0] - ly, col[1] - ly, col[2] - ly], device=x.device, dtype=x.dtype)
        x = x + tv.view(1, 3, 1, 1) * (p["tint_amount"] / 100.0 * 0.35)

    x = _pixsort(x, p)
    x = _glow(x, p["glow_amount"], p["glow_radius"], p["glow_threshold"], size)
    x = _bokeh(x, p)
    x = _lensdirt(x, p)
    x = _anamorphic(x, p)
    x = _halation(x, p["halation"], size)
    bs = p.get("_base_seed", seed)                                # leaks stay put across a video batch
    x = _leak(x, p["light_leak"], bs)
    x = _comic(x, p)
    x = _vignette(x, p["vignette"], p["vignette_midpoint"], p["vignette_feather"])
    x = _dust(x, p, bs + 2)
    x = _analog(x.clamp(0, 1), p, seed)
    x = x.clamp(0, 1)
    s = p["strength"] / 100.0
    return img + (x - img) * s if s < 1.0 else x


# ----------------------------------------------------------------------------- lens
def lens(img, p, seed=0):
    """A virtual lens: fisheye bend, barrel / pincushion, zoom, colour fringing, soft corners, dark corners and the black
    image circle of a circular fisheye (with the blue / cyan fringe real ones have at its edge)."""
    _, _, h, w = img.shape
    dev, dt = img.device, img.dtype
    gy, gx = torch.meshgrid(torch.linspace(-1, 1, h, device=dev, dtype=dt), torch.linspace(-1, 1, w, device=dev, dtype=dt), indexing="ij")
    hd = math.hypot(w / 2.0, h / 2.0)
    u = (torch.sqrt((gx * w / 2.0) ** 2 + (gy * h / 2.0) ** 2) / hd).clamp(min=1e-6)    # 0 centre .. 1 corner

    a = p["lens_fisheye"] / 100.0 * 1.25
    fac = torch.tan(u * a) / math.tan(a) / u if a > 1e-4 else torch.ones_like(u)
    k = p["lens_bend"] / 100.0 * 0.5
    if k:
        fac = fac * (1 + k * u * u)
        if k > 0:
            fac = fac / (1 + k)
    fac = fac * (100.0 / max(1, p["lens_zoom"]))

    ca = p["lens_fringe"] / 100.0 * 0.03
    chans = []
    for ci, s in enumerate((ca, 0.0, -ca)):                       # red spreads outward, blue pulls inward
        f = fac * (1 + s * u * u * 4.0)
        grid = torch.stack((gx * f, gy * f), dim=-1).unsqueeze(0)
        chans.append(F.grid_sample(img[:, ci:ci + 1], grid, mode="bilinear", padding_mode="border", align_corners=True))
    x = torch.cat(chans, dim=1)

    circle = p["lens_circle"]
    if p["lens_zoom"] < 100 and not circle:                       # pulled back with no circle: black outside the picture
        inside = ((gx * fac).abs() <= 1) & ((gy * fac).abs() <= 1)
        x = x * inside.to(dt).view(1, 1, h, w)

    if p["lens_edge_blur"]:
        sig = max(0.6, p["lens_edge_blur"] / 100.0 * 0.012 * min(h, w))
        wgt = _smooth(0.25, 1.0, u).view(1, 1, h, w)
        x = x + (_blur(x, sig) - x) * wgt
    if p["lens_falloff"]:
        x = x * (1 - p["lens_falloff"] / 100.0 * 0.85 * (u ** 2.2)).view(1, 1, h, w)

    if circle:
        rho = torch.sqrt((gx * w / 2.0) ** 2 + (gy * h / 2.0) ** 2) / (min(w, h) / 2.0)
        R = circle / 100.0
        soft = max(0.004, p["lens_circle_soft"] / 100.0 * 0.15 * R)
        e = p["lens_fringe"] / 100.0 * 0.025                      # blue reaches furthest out, red stops first
        masks = []
        for rad in (R * (1 - e), R, R * (1 + e)):
            masks.append(1 - _smooth(rad - soft / 2, rad + soft / 2, rho))
        m = torch.stack(masks, dim=0).unsqueeze(0)
        if e:                                                     # a faint blue glow where only blue is still lit
            ring = (masks[2] - masks[0]).clamp(0, 1)
            x = x + ring.view(1, 1, h, w) * torch.tensor([0.0, 0.08, 0.28], device=dev, dtype=dt).view(1, 3, 1, 1) * (p["lens_fringe"] / 100.0)
        x = x * m
    x = x.clamp(0, 1)
    s = p["strength"] / 100.0
    return img + (x - img) * s if s < 1.0 else x


# ----------------------------------------------------------------------------- grain
def film_grain(img, p, seed=0):
    """Fine, band-pass film grain: tiny grains, no cloudy low-frequency mottling, clean blacks."""
    h, w = img.shape[-2:]
    amount = p["grain_amount"] / 100.0
    size = p["grain_size"] / 100.0
    rough = p["grain_roughness"] / 100.0
    col = p["grain_color"] / 100.0
    cell = (0.45 + 2.4 * size ** 1.5) * max(h, w) / 2400.0
    g = torch.Generator(device="cpu")
    g.manual_seed(int(seed) & 0x7FFFFFFFFFFFFFFF)

    def norm(t):
        return (t - t.mean(dim=(2, 3), keepdim=True)) / (t.std(dim=(2, 3), keepdim=True) + 1e-6)

    fine = torch.randn((1, 4, h, w), generator=g).to(img.device)  # ch0 = mono, ch1-3 = colour
    sig = 0.35 + 0.55 * (1 - rough) + 0.35 * max(0.0, cell - 1)
    soft = norm(_blur(fine, sig))
    r = rough ** 0.7
    n = norm(soft * (1 - r) + fine * r)
    if cell > 1.4:  # only the big-grain end gets a coarse layer
        ch, cw = max(2, int(h / cell)), max(2, int(w / cell))
        co = torch.randn((1, 4, ch, cw), generator=g).to(img.device)
        co = norm(F.interpolate(co, size=(h, w), mode="bicubic", align_corners=False))
        k = min(0.6, (cell - 1.4) / 3)
        n = norm(n * (1 - k) + co * k)
    n = norm(n - _blur(n, max(2.5, 3 * cell)))  # high-pass: kills blotches

    n = (n[:, 0:1] * (1 - col) + n[:, 1:4] * col) / math.sqrt((1 - col) ** 2 + col ** 2)

    lum = _luma(img).clamp(0, 1)
    base = 4 * lum * (1 - lum)
    weight = (0.05 + 0.95 * base ** 0.9) * (1 + (p["grain_tonal"] / 100.0) * (2 * lum - 1))
    return (img + n * (0.1 * amount) * weight.clamp(min=0)).clamp(0, 1)


# ----------------------------------------------------------------------------- nodes
def _input_types(sliders, table, with_seed):
    req = {
        "image": ("IMAGE",),
        "enabled": ("BOOLEAN", {"default": True, "label_on": "on", "label_off": "off"}),
        "preset": (names(table),),
    }
    for name, (kind, lo, hi, default, step) in sliders.items():
        opts = {"default": default, "min": lo, "max": hi, "step": step}
        if kind == "f":
            opts["round"] = step
        req[name] = ("FLOAT" if kind == "f" else "INT", opts)
    if with_seed:
        req["grain_seed"] = ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF})
    return {"required": req}


class _LookNode:
    CATEGORY = "image/postprocessing"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    SLIDERS = {}
    TABLE = {}
    FN = None

    def run(self, image, enabled=True, preset=NONE, seed=0, **p):
        # NOTE: `preset` is a UI helper - picking one fills the sliders in the browser.
        # The sliders below are what actually drive the result.
        seed = p.pop("grain_seed", seed)
        for name, spec in self.SLIDERS.items():
            p.setdefault(name, spec[3])
        p.setdefault("strength", 100)
        # Fallback: a preset is picked but the sliders were never filled (API use, or the browser
        # script didn't run) - apply the preset values here so selecting a look always does something.
        if preset != NONE and all(p[k] == v[3] for k, v in self.SLIDERS.items() if k != "strength"):
            p.update({k: v for k, v in self.TABLE.get(preset, {}).items() if k in self.SLIDERS})
        unchanged = all(p[k] == v[3] for k, v in self.SLIDERS.items() if k != "strength")
        if not enabled or unchanged or p["strength"] == 0:
            return (image,)

        dev = _device()
        outs = []
        p["_base_seed"] = int(seed)
        with torch.no_grad():
            for i in range(image.shape[0]):
                frame = image[i]
                rgb = frame[..., :3].permute(2, 0, 1).unsqueeze(0).to(dev, torch.float32)
                out = self.FN(rgb, p, int(seed) + i)
                out = out.squeeze(0).permute(1, 2, 0).cpu().to(frame.dtype)
                if frame.shape[-1] > 3:
                    out = torch.cat([out, frame[..., 3:]], dim=-1)
                outs.append(out)
        return (torch.stack(outs, dim=0),)


class LightCraftGrade(_LookNode):
    SLIDERS = GRADE_SLIDERS
    TABLE = GRADE
    FN = staticmethod(lambda x, p, seed: grade(x, p))

    @classmethod
    def INPUT_TYPES(cls):
        return _input_types(GRADE_SLIDERS, GRADE, with_seed=False)


class LightCraftFX(_LookNode):
    SLIDERS = FX_SLIDERS
    TABLE = FX
    FN = staticmethod(fx)

    @classmethod
    def INPUT_TYPES(cls):
        return _input_types(FX_SLIDERS, FX, with_seed=True)


class LightCraftLens(_LookNode):
    SLIDERS = LENS_SLIDERS
    TABLE = LENS
    FN = staticmethod(lens)

    @classmethod
    def INPUT_TYPES(cls):
        return _input_types(LENS_SLIDERS, LENS, with_seed=False)


class LightCraftGrain(_LookNode):
    SLIDERS = GRAIN_SLIDERS
    TABLE = GRAIN
    FN = staticmethod(film_grain)

    @classmethod
    def INPUT_TYPES(cls):
        return _input_types(GRAIN_SLIDERS, GRAIN, with_seed=True)


# ----------------------------------------------------------------------------- all three in one window
# One node: LUT (the Grade look) -> FX -> Grain, each with its own on/off, dropdown and sliders. The two
# "strength" sliders get their own names so they can live side by side.
_COLOR_RENAME = {"LUT": {"strength": "look_strength"}, "FX": {"strength": "fx_strength"}, "GRAIN": {}, "LENS": {"strength": "lens_strength"}}


def _renamed(sliders, mapping):
    return {mapping.get(k, k): v for k, v in sliders.items()}


class LightCraftColor:
    CATEGORY = "image/postprocessing"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        req = {"image": ("IMAGE",)}
        for key, table in (("look", GRADE), ("fx", FX), ("grain", GRAIN)):
            req[key + "_on"] = ("BOOLEAN", {"default": True})
            req[key + "_preset"] = (names(table),)
        for sliders, mapping in ((GRADE_SLIDERS, _COLOR_RENAME["LUT"]), (FX_BASE, _COLOR_RENAME["FX"]),
                                 (GRAIN_SLIDERS, {})):
            for name, (kind, lo, hi, default, step) in _renamed(sliders, mapping).items():
                opts = {"default": default, "min": lo, "max": hi, "step": step}
                if kind == "f":
                    opts["round"] = step
                req[name] = ("FLOAT" if kind == "f" else "INT", opts)
        req["grain_seed"] = ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF})
        # Lens goes last so workflows saved before it existed keep their values in the right places
        req["lens_on"] = ("BOOLEAN", {"default": False})
        req["lens_preset"] = (names(LENS),)
        for name, (kind, lo, hi, default, step) in _renamed(LENS_SLIDERS, _COLOR_RENAME["LENS"]).items():
            opts = {"default": default, "min": lo, "max": hi, "step": step}
            req[name] = ("FLOAT" if kind == "f" else "INT", opts)
        for name, (kind, lo, hi, default, step) in FX_ANALOG.items():        # analog / CRT sliders, also last for the same reason
            req[name] = ("INT", {"default": default, "min": lo, "max": hi, "step": step})
        for name, (kind, lo, hi, default, step) in FX_FILM.items():           # film damage, also last for the same reason
            req[name] = ("INT", {"default": default, "min": lo, "max": hi, "step": step})
        return {"required": req}

    def run(self, image, look_on=True, look_preset=NONE, fx_on=True, fx_preset=NONE, grain_on=True,
            grain_preset=NONE, lens_on=False, lens_preset=NONE, **p):
        def pick(sliders, mapping):
            inv = {v: k for k, v in mapping.items()}
            return {inv.get(k, k): p[k] for k in _renamed(sliders, mapping) if k in p}

        (image,) = LightCraftGrade().run(image, look_on, look_preset, **pick(GRADE_SLIDERS, _COLOR_RENAME["LUT"]))
        fxp = pick(FX_SLIDERS, _COLOR_RENAME["FX"])
        fxp["grain_seed"] = p.get("grain_seed", 0)                 # one seed: grain, leaks and dust
        (image,) = LightCraftFX().run(image, fx_on, fx_preset, **fxp)
        g = pick(GRAIN_SLIDERS, {})
        g["grain_seed"] = p.get("grain_seed", 0)
        (image,) = LightCraftGrain().run(image, grain_on, grain_preset, **g)
        return LightCraftLens().run(image, lens_on, lens_preset, **pick(LENS_SLIDERS, _COLOR_RENAME["LENS"]))
