import { app } from "../../scripts/app.js";
import { C, rr } from "./lightcraft_ui.js";
import { UI } from "./lc_brand.js";

// Edit Page tab bar: bold slab lettering, and a quiet tip that grows out of a tab when the pointer rests on it for a moment.
//   * Hover a tab for ~0.7 s: a wide card grows out of the middle of that tab (exponential ease, same curve as the Color / Face panels).
//   * Move the pointer away, or click: it shrinks back into the tab. Moving to another tab swaps the tip without the wait.
// The card is only drawn (no hit regions), so it never gets in the way of a click.

export const SLAB = `"Roboto Slab", Rockwell, "Arvo", "Zilla Slab", Georgia, serif`;
export const tabFont = (px = 14.5) => `700 ${px}px ${UI}, ${SLAB}`;      // brand lettering: Montserrat Alternates (slab only as a fallback)

// Privacy: nothing is loaded from the internet any more (this used to ask Google Fonts for Roboto Slab, which told Google
// that you opened the Edit Page). The brand fonts are bundled in web/fonts; Roboto Slab was only a fallback.
export function loadSlab() { /* kept so older imports still work; does nothing */ }

const TIPS = {
  compare: ["Auto  ·  Q / E for tabs", "The hands-off tab: everything runs from start to end, and you see before and after.", "Drag in the picture to move the divider. With Full mode on, only this tab and the Upscale tab upscale; the Color, Face and Crop tabs never do, so a picture is not upscaled before you have edited it."],
  color: ["Color  ·  Q / E for tabs", "Grade the picture: LUT, FX, film grain and lens looks.", "Pick a look on Start, fine-tune it in its own tab. The grade is applied to the output when you run. Opening this tab locks the roulette dice so the picture stays put; Compare gives you new rolls again. Double-click any slider to reset it."],
  face: ["Face  ·  Q / E for tabs", "Press Find face, then reshape the eyes, nose, lips, jaw, cheeks and brows.", "Opening this tab locks the roulette dice so the picture stays put. Compare gives you new rolls again. Double-click any slider to reset it."],
  crop: ["Crop & Outpaint  ·  Q / E for tabs", "Drag the white box to crop; hold Shift to grow or shrink it around its centre. Drag outside the box to straighten.", "Drag an orange dot outward to grow the canvas (gray area = what the outpaint pass paints); Canvas picks its shape. Fill gaps · OFF keeps the crop inside the picture. This tab locks the roulette dice too; Compare gives them back. Double-click any slider to reset it."],
};

