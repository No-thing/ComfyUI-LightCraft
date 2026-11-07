import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { hit, drag } from "./lc_interact.js";

// LightCraft UI v2 - Lightroom / Camera Raw style panels for Develop, Grade, FX and Grain.
// Standard ComfyUI widgets stay in place (we only restyle + handle the mouse), so saving,
// loading and API prompts behave normally. Grade and FX presets fill the sliders.

export const M = 14;        // side margin
const ROW_H = 26;    // slider row height
const HEAD_H = 26;   // extra height for a section header

export const C = {
  panel: "#2b2b2b", head: "#d4d4d4", rule: "#444444",
  label: "#9c9c9c", labelHot: "#ececec",
  track: "#4a4a4a", fill: "#8a8a8a", fillHot: "#d8d8d8",
  thumb: "#b0b0b0", thumbHot: "#ffffff", thumbEdge: "#1b1b1b",
  well: "#1d1d1d", wellEdge: "#3d3d3d", btn: "#383838",
};
export const FONT = "12px Inter, 'Segoe UI', sans-serif";

const HUE = ["#f00", "#ff0", "#0f0", "#0ff", "#00f", "#f0f", "#f00"];
const WARM = ["#3b7bd9", "#e8e8e8", "#e6b422"];
const TINT = ["#3fb06a", "#e8e8e8", "#c24fb0"];
const DEG = "\u00b0";

