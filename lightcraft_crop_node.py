"""
LightCraft Edit Page - a classic Lightroom-style crop (aspect ratio, straighten) that can also
resize to a megapixel budget, and doubles as the before/after viewer for the workflow's result.

The Face tab reshapes the face before the crop, the Color tab's grade goes out on the `grade` output (put
LightCraft Apply Grade last), and the padding handles make a gray canvas for an outpaint pass (the
outpaint outputs plug straight into AusBoss's Krea 2 paint box).

Place it before the model that redraws / upscales the picture. Its panel then shows the crop editor;
when the workflow finishes, the image arriving at any Save / Preview node downstream of this node's
output appears in the panel's Compare tab, next to the crop this node produced. (A node cannot take
its own downstream result as an input - ComfyUI forbids loops - so the panel reads it from the
browser instead; nothing extra has to be wired.)

The pixel work lives in lc_geometry.py; the interactive panel is web/lightcraft_crop.js.
"""
import hashlib
import os
import time

import numpy as np
import torch
from PIL import Image, ImageOps

from . import lc_geometry as geo

try:
    import folder_paths
except ImportError:  # outside ComfyUI
    folder_paths = None

IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif")
BIG = 65536


def _input_files():
    if folder_paths is None:
        return ["none"]
    d = folder_paths.get_input_directory()
    try:
        files = [f for f in os.listdir(d)
                 if os.path.isfile(os.path.join(d, f)) and f.lower().endswith(IMG_EXT)]
    except OSError:
        files = []
    return ["none"] + sorted(files)


def _load_file(name):
    path = folder_paths.get_annotated_filepath(name)
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA") or "transparency" in im.info:
            rgba = im.convert("RGBA")
            bg = Image.new("RGBA", rgba.size, (128, 128, 128, 255))
            im = Image.alpha_composite(bg, rgba)
        return np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0


def _split_pick(raw):
    """history_pick is 'origin::file [type]' (origin = the incoming picture the state was made from)."""
    raw = (raw or "").strip()
    if "::" in raw:
        origin, _, pick = raw.partition("::")
        return origin.strip(), pick.strip()
    return "", raw


FINISH_TAG = "finish"


UPSCALED_SUFFIX = "_SkinPass"
OLD_SUFFIXES = ("_Upscaled",)                            # older pictures live in these mirror folders; still recognised


def upscaled_sub(sub):
    """The mirror folder for skin-pass pictures: 'No_Thing3.0/2026-10-24' -> 'No_Thing3.0_SkinPass/2026-10-24' (same date layout).
    A picture that is already inside a *_SkinPass (or older *_Upscaled) folder keeps its folder; with no sub-folder at all it is 'SkinPass'."""
    parts = [p for p in (sub or "").replace("\\", "/").split("/") if p]
    if not parts:
        return "SkinPass"
    if not parts[0].endswith((UPSCALED_SUFFIX,) + OLD_SUFFIXES) and parts[0] not in ("SkinPass", "Upscaled"):
        parts[0] += UPSCALED_SUFFIX
    return "/".join(parts)


def finish_names(pick):
    """
    For an Upscale (Finish tab) run: the saved picture 'sub/name.webp [output]' -> (save_name, save_path).
    save_name = the original's name + '_up' (_up_2, _up_3 ... when that already exists), save_path = the mirrored
    *_Upscaled folder with the same date layout (see upscaled_sub).
    """
    import re
    name = re.sub(r"\s*\[(output|input|temp)\]\s*$", "", (pick or "").strip())
    name = name.replace("\\", "/")
    sub, _, fname = name.rpartition("/")
    stem = os.path.splitext(fname)[0]
    stem = re.sub(r"_up(_\d+)?$", "", stem)                   # upscaling an upscaled copy: still named after the same original
    out_sub = upscaled_sub(sub)
    folder = None
    if folder_paths is not None:
        try:
            folder = os.path.join(folder_paths.get_output_directory(), out_sub)
        except Exception:
            folder = None
    taken = set()
    if folder and os.path.isdir(folder):
        taken = {os.path.splitext(f)[0].lower() for f in os.listdir(folder)}
    cand, n = stem + "_up", 1
    while cand.lower() in taken:
        n += 1
        cand = f"{stem}_up_{n}"
    return cand, out_sub


