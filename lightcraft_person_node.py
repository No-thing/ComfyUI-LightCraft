import numpy as np
import torch

from . import lc_personmask as PM


class LightCraftPersonMask:
    """The person the Face tab's face belongs to, as a soft mask (SAM 3 + the face points). Blend a skin pass over the original with it."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "mask_preview")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "sam_model": ("MODEL", {"tooltip": "The SAM 3 model (Load Checkpoint: sam3.1_multiplex)."}),
            "face_data": ("STRING", {"default": "{}", "forceInput": True, "tooltip": "From the Edit Page (its face_data output). Press Find face in the Face tab first."}),
            "grow": ("INT", {"default": 48, "min": 0, "max": 400, "step": 4, "tooltip": "Extra padding around the person, in pixels (generous: the blend then never touches the edge)."}),
            "feather": ("INT", {"default": 64, "min": 0, "max": 400, "step": 4, "tooltip": "How soft the edge is, in pixels."}),
        }}

    def run(self, image, sam_model, face_data, grow, feather):
        arr = image[0].detach().cpu().numpy().astype(np.float32)
        m, note, ok = PM.person_mask(sam_model, arr, image[:1], face_data, grow, feather)
        print("[LightCraft] person mask:", note)
        t = torch.from_numpy(np.ascontiguousarray(m))[None]
        prev = t[..., None].repeat(1, 1, 1, 3)
        if not ok:                                              # the fallback is orange, so it cannot be mistaken for a real mask
            prev = prev * torch.tensor([1.0, 0.54, 0.25])
        return (t, prev)
