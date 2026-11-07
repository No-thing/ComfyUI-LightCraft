"""
LightCraft Scope - a lightweight preview that shows the picture's histogram with Lightroom-style clipping
warnings (blue = crushed blacks, red = blown whites). The picture passes straight through, so it can sit
anywhere in a chain; the histogram and overlays are drawn in the browser from a small temporary preview.
"""
import numpy as np

from . import lc_geometry as geo
from .lightcraft_crop_node import _save_preview, folder_paths


class LightCraftScope:
    CATEGORY = "image/postprocessing"
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",)}}

    def run(self, image):
        ui = {}
        if folder_paths is not None and image.shape[0] > 0:
            frame = image[0][..., :3].detach().cpu().numpy().astype(np.float32)
            frame = geo.limit_megapixels(frame, 1.0)                        # about 1 MP is plenty for a histogram
            info, dims = _save_preview(frame, "lc_scope_", None)
            ui["lc_scope"] = [dict(info, w=dims[0], h=dims[1])]
        return {"ui": ui, "result": (image,)}
