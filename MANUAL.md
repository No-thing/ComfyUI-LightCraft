# LightCraft Edit Page · TLDR and user manual (v0.5)

## TLDR

One node, four tabs, one hotkey row. Put it between "the picture is made" and "save it".

- **1 Compare** - before / after, histogram, clipping warnings.
- **2 Color** - live grading: 50 looks, sliders, split toning, FX, grain, lens. Applied once, at the very end, by **Apply Grade**.
- **3 Face** - press Find face, reshape eyes, nose, lips, jaw, cheeks and brows with sliders. Live preview.
- **4 Crop** - crop, straighten, and add canvas. Gray canvas = what the outpaint model paints.

Wiring in one line: `picture → Edit Page → (outpaint pass, only if you padded) → Apply Grade → Saver`.
The Edit Page's `grade` output goes to Apply Grade. Nothing is graded until Apply Grade runs.

Mouse over the node and press **1 2 3 4** to flip tabs. Rest the pointer on a tab for a card that explains it.
Double-click any slider to reset it. Zoom the canvas out too far and the node goes quiet on purpose (ComfyUI's low-quality mode): zoom back in.

## What you need

- ComfyUI with this pack in `custom_nodes`. For outpaint: the AusBoss nodes pack (Stitch Inpaint) and the outpaint model of your choice (the shipped workflow uses Qwen Image 2.1 with `qwen-image-2.1-outpaint-v2.safetensors` in `models/loras`).
- Face tab, first use: the server downloads Google's MediaPipe Face Landmarker (about 12 MB) into `face_assets/`. After that it works offline. If the download is blocked, put the files listed in `lc_face_assets.py` into `face_assets/` by hand.
- For the roulette dice lock: the updated ComfyUI-NoThing-Premades pack.

## The node

**Inputs:** `image_in` (the picture to edit; or pick a file with Open… if nothing is connected), `compare_image` (optional: what the Compare tab shows as After; if empty it uses the picture that reaches a Save / Preview node after this one).

**Outputs:**

| Output | What it is |
|---|---|
| `image` | the picture after face reshape and crop / pad (not graded) |
| `width`, `height` | its size |
| `outpaint` | true when you padded the canvas or turned the picture (gray corners exist) |
| `outpaint_mask` | white where the gray canvas is |
| `outpaint_stitcher` | AusBoss stitcher, for putting your original pixels back after painting |
| `original` | the picture before padding |
| `grade` | the Color tab's settings as text, for Apply Grade |

**Order inside the node:** face reshape first, then crop / turn / pad. Colour is not applied here.

## Tab 1 · Compare

Before = the picture as it came into the node. After = what reaches Save / Preview further down (or `compare_image`). While you are on Face or Color, After shows your live edit.

- Modes: split (drag the divider), side by side, or click to flip.
- **Histogram** (right panel): the graph of the picture's tones. Click the `?` for a plain-words card.
- **Clipping warnings:** switch on Shadows / Highlights. Pixels where all channels are crushed show blue, blown ones show red, in both Before and After. The percentages say how much is clipped. Blown whites lose detail you cannot get back; pure blacks rarely matter.

## Tab 2 · Color

Live in the browser, nothing is queued. Start page: pick a look in each section (LUT, FX, Grain, Lens) and set its strength right under the picker.

- **Grade:** exposure, contrast, temperature, tint, saturation, vibrance, fade, black and white, and shadows / midtones / highlights colour wheels with balance and blending.
- **FX:** lens distortion, chromatic aberration, glow, halation, light leak, filters, vignette, TV effects.
- **Grain:** film grain looks with amount, size, roughness, colour and tonal response.
- **Lens:** presets from 55 mm to fisheye and peephole, plus fisheye, barrel / pincushion, zoom, black circle, colour fringing and soft / dark corners.
- "Compare original" flips to the ungraded picture.

The grade is stored in the node and sent out as `grade`. **LightCraft Apply Grade** applies it as the very last step, so the crop, the outpaint and any edit never see it. The browser preview and the final render use the same maths.

Not here (yet): tone curve, per-hue HSL, LUT files.

## Tab 3 · Face

1. Press **Find face**. With several faces, click the one you want.
2. Drag sliders. Double-click zeroes one; Alt-click types a value.

| Group | Sliders |
|---|---|
| Eyes | size, width, openness, tilt, spacing |
| Nose | size, nostril width, bridge, tip lift |
| Lips | fullness, upper, lower, width, corners, mouth height |
| Face shape | jaw width, chin length, chin width, cheeks |
| Brows and forehead | brow height, brow tilt, forehead height |

The tab, from the top: **Find face**, then **Eyes** (Fix eyes, eye colour pictures, own-words box, Keep my original lips), then the small tools, then the sliders. See *Eyes (Face tab)* below for the eyes part.

Small tools: **Points** shows landmarks (drag one if the finder missed a corner), **Guides** draws soft outlines that follow your sliders, **Before** (hold) shows the original.

How it works: each slider is a soft round region around a landmark. All regions add into one smooth displacement field, so nothing outside them moves. Sliders follow the face's own tilt and turn, so tilted and turned heads behave. Warping stretches pixels slightly; a light skin pass afterwards hides it. Extreme values on many sliders at once can fold the picture; one alone never does.

A new picture finds its face again by itself and keeps your slider values. **Roll lock:** while the Face, Color or Crop tab is open (every tab except Compare), the roulette dice stop on the seeds that made the picture you see, so your face points stay valid. A "Roll locked" chip appears. Open Compare (or click the chip) to roll again. Keep your main sampler seed on fixed.

## Tab 4 · Crop

- Aspect buttons (Free, Original, 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9), angle slider with its own reset, Grid overlay (thirds / grid / golden / off), Reset.
- **Mouse:** drag the **white** box to crop · drag outside the box to straighten · drag an **orange** dot outward to grow the canvas · hold **Shift** to resize from the centre (keeps a locked ratio).
- **Canvas · …** picks the shape the orange dots keep (Original, Free, or a ratio). One drag adds up to about three quarters of the picture per side; run again on the result for more.
- **Fill gaps · OFF** = classic crop that stays inside the picture. **ON** (default) lets turning leave gray corners and lets you pad.
- "Resize to megapixels" (settings drawer) scales the result. Otherwise the picture keeps its own pixels and an outpaint just makes the canvas bigger (the subject stays as sharp and as big as it was). Turn `keep_input_size` on only if you want the bigger canvas shrunk back to the input's pixel count.

## Tab 5 · Skin pass (finish a saved picture; called Upscale before v0.6)
The tab now runs the Flux skin pass. Wherever the text below says upscale, read skin pass. Steps and Denoise are the only settings; the pass works at the picture's own size.

The last tab finishes pictures you already **saved**, with the AusBoss tiled Qwen upscale. Click Upscale (or press E until you get there).

- **The grid** looks like the Station browser: the folder your Image Saver writes to (read from the saver node itself, so renaming it is fine) plus its newest dated sub-folders (the 15 newest pictures first, with a big "Load the rest" button; the skin-pass mirror folder is `<saver folder>_SkinPass`, older `_Upscaled` folders are still listed). Click a picture to choose it (**creamy white frame**). Pictures that already have an `_up` twin have an **orange frame** and a UP badge. The upscaled pictures live in a mirror folder: `No_Thing3.0/2026-10-24/name.webp` becomes `No_Thing3.0_Upscaled/2026-10-24/name_up.webp` (same date, so they are easy to find). Older `_up` files saved next to the original are still recognised. The **Show** button under the grid switches between all, saved only, and upscaled only. In the top-left corner of the picture area sit **Grid | Single** (the marker glides between them) and the thumbnail size **S M L**. In Single the real pixel size of both pictures is written above them (`Before 420 × 628 → After 840 × 1256 (2×)`). **Put the film grain back** (checkbox in the panel): the upscale smooths grain away, so a Grain node sitting right after the upscale ("Re-grain after upscale" in the workflow) gets the Color tab's grain settings and seed and adds it again on the big picture. Grain size follows the picture size, so it looks like the small one. It uses the Color tab's live grain, or else the newest snapshot layer that has grain; with no grain set it does nothing. **Full mode (upscale first, grade after):** the **Full mode** button on the Edit Page (right of Roll all, visible on every tab) switches it on or off; it also works with an external toggle: wire any boolean (an rgthree or Pixaroma toggle) to the optional `full_mode` input and the button shows "wired" and steps aside. Off = the normal single pass: crop, then LUT and grain, then save. On = the run goes crop, then the AusBoss upscale (the same Megapixels / Steps / Restore from this tab), then the Color-tab grade ONCE on the big picture, then the normal saver. So the grain is never washed out and nothing is graded twice. The result is one file in the normal dated folder (no `_up` copy). Off by default. Only the **Auto** tab (the old Compare tab, the hands-off one) and the Upscale tab run the whole way; with the Color, Face or Crop tab open the button shows "ON · paused" and the run never upscales, so a picture is not upscaled before you have edited it. In full mode the finished picture is saved in the mirror folder (`No_Thing3.0_Upscaled/<same date>/`) with the same file name and counter logic as the normal saver. Every full-mode run takes as long as an upscale. Pictures saved this way are already finished; browsing old pictures here still works and uses "Put the film grain back". Under the Upscale button: **Select new** ticks every shown picture without an `_up` twin, **Clear selection** unticks everything. The grid's scrollbar can be grabbed and dragged (or click the track to jump); the wheel still works. The magnifier opens a picture next to its twin (Split / Side / Before / After); In that view the saved pictures sit in a strip along the bottom (click one to switch, the little box ticks it); **Back to grid** returns. 
- **Stars**: click the stars, or hover a picture and press **1-5** (0 clears). The digits are ONLY star ratings now; use **Q / E** to change tab. Same ratings as the Station (shared `library.json`); the 3★+ / 4★+ / 5★ buttons filter.
- **Tab motion**: the right side never closes and re-opens between tabs. Its width glides to the new shape and the controls slide in from the right while fading in (and back out to the right), so the main picture just re-centres.
- **The History bar slides away** in this tab. The right panel holds **Megapixels**, **Steps**, **Restore**, **Fast** (Turbo LoRA, 8 steps) and the big **Upscale** button; they write straight into the AusBoss nodes. Restore 1.0 holds faces in place, 0.5 for blurry photos.
- **Upscale** queues one run per chosen picture. Only the upscale part of the workflow runs (the request to the server is trimmed, your saved workflow is not changed), the roulette dice stay locked, and the result is saved in the mirror folder `<your saver folder>_Upscaled/<same date>/` (for you `No_Thing3.0_Upscaled/2026-10-24/`) as `name_up` (`name_up_2` ... if taken) by the second Image Saver, with the original's full metadata copied on plus one "Upscaled" line.
- **Pixel drift** (in the compare view, also in Compare and Color): paints the pixels that moved between Before and After in red, with a "% moved" label. The two pictures are first lined up (an upscale rounds its size, so it can be a few pixels off), and slow tone changes such as a different brightness, contrast, colour or soft glow are ignored, so only edges and shapes that really changed count.
- **TEMP decimate** (bottom of the right panel, and the History bar elsewhere): shows how much it would free, e.g. "TEMP decimate · 240 MB" (shorter wording if the bar is narrow). Click twice to delete the old temporary pictures: the Edit Page's and the preview pictures ComfyUI leaves in its temp folder. The edit you are working on (Source, the state you are on, what the tabs are showing) is kept, and so is anything newer than 90 seconds, so a running render is safe. Other History rows disappear. Saved pictures are never touched.

Needs the LightCraft Upscaler pack (folder list, thumbnails, stars) and AusBoss nodes 2.15.0+. In the workflow the second Image Saver takes `save_name` / `save_path` from the Edit Page, and an Outpaint Gate (opened by the Edit Page `finish` output) sits in front of the upscale.

## Outpainting (when you padded or turned)

The gray is what a model paints. The Edit Page hands out `image` (with gray), `outpaint_mask`, `outpaint_stitcher` and `original`. Your outpaint group paints the gray, then AusBoss' **Stitch Inpaint** puts your own pixels back with a soft seam. **LightCraft Outpaint Switch** is lazy: with no padding it passes the picture through and the painting branch never runs, so no extra model loads.

**Shipped workflow (Qwen Image 2.1):** Qwen3-VL describes the gray canvas, the outpaint LoRA (`qwen-image-2.1-outpaint-v2.safetensors`, in `models/loras`) paints it with a normal KSampler (25 steps), and Stitch Inpaint puts your pixels back. Type an extra hint in "What goes there" if you want something specific in the new area. The outpaint seed is random each run; set it to fixed to repeat a result.

Tips: keep the first sentence of the outpaint prompt your model needs; big pads can invent extra faces or hands near the edge, so extend in two smaller steps; turning or pulling a dot also locks the roulette dice so the run paints the picture you are looking at.

## History (right panel)

Every run adds its finished picture (before the grade) to History. Click a step and it becomes the picture every tab works on; crop, turn, canvas and face sliders start fresh. **Source** brings back the original and your last face sliders. Leaving Face or Crop with changes bakes them into a History step automatically ("Edit 2 · Face"), so you can sculpt, crop, sculpt again and keep every step one click away. Gray corners or padding are not baked; they stay a setting for the run. The panel tucks away with the arrow strip. History lives in ComfyUI's temp folder and is cleared when ComfyUI closes.

## Troubleshooting

- **Node ignores clicks:** you are zoomed out too far (low-quality mode). Zoom in. Tab buttons stay live.
- **Face not found:** try Find face again after the picture has loaded; for profile views use Points to place landmarks.
- **Face sliders do nothing on a new picture:** the face is looked up again automatically; if none is found the old points are dropped. Press Find face.
- **Picture looks different after Run:** the roulette dice rolled. Open any tab except Compare (Color, Face or Crop) before running to lock them.
- **Something else wrong:** note the steps, the F12 console lines starting with `[LightCraft]` and the last ~15 lines of the ComfyUI window.

## Classic Film and Classic Hollywood looks
Added to the Color tab lists (all are slider recipes, so you can edit them after picking):
- **LUT:** Kodachrome-style 64, Vision3 250D-style, Vision3 500T-style, Eterna-style Muted, Ektachrome-style, Print 2383-style, Cinestill 800T-style, Agfa Vista-style, Technicolor 3-Strip, Two-Strip Technicolor, Silver Screen B&W, Casablanca Soft Mono, Golden Age Glamour, Western Sunset, Epic 70mm, Hitchcock Pastel.
- **FX:** Print Halation 2383, Cinestill Halation, Silver Screen Glow, Golden Age Diffusion, Technicolor Punch, Epic Widescreen, Old Hollywood Fade, Projector Warmth, Magic Hour Bloom.
- **Grain:** Kodak 5219 500T, Vision3 250D Fine, Double-X Cine B&W, Kodachrome Fine, 35mm Print Grain, Golden Age Mono.
A good film chain: a stock LUT, then a halation FX, then a matching grain. "-style" means in the spirit of the stock, not a copy of it.

## Light leaks (seeded)

- **Light leak** (FX tab): 1-3 soft coloured glows creeping in from the frame edges. The seed picks where they sit, how big they are and which colour (orange, red, amber, pink, yellow). The middle of a leak runs hot, nearly white.
- Leaks use the **same seed as the grain** (the Seed row on the Grain and FX tabs is one value), so one seed = one complete film look.
- In a video batch the leak stays put; only grain and TV noise move per frame.
- New presets: Leaky Camera, Expired Roll. (A DaVinci-style burn transition may come later.)

## Pixel sort, anamorphic streaks, bokeh, dust & scratches (FX tab)

- **Pixel sort:** runs of pixels whose brightness lies between *From* and *To* are sorted by brightness, giving the glitch-art streaks. *Streak length* sets how long a run may get. *Vertical* sorts down instead of sideways; *Reverse* flips bright-to-dark. Only the pixels inside the brightness window move, so the rest of the picture stays intact.
- **Anamorphic streaks:** only lights brighter than *Only lights above* flare into a long horizontal line. *Blue tint* 0 gives gold/white streaks.
- **Bokeh:** small bright lights bloom into discs (brighter light = brighter disc). *Blades* 0 = round, 3-9 = a polygon aperture. Big bright areas (a window) do not turn into discs; only light-like spots do.
- **Lens dirt / bokeh overlay:** a texture (hex bokeh, city lights, glitter...) that only shows where your picture has bright light, like dirt on a real lens catching a lamp. *Lights above* picks what counts as a light, *Glow spread* how far the dirt glows around it, *Scale* and *Rotate* place the texture, *Keep texture colours* 0 = grey, 100 = the texture's own colours, *Tint* paints it any hue, *Displace* bends the picture a hair where the dirt is, like glass does. Textures 1-7 are built in (city lights, neon, gold glitter, grey hexagons, soft discs, silver glitter, star sparkle). *Rotate texture colours* spins the colours of the multicolour ones around the colour wheel; drop your own black-background JPG/PNG into the `overlays` folder and it becomes the next number (files sort by name). Black = nothing, bright = shows.
- **Dust & specks / Scratches:** seeded (same seed as grain, leak and burn).
- The Start page of the Color node and Edit Page dropdowns now have a search box and category headings. The standalone nodes keep ComfyUI's normal dropdown.

## Comic / anime / Spider-Verse (FX tab)

- **Halftone dots (shadows):** dots that grow with darkness (like manga screentone); *Dots below brightness* sets how much of the picture counts as shadow, *Dot size* and *Dot angle* are what you expect.
- **White dots (lights):** the same idea in the highlights, white dots that grow with brightness.
- **Diagonal hatching:** fine diagonal ink lines that thicken in the shadows.
- **Colour offset:** the red and blue plates drift apart diagonally (print misregistration, the Spider-Verse aberration).
- **Flatten colours:** a little posterising for the flat comic look.
- Presets: Anime Halftone, Manga Screentone, Spider-Verse, Pop Art Dots.

## Snapshots (layers of effects) and tidier FX sliders

- **Snapshot** (button at the top of the History bar): bakes what you have set so far (LUT, FX, Grain, Lens) as a layer, then clears the live sliders so you can add the next effect on top. Up to 12 layers (the oldest is replaced when you go past that). They are listed on the Start tab (oldest first): the dot switches a layer on/off, the x deletes it. Layers are applied in order, then your live edits.
- Each layer gets its own grain / leak / dust pattern.
- On the FX and LUT tabs the slider groups fold: a group is open when your look uses it, Sharpen and Vignette are always open, and clicking a group heading opens or folds it.

- The **Source** picture is pinned at the bottom of the History bar and is never removed; the bar keeps the newest 12 steps and replaces the oldest ones. The little up / down arrows are gone.

## Make layer (v0.5 slice 1)
- The History bar's orange button is now **Make layer** (it was Snapshot). It bakes the Color tab's edits as a layer and starts the live edits clean on top.
- Stepping back to an older layer and then making something new **replaces the layers above it**, like Photoshop history.
- Temp layer files are written atomically (write beside, then rename). A half-written file from a crash is detected and rewritten, never shown.

## Auto | Edit (v0.5 slice 2)
- The top row has two main buttons. **Auto** is the hands-off tab (Roll all and Full mode sit next to it). **Edit** opens the sub-tabs: **Browse** (the picture browser, where you also press Upscale), **Crop** (crop, straighten and outpaint), **Face** and **Color**.
- The sub-tabs slide in from the right and fade; Roll all / Full mode slide out to the left. No jiggle.
- Edit remembers the last sub-tab you used. **Q** goes to the tab before, **E** to the tab after (Auto, Browse, Crop, Face, Color, Upscale; it stops at the ends). The number keys 1-5 are star ratings in Browse and Upscale (0 clears). Q/E only work while the pointer is on the Edit Page (or it is selected), and not while you type in a field.
- Outpaint still lives inside Crop and Upscale inside Browse; they become their own sub-tabs in the next slices.

## Browse chooses, Upscale finishes (v0.5 slice 2b)
- Edit sub-tabs, in order: **Browse, Crop, Face, Color, Upscale**. Upscale is last.
- **Browse** shows any picture in your saved folder (not only the newest). Click one to choose it, then press **Edit this picture** (or double-click it). It opens in Crop.
- The chosen picture becomes the **document**: layer 0 is a lossless temp copy; the saved file is never changed.
- While you edit, a run only runs the Edit Page on that picture. Krea, the roulettes and the seeds are cut out of the queued prompt, so a seed can never restart a generation. Auto still runs the whole workflow.
- Not built yet: saving the edited result back to a folder, and Upscale taking the edited document as its source (Upscale still works on saved files).

## Browse upscales, Upscale compares (v0.5 slice 2c)
- **Browse** is the only browser. Each picture has a box in its corner (tick it for the batch upscale) and a cream frame when chosen for editing. The panel has **Edit this picture** and **Upscale N ticked** (with Select new / Clear selection). The magnifier opens the picture in the Upscale tab.
- **Upscale** is no longer a browser. It is the comparer: the picture and its _up twin with real sizes, Split / Side by side / Before / After, the histogram with Shadows / Highlights warnings, and **Pixel drift**. It also holds the settings (Megapixels, Steps, Restore, Fast, film grain back) and an **Upscale this picture** button for the picture you are looking at.
- **Pixel drift is now neon purple** (red already means blown highlights).

- **The browser keeps itself up to date:** it looks again when you open Browse or Upscale, when the queue goes idle (new pictures were saved), and when you come back to the ComfyUI window. The refresh button is still there.

## Upscale your edit (v0.5 slice 3)
- With a picture opened from Browse, the **Upscale** tab shows **your edit** (the last result of the Edit tabs: crop, outpaint, face, color) as the picture to upscale.
- **Upscale your edit** does two things in a row: it saves the edit next to the original as `<name>_edit` (in the same dated folder, with the original's metadata copied across), then upscales that file into the `_SkinPass` mirror folder like any other picture.
- The save uses your normal Image Saver, so its format (webp) and folder settings apply. While you only edit, nothing is saved.
- Pictures you magnify from Browse are shown in the Upscale tab as before (saved picture against its _up twin).

- Fixed: the saver's model name (Workflow Input Value reading the loader by node_id) was missing from trimmed runs, so Upscale / Export stopped with "NoneType has no attribute split" or "Node not found in prompt ... 32". Trimmed runs now keep every node another node reads by id.

- **No grain before the upscale:** the saved `_edit` file is made without film grain (the upscaler would treat it as detail). The Color tab grain is put on afterwards by the re-grain step, so keep **Put the film grain back** ticked.

## Browse: magnifier, Esc and the unsaved-edits warning
- The **magnifier** on a picture in Browse shows it big, right in Browse (it no longer jumps to the Upscale tab). If the picture has an upscaled twin, the big view shows both. **Esc** or the **Grid** button goes back to the grid.
- **Double-click** a picture (or press **Edit this picture**) to start editing it. If you are already editing another picture and have not saved your changes, a box pops up: **Keep editing** or **Replace it**. Tick "Don't show this again" to stop it; switch it back on in ComfyUI Settings (cog) > LightCraft > Edit Page > "Warn before replacing unsaved edits". After a save or export nothing is asked.

## Metadata
- Upscales and edit exports get the ORIGINAL picture's prompt/workflow metadata (not the workflow's current roll), plus one added line ("Upscaled: ..." or "Edited in LightCraft Edit Page"). The `Size:` field now shows the saved file's real size (for example 2304x3456 after an 8 MP upscale), not the size it was generated at.


## Use grade / Use FX / Use grain (on the upscale)
Both the **Upscale tab** and the **Browse batch panel** have three switches. All three are **off** until you turn them on.
- **Use grade (LUT):** the LUT and its sliders from the Color tab are put on the big upscaled picture.
- **Use FX (+ lens):** the Color tab's FX and lens effects are put on the big picture.
- **Use grain:** the Color tab's film grain is added last of all.

They apply your **current Color tab settings** (whatever is set there right now) to every picture in the run, so a batch comes out with one look. With all three off, the upscale keeps each picture's colours as saved. The order is grade and FX first, grain last.

## Compare: one picture only, zoom, full size
- If only one of the two pictures exists (for example a picture that is not upscaled yet), it is shown full size with a small label, instead of an empty half. As soon as the upscale exists, the Split slider is back.
- Mouse wheel over the picture zooms toward the pointer, all the way to 100% of the real pixels and a bit past. While zoomed, drag the picture to move it (the Split divider is still grabbed by its line). The full-size file is loaded only while you are zoomed in.

## Light on the computer
- Browse reads only the newest date folder by default; "more" loads older ones.
- The browser does not look at your folders while a render is running, and not again for 2 minutes when you come back to the window.


## Eyes (Face tab)
Small eyes are drawn badly because they are only a few pixels in the picture. **Fix eyes** cuts both eyes out, enlarges them to 2048 px, lets Flux 2 Klein redraw them, and pastes them back with a soft edge. Only the eyes come back (lids, lashes, liner); skin, freckles and brows around them stay as they were. The result appears in History as "Edit · Eyes", and the Face view shows before and after, big (click anywhere to close; "Show before / after (big)" opens it again). Uses the Flux files already in your workflow (no extra model), always at full strength: there is nothing to tune.

1. Press **Find face** (the eyes use the same face points).
2. Pick an **eye colour**: eight small eye pictures. **Auto** (the first, rainbow iris) reads the colour from the picture. The others set it: Brown, Hazel, Blue, Ocean blue, Green, Hazel with a blue ring, Hazel with a green ring. The chosen one has an orange frame and its name sits next to the heading.
3. Or type **your own words** in the box under the pictures (for example "violet iris with silver flecks"). Whatever you type beats the pictures; the pictures dim while it is used. The ✕ clears it.
4. Press **Fix eyes**.

**How Auto reads the colour.** Find face also returns the exact centre and rim of each iris and the outline of each eye opening. Auto takes only the visible iris: inside the eye opening, between 45% and 90% of the way out from the centre, so the black pupil, the dark rim, the lids and the lashes are skipped. It drops the darkest 12% and brightest 10% of those pixels (shadow and the white catchlights), takes the median colour of the rest and names it by hue and saturation: brown, hazel, blue, ocean blue, green, grey or dark brown. That word goes into the request, which is what stops Flux from picking blue, grey or hazel at random between runs. It is a best guess: with sideways looks, half-closed eyes, or glitter and heavy makeup over the iris, pick the colour yourself.

**Lips.** If your workflow has the Face protect node, a **Keep my original lips** checkbox appears under Eyes (on by default). The Flux skin pass tends to thin lips; with this on, the original lips are put back untouched after the pass.

**Automatic eyes pass.** In Full mode the same pass runs by itself after the skin pass, only if a face is stored (press Find face once on that picture; a face found on another picture is ignored).

**Saving the result.** The eyes land in History. Click that entry to work on it; move the face sliders if you want, then press **Keep face edit** (it replaces Make layer while face sliders are moved), so the reshape is saved into History too. If a save fails, a red "edit not saved" appears next to HISTORY.

## Eyes / Face comparison workflow (NoThing_Eyes_Face_comparison.json)
One picture, one set of face points, one mask, one seed, three engines side by side: Qwen (text only), Krea 2 with the identity LoRA, Flux 2 Klein with the crop as a reference. Each runs an eyes pass, then a face pass on top, with a single KSampler per pass. The eye and face masks are shown as white / black pictures.
1. Pick a picture in "1", press Run once. 2. In the Edit Page open the Face tab, press Find face. 3. Run again.
The Edit Page now has a `face_data` output, and two nodes ("Eyes / Face crop" and "paste back") you can use in any workflow. The crop node also outputs the mask.

## Tile split / merge (LightCraft)
LightCraft Tile split cuts a picture into overlapping tiles (one batch) so a single sampler can redraw them all; LightCraft Tile merge blends them back with a smooth ramp inside the overlap. Used by the Krea skin pass test workflow (NoThing_Krea_Skin_Pass_test.json).

## Person mask (SAM 3)
LightCraft Person mask uses ComfyUI's own SAM3_Detect (point prompts) to pick the person the Face tab's face belongs to: the points go from the face down the neck and chest, so people in the background are never picked. grow = padding and feather = soft edge, both in pixels. With no face points the whole picture is used. Blend a skin pass over the original with it (ImageCompositeMasked). It is a normal node in a flat graph; the SAM 3 model comes from a plain Load Checkpoint (sam3.1_multiplex).

Tile split "tiles" switch: By tile size (default) uses tile_size and zoom. "2 tiles" cuts the picture in two along its long side, "4 tiles" in a 2 x 2 grid. Both always fit the picture, whatever its size, and overlap by the overlap setting (tile_size and zoom are ignored). A big picture gives big tiles (a 3900 x 2600 picture gives 2016 x 2608 px halves or 2016 x 1376 px quarters), so it is slower and the model may ghost on very large tiles; the console prints the tile size. Pictures are padded to a multiple of 16 internally and cropped back by Tile merge.

Tile split zoom: 1 = tiles are redrawn at their real size. 2 = each tile covers half as much picture and is enlarged to tile_size first, so pores and fine hairs are drawn at a size the model knows (the Face tab pass gets this for free because the face crop is enlarged). Costs about zoom squared in time.

## Upscale to long side (LightCraft)
LightCraft Upscale to long side takes a picture and an upscale model (for example ClearReality, from Load Upscale Model) and gives back a picture whose LONG side is exactly the number you set (default 4096), whatever size went in. It runs the model as many times as needed (a 1024 px picture needs one x4 run; a 400 px one needs two), then fixes the exact size with a Lanczos resize, so the result is always the same size. A picture that is already big enough is only resized. The short side follows the aspect ratio. Outputs: image, width, height.

Size by: Long side (default) uses the long_side number. Megapixels works the long side out from the picture's aspect ratio so that the result has that many million pixels (6 = about 3000 x 2000 and 8 = about 3464 x 2309 for a 2:3 picture); every picture then costs about the same render time. A picture that is bigger than the target is shrunk with Lanczos and the model is not run.

## Keep colour and Face protect (LightCraft)
Two finishing nodes for the end of a skin pass. Both take the picture BEFORE the pass as "original" (any size) and the result AFTER it.

LightCraft Keep colour: a skin pass often shifts the skin tone (darker, browner). The node blurs the original and the result so only the broad colour is left, takes the difference, and subtracts it from the result, so the new fine detail stays and the overall colour comes back. amount 0 = untouched, 1 = the original's colour. About 0.6 to 0.8 is a good start. softness is how broad "colour" is (fraction of the long side).

LightCraft Face protect (lips / eyes): the Flux pass can thin the lips or change the eyes. The node builds a mask of the lips, eyes and (optionally) brows from the Face tab's landmarks and pastes the original pixels back there with a soft edge. Plug the Edit Page's face_data output (the 15th) into it and press Find face once. With no face data it changes nothing and prints a note. grow makes the parts a little bigger, feather softens the edge (fractions of the face width). The mask is also an output so you can preview it.

Order at the end of the chain: Tile merge -> Keep colour -> Face protect.

## Flux skin pass and the automatic Eyes pass (Full mode)
- The AusBoss box in the main workflow no longer upscales with Qwen. In **Full mode** and in the **Upscale tab** it now runs a **Flux 2 Klein skin pass** on the picture as it is (no upscaler: let Krea's second pass make 2304 or about 3200 px): 4 tiles (2 x 2), 2 steps, denoise 0.65, the Restore and UltraReal LoRAs, no person mask. The Upscale tab shows **Steps** and **Denoise** for it.
- After the pass: **Keep colour** (0.7, gives back the original's overall colour, because the pass can darken skin) and **Face protect** (puts the original lips and eyes back).
- Then, **only in Full mode and only if a face is stored** (press Find face once in the Face tab), the **Eyes pass** runs: Flux, 2048 px crop, denoise 1.0, eye colour read from the irises. No face stored = the Eyes pass is skipped, the rest still runs. New node: `LightCraft Eyes pass on?`.
- The Qwen **outpaint** part of the AusBoss box is unchanged.

### Skin pass tab: which picture does it use?
The line above the big button says **Working on: …**. If you opened a picture for editing (Browse, double-click), the tab shows YOUR EDIT and the huge **Skin pass your edit →** button saves the edit first and then skin-passes it, so you never end up on a different picture. Only the magnifier in Browse switches the tab to look at some other saved picture; opening a picture for editing again switches back to your edit.

### Save image (every tab) and a fresh render
The orange **Save image** button in the History column (under Make layer) saves the picture exactly as it is now: all layers, crop, face and colour. It works on a picture you opened from Browse (saved as `name_edit` next to the original) and on a fresh render you jumped straight into editing (saved with your normal Image Saver's own name and folder, with the workflow's metadata). The Skin pass tab has the same button plus the huge **Skin pass your edit →**, which saves first and then skin-passes. A fresh render with no edits yet is already saved by the normal saver, so the buttons stay grey until you have a layer.

**Bring my edit here (manual):** under the big button in the Skin pass tab. If "Skin pass your edit" ever fails, this saves your edit and makes that saved picture the one shown in the tab; then press the normal "Skin pass this picture" button on it.

### Colour and the skin pass: order
Colour never goes into the picture before the skin pass. The Color tab's settings and layers are only settings; the workflow's **Apply grade (last step)** node puts them on the finished picture right before the Image Saver, after the crop, outpaint and skin pass. (In the Skin pass tab, the Use grade / Use FX / Use grain boxes do the same after that tab's skin pass.)

### The AUTO button
The button next to Roll all says **AUTO ON** (orange, softly glowing) or **AUTO OFF**. Click it to switch. The two small ticks on it choose what AUTO does: **Skin** (the Flux skin pass) and **Eyes** (the automatic eyes pass on top of it; it needs Find face once in the Face tab, and is greyed out without Skin). The grade always goes on last, once, right before the saver. While you are in the Edit tabs the button shows "paused in Edit": nothing is upscaled there.

### Watermark (optional, last step)
The workflow has a **Watermark** node between "Apply grade (last step)" and the Image Saver, so it goes on after everything else, like the grade. Pick a transparent PNG (or WebP) with **Upload…** or **From input folder…** on the node (it lives in ComfyUI's input folder), choose a corner, size (share of the picture's width), opacity and margin. With "none" selected, or the switch off, the picture passes through untouched. It is only on the normal saver's path: the Skin pass tab's own saver does not add it.

### Outpaint size lock
The Qwen outpaint never works on a picture larger than **3072 px on the long side** (the **Outpaint size lock** nodes in the outpaint group). A bigger canvas is scaled down for Qwen, and the painted result is scaled back to the canvas size before it is stitched in, so the outpaint no longer crashes on big pictures. Smaller pictures pass through untouched. The limit is the number on the "(down)" node; 12 GB cards should try 2048 to 2560.

The Watermark node is drawn on the node itself, in the Edit Page's look and with the same mouse system, like a Load Image with a crop. The picture frame fills the node, anchored to its corners: drag the node's corner and the frame grows with it. **Click the picture and drag** to draw the crop box (draw again to replace it). Pull its corners or sides to adjust, drag inside it to move it; the size is shown above the box. The node's own **Angle slider** turns the picture around the exact middle of the box (the small orange cross); anything the picture no longer covers stays transparent. The **mouse wheel** zooms the picture inside the box (around the cross); **Shift + drag** slides the picture inside the box. **Aspect: free / locked** keeps the box shape when locked. **Placement** folds open the corner, size, opacity and margin fields (closed by default). **Reset** (or a double-click on the picture) clears the crop. Position (corners, centre or "free" with free_x / free_y), size, opacity and margin are the normal number fields on the node; size is the width of the cropped result. If the editor ever fails to start, the node keeps working and the browser console (F12) says why.

### Running without Qwen or Flux
You can bypass the Qwen and Flux model loaders and the workflow still makes the picture, grades it and saves it: Krea → Edit Page → Apply grade → Watermark → Image Saver. LightCraft removes the branches that cannot run from the copy of the workflow it sends to ComfyUI (your own workflow is not touched), so the red inputs on the Flux / Qwen subgraph do not stop the save. What you lose without the models: the skin pass and eyes pass (Full / AUTO mode needs Flux, and ComfyUI shows its normal error if you turn it on without it) and the outpaint (a gray canvas stays gray, the console says so).

## Skin pass: 2 or 4 tiles
The Skin pass tab has a **Tiles** choice under Denoise.
- **4 tiles (default):** the picture is cut 2 x 2. Faster. There is a small chance that a seam running through the face leaves a faint ghost.
- **2 tiles:** the picture is cut in two halves, so no seam crosses the face and it cannot ghost there. Slower, and the better pick for smaller pictures because each half keeps more of the picture around it.
If you see a ghost on a face, switch to 2 tiles and run the skin pass again.

How common is it? In testing, 100+ pictures were skin-passed with 4 tiles and one showed a faint ghost on an eye. If it happens to you, switch to 2 tiles (or run the Eyes pass) and redo that picture.