def _stamp(name):
    if not name or folder_paths is None:
        return ""
    try:
        st = os.stat(folder_paths.get_annotated_filepath(name))
        return f"{name}:{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        return f"{name}:missing"


def _temp_ok(path):
    """True when a temp layer file exists and opens (a half-written one from a crash is rejected and rewritten)."""
    if not os.path.exists(path) or os.path.getsize(path) < 64:
        return False
    try:
        with Image.open(path) as t:
            t.load()
        return True
    except Exception:
        return False


def _save_preview(arr, prefix, max_side=1600):
    """Write a copy to temp so the browser panel can show it (max_side=None: full resolution)."""
    h, w = arr.shape[:2]
    im = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8))
    scale = min(1.0, max_side / max(w, h)) if max_side else 1.0
    if scale < 1.0:
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    name = prefix + hashlib.md5(im.tobytes()).hexdigest()[:16] + ".png"
    path = os.path.join(folder_paths.get_temp_directory(), name)
    if not _temp_ok(path):
        tmp = path + f".{os.getpid()}.part"   # atomic: write beside it, then rename, so a crash never leaves half a layer
        try:
            im.save(tmp, format="PNG", compress_level=1)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                try: os.remove(tmp)
                except OSError: pass
    return {"filename": name, "subfolder": "", "type": "temp"}, [w, h]


def _apply_color(out, raw):
    """The Color panel's LUT / FX / Grain / Lens at full size (lc_color_pipeline), the same code the live preview uses."""
    try:
        from .lc_color_pipeline import apply_state
        return apply_state(out, raw or "{}")
    except Exception as e:  # a bad grade must never stop the run
        print("[LightCraft] Color panel skipped:", e)
        return out


def _apply_face(frame, raw, require_pic=False):
    """The Face tab's reshape (lc_face.py: landmark-driven soft warp). Needs no model: the landmarks are stored in the node."""
    try:
        from .lc_face import apply_state
        return apply_state(frame, raw or "{}", require_pic)
    except Exception as e:  # a bad face must never stop the run
        print("[LightCraft] Face tab skipped:", e)
        return frame


def _face_for_output(raw, xf, frame_wh):
    """face_data for the PICTURE THE EDIT PAGE OUTPUTS. The Face tab stores landmarks 0..1 on the picture it looked at;
    the output has been turned, padded, cropped and resized since, so the points are carried through the same steps."""
    import json
    try:
        d = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
        faces = d.get("faces") if isinstance(d, dict) else None
        if not faces or not xf:
            return raw or "{}"
        if d.get("src") and d["src"] != f"{frame_wh[0]}x{frame_wh[1]}":     # these points belong to another picture: leave them as they are
            return raw
        w1, h1, W, H = xf["w1"], xf["h1"], xf["width"], xf["height"]
        if xf["angle"] == 0 and (xf["pl"], xf["pt"], xf["cx"], xf["cy"]) == (0, 0, 0, 0) and (W, H) == (w1, h1):
            return raw
        new = []
        for lm in faces:
            nested = bool(lm) and isinstance(lm[0], (list, tuple))
            P = [(float(a) * w1, float(b) * h1) for a, b in lm] if nested else [(float(lm[i]) * w1, float(lm[i + 1]) * h1) for i in range(0, len(lm) - 1, 2)]
            Q = [(u / W, v / H) for u, v in geo.map_points(P, xf)]
            new.append([[u, v] for u, v in Q] if nested else [c for q in Q for c in q])
        d = dict(d, faces=new, src=f"{W}x{H}", pic="", p={}, zs=[], on=False)      # only the positions matter downstream (the reshape was already applied)
        return json.dumps(d)
    except Exception as e:
        print("[LightCraft] face_data for the output skipped:", e)
        return raw or "{}"