export const SPECS = {
  LightCraftDevelop: {
    exposure:    { head: "Light", label: "Exposure", dec: 2, step: 0.01 },
    contrast:    { label: "Contrast" },
    highlights:  { label: "Highlights" },
    shadows:     { label: "Shadows" },
    whites:      { label: "Whites" },
    blacks:      { label: "Blacks" },
    temperature: { head: "Color", label: "Temp", grad: WARM },
    tint:        { label: "Tint", grad: TINT },
    vibrance:    { label: "Vibrance" },
    saturation:  { label: "Saturation" },
    texture:     { head: "Detail", label: "Texture" },
    clarity:     { label: "Clarity" },
    dehaze:      { label: "Dehaze" },
  },
  LightCraftGrade: {
    strength:       { head: "Look", label: "Strength" },
    exposure:       { head: "Tone", label: "Exposure", dec: 2, step: 0.01 },
    contrast:       { label: "Contrast" },
    saturation:     { label: "Saturation" },
    vibrance:       { label: "Vibrance" },
    temperature:    { label: "Temp", grad: WARM },
    tint:           { label: "Tint", grad: TINT },
    fade:           { label: "Fade" },
    bw:             { label: "Black & white" },
    shadows_hue:    { head: "Color grading", label: "Shadows hue", grad: HUE, unit: DEG },
    shadows_sat:    { label: "Shadows sat" },
    midtones_hue:   { label: "Midtones hue", grad: HUE, unit: DEG },
    midtones_sat:   { label: "Midtones sat" },
    highlights_hue: { label: "Highlights hue", grad: HUE, unit: DEG },
    highlights_sat: { label: "Highlights sat" },
    grade_balance:  { label: "Balance" },
    grade_blending: { label: "Blending" },
  },
  LightCraftFX: {
    strength:             { head: "Filter", label: "Strength" },
    lens_distortion:      { head: "Lens", label: "Distortion" },
    chromatic_aberration: { label: "Chromatic aberration" },
    glow_amount:          { head: "Glow", label: "Glow" },
    glow_radius:          { label: "  Radius" },
    glow_threshold:       { label: "  Threshold" },
    halation:             { label: "Halation" },
    filter_contrast:      { head: "Filter colour", label: "Contrast" },
    filter_saturation:    { label: "Saturation" },
    filter_warmth:        { label: "Warmth", grad: WARM },
    filter_fade:          { label: "Fade" },
    tint_hue:             { label: "Wash hue", grad: HUE, unit: DEG },
    tint_amount:          { label: "Wash amount" },
    light_leak:           { label: "Light leak (seeded)" },
    sharpen:              { head: "Detail", label: "Sharpen" },
    vignette:             { head: "Vignette", label: "Amount" },
    vignette_midpoint:    { label: "  Midpoint" },
    vignette_feather:     { label: "  Feather" },
    tv_curve:             { head: "Old TV / CRT", label: "Curved glass" },
    tv_scanlines:         { label: "Scanlines" },
    tv_scan_size:         { label: "  Line thickness" },
    tv_mask:              { label: "Phosphor stripes" },
    tv_bleed:             { label: "Colour bleed" },
    tv_ghost:             { label: "Ghosting" },
    tv_noise:             { label: "Static" },
    tv_wobble:            { label: "Line wobble" },
    tv_dropouts:          { label: "Tape dropouts" },
    film_dust:            { head: "Film damage", label: "Dust & specks (seeded)" },
    film_scratches:       { label: "Scratches (seeded)" },
    ana_streak:           { head: "Anamorphic streaks", label: "Streaks" },
    ana_length:           { label: "  Length" },
    ana_threshold:        { label: "  Only lights above" },
    ana_blue:             { label: "  Blue tint" },
    bokeh_amount:         { head: "Bokeh (from highlights)", label: "Bokeh" },
    bokeh_size:           { label: "  Disc size" },
    bokeh_threshold:      { label: "  Only lights above" },
    bokeh_blades:         { label: "  Blades (0 = round)" },
    sort_amount:          { head: "Pixel sort", label: "Streak length" },
    sort_low:             { label: "  From brightness" },
    sort_high:            { label: "  To brightness" },
    sort_vertical:        { label: "  Vertical (0/1)" },
    sort_reverse:         { label: "  Reverse (0/1)" },
    comic_dots:           { head: "Comic / anime / Spider-Verse", label: "Halftone dots (shadows)" },
    comic_dot_size:       { label: "  Dot size" },
    comic_dot_angle:      { label: "  Dot angle" , unit: DEG },
    comic_dot_below:      { label: "  Dots below brightness" },
    comic_light_dots:     { label: "White dots (lights)" },
    comic_light_above:    { label: "  Dots above brightness" },
    comic_hatch:          { label: "Diagonal hatching (shadows)" },
    comic_hatch_density:  { label: "  Hatch density" },
    comic_offset:         { label: "Colour offset (print misregistration)" },
    comic_poster:         { label: "Flatten colours" },
    dirt_amount:          { head: "Lens dirt / bokeh overlay", label: "Overlay amount" },
    dirt_texture:         { label: "  Texture (1-7 built in, more = your own)" },
    dirt_threshold:       { label: "  Lights above" },
    dirt_spread:          { label: "  Glow spread" },
    dirt_scale:           { label: "  Scale" },
    dirt_rotate:          { label: "  Rotate", unit: DEG },
    dirt_colour:          { label: "  Keep texture colours" },
    dirt_hue_shift:       { label: "  Rotate texture colours", grad: HUE, unit: DEG },
    dirt_tint:            { label: "  Tint amount" },
    dirt_tint_hue:        { label: "  Tint hue", grad: HUE, unit: DEG },
    dirt_displace:        { label: "  Displace (refraction)" },
  },
  LightCraftLens: {
    strength:         { head: "Lens", label: "Strength" },
    lens_fisheye:     { head: "Shape", label: "Fisheye" },
    lens_bend:        { label: "Barrel \u2194 pincushion" },
    lens_zoom:        { label: "Zoom" },
    lens_circle:      { head: "Image circle", label: "Black circle" },
    lens_circle_soft: { label: "  Edge softness" },
    lens_fringe:      { head: "Glass", label: "Colour fringing" },
    lens_edge_blur:   { label: "Soft corners" },
    lens_falloff:     { label: "Dark corners" },
  },
  LightCraftGrain: {
    grain_amount:    { head: "Grain", label: "Amount" },
    grain_size:      { label: "Size" },
    grain_roughness: { label: "Roughness" },
    grain_color:     { label: "Colour grain" },
    grain_tonal:     { label: "Shadows \u2194 highlights" },
  },
};

// ---- preset data: server route first, static file as fallback
let PRESETS = {};
let NONE = "- none (neutral) -";
let SLIDERS = {};
const presetsReady = (async () => {
  let j = null;
  try {
    const r = await api.fetchApi("/lightcraft/presets");
    if (r.ok) j = await r.json();
  } catch (e) { /* fall through */ }
  if (!j) {
    try { j = await (await fetch(new URL("./presets.json", import.meta.url))).json(); }
    catch (e) { console.warn("[LightCraft] could not load presets", e); }
  }
  if (j) {
    PRESETS = j.presets || {};
    NONE = j.none || NONE;
    SLIDERS = j.sliders || {};
    console.info("[LightCraft] UI v2 loaded;", Object.keys(PRESETS).map((k) => `${k}: ${Object.keys(PRESETS[k]).length}`).join(", "));
  }
})();

