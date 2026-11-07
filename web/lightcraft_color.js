import { app } from "../../scripts/app.js";
import { C, M, FONT, rr, drawSlider, fixedSize, rowHeight, sliderHit, setValue, SPECS, presetsReady, presetData } from "./lightcraft_ui.js";
import { hit } from "./lc_interact.js";
import { pickPreset } from "./lc_preset_picker.js";

// LightCraft Color: LUT (the Grade look), FX and Grain in one window. A Start page holds three quiet
// dropdowns; each section then has its own tab with the same dropdown and its sliders.
// Like the Crop & Compare panel it only writes normal node widgets.

const CLS = "LightCraftColor";
const TITLE_H = 26, TAB_H = 32, START_ROW = 44, DD_H = 40, MIN_W = 360;
const ORANGE = "#ff8a2a";

// section id -> where its widgets live. `from` is the original node whose presets / specs it reuses.
const SECTIONS = {
  lut:   { label: "LUT",   from: "LightCraftGrade", on: "look_on",  preset: "look_preset",  rename: { strength: "look_strength" } },
  fx:    { label: "FX",    from: "LightCraftFX",    on: "fx_on",    preset: "fx_preset",    rename: { strength: "fx_strength" } },
  grain: { label: "Grain", from: "LightCraftGrain", on: "grain_on", preset: "grain_preset", rename: {} },
  lens:  { label: "Lens",  from: "LightCraftLens",  on: "lens_on",  preset: "lens_preset",  rename: { strength: "lens_strength" } },
};
const TABS = [["start", "Start"], ["lut", "LUT"], ["fx", "FX"], ["grain", "Grain"], ["lens", "Lens"]];