class LightCraftCrop:
    OUTPUT_NODE = True        # an Edit-tab run is just this node (the generation is cut out of the prompt), so it must be able to run on its own
    CATEGORY = "image/transform"
    RETURN_TYPES = ("IMAGE", "INT", "INT", "BOOLEAN", "MASK", "AUSBOSS_STITCHER", "IMAGE", "STRING", "BOOLEAN", "BOOLEAN", "STRING", "STRING", "BOOLEAN", "BOOLEAN", "STRING")
    RETURN_NAMES = ("image", "width", "height", "outpaint", "outpaint_mask", "outpaint_stitcher", "original", "grade",
                    "finish", "normal", "save_name", "save_path", "full", "upscale", "face_data")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (_input_files(),),
                "crop_aspect_ratio": (geo.ASPECTS, {"default": "original"}),
                "rotation_degrees": ("FLOAT", {"default": 0.0, "min": -45.0, "max": 45.0, "step": 0.05, "round": 0.01}),
                "crop_x": ("INT", {"default": 0, "min": 0, "max": BIG}),
                "crop_y": ("INT", {"default": 0, "min": 0, "max": BIG}),
                "crop_width": ("INT", {"default": 0, "min": 0, "max": BIG}),
                "crop_height": ("INT", {"default": 0, "min": 0, "max": BIG}),
                "resize_to_megapixels": ("BOOLEAN", {"default": True}),
                "megapixels": ("FLOAT", {"default": 2.0, "min": 0.1, "max": 64.0, "step": 0.05}),
                "resize_method": (list(geo.RESIZE_METHODS.keys()),),
                "resolution_steps": ("INT", {"default": 16, "min": 1, "max": 256}),
                "history_pick": ("STRING", {"default": ""}),
                "color_data": ("STRING", {"default": "{}"}),
                "crop_src": ("STRING", {"default": ""}),             # size of the picture the hand-made crop belongs to (last, so saved workflows keep their values)       # the Color tab's grade (one JSON, last so saved workflows keep their values)
                "face_data": ("STRING", {"default": "{}"}),          # the Face tab: face landmarks + reshape sliders (one JSON, last so saved workflows keep their values)
                # outpaint (the Outpaint tab pads the canvas; turning the picture leaves gray corners): new widgets go last
                "pad_left": ("INT", {"default": 0, "min": 0, "max": BIG}),
                "pad_top": ("INT", {"default": 0, "min": 0, "max": BIG}),
                "pad_right": ("INT", {"default": 0, "min": 0, "max": BIG}),
                "pad_bottom": ("INT", {"default": 0, "min": 0, "max": BIG}),
                "outpaint_aspect": (geo.ASPECTS, {"default": "original"}),
                "constrain_crop": ("BOOLEAN", {"default": False}),
                "keep_input_size": ("BOOLEAN", {"default": False}),     # ON: a bigger canvas (outpaint / turn) is scaled back to the input's pixel count. OFF (default): the picture keeps its pixels and the canvas just gets bigger
            },
            "optional": {"image_in": ("IMAGE",), "compare_image": ("IMAGE",),
                         "full_mode": ("BOOLEAN", {"forceInput": True})},   # wire any on/off button here: on = upscale in every run, the grade comes after the upscale
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, image, **kwargs):
        parts = []
        if kwargs.get("image_in") is None and image != "none":
            parts.append(_stamp(image))
        if kwargs.get("history_pick"):                                          # a picked history state re-runs
            parts.append(_stamp(_split_pick(kwargs["history_pick"])[1]))
        return "|".join(parts)

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        if image == "none" or folder_paths is None:
            return True
        if not folder_paths.exists_annotated_filepath(image):
            return f"Image not found: {image}"
        return True

    def run(self, image, image_in=None, compare_image=None, unique_id=None, **p):
        ui = {}
        pick_origin, pick = _split_pick(p.get("history_pick"))
        finish_run = pick_origin == FINISH_TAG and bool(pick)       # the Upscale tab: a saved picture goes through untouched
        if pick and (folder_paths is None or not folder_paths.exists_annotated_filepath(pick)):
            print(f"[LightCraft] History picture {pick} is gone (temp files are cleared when ComfyUI restarts): using the source")
            pick = ""                                   # that temp picture is gone (ComfyUI restarted): use the real source
            finish_run = False
        if image_in is not None:
            raw = [f[..., :3].detach().cpu().numpy().astype(np.float32) for f in image_in]
        elif image == "none" and not pick:
            raise ValueError("LightCraft Crop: pick an image, or connect one to image_in.")
        else:
            raw = [_load_file(image)] if image != "none" else None
        if pick and image_in is not None and folder_paths is not None:
            # A history state only belongs to the picture it was made from. When a NEW picture arrives on image_in
            # (a new generation, say) the old state must not win, or every run would repeat the same edit.
            now_origin = _save_preview(raw[0], "lc_src_", None)[0]["filename"]
            if pick_origin != now_origin:
                print(f"[LightCraft] the picture on image_in is a NEW one ({now_origin}, the History state was made from {pick_origin}): back to the source")
                pick = ""
                ui["lc_pick_stale"] = [True]
        frames = [_load_file(pick)] if pick else raw
        if folder_paths is not None and not finish_run:
            # "origin" = the picture that came in; the panel starts a fresh history when it changes
            if image_in is not None:
                info, dims0 = _save_preview(raw[0], "lc_src_", None)
            elif pick and raw is None:                      # a picture opened from the Browse tab: layer 0 is a lossless copy of it
                info, dims0 = _save_preview(frames[0], "lc_src_", None)
            elif raw is not None:
                info, dims0 = {"filename": image, "subfolder": "", "type": "input"}, [raw[0].shape[1], raw[0].shape[0]]
            else:
                info, dims0 = None, None
            if info is not None:
                ui["lc_origin"] = [dict(info, w=dims0[0], h=dims0[1])]
            if image_in is not None or pick:
                src_info, dims = _save_preview(frames[0], "lc_src_", None) if pick else (info, dims0)
                ui["lc_source"] = [src_info]
                ui["lc_dims"] = [dims]

        cs = str(p.get("crop_src") or "")
        h0_, w0_ = frames[0].shape[:2]
        if cs and cs != f"{w0_}x{h0_}":                 # the crop was drawn on a different-sized picture: use the full frame, as when nothing was set by hand
            p = dict(p, crop_x=0, crop_y=0, crop_width=0, crop_height=0, pad_left=0, pad_top=0, pad_right=0, pad_bottom=0)
        face_raw = p.get("face_data") or "{}"          # a face found on ANOTHER picture (a new roll) must never reach the Eyes pass / Face protect: they would crop the wrong place
        try:
            from .lc_face import parse as _fparse, picture_id as _pid
            _d0 = _fparse(face_raw)
            if _d0["faces"]:
                why = ""
                if _d0["pic"] and _pid(frames[0]) != _d0["pic"]:
                    why = "it belongs to another picture"
                elif _d0["src"] and _d0["src"] != f"{frames[0].shape[1]}x{frames[0].shape[0]}":
                    why = "it was found on a picture of another size"
                if why:                                # never guess: wrong points put the eyes in the hair
                    print(f"[LightCraft] the stored face is ignored for this run ({why}). Open the Face tab on this picture and press Find face.")
                    face_raw = "{}"
        except Exception as e:
            print("[LightCraft] face check skipped:", e)
        if finish_run:                                  # no reshape, no crop, no resize: the saved picture is upscaled as it is
            p = dict(p, crop_x=0, crop_y=0, crop_width=0, crop_height=0, pad_left=0, pad_top=0, pad_right=0, pad_bottom=0,
                     rotation_degrees=0.0, resize_to_megapixels=False, crop_aspect_ratio="original")
        else:
            frames = [_apply_face(f, p.get("face_data"), image_in is not None) for f in frames]           # Face tab reshape comes first; crop, mask and colour follow it
        results = [geo.process(f, p) for f in frames]
        out = torch.cat([torch.from_numpy(np.ascontiguousarray(r["image"])).unsqueeze(0) for r in results], 0)
        # the Color tab's grade is NOT applied here any more: it goes out on the `grade` output and LightCraft Apply Grade
        # puts it on the finished picture at the very end of the workflow (after the crop, the outpaint and the edit)

        # the gray area (what an outpaint pass has to paint) and the picture before the crop, for AusBoss's Krea 2 paint box
        fill_on = bool(results[0].get("outpaint"))
        fill_mask = torch.from_numpy(np.ascontiguousarray(results[0]["fill"])).unsqueeze(0).repeat(len(results), 1, 1)
        original = torch.cat([torch.from_numpy(np.ascontiguousarray(f)).unsqueeze(0) for f in frames], 0)

        if folder_paths is not None and not finish_run:
            ui["lc_before"] = [_save_preview(results[0]["image"], "lc_before_", None)[0]]
            if compare_image is not None:
                after = compare_image[0][..., :3].detach().cpu().numpy().astype(np.float32)
                ui["lc_after"] = [_save_preview(after, "lc_after_", None)[0]]
        finish = finish_run
        full = bool(p.get("full_mode")) and not finish            # full mode: this run upscales too (the grade is applied after the upscale)
        save_name, save_path = ("", "")
        if finish:
            save_name, save_path = finish_names(pick)
            ui["lc_finish"] = [{"src": pick, "name": save_name, "path": save_path}]
        return {"ui": ui, "result": (out, results[0]["width"], results[0]["height"], fill_on, fill_mask,
                                     _outpaint_stitcher(out, fill_mask), original, _grade_string(p.get("color_data"), unique_id),
                                     finish, not finish, save_name, save_path, full, finish or full,
                                     _face_for_output(face_raw, results[0].get("xf"), (w0_, h0_)))}


