import numpy as np
import torch

from . import lc_tiles as T


class LightCraftTileSplit:
    """Cuts a picture into overlapping tiles. They go down the chain one by one (a list), so ONE sampler redraws them all; LightCraft Tile merge puts them back."""
    CATEGORY = "LightCraft"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "LC_TILES")
    RETURN_NAMES = ("tiles", "layout")
    OUTPUT_IS_LIST = (True, False)          # one tile at a time down the chain: some models (Krea 2) cannot take a batch of tiles at once

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "tile_size": ("INT", {"default": 1024, "min": 512, "max": 2048, "step": 64, "tooltip": "Side of one tile in pixels (made a multiple of 16)."}),
            "overlap": ("INT", {"default": 128, "min": 0, "max": 512, "step": 16, "tooltip": "How far neighbouring tiles overlap, in the picture's own pixels. The blend happens inside this strip."}),
            "zoom": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 3.0, "step": 0.25, "tooltip": "1 = tiles are redrawn at their real size. 2 = each tile covers half as much picture and is enlarged to tile_size first: pores and fine hairs get drawn at a size the model knows (4x as many tiles, so about 4x the time)."}),
            "tiles": (["By tile size", "2 tiles (fit the picture)", "4 tiles (2 x 2, fit the picture)"], {"default": "By tile size", "tooltip": "By tile size: tile_size and zoom decide how many tiles. 2 / 4 tiles: the picture is always cut into exactly that many tiles that fit it whatever its size (tile_size and zoom are ignored). Big pictures give big tiles, so check the console line for the tile size."}),
        }}

    def run(self, image, tile_size, overlap, zoom=1.0, tiles="By tile size"):
        arr = image[0].detach().cpu().numpy().astype(np.float32)
        count = 2 if str(tiles).startswith("2") else 4 if str(tiles).startswith("4") else 0
        lay = T.layout(arr.shape[1], arr.shape[0], tile_size, overlap, zoom, count)
        print(f"[LightCraft] tiles: {len(lay['xs'])} x {len(lay['ys'])} of {lay['tw']}x{lay['th']} picture pixels (zoom {lay['zoom']}), overlap {lay['ov']}" + (" - fixed count mode" if lay.get("count") else ""))
        return ([torch.from_numpy(np.ascontiguousarray(t))[None] for t in T.split(arr, lay)], lay)


class LightCraftTileMerge:
    CATEGORY = "LightCraft"
    INPUT_IS_LIST = True                    # receives every tile (a list) and the layout (a list of one)
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"tiles": ("IMAGE",), "layout": ("LC_TILES",)}}

    def run(self, tiles, layout):
        lay = layout[0] if isinstance(layout, (list, tuple)) else layout
        arr = np.concatenate([t.detach().cpu().numpy().astype(np.float32) for t in tiles], 0)
        out = T.merge(arr, lay)
        return (torch.from_numpy(np.ascontiguousarray(out))[None],)