export { presetsReady };
export const presetData = () => ({ presets: PRESETS, none: NONE, sliders: SLIDERS });

// ---- drawing helpers
export function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

export const rowHeight = (spec) => ROW_H + (spec.head ? HEAD_H : 0);

function formatValue(w, spec) {
  const v = w.value;
  let s = spec.dec ? Number(v).toFixed(spec.dec) : String(Math.round(v));
  if (w.options.min < 0 && v > 0) s = "+" + s;
  return s + (spec.unit || "");
}

export function drawSlider(ctx, node, w, spec, y) {
  const width = node.size[0];
  const { min, max } = w.options;
  const hot = Math.abs(w.value - w.__lcDefault) > 1e-9;
  let top = y;
  w.__lcY = y;

  ctx.save();
  if (spec.head) {
    ctx.fillStyle = C.head;
    ctx.font = "600 13px Inter, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(spec.head, M, y + 12);
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M, y + HEAD_H - 3.5);
    ctx.lineTo(width - M, y + HEAD_H - 3.5);
    ctx.stroke();
    top = y + HEAD_H;
  }

  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.fillStyle = hot ? C.labelHot : C.label;
  ctx.textAlign = "left";
  ctx.fillText(spec.label, M, top + 8);
  ctx.textAlign = "right";
  ctx.fillText(formatValue(w, spec), width - M, top + 8);

  const x0 = M, x1 = width - M, ty = top + ROW_H - 8;
  const f = (w.value - min) / (max - min);
  const px = x0 + Math.min(1, Math.max(0, f)) * (x1 - x0);
  ctx.lineCap = "round";
  ctx.lineWidth = 3;

  if (spec.grad) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    spec.grad.forEach((c, i) => g.addColorStop(i / (spec.grad.length - 1), c));
    ctx.strokeStyle = g;
    ctx.beginPath(); ctx.moveTo(x0, ty); ctx.lineTo(x1, ty); ctx.stroke();
  } else {
    ctx.strokeStyle = C.track;
    ctx.beginPath(); ctx.moveTo(x0, ty); ctx.lineTo(x1, ty); ctx.stroke();
    const bipolar = min < 0;
    const ox = bipolar ? x0 + ((0 - min) / (max - min)) * (x1 - x0) : x0;
    if (Math.abs(px - ox) > 0.5) {
      ctx.strokeStyle = hot ? C.fillHot : C.fill;
      ctx.beginPath(); ctx.moveTo(ox, ty); ctx.lineTo(px, ty); ctx.stroke();
    }
    if (bipolar) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#777";
      ctx.beginPath(); ctx.moveTo(ox, ty - 5); ctx.lineTo(ox, ty + 5); ctx.stroke();
    }
  }

  ctx.beginPath();
  ctx.arc(px, ty, 5, 0, Math.PI * 2);
  ctx.fillStyle = hot ? C.thumbHot : C.thumb;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.thumbEdge;
  ctx.stroke();
  ctx.restore();
}

function drawToggle(ctx, node, w, y) {
  const width = node.size[0];
  ctx.save();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.fillStyle = w.value ? C.labelHot : C.label;
  ctx.fillText(w.value ? "Enabled" : "Bypassed", M, y + 14);
  const sx = width - M - 34, sy = y + 6;
  rr(ctx, sx, sy, 34, 16, 8);
  ctx.fillStyle = w.value ? "#cfcfcf" : "#444";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(w.value ? sx + 26 : sx + 8, sy + 8, 6, 0, Math.PI * 2);
  ctx.fillStyle = w.value ? "#222" : "#888";
  ctx.fill();
  ctx.restore();
}