def _outpaint_stitcher(canvas, fill):
    """
    The stitcher AusBoss's Stitch Inpaint reads: the canvas, the paste mask (gray area, grown and softened by 32 px
    exactly as AusBoss's own Crop + Rotate + Pad does) and where the picture sits. Built with AusBoss's own helpers,
    so it is the same object their node would have made. None when the AusBoss pack is not installed.
    """
    import sys
    mod = None
    for name, m in list(sys.modules.items()):
        if name.endswith("_inpaint_crop_helpers") and hasattr(m, "build_canvas_stitcher") and hasattr(m, "stitch_blend_from_mask"):
            mod = m
            break
    if mod is None:
        print("[LightCraft] the AusBoss nodes are not installed: outpaint_stitcher is empty")
        return None
    try:
        pic = (fill[0] < 0.5).detach().cpu().numpy()
        ys, xs = np.nonzero(pic)
        h, w = pic.shape
        bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1) if len(xs) else (0, 0, w, h)
        blend = mod.stitch_blend_from_mask(fill, 32, 0)
        st = mod.build_canvas_stitcher(canvas, blend, bbox=bbox, source="LightCraft Edit Page")
        st["generated"] = fill
        return st
    except Exception as e:
        print("[LightCraft] could not build the outpaint stitcher:", e)
        return None