TIPS.edit = ["Edit", "Finish the pictures you picked: browse, crop, face, color and skin pass.", "Opens the sub-tabs. Nothing is rolled here, so your picture stays put. Auto goes back to churning out new batches."];
TIPS.finish = ["Browse + Skin pass  ·  Q / E for tabs, 1-5 stars", "Pick pictures you already saved and finish them with the Flux skin pass.", "The list is the folder your Image Saver writes to. Tick one or many, press Upscale: the result is saved in the matching _Upscaled folder (same date) with _up in its name and carries all of its metadata. Orange frame = already upscaled, creamy white frame = chosen. Inside this tab the number keys 1-5 give stars to the picture under the pointer (0 clears), so click another tab to leave. This tab locks the roulette dice too; Compare gives them back."];
TIPS["fin:mp"] = ["Megapixels", "How big the result gets, in megapixels.", "4 is a good finish for a 2 MP picture. Bigger takes longer and more memory. Double-click to reset."];
TIPS["fin:fast"] = ["Fast · Turbo LoRA", "On: 8 steps with the Turbo LoRA. Off: about 25 steps, slower.", "Fast is what AusBoss recommends for most pictures. Turn it off only when Fast looks too smooth."];
TIPS["fin:st"] = ["Steps", "How many sampling steps each tile gets.", "8 with the Turbo LoRA (Fast), about 25 without it. More steps rarely help; fewer than the LoRA was made for can look smeared."];
TIPS["fin:rs"] = ["Restore strength", "How strongly the Restore LoRA holds the picture in place.", "1.0 keeps faces and shapes where they were. Try 0.5 for blurry photos so the model may invent more detail."];
TIPS["fin:t2"] = ["2 tiles", "The skin pass cuts the picture in two halves.", "No seam crosses the face, so a face cannot ghost at a seam. Slower than 4 tiles, and the better choice for smaller pictures (each half keeps more of the picture around it)."];
TIPS["fin:t4"] = ["4 tiles", "The skin pass cuts the picture in four (2 x 2). Faster.", "There is a small chance that a seam through the face leaves a faint ghost. If you see one, switch to 2 tiles."];
TIPS["fin:go"] = ["Skin pass", "Runs the skin pass for every ticked picture, one after the other.", "Nothing else in the workflow runs, and the roulette dice stay locked. Each result is saved next to its original as name_up."];
TIPS["fin:stars"] = ["Stars", "Show only pictures with this many stars or more.", "Click the stars on a picture, or hover it and press 1-5. The ratings are shared with the LightCraft Station."];
TIPS["fin:tick"] = ["Select new · Clear selection", "Select new chooses every shown picture that has no _up twin yet. Clear selection unticks everything.", "Both sit under the Skin pass button."];
TIPS["fin:scope"] = ["Show", "Switch between everything, only your saved pictures, or only the upscaled ones.", "Upscaled pictures are saved in a mirror folder named like your saver folder plus _SkinPass, with the same date sub-folders, so they are easy to find."];
TIPS["fin:temp"] = ["TEMP decimate", "Deletes every temporary picture the Edit Page made.", "That is the History states and previews. Your saved pictures are never touched. Click twice to confirm."];
TIPS["fin:drift"] = ["Pixel drift", "Paints the pixels that moved between Before and After in neon purple.", "Fine texture, brightness and soft glow do not count, only things that actually shifted: an edge, a hand, an earring. The percentage says how much of the picture moved."];

const DELAY = 700, DUR_IN = 520, DUR_OUT = 360;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

export function tipHide(node) {                                           // a click on a tab closes its tip until the pointer leaves it
  const T = node.__lcTip;
  if (T) T.suppressed = T.hov;
}

