import numpy as np
import torch

from . import lc_protect as PR


def _np(t):
    return t[0].detach().cpu().numpy().astype(np.float32)[..., :3]


class LightCraftKeepColour:
    """After a skin pass: gives the result the ORIGINAL picture's overall colour back and keeps the new fine detail."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "result": ("IMAGE", {"tooltip": "The picture after the skin pass."}),
            "original": ("IMAGE", {"tooltip": "The picture before the skin pass (any size, it is fitted to the result)."}),
            "amount": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "0 = leave the result as it is. 1 = the overall colour and tone is the original's. About 0.6 to 0.8 keeps the look and removes most of a darkening."}),
            "softness": ("FLOAT", {"default": 0.06, "min": 0.01, "max": 0.3, "step": 0.01, "tooltip": "How broad 'colour' is, as a fraction of the long side. Bigger = only the very broad tone is restored; smaller = the original's mid-sized shading comes back too."}),
        }}

    def run(self, result, original, amount, softness):
        out = PR.keep_colour(_np(result), _np(original), amount, softness)
        return (torch.from_numpy(np.ascontiguousarray(out))[None],)


class LightCraftFaceProtect:
    """After a skin pass: puts the ORIGINAL lips / eyes / brows back (from the Face tab's landmarks), with a soft edge."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "result": ("IMAGE", {"tooltip": "The picture after the skin pass."}),
            "original": ("IMAGE", {"tooltip": "The picture before the skin pass (any size, it is fitted to the result)."}),
            "face_data": ("STRING", {"forceInput": True, "tooltip": "The Edit Page's face_data output (press Find face in the Face tab first). Without a face nothing is changed."}),
            "lips": ("BOOLEAN", {"default": True}),
            "eyes": ("BOOLEAN", {"default": True}),
            "brows": ("BOOLEAN", {"default": False}),
            "grow": ("FLOAT", {"default": 0.02, "min": 0.0, "max": 0.2, "step": 0.005, "tooltip": "Makes each protected part a little bigger, as a fraction of the face width."}),
            "feather": ("FLOAT", {"default": 0.03, "min": 0.005, "max": 0.2, "step": 0.005, "tooltip": "Softness of the edge, as a fraction of the face width. Bigger hides the join better."}),
            "amount": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "1 = the original parts come back fully. 0.5 = half way between the original and the skin pass."}),
        }}

    def run(self, result, original, face_data, lips, eyes, brows, grow, feather, amount):
        img, mask, note = PR.face_protect(_np(result), _np(original), face_data, lips, eyes, brows, grow, feather, amount)
        print("[LightCraft] face protect: " + note)
        return (torch.from_numpy(np.ascontiguousarray(img))[None], torch.from_numpy(np.ascontiguousarray(mask))[None])


class LightCraftEyesOn:
    """Decides if the automatic Eyes pass should run: only in Full mode, and only when the Face tab has a face stored."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("eyes_on",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "full": ("BOOLEAN", {"forceInput": True, "tooltip": "The Edit Page's full output (Full mode)."}),
            "face_data": ("STRING", {"forceInput": True, "tooltip": "The Edit Page's face_data output."}),
        }}

    def run(self, full, face_data):
        from . import lc_region as R
        try:
            ok = bool(full) and R.parse(face_data)["faces"] != []
        except Exception:
            ok = False
        print(f"[LightCraft] auto eyes pass: {'ON' if ok else 'off (' + ('no Full mode' if not full else 'no face found - press Find face once in the Face tab') + ')'}")
        return (ok,)