const W = (node, name) => node.widgets.find((w) => w.name === name);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fitText(ctx, text, maxW) {
  let t = String(text);
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

function pickFromMenu(values, e, cb) {
  const LG = window.LiteGraph;
  if (LG && LG.ContextMenu) new LG.ContextMenu(values, { event: e, callback: cb });
  else cb(values[0]);
}

function button(ctx, node, id, x, y, w, h, text, on, fn) {
  rr(ctx, x, y, w, h, 5);
  ctx.fillStyle = on ? "#5a5a5a" : C.btn; ctx.fill();
  if (on) { ctx.strokeStyle = "#8c8c8c"; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = on ? "#ffffff" : "#d0d0d0";
  ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  hit(node, "ed:" + id, x, y, w, h, fn, "pointer");
}

// ---- section data (built once the node's widgets exist)
function sectionSliders(node, id) {
  const S = node.__lc;
  if (S.sliders[id]) return S.sliders[id];
  const sec = SECTIONS[id], specs = SPECS[sec.from] || {};
  const out = [];
  for (const [orig, spec] of Object.entries(specs)) {
    const name = sec.rename[orig] || orig;
    const w = W(node, name);
    if (w) out.push({ orig, name, w, spec });
  }
  return (S.sliders[id] = out);
}

const contentH = (node, tab) => {
  if (tab === "start") return Object.keys(SECTIONS).length * START_ROW + 62;
  return DD_H + sectionSliders(node, tab).reduce((a, s) => a + rowHeight(s.spec), 0) + 10 + (tab === "grain" ? 38 : 0);
};
const editH = (node) => TITLE_H + TAB_H + contentH(node, node.__lc.tab);

// ---- presets
function setDefaults(node, id, keepStrength) {
  for (const s of sectionSliders(node, id)) {
    if (keepStrength && s.orig === "strength") continue;
    setValue(node, s.w, s.spec, s.w.__lcDefault);
  }
}

function applyPreset(node, id, value) {
  const sec = SECTIONS[id];
  presetsReady.then(() => {
    const { presets, none } = presetData();
    const table = (presets[sec.from] || {})[value];
    setDefaults(node, id, true);                       // start clean so looks never stack
    if (table) {
      for (const s of sectionSliders(node, id)) if (s.orig in table) setValue(node, s.w, s.spec, table[s.orig]);
    } else if (value !== none) {
      console.warn("[LightCraft] no preset data for", sec.from, value);
    }
    if (app.graph && app.graph.change) app.graph.change();
    node.setDirtyCanvas(true, true);
  });
}

function setPreset(node, id, value) {
  const w = W(node, SECTIONS[id].preset);
  if (!w || w.value === value) return;
  w.value = value;
  if (w.callback) { try { w.callback(value, app.canvas, node); } catch (e) { /* ignore */ } }
  applyPreset(node, id, value);
}

function resetSection(node, id) {
  setDefaults(node, id, false);
  const w = W(node, SECTIONS[id].preset);
  if (w) w.value = presetData().none;
  if (app.graph && app.graph.change) app.graph.change();
  node.setDirtyCanvas(true, true);
}

// ---- small drawn controls
function drawDot(ctx, node, id, x, y, on, fn) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2);
  ctx.strokeStyle = on ? ORANGE : "#55555c"; ctx.lineWidth = 1.5; ctx.stroke();
  if (on) { ctx.beginPath(); ctx.arc(x, y, 2.8, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill(); }
  ctx.restore();
  hit(node, "ed:" + id, x - 10, y - 12, 20, 24, fn, "pointer");
}

// the dropdown: arrows step through the list, the middle opens the menu
function drawDropdown(ctx, node, id, x, y, w) {
  const sec = SECTIONS[id], pw = W(node, sec.preset), vals = pw.options.values, none = presetData().none;
  ctx.save();
  rr(ctx, x, y, w, 26, 5); ctx.fillStyle = C.well; ctx.fill();
  ctx.strokeStyle = C.wellEdge; ctx.lineWidth = 1; ctx.stroke();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.fillStyle = "#777"; ctx.fillText("‹", x + 10, y + 13); ctx.fillText("›", x + w - 10, y + 13);
  ctx.fillStyle = pw.value === none ? C.label : "#ececec";
  ctx.fillText(fitText(ctx, pw.value === none ? "None" : pw.value, w - 48), x + w / 2, y + 13.5);
  ctx.restore();
  hit(node, "ed:dd:" + id, x, y, w, 26, ({ ev, pos }) => {
    const i = Math.max(0, vals.indexOf(pw.value));
    if (pos[0] < x + 22) setPreset(node, id, vals[(i + vals.length - 1) % vals.length]);
    else if (pos[0] > x + w - 22) setPreset(node, id, vals[(i + 1) % vals.length]);
    else pickPreset({ event: ev, cls: SECTIONS[id].from, none, names: vals.filter((v) => v !== none), current: pw.value, onPick: (v) => setPreset(node, id, v) });
  }, "pointer");
}

function toggleOn(node, id) {
  const w = W(node, SECTIONS[id].on);
  w.value = !w.value;
  if (app.graph && app.graph.change) app.graph.change();
  node.setDirtyCanvas(true, true);
}

// ---- the editor
function drawEditor(ctx, node, y) {
  const S = node.__lc, width = node.size[0], reg = node.__lcHits;
  if (reg) for (const k of Array.from(reg.keys())) if (k.startsWith("ed:") || k.startsWith("slider:")) reg.delete(k);
  const tab = S.tab;
  hit(node, "ed:bg", 0, y, width, editH(node), () => {});

  ctx.save();
  ctx.fillStyle = C.head; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Color", M, y + 12);
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(M, y + TITLE_H - 3.5); ctx.lineTo(width - M, y + TITLE_H - 3.5); ctx.stroke();

  const ty0 = y + TITLE_H + 3, tabW = Math.min(78, (width - 2 * M - 5 * (TABS.length - 1)) / TABS.length);
  TABS.forEach(([id, label], i) => {
    const tx = M + i * (tabW + 5);
    button(ctx, node, "tab:" + id, tx, ty0, tabW, 24, label, tab === id, () => setTab(node, id));
    const sec = SECTIONS[id];                                                   // a dot says the section is doing something
    if (sec && W(node, sec.on).value && W(node, sec.preset).value !== presetData().none) {
      ctx.fillStyle = ORANGE; ctx.beginPath(); ctx.arc(tx + tabW - 10, ty0 + 7, 3, 0, Math.PI * 2); ctx.fill();
    }
  });

  const cy = y + TITLE_H + TAB_H;
  const done = () => { if (app.graph && app.graph.change) app.graph.change(); };
  if (tab === "start") {
    Object.keys(SECTIONS).forEach((id, i) => {
      const ry = cy + i * START_ROW + 8, on = !!W(node, SECTIONS[id].on).value;
      drawDot(ctx, node, "on:" + id, M + 8, ry + 13, on, () => toggleOn(node, id));
      ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = on ? "#ececec" : C.label;
      ctx.fillText(SECTIONS[id].label, M + 26, ry + 13);
      drawDropdown(ctx, node, id, M + 78, ry, width - 2 * M - 78);
    });
    const by = cy + Object.keys(SECTIONS).length * START_ROW + 12;
    ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = C.label;
    ctx.fillText("Pick a look here, fine-tune it in its tab.", M, by + 4);
    button(ctx, node, "resetall", width - M - 84, by - 8, 84, 24, "Reset all", false, () => {
      Object.keys(SECTIONS).forEach((id) => resetSection(node, id));
    });
  } else {
    const id = tab, sec = SECTIONS[id], on = !!W(node, sec.on).value;
    drawDot(ctx, node, "on:" + id, M + 8, cy + 13, on, () => toggleOn(node, id));
    drawDropdown(ctx, node, id, M + 26, cy, width - 2 * M - 26 - 58);
    button(ctx, node, "reset:" + id, width - M - 52, cy, 52, 26, "Reset", false, () => resetSection(node, id));
    let yy = cy + DD_H;
    for (const s of sectionSliders(node, id)) {
      drawSlider(ctx, node, s.w, s.spec, yy);
      sliderHit(node, s.w, s.spec, yy, { resetOnDouble: true, onDone: done });
      yy += rowHeight(s.spec);
    }
    if (id === "grain" || id === "fx") {                                       // the seed, as a quiet stepper
      const sw = W(node, "grain_seed");
      rr(ctx, M, yy + 6, width - 2 * M, 26, 5); ctx.fillStyle = C.well; ctx.fill();
      ctx.strokeStyle = C.wellEdge; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
      ctx.fillText(id === "fx" ? "Seed (leaks, dust)" : "Seed", M + 28, yy + 19);
      ctx.textAlign = "center"; ctx.fillStyle = "#777";
      ctx.fillText("‹", M + 12, yy + 18); ctx.fillText("›", width - M - 12, yy + 18);
      ctx.textAlign = "right"; ctx.fillStyle = "#ececec"; ctx.fillText(String(sw.value), width - M - 28, yy + 19);
      hit(node, "ed:seed", M, yy + 6, width - 2 * M, 26, ({ pos }) => {
        if (pos[0] < M + 26) sw.value = Math.max(0, Number(sw.value) - 1);
        else if (pos[0] > width - M - 26) sw.value = Number(sw.value) + 1;
        else app.canvas.prompt("Seed", sw.value, (v) => { const n = parseInt(v, 10); if (!Number.isNaN(n) && n >= 0) { sw.value = n; node.setDirtyCanvas(true, true); } }, null);
        done(); node.setDirtyCanvas(true, true);
      }, "pointer");
    }
  }
  ctx.restore();
}

function setTab(node, id) {
  node.__lc.tab = id;
  node.setSize([Math.max(MIN_W, node.size[0]), node.computeSize()[1]]);
  node.setDirtyCanvas(true, true);
}

function setupNode(node) {
  if (node.__lc) return;
  node.__lc = { tab: "start", sliders: {} };
  const first = W(node, "look_on");
  if (!first) return;
  for (const w of node.widgets) {
    if (w === first) continue;
    w.computeSize = () => [0, -4];
    w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
    w.draw = () => {};
  }
  for (const id of Object.keys(SECTIONS)) for (const s of sectionSliders(node, id)) s.w.__lcDefault = s.w.value;
  first.computeSize = (width) => [width, editH(node)];
  first.computeLayoutSize = () => ({ minHeight: editH(node), maxHeight: editH(node), minWidth: 0 });
  first.draw = (ctx, n, _w, y) => drawEditor(ctx, n, y);
  node.color = "#1e1e1e";
  node.bgcolor = C.panel;
  node.setSize([Math.max(MIN_W, node.size[0]), node.computeSize()[1]]);
}

app.registerExtension({
  name: "LightCraft.Color",
  nodeCreated(node) {
    if ((node.comfyClass || node.type) !== CLS) return;
    try { setupNode(node); }
    catch (e) { console.error("[LightCraft] Color setup failed", e); }
  },
});
