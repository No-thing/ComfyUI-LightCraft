"""Outpaint size lock: the picture Qwen outpaints is never larger than a set long side; the result goes back to the canvas size."""


def fit_size(w, h, max_long, mult=16):
    """(w, h) -> the size whose long side is at most max_long, both sides a multiple of `mult`. Unchanged when it already fits."""
    long_ = max(w, h)
    if long_ <= max_long:
        return w, h
    k = max_long / float(long_)
    nw = max(mult, int(round(w * k / mult)) * mult)
    nh = max(mult, int(round(h * k / mult)) * mult)
    while max(nw, nh) > max_long:                              # rounding up must never break the limit
        if nw >= nh: nw -= mult
        else: nh -= mult
    return nw, nh


def _resize(img, w, h):
    import torch.nn.functional as F
    x = img.movedim(-1, 1)                                     # b, c, h, w
    down = w < x.shape[3] or h < x.shape[2]
    x = F.interpolate(x, size=(h, w), mode="bicubic", align_corners=False, antialias=down)
    return x.clamp(0, 1).movedim(1, -1)


class LightCraftFitDown:
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "max_long_side": ("INT", {"default": 3072, "min": 512, "max": 8192, "step": 16,
                                      "tooltip": "The outpaint never works on a picture larger than this (long side). 3072 fits a 16 GB card; try 2048-2560 on 12 GB."}),
        }}

    def run(self, image, max_long_side):
        h, w = int(image.shape[1]), int(image.shape[2])
        nw, nh = fit_size(w, h, int(max_long_side))
        if (nw, nh) == (w, h):
            return (image,)
        print(f"[LightCraft] outpaint size lock: {w}x{h} -> {nw}x{nh} for Qwen (the result is scaled back)")
        return (_resize(image, nw, nh),)


class LightCraftFitBack:
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "reference": ("IMAGE", {"tooltip": "The canvas the picture has to match in size."}),
        }}

    def run(self, image, reference):
        h, w = int(reference.shape[1]), int(reference.shape[2])
        if (int(image.shape[1]), int(image.shape[2])) == (h, w):
            return (image,)
        return (_resize(image, w, h),)