function wrap(ctx, text, maxW) {
  const out = []; let line = "";
  for (const word of String(text).split(/\s+/)) {
    const t = line ? line + " " + word : word;
    if (line && ctx.measureText(t).width > maxW) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

// rects: { tabId: [x, y, w, h] } in node coordinates; width: node width
export function drawTabTips(ctx, node, rects, width) {
  const T = node.__lcTip || (node.__lcTip = { hov: null, since: 0, id: null, p: 0, last: performance.now(), suppressed: null });
  const now = performance.now(), dt = Math.min(64, now - T.last); T.last = now;
  const p = node.__lcPointer, low = app.canvas && app.canvas.low_quality;
  let hov = null;
  if (p && !node.__lcDragging && !low) for (const [id, r] of Object.entries(rects)) if (p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3]) hov = id;
  if (hov !== T.hov) { T.hov = hov; T.since = now; if (hov !== T.suppressed) T.suppressed = null; }
  const open = T.p > 0.001;                                                // a tip is already out: moving to the next tab skips the wait
  const want = hov && hov !== T.suppressed && TIPS[hov] && (open || now - T.since >= DELAY) ? hov : null;
  if (T.id === null || T.p <= 0.001) T.id = want || T.id;
  const goal = want && want === T.id ? 1 : 0;
  if (T.p !== goal) T.p = clamp(T.p + (goal > T.p ? dt / DUR_IN : -dt / DUR_OUT), 0, 1);
  const waiting = hov && hov !== T.suppressed && TIPS[hov] && !want;
  if (T.p !== goal || waiting) {
    if (waiting) setTimeout(() => node.setDirtyCanvas(true, false), Math.max(30, DELAY - (now - T.since) + 20));
    if (T.p !== goal) requestAnimationFrame(() => node.setDirtyCanvas(true, false));
  }
  const e = ease(T.p), id = T.id;
  if (e <= 0.002 || !id || !TIPS[id] || !rects[id]) return;

  const [title, lead, more] = TIPS[id], tr = rects[id];
  const fw = Math.min(520, width - 28), padX = 16;
  ctx.save();
  ctx.font = "12px Inter, 'Segoe UI', sans-serif";
  const l1 = wrap(ctx, lead, fw - 2 * padX), l2 = wrap(ctx, more, fw - 2 * padX);
  const fh = 36 + 12 + (l1.length + l2.length) * 17 + 6 + 10;
  const tcx = tr[0] + tr[2] / 2, x0 = clamp(tcx - fw / 2, 14, width - 14 - fw);
  let top = tr[1] + tr[3] + 7;
  if (top + fh > node.size[1] - 6) top = Math.max(6, tr[1] - 7 - fh);                    // near the bottom edge: grow upward instead
  const sw = tr[2] * 0.6;                                                 // it starts as a small stub in the middle of the tab ...
  const rw = lerp(sw, fw, e), rx = lerp(tcx - sw / 2, x0, e), rh = Math.max(2, fh * e), ry = top < tr[1] ? top + fh - rh + (1 - e) * 5 : top - (1 - e) * 5;
  ctx.globalAlpha = clamp(e * 1.8, 0, 1);
  ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
  rr(ctx, rx, ry, rw, rh, 9); ctx.fillStyle = "#1c1c1f"; ctx.fill();      // ... and grows into the wide card
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = "#3b3b42"; ctx.lineWidth = 1; ctx.stroke();
  ctx.save();
  rr(ctx, rx, ry, rw, rh, 9); ctx.clip();
  ctx.globalAlpha = clamp((e - 0.5) / 0.5, 0, 1);
  ctx.fillStyle = "#ff8a2a"; ctx.fillRect(x0 + padX, top + 14, 22, 2.5);                       // a small orange tick under the title
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.font = `800 15px ${SLAB}`; ctx.fillStyle = "#f2f2f4"; ctx.fillText(title, x0 + padX, top + 36);
  let yy = top + 36 + 20;
  ctx.font = "12px Inter, 'Segoe UI', sans-serif"; ctx.fillStyle = "#d6d6dc";
  for (const ln of l1) { ctx.fillText(ln, x0 + padX, yy); yy += 17; }
  yy += 6;
  ctx.fillStyle = C.label;
  for (const ln of l2) { ctx.fillText(ln, x0 + padX, yy); yy += 17; }
  ctx.restore();
  ctx.restore();
}
TIPS["fin:size"] = ["Thumbnail size", "S, M or L: how big the pictures are in the grid.", "Small fits many at once, large lets you judge detail before you choose."];

TIPS["fin:save"] = ["Save image", "Saves your edit as name_edit next to the original picture, with the original's metadata, and stops there. No upscale.", "You can upscale it later from Browse (tick it, then Upscale)."];
TIPS["fin:bring"] = ["Bring my edit here", "Manual fallback: saves your edit as a picture and makes it the picture of this tab.", "Then press Skin pass this picture. Use it if the big button ever fails."];
TIPS["fin:use_grade"] = ["Use grade (LUT)", "Your current Color tab grade (the LUT and its sliders) is put on the big upscaled picture. Off: the upscale keeps the picture's colours as they were saved.", "Every picture in the batch gets the same grade, the one that is set in the Color tab right now."];
TIPS["fin:use_fx"] = ["Use FX (+ lens)", "Your current Color tab FX and lens effects are put on the big upscaled picture. Off: none are added.", "Every picture in the batch gets the same ones, the ones set in the Color tab right now."];
TIPS["fin:use_grain"] = ["Use grain", "Your current Color tab film grain is added on the big upscaled picture, last of all. Off: no grain is added (the upscale smooths the old grain away).", "Grain size follows the picture size, so it looks the same as on the small one."];

TIPS["full"] = ["AUTO ON / OFF", "Off: crop, then your Color-tab grade and grain, then save (the normal single pass).", "On: crop, then the Flux skin pass (Skin), then the eyes pass (Eyes, needs Find face once in the Face tab), then your grade ONCE, then save. Untick Eyes to skip the eyes, untick Skin to skip both."];
