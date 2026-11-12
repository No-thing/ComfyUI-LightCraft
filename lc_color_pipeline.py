"""
The Edit Page's Color panel: LUT (Grade look) -> FX -> Grain -> Lens, each with its own on / off.
One function applies the saved state to a picture; the panel's live preview asks for it over HTTP
(/lightcraft/color_preview) and the node uses it on its full-size output, so both always agree.

state = {"lut": {"on": true, "p": {...slider values}}, "fx": {...}, "grain": {...}, "lens": {...}, "seed": 0}
"""
import io
import json

import torch

from .lc_presets import NONE

_SECTIONS = (("lut", "LightCraftGrade"), ("fx", "LightCraftFX"), ("grain", "LightCraftGrain"), ("lens", "LightCraftLens"))


def _clean(raw):
    """Accepts the current state, or the first version's {"preset", "p"} (a LUT only)."""
    try:
        d = json.loads(raw) if isinstance(raw, (str, bytes)) else dict(raw or {})
    except (TypeError, ValueError):
        return {}
    if "p" in d and "lut" not in d:
        d = {"lut": {"on": True, "p": d.get("p") or {}}}
    return d if isinstance(d, dict) else {}


def is_neutral(state):
    from .lc_sliders import FX_SLIDERS, GRADE_SLIDERS, GRAIN_SLIDERS, LENS_SLIDERS
    tables = {"lut": GRADE_SLIDERS, "fx": FX_SLIDERS, "grain": GRAIN_SLIDERS, "lens": LENS_SLIDERS}
    for key, _ in _SECTIONS:
        sec = state.get(key) or {}
        if sec.get("on", True) is False:
            continue
        p = sec.get("p") or {}
        if any(k in p and p[k] != v[3] for k, v in tables[key].items() if k != "strength"):
            return False
    return True


def _apply_sections(image, state):
    from .lightcraft_look_nodes import LightCraftFX, LightCraftGrade, LightCraftGrain, LightCraftLens
    nodes = {"lut": LightCraftGrade, "fx": LightCraftFX, "grain": LightCraftGrain, "lens": LightCraftLens}
    out = image
    for key, _ in _SECTIONS:
        sec = state.get(key) or {}
        if sec.get("on", True) is False:
            continue
        p = {k: v for k, v in (sec.get("p") or {}).items() if isinstance(v, (int, float))}
        if key in ("grain", "fx"):
            p["grain_seed"] = int(state.get("seed") or 0)
        (out,) = nodes[key]().run(out, True, NONE, **p)          # the sliders are the truth; the preset name only fills them in the browser
    return out


def apply_state(image, raw):
    """image: [B,H,W,3(+alpha)] float 0..1 on any device -> same shape. Returns the input untouched when nothing is set.
    Snapshot layers (state["layers"], oldest first) are applied one after another, then the live edits on top."""
    state = _clean(raw)
    if not state:
        return image
    out = image
    for i, layer in enumerate(state.get("layers") or []):
        s = layer.get("s") if isinstance(layer, dict) else None
        if not isinstance(s, dict) or layer.get("on", True) is False or is_neutral(s):
            continue
        s = dict(s, seed=int(s.get("seed") or 0) + 7919 * (i + 1))        # each layer gets its own grain / leak / dust pattern
        out = _apply_sections(out, s)
    if not is_neutral(state):
        out = _apply_sections(out, state)
    return out


# ---------------------------------------------------------------- live preview over HTTP
_CACHE = {}
MAX_PREVIEW_PIXELS = 40_000_000       # the panel sends a reduced copy; anything bigger than this is refused instead of filling memory
MAX_CACHED = 3


def register_routes():
    from aiohttp import web
    from PIL import Image
    import numpy as np
    from server import PromptServer

    @PromptServer.instance.routes.post("/lightcraft/color_preview")
    async def color_preview(request):
        form = await request.post()
        key = str(form.get("key", ""))
        up = form.get("image")
        if up is not None and hasattr(up, "file"):
            im = Image.open(io.BytesIO(up.file.read()))
            if im.width * im.height > MAX_PREVIEW_PIXELS:
                return web.json_response({"error": "Preview picture is too large."}, status=413)
            im = im.convert("RGB")
            _CACHE[key] = np.asarray(im, dtype=np.float32) / 255.0
            if len(_CACHE) > MAX_CACHED:
                _CACHE.pop(next(iter(_CACHE)))
        arr = _CACHE.get(key)
        if arr is None:
            return web.json_response({"error": "need_image"}, status=409)
        try:
            img = torch.from_numpy(arr).unsqueeze(0)
            out = apply_state(img, form.get("state", "{}"))
            res = (out[0][..., :3].clamp(0, 1).cpu().numpy() * 255.0 + 0.5).astype(np.uint8)
            buf = io.BytesIO()
            Image.fromarray(res).save(buf, format="PNG", compress_level=1)
            return web.Response(body=buf.getvalue(), content_type="image/png")
        except Exception as e:  # keep the editor alive, show the reason
            return web.json_response({"error": str(e)}, status=500)
