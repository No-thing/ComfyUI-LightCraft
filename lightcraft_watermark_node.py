"""LightCraft Watermark: an optional transparent PNG placed on the finished picture, right before the saver (after the grade)."""
import os

import numpy as np

try:
    import folder_paths
except Exception:  # outside ComfyUI (tests)
    folder_paths = None

POSITIONS = ["bottom right", "bottom left", "top right", "top left", "bottom centre", "top centre", "centre", "free (x / y below)"]
EXT = (".png", ".webp")


def _files():
    names = ["none"]
    if folder_paths is not None:
        try:
            d = folder_paths.get_input_directory()
            names += sorted(f for f in os.listdir(d) if f.lower().endswith(EXT) and os.path.isfile(os.path.join(d, f)))
        except OSError:
            pass
    return names


def cut(wm, cx, cy, cw_pct, ch_pct, angle, zoom=1.0):
    """The snipping-tool cut: a crop box (centre cx/cy and size in % of the mark's width/height) with the mark turned by `angle`
    degrees (clockwise) around the box's own centre. Anything the mark does not cover stays transparent."""
    from PIL import Image
    H, W = wm.shape[:2]
    cw = max(1, int(round(W * cw_pct / 100.0))); ch = max(1, int(round(H * ch_pct / 100.0)))
    if abs(angle) < 1e-6 and abs(zoom - 1) < 1e-6 and cw == W and ch == H and abs(cx - 50) < 1e-6 and abs(cy - 50) < 1e-6:
        return wm
    px, py, th = W * cx / 100.0, H * cy / 100.0, np.radians(angle)
    z = max(0.05, float(zoom))
    c, s_ = float(np.cos(th)) / z, float(np.sin(th)) / z          # zoom: the box shows 1/z of the mark around its centre
    # output pixel (x, y) -> mark pixel: the point `centre of the box` sits on (px, py), the mark is turned about it
    data = (c, s_, px - (cw / 2.0) * c - (ch / 2.0) * s_, -s_, c, py + (cw / 2.0) * s_ - (ch / 2.0) * c)
    pm = wm.copy(); pm[..., :3] *= pm[..., 3:4]
    chans = [np.asarray(Image.fromarray(pm[..., k]).transform((cw, ch), Image.AFFINE, data, resample=Image.BICUBIC, fillcolor=0.0), dtype=np.float32) for k in range(4)]
    pm = np.clip(np.stack(chans, -1), 0, 1)
    a = pm[..., 3:4]
    return np.concatenate([np.where(a > 1e-6, pm[..., :3] / np.maximum(a, 1e-6), 0.0), a], -1).astype(np.float32)


