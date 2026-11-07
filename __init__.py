import os

from .lc_presets import NONE, PRESETS, export_json, slider_tables
from .lightcraft_flux_node import LightCraftFluxRefs
from .lightcraft_crop_node import LightCraftCrop, LightCraftApplyGrade, LightCraftOutpaintSwitch, LightCraftOutpaintGate
from .lightcraft_look_nodes import LightCraftColor, LightCraftFX, LightCraftGrade, LightCraftGrain, LightCraftLens
from .lightcraft_nodes import LightCraftDevelop
from .lightcraft_scope_node import LightCraftScope
from .lightcraft_person_node import LightCraftPersonMask
from .lightcraft_tile_node import LightCraftTileSplit, LightCraftTileMerge
from .lightcraft_longside_node import LightCraftUpscaleLongSide
from .lightcraft_finish_node import LightCraftKeepColour, LightCraftFaceProtect, LightCraftEyesOn
from .lightcraft_watermark_node import LightCraftWatermark
from .lightcraft_fit_node import LightCraftFitDown, LightCraftFitBack
from .lightcraft_region_node import LightCraftRegionCrop, LightCraftRegionPaste, LightCraftEyePrompt, LightCraftRegionPasteAuto

# remove the UI script from the first release if an old install is being overwritten,
# otherwise it would run next to the new one
try:
    _old = os.path.join(os.path.dirname(__file__), "web", "lightcraft.js")
    if os.path.exists(_old):
        os.remove(_old)
except OSError:
    pass

export_json()  # keeps web/presets.json in sync with lc_presets.py

try:  # preset data for the browser script
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lightcraft/presets")
    async def _lightcraft_presets(request):
        return web.json_response({"none": NONE, "presets": PRESETS, "sliders": slider_tables()})
except Exception:
    pass

try:  # live preview for the Edit Page's Color panel
    from .lc_color_pipeline import register_routes as _color_routes

    _color_routes()
except Exception:
    pass

try:  # bake the Face / crop edits into a History picture when you leave their tab
    from .lc_bake import register_routes as _bake_routes

    _bake_routes()
except Exception:
    pass

try:  # face landmark model files for the Face tab (downloaded on first use)
    from .lc_face_assets import register_routes as _face_routes

    _face_routes()
except Exception:
    pass

try:  # the Upscale tab: TEMP clean-up + metadata copy for the "_up" pictures
    from .lc_finish import register_routes as _finish_routes

    _finish_routes()
except Exception:
    pass

NODE_CLASS_MAPPINGS = {
    "LightCraftDevelop": LightCraftDevelop,
    "LightCraftGrade": LightCraftGrade,
    "LightCraftFX": LightCraftFX,
    "LightCraftGrain": LightCraftGrain,
    "LightCraftLens": LightCraftLens,
    "LightCraftColor": LightCraftColor,
    "LightCraftCrop": LightCraftCrop,
    "LightCraftFluxRefs": LightCraftFluxRefs,
    "LightCraftScope": LightCraftScope,
    "LightCraftOutpaintSwitch": LightCraftOutpaintSwitch,
    "LightCraftOutpaintGate": LightCraftOutpaintGate,
    "LightCraftApplyGrade": LightCraftApplyGrade,
    "LightCraftRegionCrop": LightCraftRegionCrop,
    "LightCraftRegionPaste": LightCraftRegionPaste,
    "LightCraftEyePrompt": LightCraftEyePrompt,
    "LightCraftPersonMask": LightCraftPersonMask,
    "LightCraftTileSplit": LightCraftTileSplit,
    "LightCraftTileMerge": LightCraftTileMerge,
    "LightCraftUpscaleLongSide": LightCraftUpscaleLongSide,
    "LightCraftKeepColour": LightCraftKeepColour,
    "LightCraftEyesOn": LightCraftEyesOn,
    "LightCraftWatermark": LightCraftWatermark,
    "LightCraftFitDown": LightCraftFitDown,
    "LightCraftFitBack": LightCraftFitBack,
    "LightCraftRegionPasteAuto": LightCraftRegionPasteAuto,
    "LightCraftFaceProtect": LightCraftFaceProtect,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LightCraftDevelop": "LightCraft Develop",
    "LightCraftGrade": "LightCraft Grade (50 looks)",
    "LightCraftFX": "LightCraft FX (glow, lens, filters)",
    "LightCraftGrain": "LightCraft Grain (film presets)",
    "LightCraftLens": "LightCraft Lens (55mm to fisheye)",
    "LightCraftColor": "LightCraft Color (LUT + FX + Grain)",
    "LightCraftCrop": "LightCraft Edit Page",
    "LightCraftFluxRefs": "LightCraft Flux References",
    "LightCraftScope": "LightCraft Scope (histogram + clipping)",
    "LightCraftOutpaintSwitch": "LightCraft Outpaint Switch (paint only when needed)",
    "LightCraftOutpaintGate": "LightCraft Outpaint Gate (skip what follows when there is nothing to paint)",
    "LightCraftApplyGrade": "LightCraft Apply Grade (last step)",
    "LightCraftRegionCrop": "LightCraft Eyes / Face crop",
    "LightCraftRegionPaste": "LightCraft Eyes / Face paste back",
    "LightCraftEyePrompt": "LightCraft Eye request (colour)",
    "LightCraftPersonMask": "LightCraft Person mask (SAM 3)",
    "LightCraftTileSplit": "LightCraft Tile split",
    "LightCraftTileMerge": "LightCraft Tile merge",
    "LightCraftUpscaleLongSide": "LightCraft Upscale to long side",
    "LightCraftKeepColour": "LightCraft Keep colour",
    "LightCraftEyesOn": "LightCraft Eyes pass on?",
    "LightCraftWatermark": "LightCraft Watermark (optional, last step)",
    "LightCraftFitDown": "LightCraft Outpaint size lock (down)",
    "LightCraftFitBack": "LightCraft Outpaint size lock (back)",
    "LightCraftRegionPasteAuto": "LightCraft Region paste (automatic)",
    "LightCraftFaceProtect": "LightCraft Face protect (lips / eyes)",
}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
