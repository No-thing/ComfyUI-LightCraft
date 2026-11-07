import numpy as np
import torch
from PIL import Image

from . import lc_longside as S


class LightCraftUpscaleLongSide:
    """Runs an upscale model (for example ClearReality) as often as needed, then sets the picture to EXACTLY the wanted long side with a Lanczos resize.
    Any picture size in, same long side out. A picture that is already big enough is only resized (no model run)."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "upscale_model": ("UPSCALE_MODEL",),
            "long_side": ("INT", {"default": 4096, "min": 256, "max": 16384, "step": 16, "tooltip": "The LONG side of the result in pixels (4096 = 4K). The short side follows the aspect ratio. Used when Size by = Long side."}),
            "size_by": (["Long side", "Megapixels"], {"default": "Long side", "tooltip": "Long side: the long_side number decides. Megapixels: the megapixels number decides and the long side is worked out from the picture's aspect ratio, so every picture costs about the same render time."}),
            "megapixels": ("FLOAT", {"default": 8.0, "min": 0.5, "max": 100.0, "step": 0.5, "tooltip": "Target size in millions of pixels (6 = about 3000 x 2000, 8 = about 3464 x 2309 for a 2:3 picture). Used when Size by = Megapixels."}),
        }}

    def run(self, image, upscale_model, long_side, size_by="Long side", megapixels=8.0):
        import nodes
        up = nodes.NODE_CLASS_MAPPINGS["ImageUpscaleWithModel"]()
        h, w = int(image.shape[1]), int(image.shape[2])
        if str(size_by).startswith("Mega"):
            long_side = S.long_side_for_megapixels(w, h, megapixels)
        scale = int(getattr(upscale_model, "scale", 4) or 4)
        n = S.passes_needed(w, h, long_side, scale)
        out = image[..., :3]
        for _ in range(n):
            out = up.upscale(upscale_model, out)[0]
        tw, th = S.target_size(w, h, long_side)
        oh, ow = int(out.shape[1]), int(out.shape[2])
        if (ow, oh) != (tw, th):
            arr = (out.detach().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
            res = [np.asarray(Image.fromarray(a).resize((tw, th), Image.LANCZOS), dtype=np.float32) / 255.0 for a in arr]
            out = torch.from_numpy(np.ascontiguousarray(np.stack(res, 0)))
        print(f"[LightCraft] upscale to long side: {w}x{h} -> model x{scale} run {n} time(s) -> {tw}x{th} ({tw * th / 1e6:.2f} MP)")
        return (out, tw, th)