def composite(img, wm, position, size_pct, opacity_pct, margin_pct, box=(50.0, 50.0, 100.0, 100.0, 1.0), free=(50.0, 50.0), angle=0.0):
    """img float32 (h, w, 3) 0..1, wm float32 (wh, ww, 4) 0..1 straight alpha. Returns the picture with the mark on it."""
    h, w = img.shape[:2]
    from PIL import Image
    wm = cut(wm, box[0], box[1], box[2], box[3], angle, box[4] if len(box) > 4 else 1.0)
    tw = max(1, int(round(w * size_pct / 100.0)))
    th = max(1, int(round(wm.shape[0] * tw / wm.shape[1])))
    if th > h:                                                  # never taller than the picture
        th = h; tw = max(1, int(round(wm.shape[1] * th / wm.shape[0])))
    # resize premultiplied, so the transparent edges do not bleed a dark or white fringe
    pm = wm.copy(); pm[..., :3] *= pm[..., 3:4]
    chans = [np.asarray(Image.fromarray(pm[..., c]).resize((tw, th), Image.LANCZOS), dtype=np.float32) for c in range(4)]
    pm = np.clip(np.stack(chans, -1), 0, 1)
    a = pm[..., 3:4] * (opacity_pct / 100.0)
    rgb = np.where(pm[..., 3:4] > 1e-6, pm[..., :3] / np.maximum(pm[..., 3:4], 1e-6), 0.0)
    m = int(round(w * margin_pct / 100.0))
    if position.startswith("free"):                                 # the mark's centre sits at x / y (% of the picture)
        x = int(round(w * free[0] / 100.0 - tw / 2.0)); y = int(round(h * free[1] / 100.0 - th / 2.0))
    else:
        tok = position.split(); vert = tok[0] if tok[0] in ("top", "bottom") else "centre"; horz = tok[-1] if tok[-1] in ("left", "right") else "centre"
        x = {"left": m, "right": w - tw - m}.get(horz, (w - tw) // 2)
        y = {"top": m, "bottom": h - th - m}.get(vert, (h - th) // 2)
    x = int(np.clip(x, 0, max(0, w - tw))); y = int(np.clip(y, 0, max(0, h - th)))
    out = img.copy()
    reg = out[y:y + th, x:x + tw, :3]
    out[y:y + th, x:x + tw, :3] = reg * (1 - a) + rgb * a
    return out


def parse_box(raw):
    """The crop editor's JSON {"cx","cy","w","h"} (fractions of the mark) -> (cx, cy, w, h) in percent. Anything unusable = the whole mark."""
    import json, math
    try:
        d = json.loads(raw) if isinstance(raw, str) and raw.strip() else None
        v = [float(d[k]) for k in ("cx", "cy", "w", "h")]
        if not all(math.isfinite(x) for x in v) or v[2] <= 0 or v[3] <= 0:
            raise ValueError
        z = float(d.get("z", 1.0)) if isinstance(d, dict) else 1.0
        if not math.isfinite(z) or z <= 0:
            z = 1.0
        return (v[0] * 100.0, v[1] * 100.0, min(v[2], 4.0) * 100.0, min(v[3], 4.0) * 100.0, min(max(z, 0.1), 10.0))
    except Exception:
        return (50.0, 50.0, 100.0, 100.0, 1.0)


def _register_routes():
    """GET /lightcraft/input_images -> {"files": [...]}: the PNG / WebP files of the input folder, asked for only when the picker opens."""
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.get("/lightcraft/input_images")
        async def _list(request):
            return web.json_response({"files": [f for f in _files() if f != "none"]})
    except Exception as e:  # not inside ComfyUI, or the route exists already
        print(f"[LightCraft] watermark picker route not registered ({e})")


_register_routes()


class LightCraftWatermark:
    CATEGORY = "image/transform"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "enabled": ("BOOLEAN", {"default": True, "tooltip": "Off: the picture passes through untouched."}),
            "watermark": ("STRING", {"default": "none", "tooltip": "Managed by the picker on the node: a transparent PNG (or WebP) in the ComfyUI input folder."}),
            "position": (POSITIONS, {"default": "bottom right"}),
            "size_percent": ("FLOAT", {"default": 15.0, "min": 1.0, "max": 100.0, "step": 0.5, "tooltip": "Width of the mark as a share of the picture's width."}),
            "opacity_percent": ("FLOAT", {"default": 80.0, "min": 0.0, "max": 100.0, "step": 1.0}),
            "margin_percent": ("FLOAT", {"default": 3.0, "min": 0.0, "max": 30.0, "step": 0.5, "tooltip": "Distance from the edge, as a share of the picture's width."}),
            "free_x_percent": ("FLOAT", {"default": 50.0, "min": 0.0, "max": 100.0, "step": 0.5, "tooltip": "Only with position 'free': where the mark's centre sits, left to right."}),
            "free_y_percent": ("FLOAT", {"default": 50.0, "min": 0.0, "max": 100.0, "step": 0.5, "tooltip": "Only with position 'free': where the mark's centre sits, top to bottom."}),
            "crop_box": ("STRING", {"default": "", "tooltip": "Managed by the crop editor on the node (the crop as JSON, fractions of the mark). Empty = the whole mark."}),
            "angle_degrees": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 0.1, "display": "slider", "tooltip": "Turns the mark inside the crop box, around the exact centre of the box. Clockwise is positive."}),
        }}

    def run(self, image, enabled, watermark, position, size_percent, opacity_percent, margin_percent, free_x_percent=50.0, free_y_percent=50.0, crop_box="", angle_degrees=0.0):
        if not enabled or watermark in (None, "", "none") or opacity_percent <= 0:
            return (image,)
        import math
        free_x_percent = free_x_percent if isinstance(free_x_percent, (int, float)) and math.isfinite(free_x_percent) else 50.0
        free_y_percent = free_y_percent if isinstance(free_y_percent, (int, float)) and math.isfinite(free_y_percent) else 50.0
        try:
            from PIL import Image
            from .lc_safe import safe_annotated_path
            path = safe_annotated_path(watermark)
            wm = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0
        except Exception as e:
            print(f"[LightCraft] watermark skipped ({e})")
            return (image,)
        import torch
        outs = []
        for frame in image:
            arr = frame[..., :3].detach().cpu().numpy().astype(np.float32)
            outs.append(torch.from_numpy(composite(arr, wm, position, size_percent, opacity_percent, margin_percent, parse_box(crop_box), (free_x_percent, free_y_percent), angle_degrees)))
        res = torch.stack(outs, 0)
        if image.shape[-1] > 3:
            res = torch.cat([res, image[..., 3:].cpu()], -1)
        print(f"[LightCraft] watermark: {watermark} · {position} · {size_percent:g}% · {opacity_percent:g}%")
        return (res.to(image.device),)
