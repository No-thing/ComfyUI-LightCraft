"""
LightCraft Flux References - hands the Edit Page's reference pictures (ref_1..ref_3) to Flux 2.

Flux 2 takes references as extra "reference latents" on the conditioning. This node encodes every reference
picture that is really filled in and appends it to both the positive and the negative conditioning (the same
thing a chain of ReferenceLatent nodes does), and skips the 8x8 grey stubs the Edit Page gives for empty slots,
so only the slots you filled in are used.
"""
try:
    import node_helpers
except ImportError:                      # outside ComfyUI (tests)
    node_helpers = None

STUB = 8          # the Edit Page's placeholder for an empty reference slot is an 8x8 grey picture


def _real(img):
    return img is not None and img.shape[0] > 0 and max(img.shape[1], img.shape[2]) > STUB


class LightCraftFluxRefs:
    CATEGORY = "image/transform"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"positive": ("CONDITIONING",), "negative": ("CONDITIONING",), "vae": ("VAE",)},
            "optional": {"ref_1": ("IMAGE",), "ref_2": ("IMAGE",), "ref_3": ("IMAGE",)},
        }

    def run(self, positive, negative, vae, ref_1=None, ref_2=None, ref_3=None):
        for ref in (ref_1, ref_2, ref_3):
            if not _real(ref):
                continue
            latent = vae.encode(ref[:, :, :, :3])
            positive = node_helpers.conditioning_set_values(positive, {"reference_latents": [latent]}, append=True)
            negative = node_helpers.conditioning_set_values(negative, {"reference_latents": [latent]}, append=True)
        return (positive, negative)