function drawCombo(ctx, node, w, y) {
  const width = node.size[0];
  ctx.save();
  rr(ctx, M, y + 4, width - 2 * M, 26, 5);
  ctx.fillStyle = C.well; ctx.fill();
  ctx.strokeStyle = C.wellEdge; ctx.lineWidth = 1; ctx.stroke();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.fillStyle = "#777";
  ctx.fillText("\u2039", M + 12, y + 16);
  ctx.fillText("\u203a", width - M - 12, y + 16);
  let t = String(w.value);
  const maxW = width - 2 * M - 56;
  if (ctx.measureText(t).width > maxW) {
    while (t.length > 3 && ctx.measureText(t + "\u2026").width > maxW) t = t.slice(0, -1);
    t += "\u2026";
  }
  ctx.fillStyle = w.value === NONE ? C.label : "#ececec";
  ctx.fillText(t, width / 2, y + 17);
  ctx.restore();
}

function drawSeed(ctx, node, w, y) {
  const width = node.size[0];
  ctx.save();
  rr(ctx, M, y + 4, width - 2 * M, 26, 5);
  ctx.fillStyle = C.well; ctx.fill();
  ctx.strokeStyle = C.wellEdge; ctx.lineWidth = 1; ctx.stroke();
  ctx.font = FONT; ctx.textBaseline = "middle";
  ctx.fillStyle = C.label; ctx.textAlign = "left";
  ctx.fillText("Seed", M + 28, y + 17);
  ctx.fillStyle = "#777"; ctx.textAlign = "center";
  ctx.fillText("\u2039", M + 12, y + 16);
  ctx.fillText("\u203a", width - M - 12, y + 16);
  ctx.fillStyle = "#ececec"; ctx.textAlign = "right";
  ctx.fillText(String(w.value), width - M - 28, y + 17);
  ctx.restore();
}

function drawButton(ctx, node, w, y) {
  const width = node.size[0];
  ctx.save();
  rr(ctx, M, y + 3, width - 2 * M, 24, 5);
  ctx.fillStyle = C.btn; ctx.fill();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.fillStyle = "#d0d0d0";
  ctx.fillText(w.name, width / 2, y + 15);
  ctx.restore();
}

export function fixedSize(w, h) {
  w.computeSize = (width) => [width, h];
  w.computeLayoutSize = () => ({ minHeight: h, maxHeight: h, minWidth: 0 });
}

export function setValue(node, w, spec, v) {
  const step = spec.step || 1;
  const { min, max } = w.options;
  v = Math.min(max, Math.max(min, v));
  v = Math.round(v / step) * step;
  v = Number(v.toFixed(spec.dec || 0));
  if (v !== w.value) w.value = v;       // callbacks fire once, on release (see sliderHit)
}

// Register a slider row as a mouse region. The thumb follows the pointer 1:1: the press jumps
// the value to the click position, then moves by (pointer delta / track length) * range.
// Alt+click types a value. opts.onChange(prevValue) runs on every change (live), opts.onDone on release.
export function sliderHit(node, w, spec, y, opts = {}) {
  hit(node, "slider:" + w.name, 0, y, node.size[0], rowHeight(spec), ({ ev, pos }) => {
    if (opts.resetOnDouble) {                      // double-click anywhere on the row (title or bar) = default
      const now = performance.now(), last = node.__lcLastDown;
      node.__lcLastDown = { id: w.name, t: now, x: ev.clientX, y: ev.clientY };
      if (last && last.id === w.name && now - last.t < 450 && Math.abs(last.x - ev.clientX) < 12 && Math.abs(last.y - ev.clientY) < 12) {
        node.__lcLastDown = null;
        const before = w.value;
        setValue(node, w, spec, w.__lcDefault);
        if (opts.onChange) opts.onChange(before);
        if (w.callback) { try { w.callback(w.value, app.canvas, node); } catch (e) { /* ignore */ } }
        if (opts.onDone) opts.onDone();
        node.setDirtyCanvas(true, true);
        return;
      }
    }
    if (ev.altKey) {
      app.canvas.prompt("Value", w.value, (v) => {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) { setValue(node, w, spec, n); node.setDirtyCanvas(true, true); if (opts.onDone) opts.onDone(); }
      }, ev);
      return;
    }
    const x0 = M, span = Math.max(1, node.size[0] - 2 * M);
    const { min, max } = w.options;
    const apply = (v) => {
      const before = w.value;
      setValue(node, w, spec, v);
      if (w.value !== before && opts.onChange) opts.onChange(before);
    };
    const base = min + Math.min(1, Math.max(0, (pos[0] - x0) / span)) * (max - min);
    apply(base);
    node.setDirtyCanvas(true, true);
    drag({
      node, ev, cursor: "ew-resize",
      onMove: (dx) => apply(base + (dx / span) * (max - min)),
      onUp: () => {
        if (w.callback) { try { w.callback(w.value, app.canvas, node); } catch (e) { /* ignore */ } }
        if (opts.onDone) opts.onDone();
      },
    });
  }, "ew-resize");
}

