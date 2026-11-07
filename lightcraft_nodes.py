"""
LightCraft Develop - a Camera Raw / Lightroom style post-process node for ComfyUI.

Pure PyTorch re-implementation of the LightCraft "Light / Color / Effects / Color Grading"
panels (https://github.com/storytold/lightcraft). The original is a Rust desktop app and cannot
be loaded into ComfyUI directly, so the maths here is an independent approximation, not a
pixel-exact port. Runs on GPU when ComfyUI has one, otherwise CPU.
"""
import math

import torch
import torch.nn.functional as F

try:
    import comfy.model_management as _mm

    def _device():
        return _mm.get_torch_device()
except Exception:  # running outside ComfyUI (tests)
    def _device():
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


# name: (type, min, max, default, step)
SLIDERS = {
    # Light
    "exposure": ("f", -5.0, 5.0, 0.0, 0.01),
    "contrast": ("i", -100, 100, 0, 1),
    "highlights": ("i", -100, 100, 0, 1),
    "shadows": ("i", -100, 100, 0, 1),
    "whites": ("i", -100, 100, 0, 1),
    "blacks": ("i", -100, 100, 0, 1),
    # Color
    "temperature": ("i", -100, 100, 0, 1),
    "tint": ("i", -100, 100, 0, 1),
    "vibrance": ("i", -100, 100, 0, 1),
    "saturation": ("i", -100, 100, 0, 1),
    # Detail
    "texture": ("i", -100, 100, 0, 1),
    "clarity": ("i", -100, 100, 0, 1),
    "dehaze": ("i", -100, 100, 0, 1),
}


# ----------------------------------------------------------------------------- helpers
def _srgb_to_lin(x):
    x = x.clamp(min=0)
    return torch.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def _lin_to_srgb(x):
    x = x.clamp(min=0)
    return torch.where(x <= 0.0031308, x * 12.92, 1.055 * x.clamp(min=1e-8) ** (1 / 2.4) - 0.055)


def _luma(x):
    return x[:, 0:1] * 0.2126 + x[:, 1:2] * 0.7152 + x[:, 2:3] * 0.0722


def _smooth(a, b, x):
    t = ((x - a) / (b - a)).clamp(0, 1)
    return t * t * (3 - 2 * t)


def _blur(x, sigma):
    """Separable gaussian; large radii are done on a downsampled copy."""
    if sigma < 0.3:
        return x
    h, w = x.shape[-2:]
    if sigma > 8:
        s = sigma / 4.0
        h2, w2 = max(1, int(round(h / s))), max(1, int(round(w / s)))
        small = F.interpolate(x, size=(h2, w2), mode="area")
        small = _blur(small, 4.0)
        return F.interpolate(small, size=(h, w), mode="bilinear", align_corners=False)
    r = max(1, int(math.ceil(sigma * 3)))
    t = torch.arange(-r, r + 1, device=x.device, dtype=x.dtype)
    k = torch.exp(-(t * t) / (2 * sigma * sigma))
    k = k / k.sum()
    c = x.shape[1]
    kh = k.view(1, 1, 1, -1).repeat(c, 1, 1, 1)
    kv = k.view(1, 1, -1, 1).repeat(c, 1, 1, 1)
    y = F.conv2d(F.pad(x, (r, r, 0, 0), mode="replicate"), kh, groups=c)
    return F.conv2d(F.pad(y, (0, 0, r, r), mode="replicate"), kv, groups=c)


def _hue_rgb(h):
    h = (h % 360.0) / 60.0
    xx = 1 - abs(h % 2 - 1)
    table = [(1, xx, 0), (xx, 1, 0), (0, 1, xx), (0, xx, 1), (xx, 0, 1), (1, 0, xx)]
    return table[int(h) % 6]


