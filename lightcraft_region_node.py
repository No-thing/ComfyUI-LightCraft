import numpy as np
import torch

from . import lc_region as R


def _np(t):
    return t[0].detach().cpu().numpy().astype(np.float32)


class LightCraftRegionCrop:
    """Cuts the eyes (or the face) out of the picture and enlarges them, ready for a redraw."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "LC_REGION", "IMAGE")
    RETURN_NAMES = ("crop", "region", "mask")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "face_data": ("STRING", {"default": "{}", "forceInput": True, "tooltip": "From the Edit Page (its face_data output). Press Find face in the Face tab first."}),
            "region": (["eyes", "face"], {"default": "eyes", "tooltip": "eyes: both eyes with brows. face: the whole face."}),
            "size": (list(R.SIZES), {"default": "Small 1024", "tooltip": "The crop is enlarged until its long side is this many pixels, then redrawn. Bigger = more detail, slower, more VRAM (Overkill 3072 is for tests; on a squarish face crop it needs a lot of VRAM)."}),
            "margin": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 1.5, "step": 0.05, "tooltip": "Extra skin around the region, so the model sees some context."}),
        }}

    def run(self, image, face_data, region, size, margin):
        arr = _np(image)
        h, w = arr.shape[:2]
        P = R.face_points(face_data, w, h)
        if P is None:
            raise ValueError("No face found. Open the Face tab and press Find face first.")
        reg = R.make_region(w, h, P, region, R.SIZES[size], margin)
        c = R.crop(arr, reg)
        m = R.region_mask(reg, 0.25 if region == "eyes" else 0.12)                   # what comes back, as a white / black picture (white = replaced)
        mimg = np.repeat(np.asarray(R.Image.fromarray((m[..., 0] * 255).astype(np.uint8)).resize((reg["tw"], reg["th"]), R.Image.BILINEAR), dtype=np.float32)[..., None] / 255.0, 3, axis=2)
        return (torch.from_numpy(c)[None], reg, torch.from_numpy(mimg)[None])


class LightCraftEyePrompt:
    """Writes the eyes request. {colour} in the template is replaced by the colour you chose, or (colour empty) by the colour read from the irises."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "face_data": ("STRING", {"default": "{}", "forceInput": True}),
            "template": ("STRING", {"default": "Refine the eyes using the reference image: {colour}, sharp, detailed irises with natural texture, clear catchlights,", "multiline": True}),
            "colour": ("STRING", {"default": "", "tooltip": "e.g. 'hazel iris with a soft blue outer ring'. Empty = read it from the picture."}),
        }}

    def run(self, image, face_data, template, colour):
        c = (colour or "").strip()
        if not c and "{colour}" in template:
            arr = _np(image)
            h, w = arr.shape[:2]
            P = R.face_points(face_data, w, h)
            name = R.iris_colour(arr, P) if P else None
            c = f"{name} iris" if name else "natural iris"
            print(f"[LightCraft] eye colour read from the picture: {c}")
        return (template.replace("{colour}", c),)


class LightCraftRegionPaste:
    """Puts the redrawn crop back into the picture with a soft edge."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_NODE = True                                       # the Edit Page's Eyes / Face buttons run just this chain: the finished picture goes to the History as a temp file

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",), "redrawn": ("IMAGE",), "region": ("LC_REGION",),
            "feather": ("FLOAT", {"default": 0.22, "min": 0.02, "max": 0.5, "step": 0.01, "tooltip": "How soft the edge is (share of the crop's shorter side)."}),
            "color_match": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "Pulls the redrawn colours toward the original so no seam shows."}),
        }}

    def run(self, image, redrawn, region, feather, color_match):
        out = R.paste(_np(image), _np(redrawn), region, feather, color_match)
        res = torch.from_numpy(out)[None]
        if image.shape[-1] > 3:
            res = torch.cat([res, image[:1, ..., 3:]], dim=-1)
        ui = {}
        try:
            from .lightcraft_crop_node import _save_preview
            info, dims = _save_preview(out, "lc_hist_", None)
            ui = {"images": [info], "lc_region": [dict(info, w=dims[0], h=dims[1], box=[region["x0"], region["y0"], region["x1"], region["y1"]], full=[region["w"], region["h"]])]}      # "images" also puts a thumbnail in ComfyUI's queue
            print(f"[LightCraft] Eyes/Face pass done: {info['filename']} ({dims[0]}x{dims[1]})")
        except Exception as e:
            import traceback
            print("[LightCraft] Eyes/Face pass: could not save the result picture:", e)
            traceback.print_exc()
        return {"ui": ui, "result": (res,)}


class LightCraftRegionPasteAuto:
    """Same as Region paste, but not an output node: it only runs when something later needs its picture (the automatic Eyes pass in Full mode). No history file is written."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls):
        return LightCraftRegionPaste.INPUT_TYPES()

    def run(self, image, redrawn, region, feather, color_match):
        out = R.paste(_np(image), _np(redrawn), region, feather, color_match)
        res = torch.from_numpy(out)[None]
        if image.shape[-1] > 3:
            res = torch.cat([res, image[:1, ..., 3:]], dim=-1)
        return (res,)
