# LightCraft Edit Page for ComfyUI

**Quality and minimalism.** One compact node that edits the picture right inside ComfyUI: crop, outpaint, face morph, colour grading, effects and an optional Flux skin pass. A Lightroom-style panel, "Photoshop at home".

Made by **No_Thing**. The UI idea comes from [storytold/lightcraft](https://github.com/storytold/lightcraft); the code in this repo was vibe coded with Claude. Outpaint and rotation use **AusBoss's** Qwen outpaint nodes (optional).

## What it does

| Tab | What you get |
| --- | --- |
| **Auto** | Press Run once. Full auto also adds the Flux skin pass and eyes pass. |
| **Browse** | Fast light grid of your saved pictures, star ratings, tick pictures for a batch. **Needs the ComfyUI-LightCraft-Upscaler (Station) pack installed.** |
| **Crop** | Rule-of-thirds grid, straighten, aspect buttons, outpaint (gray canvas is filled by Qwen). |
| **Face** | Find face, then eyes, nose and lips sliders (plus jaw, chin, cheeks, brows). Fix eyes. |
| **Color** | 50 looks (LUTs), FX, grain, lens. Applied once at the end. |
| **Skin pass** | Optional Flux pass, tiled (2 or 4 tiles) with a reference. Denoise slider. |

Everywhere:
- **History**: Photoshop-style layers on every tab. Newest on top, click a lower step to go back, Make layer, Save image.
- **Histogram** with clipping warnings (blue crushed blacks, red blown whites) and **Pixel drift** (what really changed between Before and After).
- **Double click any slider to reset it.**
- Run is ComfyUI's own Run button. There is no separate queue.

## Skin pass: keep Denoise at 0.67 or below

Above about 0.67 the face starts to drift into a different person. Around 0.60 the skin gets real pores and the face stays itself. The skin pass uses Flux with two LoRAs (Restore and UltraReal v5 pro, strength 1.00 each).

## Install

1. Copy the `ComfyUI-LightCraft` folder into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI and hard-refresh the browser.
3. Drag in the workflow, install any missing nodes, press Run on Auto.

First use of the Face tab downloads Google's MediaPipe Face Landmarker (about 12 MB) into `face_assets/`.

## You need

- ComfyUI, and the models in the workflow: Krea 2 for the base image, Flux for the skin pass, plus the two skin pass LoRAs.
- Optional, for outpaint: the AusBoss node pack and its Qwen outpaint model.
- Optional, for the dice lock: the **ComfyUI-NoThing-Premades** pack (the Roulette nodes).

## Docs

Full manual: [`MANUAL.md`](MANUAL.md). Short clips of every tab are on the Civitai page.

## Known limits

- Outpaint has an image size cap. Large images on 12 GB cards are still being tested.
- Report bugs with the steps, the F12 console lines starting with `[LightCraft]`, and the last 15 lines of the ComfyUI window.

## Credits

- [storytold/lightcraft](https://github.com/storytold/lightcraft) (MIT or Apache-2.0): UI inspiration. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **AusBoss**: Qwen outpaint and tiled restore nodes.
- Google MediaPipe Face Landmarker (face points).

## Licence

[No_Thing Free Use Licence v1](LICENSE): free to use and modify (including commercial image-making), share for free with credit; no selling the packs, no AI training on them, no re-uploading as your own.