# ----------------------------------------------------------------------------- stages
def _dehaze(x, amount):
    a = amount / 100.0
    xc = x.clamp(0, 1)
    h, w = xc.shape[-2:]
    s = min(1.0, 256.0 / max(h, w))
    small = F.interpolate(xc, scale_factor=s, mode="area") if s < 1.0 else xc
    sh, sw = small.shape[-2:]
    k = max(3, (int(0.02 * max(sh, sw)) * 2) + 1)

    dark = small.min(dim=1, keepdim=True)[0]
    dark_e = -F.max_pool2d(-dark, k, stride=1, padding=k // 2)
    flat = dark_e.flatten()
    n = max(1, int(flat.numel() * 0.002))
    idx = flat.topk(n).indices
    A = small.flatten(2)[0][:, idx].mean(dim=1).view(1, 3, 1, 1).clamp(0.55, 1.0)

    dn = (small / A).min(dim=1, keepdim=True)[0]
    dn = -F.max_pool2d(-dn, k, stride=1, padding=k // 2)
    t = (1 - 0.92 * dn).clamp(0.15, 1.0)
    t = _blur(t, 0.01 * max(sh, sw))
    t = F.interpolate(t, size=(h, w), mode="bilinear", align_corners=False)
    if a > 0:
        j = ((x - A) / t + A).clamp(min=0)
        return x + a * (j - x)
    k2 = 0.6 * (-a)
    return x * (1 - k2) + A * k2


def _grain(x, p, seed):
    from .lightcraft_look_nodes import film_grain
    return film_grain(x, p, seed)


def _sat_vib(x, sat, vib):
    """Saturation + skin-tone-aware vibrance."""
    if not (sat or vib):
        return x
    lum = _luma(x)
    mx, mn = x.max(dim=1, keepdim=True)[0], x.min(dim=1, keepdim=True)[0]
    chroma = (mx - mn).clamp(0, 1)
    r, g, b = x[:, 0:1], x[:, 1:2], x[:, 2:3]
    hue = torch.atan2(1.7320508 * (g - b), 2 * r - g - b) * (180.0 / math.pi)
    skin = torch.exp(-((((hue - 25.0) + 180.0) % 360.0 - 180.0) / 30.0) ** 2)
    f = (1 + sat + vib * (1 - chroma) ** 1.5 * (1 - 0.6 * skin)).clamp(min=0)
    return lum + (x - lum) * f


def _grade3(x, p):
    """3-way colour grading (shadows / midtones / highlights hue + saturation)."""
    if not (p["shadows_sat"] or p["midtones_sat"] or p["highlights_sat"]):
        return x
    lum = _luma(x).clamp(0, 1)
    centre = 0.5 - 0.2 * (p["grade_balance"] / 100.0)
    width = 0.05 + 0.25 * (p["grade_blending"] / 100.0)
    w_sh = 1 - _smooth(centre - 0.25 - width, centre - 0.25 + width, lum)
    w_hi = _smooth(centre + 0.25 - width, centre + 0.25 + width, lum)
    w_mid = (1 - w_sh - w_hi).clamp(min=0)
    for name, wt in (("shadows", w_sh), ("midtones", w_mid), ("highlights", w_hi)):
        s = p[name + "_sat"] / 100.0
        if s <= 0:
            continue
        col = _hue_rgb(float(p[name + "_hue"]))
        ly = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2]
        tv = torch.tensor([col[0] - ly, col[1] - ly, col[2] - ly], device=x.device, dtype=x.dtype)
        x = x + tv.view(1, 3, 1, 1) * (0.3 * s) * wt
    return x


def _vignette(x, amount, midpoint, feather):
    v = amount / 100.0
    if not v:
        return x
    h, w = x.shape[-2:]
    yy = torch.linspace(-1, 1, h, device=x.device, dtype=x.dtype).view(h, 1)
    xx = torch.linspace(-1, 1, w, device=x.device, dtype=x.dtype).view(1, w)
    r = torch.sqrt(xx * xx + yy * yy) / math.sqrt(2.0)
    start = 0.15 + 0.75 * (midpoint / 100.0)
    width = 0.05 + 0.65 * (feather / 100.0)
    mask = _smooth(start, start + width, r).view(1, 1, h, w)
    if v < 0:
        return x * (1 + 0.95 * v * mask)
    return x + v * mask * (1 - x.clamp(0, 1))



def develop(img, p, seed=0):
    """img: [1,3,H,W] float32 in 0..1 (sRGB). Returns same shape."""
    h, w = img.shape[-2:]
    size = float(min(h, w))
    x = img

    # --- white balance + exposure in linear light
    t, ti, ev = p["temperature"] / 100.0, p["tint"] / 100.0, p["exposure"]
    if t or ti or ev:
        lin = _srgb_to_lin(x)
        if t or ti:
            gains = torch.tensor(
                [2 ** (0.45 * t), 2 ** (-0.30 * ti), 2 ** (-0.45 * t)],
                device=x.device, dtype=x.dtype,
            )
            gains = gains / (0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2])
            lin = lin * gains.view(1, 3, 1, 1)
        if ev:
            lin = lin * (2.0 ** ev)
        x = _lin_to_srgb(lin)
        # filmic shoulder so pushed highlights roll off instead of clipping hard
        x = torch.where(x > 0.8, 0.8 + 0.2 * torch.tanh((x - 0.8) / 0.2), x)

    # --- contrast (S-curve around mid grey)
    c = p["contrast"] / 100.0
    if c:
        xs = x.clamp(0, 1)
        x = x + c * ((xs * xs * (3 - 2 * xs)) - xs)

    # --- highlights / shadows / whites / blacks
    hi, sh = p["highlights"] / 100.0, p["shadows"] / 100.0
    wh, bl = p["whites"] / 100.0, p["blacks"] / 100.0
    if hi or sh or wh or bl:
        lum = _luma(x).clamp(0, 1)
        lm = 0.5 * (lum + _blur(lum, max(1.0, 0.004 * size)))
        stops = (hi * 1.0) * _smooth(0.5, 1.0, lm) + (wh * 0.8) * _smooth(0.75, 1.0, lm)
        stops = stops + (sh * 0.9) * (1 - _smooth(0.0, 0.55, lm))
        lift = (sh * 0.06) * (1 - _smooth(0.0, 0.5, lm)) + (bl * 0.10) * (1 - _smooth(0.0, 0.25, lm))
        x = x * torch.exp2(stops) + lift

    # --- dehaze
    if p["dehaze"]:
        x = _dehaze(x, p["dehaze"])

    # --- clarity (mid-tone local contrast) and texture (fine detail)
    if p["clarity"]:
        lum = _luma(x)
        d = lum - _blur(lum, max(2.0, 0.012 * size))
        lc = lum.clamp(0, 1)
        x = x + (p["clarity"] / 100.0) * d * (4 * lc * (1 - lc))
    if p["texture"]:
        lum = _luma(x)
        d = lum - _blur(lum, max(0.8, 0.0025 * size))
        x = x + (p["texture"] / 100.0) * 0.8 * d

    x = _sat_vib(x, p["saturation"] / 100.0, p["vibrance"] / 100.0)

    return x.clamp(0, 1)


# ----------------------------------------------------------------------------- node
class LightCraftDevelop:
    CATEGORY = "image/postprocessing"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        req = {"image": ("IMAGE",)}
        for name, (kind, lo, hi, default, step) in SLIDERS.items():
            opts = {"default": default, "min": lo, "max": hi, "step": step}
            if kind == "f":
                opts["round"] = step
            req[name] = ("FLOAT" if kind == "f" else "INT", opts)
        return {"required": req}

    def run(self, image, seed=0, **p):
        for name, spec in SLIDERS.items():
            p.setdefault(name, spec[3])
        if all(p[k] == v[3] for k, v in SLIDERS.items()):
            return (image,)  # nothing changed - pass through untouched

        dev = _device()
        outs = []
        with torch.no_grad():
            for i in range(image.shape[0]):
                frame = image[i]
                rgb = frame[..., :3].permute(2, 0, 1).unsqueeze(0).to(dev, torch.float32)
                out = develop(rgb, p, int(seed) + i)
                out = out.squeeze(0).permute(1, 2, 0).cpu().to(frame.dtype)
                if frame.shape[-1] > 3:
                    out = torch.cat([out, frame[..., 3:]], dim=-1)
                outs.append(out)
        return (torch.stack(outs, dim=0),)