def _grade_string(raw, node_id):
    """The Color tab's settings for the last step, plus which Edit Page to report the finished picture to (History)."""
    import json
    try:
        d = json.loads(raw or "{}")
        if not isinstance(d, dict):
            d = {}
    except ValueError:
        d = {}
    d["_node"] = str(node_id) if node_id is not None else ""
    return json.dumps(d)


def _record_history(img, node_id):
    """
    Keep a picture as a History state of the Edit Page `node_id` (a temp file, gone when ComfyUI closes) and tell its panel.
    `run` is the queue id: two nodes recording in the same run (the stitch, then the last step) make ONE state, the later wins.
    """
    if folder_paths is None or node_id is None:
        return
    try:
        arr = img[..., :3].detach().cpu().numpy().astype(np.float32)
        info, dims = _save_preview(arr, "lc_hist_", None)
        from server import PromptServer
        PromptServer.instance.send_sync("lightcraft.history", {
            "node": str(node_id), "file": info["filename"], "type": "temp",
            "w": dims[0], "h": dims[1], "t": int(time.time() * 1000),
            "run": str(getattr(PromptServer.instance, "last_prompt_id", "") or "")})
    except Exception as e:  # history is a bonus; never break the run
        print("[LightCraft] could not save a history state:", e)


class LightCraftApplyGrade:
    """
    The Color tab's grade, put on the finished picture. Wire the Edit Page's `grade` output here and put this node
    last, just before the saver: the grade then never goes through the crop, the outpaint or the edit.
    """
    CATEGORY = "image/transform"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",), "grade": ("STRING", {"forceInput": True})}}

    def run(self, image, grade):
        import json
        node = None
        try:
            d = json.loads(grade or "{}")
            node = d.pop("_node", None)
            grade = json.dumps(d)
        except ValueError:
            pass
        try:                                                # a look at what arrives: flat gray (0.5) along the edges means the outpaint never reached this node
            a = image[0][..., :3].detach().cpu().numpy()
            edge = np.concatenate([a[:3].reshape(-1, 3), a[-3:].reshape(-1, 3), a[:, :3].reshape(-1, 3), a[:, -3:].reshape(-1, 3)])
            gray = float((np.abs(edge - 0.5) < 0.006).all(axis=1).mean())
            print(f"[LightCraft] apply grade: picture {a.shape[1]}x{a.shape[0]}, history={'yes (node ' + str(node) + ')' if node else 'NO - grade has no node id'}, gray edge share {gray * 100:.0f}%"
                  + ("  <-- FLAT GRAY EDGES: this is the unpainted picture" if gray > 0.25 else ""))
        except Exception:
            pass
        if node:
            _record_history(image[0], node)                 # the picture as it is BEFORE the grade, so the Color tab can still change it
        return (_apply_color(image[..., :3], grade),)


