## v3.1.0 (preview, branch edit-tab): Brush tab

A true Edit tab. Paint over an area with a round red brush, write a prompt (for example the trigger word of a LoRA), press Run: only the painted area is redrawn by a Flux Klein sampler.

* New **Brush** tab in the Edit Page: red round brush, Size, Feather, Paint / Erase, Reset mask, prompt, Strength.
* The mask is a temp picture (`lc_mask_*.png` in ComfyUI's temp folder). It goes away when ComfyUI closes and is included in the Browse tab's temp clean-up.
* The Edit Page has four new outputs: `edit_mask`, `edit_prompt`, `edit_on`, `edit_strength`. The mask follows the crop, turn and resize.
* New node **LightCraft Edit brush crop** (cuts a box around the painted area, enlarges it, pastes the result back softly with the existing paste node).
* Nothing runs when nothing is painted.

## v3.0.1

* Browse now works on its own. It no longer needs the Upscaler (Station) pack, which fixes the "HTTP 404" in the Browse tab. Star ratings still live in the same file, so they stay shared if you also use the Station.
* Edit Page and the Watermark node only open pictures inside ComfyUI's input, output and temp folders (symlinks are followed to the real file before checking).
* Browse keeps Pillow's decompression-bomb protection on, decodes at most two pictures at a time, and does the heavy work without freezing the ComfyUI server.
* The Color panel's live preview refuses pictures over 40 megapixels and keeps fewer in memory.
* The Edit Page no longer asks Google Fonts for a font. Nothing is loaded from the internet except the optional face-detection files.
* Only one face-detection download can run at a time.

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
