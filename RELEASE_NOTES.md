## v3.0.1

* Browse now works on its own. It no longer needs the Upscaler (Station) pack, which fixes the "HTTP 404" in the Browse tab. Star ratings still live in the same file, so they stay shared if you also use the Station.
* Edit Page only opens pictures inside ComfyUI's input, output and temp folders.

## v3

* Flux (optional) skin pass is now tiled with a reference: 2 or 4 tiles.
* Skin pass has a Denoise slider to dial it in. "The skin looks plastic", noted. Keep it at 0.67 or below.
* AusBoss's Qwen (optional) outpainting workflow is embedded.
* A completely free Roulette randomiser node. Roughly millions of combinations (estimated by Claude). 3 weeks in the making.
* The Edit Page, a Lightroom-style node with Auto, Browse, Crop (with outpaint), Face, Color and Skin pass tabs. Photoshop at home.
* Auto and Full auto: press Run once, or tick Skin + Eyes to add the Flux passes.
* Browse: a fast grid with star ratings and batch ticking.
* History: Photoshop-style layers on every tab. Click any step to go back.
* Histogram with blown-white and crushed-black warnings, plus Pixel drift to see what really changed.
* Double click any slider to reset it.