class LightCraftOutpaintSwitch:
    """
    Picks the picture that goes on to the edit: the outpainted one when the Edit Page says there is something to
    paint (outpaint = true), otherwise the plain picture. Only the chosen branch runs, so the whole outpaint pass
    costs nothing when the picture has no gray area.
    """
    CATEGORY = "image/transform"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"outpaint": ("BOOLEAN", {"forceInput": True})},
            "optional": {
                "painted": ("IMAGE", {"lazy": True}),
                "plain": ("IMAGE", {"lazy": True}),
            },
        }

    def check_lazy_status(self, outpaint, painted=None, plain=None):
        want = "painted" if outpaint else "plain"
        have = painted if outpaint else plain
        return [] if have is not None else [want]

    def run(self, outpaint, painted=None, plain=None):
        print(f"[LightCraft] outpaint switch: outpaint={outpaint} -> {'painted picture' if outpaint else 'plain picture'}")
        return (painted if outpaint else plain,)


class LightCraftOutpaintGate:
    """
    A door in front of a branch that must only run when the Edit Page added canvas to paint.
    on = true  -> the picture passes through.
    on = false -> nothing passes and every node after the door is skipped for this run (even the ones that always run,
                  like Show Text), so the Qwen "Describe the canvas" step costs no time when there is nothing to outpaint.
    Put it between the Edit Page picture and the first Qwen node of the outpaint branch (the one that reads the picture).
    """
    CATEGORY = "image/transform"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",), "on": ("BOOLEAN", {"forceInput": True})}}

    def run(self, image, on):
        if on:
            return (image,)
        try:
            from comfy_execution.graph_utils import ExecutionBlocker
        except Exception:                                         # an older ComfyUI without blockers: pass the picture, the switch still skips the heavy part
            print("[LightCraft] this ComfyUI has no ExecutionBlocker, the gate lets the picture through")
            return (image,)
        return (ExecutionBlocker(None),)
