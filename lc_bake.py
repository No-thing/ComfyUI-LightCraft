"""
Bake: the Edit Page's Face reshape and plain crop / straighten turned into a real picture (a History state), so the next
edits start from it. The browser asks for this when you leave the Face or Crop tab with something changed.

POST /lightcraft/bake  {file, type, face_data, crop: bool, params: {rotation_degrees, crop_x, crop_y, crop_width, crop_height, crop_aspect_ratio}}
  -> {baked: ["face", "crop"], file, type: "temp", w, h}      (baked is empty when there was nothing to do)

The crop is only baked when it makes a plain picture: a turn or a pad that leaves gray corners is an outpaint job and
stays a setting for the workflow run. Colour is never baked here: the grade is the last step of the workflow.
"""
import asyncio


def bake(file, typ, face_data, want_crop, params):
    import numpy as np
    from . import lc_face as F
    from . import lc_geometry as geo
    from .lightcraft_crop_node import _apply_face, _load_file, _save_preview

    frame = _load_file(f"{file} [{typ}]")
    out, baked = frame, []
    try:
        if F.active(F.parse(face_data or "{}")):
            warped = _apply_face(frame, face_data, False)
            if warped is not frame and not np.array_equal(warped, frame):
                out = warped
                baked.append("face")
    except Exception as e:                                               # a bad face must never stop the crop
        print("[LightCraft] bake: face skipped:", e)
    if want_crop:
        p = dict(params or {})
        p.update(resize_to_megapixels=False, keep_input_size=False, pad_left=0, pad_top=0, pad_right=0, pad_bottom=0)
        r = geo.process(out, p)
        if not r.get("outpaint"):                                        # gray corners would need the outpaint pass: leave those settings alone
            img = np.clip(r["image"], 0, 1).astype(np.float32)
            if img.shape != out.shape or not np.array_equal(img, out):
                out = img
                baked.append("crop")
    if not baked:
        return {"baked": []}
    info, dims = _save_preview(out[..., :3], "lc_hist_", None)
    return {"baked": baked, "file": info["filename"], "type": "temp", "w": dims[0], "h": dims[1]}


def register_routes():
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/lightcraft/bake")
    async def _bake(request):
        try:
            d = await request.json()
            file, typ = str(d["file"]), str(d.get("type") or "temp")
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        try:
            res = await asyncio.get_running_loop().run_in_executor(
                None, bake, file, typ, d.get("face_data"), bool(d.get("crop")), d.get("params"))
        except Exception as e:
            print("[LightCraft] bake failed:", e)
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)
        return web.json_response(res)