// ---- per-node setup
function setupNode(node, cls, specs) {
  if (node.__lcSetup) return;
  node.__lcSetup = true;

  const widgets = node.widgets || [];
  const sliders = widgets.filter((w) => specs[w.name]);
  const presetW = widgets.find((w) => w.name === "preset");
  const enabledW = widgets.find((w) => w.name === "enabled");
  const seedW = widgets.find((w) => w.name === "grain_seed");

  const setDefaults = (keepStrength) => {
    for (const w of sliders) {
      if (keepStrength && w.name === "strength") continue;
      setValue(node, w, specs[w.name], w.__lcDefault);
    }
  };

  // Fill the sliders from a preset. Waits for preset data if it hasn't arrived yet.
  const applyPreset = (value) => {
    presetW.__lcLast = value;
    presetsReady.then(() => {
      const table = (PRESETS[cls] || {})[value];
      setDefaults(true);                       // start clean so presets never stack
      if (table) {
        for (const w of sliders) {
          if (w.name in table) setValue(node, w, specs[w.name], table[w.name]);
        }
      } else if (value !== NONE) {
        console.warn("[LightCraft] no preset data for", cls, value);
      }
      node.setDirtyCanvas(true, true);
    });
  };

  // Belt and braces: the callback AND a per-frame watcher, so a preset change is never missed.
  const watchPreset = () => {
    if (!presetW) return;
    if (presetW.__lcLast === undefined) { presetW.__lcLast = presetW.value; return; }  // first frame / loaded workflow
    if (presetW.value !== presetW.__lcLast) applyPreset(presetW.value);
  };
  if (presetW) {
    const orig = presetW.callback;
    presetW.callback = function (value) {
      if (orig) { try { orig.apply(this, arguments); } catch (e) { /* ignore */ } }
      if (value !== presetW.__lcLast) applyPreset(value);
    };
  }

  for (const w of sliders) {
    const spec = specs[w.name];
    w.__lcDefault = w.value;
    fixedSize(w, rowHeight(spec));
    w.draw = function (ctx, n, _width, y) { watchPreset(); drawSlider(ctx, n, w, spec, y); sliderHit(n, w, spec, y); };
  }
  if (enabledW) { fixedSize(enabledW, 28); enabledW.draw = (ctx, n, _w, y) => drawToggle(ctx, n, enabledW, y); }
  if (seedW) { fixedSize(seedW, 34); seedW.draw = (ctx, n, _w, y) => drawSeed(ctx, n, seedW, y); }
  if (presetW) { fixedSize(presetW, 34); presetW.draw = (ctx, n, _w, y) => { watchPreset(); drawCombo(ctx, n, presetW, y); }; }

  if (presetW) {
    const btn = node.addWidget("button", "Reset all", null, () => {
      setDefaults(false);
      presetW.value = NONE;
      presetW.__lcLast = NONE;
      node.setDirtyCanvas(true, true);
    }, { serialize: false });
    fixedSize(btn, 32);
    btn.draw = (ctx, n, _w, y) => drawButton(ctx, n, btn, y);
  } else {
    const btn = node.addWidget("button", "Reset all", null, () => {
      setDefaults(false);
      node.setDirtyCanvas(true, true);
    }, { serialize: false });
    fixedSize(btn, 32);
    btn.draw = (ctx, n, _w, y) => drawButton(ctx, n, btn, y);
  }

  node.color = "#1e1e1e";
  node.bgcolor = C.panel;
  node.setSize([Math.max(340, node.size[0]), node.computeSize()[1]]);
}

app.registerExtension({
  name: "LightCraft.UI",
  nodeCreated(node) {
    const cls = node.comfyClass || node.type;
    const specs = SPECS[cls];
    if (!specs) return;
    try { setupNode(node, cls, specs); }
    catch (e) { console.error("[LightCraft] UI setup failed for", cls, e); }
  },
});
