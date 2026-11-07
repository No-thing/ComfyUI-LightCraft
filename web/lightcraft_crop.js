import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { C, M, FONT, rr, drawSlider, fixedSize, rowHeight, sliderHit } from "./lightcraft_ui.js";
import { hit, drag, zoom, dropZone, wheelZone } from "./lc_interact.js";
import * as G from "./lc_crop_math.js";
import { colorPictures, colorOpenness, drawColorPanel, colorActive, COLOR_HIDDEN, CP_W, HIST_NARROW, COLOR_MIN_NODE_W, takeSnapshot, canSnapshot, snapshotCount } from "./lc_color_tab.js";
import { lockRoll, unlockRoll, rollLocked, rollAll } from "./lc_roll_lock.js";
import { DISPLAY, UI, loadBrandFonts } from "./lc_brand.js";
import { tabFont, loadSlab, drawTabTips, tipHide } from "./lc_tab_tips.js";
import { faceLivePicture, faceSliders, faceSetSliders, faceAutoRefresh, faceOpenness, drawFaceView, drawFacePanel, faceActive, FACE_HIDDEN, FACE_W, FACE_MIN_NODE_W } from "./lc_face_tab.js";
import { setRegionHistAdder } from "./lc_region_job.js";
import { FIN_W, FIN_MIN_NODE_W, drawFinishPanel, drawFinishGrid, drawFinishStrip, STRIP_H, drawFinishBar, drawFinishHead, finView, finKey, finishPictures, finRefresh, finOnExecuted, finOnError, finOnStatus, rewritePrompt, tempButton, finTipRects, finFrameStart, setDocOpener, setTabHook, finDocOpened, finBackToGrid, saveEditOnly, hasEdit, editSig } from "./lc_finish_tab.js";
import { driftFor, drawDrift, fmtMoved, DRIFT_COL } from "./lc_drift.js";
import { drawHistHelp, helpClick, helpReset, analysisFor, overlayFor, drawHistogram, drawCheckbox, percent, fmtPercent, CLIP_LO, CLIP_HI } from "./lc_scope.js";

// LightCraft Edit Page (compare, color, face, crop).
//  Tab 1 "Crop": a classic Lightroom crop - aspect-ratio buttons, an angle slider, drag the
//  corners / edges / box, drag outside the box to straighten, Reset. The crop never leaves the
//  picture and nothing is ever padded.
//  Tab 2 "Compare": before / after of the workflow. Before = what this node outputs; After = the
//  picture that reaches a Save / Preview node further down the graph (or the optional
//  compare_image input).
// The editor only writes normal node widgets, so saving, undo and API submission work as usual.

const CLS = "LightCraftCrop";
const TITLE_H = 26, TAB_H = 42, FILE_H = 34, VIEW_H = 470, ASP_H = 84, TOOL_H = 34;
const MAX_BOTTOM_H = 114;                      // the Crop tab has the most controls under the picture (aspect rows + angle)
const ANGLE_H = 30;                            // the Angle slider lives in the Crop tab only
const bottomH = (tab) => (tab === "crop" ? ASP_H + ANGLE_H : ASP_H);
// The node is always as tall as its fullest tab (Crop). Tabs with fewer controls give the space to the picture.
const BAR_H = 30;                              // the strip along the bottom: the settings cog lives here
const editH = () => TITLE_H + TAB_H + FILE_H + VIEW_H + MAX_BOTTOM_H + TOOL_H + BAR_H;
const viewH = (S) => VIEW_H + (MAX_BOTTOM_H - bottomH(S.tab)) + (S.extra || 0);
const GRAB = 12;          // grab radius in screen pixels, whatever the canvas zoom
const HEAD_H = 26;
const DEG = "°";
const OVERLAYS = ["thirds", "grid", "golden", "off"];
const HIDDEN = ["crop_aspect_ratio", "crop_x", "crop_y", "crop_width", "crop_height",
  "history_pick", ...COLOR_HIDDEN, "crop_src", ...FACE_HIDDEN,
  "pad_left", "pad_top", "pad_right", "pad_bottom", "outpaint_aspect", "constrain_crop", "keep_input_size"];

const ASPECT_ROWS = [["free", "original", "1:1", "2:3", "3:2"], ["3:4", "4:3", "9:16", "16:9", "21:9"]];
const ASPECT_LABEL = { free: "Free", original: "Original" };
const ASPECT_NAME = {
  "1:1": "Square", "2:3": "Portrait Photo", "3:2": "Photo", "3:4": "Portrait Standard",
  "4:3": "Standard", "9:16": "Portrait Widescreen", "16:9": "Widescreen", "21:9": "Ultrawide",
};
const CMP_MODES = [["split", "Split"], ["side", "Side by side"], ["before", "Before"], ["after", "After"]];

// visible rows after the editor
const DRAWER_WIDGETS = ["resize_to_megapixels", "megapixels", "resize_method", "resolution_steps"];
const ROWS = {
  rotation_degrees:     { kind: "slider", spec: { label: "Angle", dec: 2, step: 0.05, unit: DEG } },
  resize_to_megapixels: { kind: "check", label: "Resize to megapixels", head: "Output", h: 26 + HEAD_H },
  megapixels:           { kind: "slider", spec: { label: "Megapixels", dec: 2, step: 0.05 }, max: 16 },
  resize_method:        { kind: "combo", label: "Method", h: 32 },
  resolution_steps:     { kind: "slider", spec: { label: "Round to multiple of", step: 8 }, min: 8, max: 128 },
};

// ---------------------------------------------------------------- small helpers
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fitText(ctx, text, maxW) {
  let t = String(text);
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 2 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

function pickFromMenu(values, e, cb) {
  const LG = window.LiteGraph;
  if (LG && LG.ContextMenu) new LG.ContextMenu(values, { event: e, callback: cb });
  else cb(values[0]);
}

// ---------------------------------------------------------------- node state
function W(node, name) { return node.widgets.find((w) => w.name === name); }
function val(node, name) { const w = W(node, name); return w ? w.value : undefined; }
function put(node, name, v) { const w = W(node, name); if (w) w.value = v; }
const isLinked = (node, name) => !!(node.inputs && node.inputs.some((i) => i.name === name && i.link != null));

function srcState(node) {
  const S = node.__lc;
  const linked = isLinked(node, "image_in");
  const picking = !!val(node, "history_pick");
  const src = picking && S.pick ? S.pick : (linked ? S.linked : S.file);
  return { linked, ...(src || {}) };
}

// everything the crop editor needs, or null when no picture is available yet
function readState(node) {
  const s = srcState(node);
  if (!s.img || !s.w) return null;
  const w1 = s.w, h1 = s.h;
  const angle = val(node, "rotation_degrees") || 0;
  const aspectName = val(node, "crop_aspect_ratio") || "original";
  const aspect = G.aspectValue(aspectName, w1, h1);
  const raw = [val(node, "crop_x"), val(node, "crop_y"), val(node, "crop_width"), val(node, "crop_height")];
  const cs = val(node, "crop_src");                                     // the picture size the hand-made crop belongs to
  const stale = !!cs && cs !== `${w1}x${h1}`;                          // a different (bigger / smaller) picture arrived: start from the full frame again
  const explicit = raw[2] > 0 && raw[3] > 0 && !stale;
  const constrain = !!val(node, "constrain_crop");                      // on: classic crop that stays inside the picture; off: turning / padding leaves gaps that outpaint fills
  const pads = constrain || stale ? [0, 0, 0, 0] : PAD_NAMES.map((n) => Math.max(0, Math.round(val(node, n) || 0)));
  const [w2, h2] = G.canvasSize(w1, h1, angle), [W3, H3] = G.paddedSize(w1, h1, angle, pads);
  const crop = explicit ? raw : G.autoCrop(w1, h1, angle, aspect, constrain, pads);
  const cropU = [crop[0] - pads[0], crop[1] - pads[1], crop[2], crop[3]];      // the same rectangle on the unpadded canvas (the picture's own)
  const oAspectName = val(node, "outpaint_aspect") || "original";
  return { s, w1, h1, angle, aspectName, aspect, explicit, crop, cropU, constrain, pads, w2, h2, W3, H3,
           oAspectName, oAspect: G.aspectValue(oAspectName, w1, h1), padded: pads.some((v) => v > 0) };
}
const PAD_NAMES = ["pad_left", "pad_top", "pad_right", "pad_bottom"];

// the crop stays on picture pixels when "Fill gaps" is off, otherwise anywhere on the (padded) canvas: gray gaps get painted
const okFn = (st, angle = st.angle) => (r) => {
  if (r[2] < 8 || r[3] < 8) return false;
  if (st.constrain) return G.insidePicture(r, st.w1, st.h1, angle);
  const [W3, H3] = G.paddedSize(st.w1, st.h1, angle, st.pads);
  return r[0] >= -0.5 && r[1] >= -0.5 && r[0] + r[2] <= W3 + 0.5 && r[1] + r[3] <= H3 + 0.5;
};

function writeCrop(node, r) {
  const s0 = srcState(node);
  put(node, "crop_src", s0 && s0.w ? `${s0.w}x${s0.h}` : "");
  put(node, "crop_x", Math.max(0, Math.round(r[0])));
  put(node, "crop_y", Math.max(0, Math.round(r[1])));
  put(node, "crop_width", Math.max(1, Math.round(r[2])));
  put(node, "crop_height", Math.max(1, Math.round(r[3])));
}
function autoCropWidgets(node) { ["crop_x", "crop_y", "crop_width", "crop_height"].forEach((n) => put(node, n, 0)); put(node, "crop_src", ""); }
function resetPads(node) { PAD_NAMES.forEach((n) => put(node, n, 0)); }

const near = (a, b, t = 2) => a.every((v, i) => Math.abs(v - b[i]) <= t);

// The angle changed (slider or rotate-drag). The crop keeps the SHAPE it has:
//  - a locked aspect stays exactly that aspect;
//  - an auto-fitted crop regrows/shrinks to the largest rectangle of the same shape;
//  - a crop the user sized by hand keeps its size and position and only shrinks if it no longer fits.
function refitCrop(node, prevAngle) {
  const S = node.__lc, st = readState(node);
  const angle = val(node, "rotation_degrees") || 0;
  S.lastAngle = angle;
  if (!st || Math.abs(angle - prevAngle) < 1e-9) return;
  const ac = (ang, asp) => G.autoCrop(st.w1, st.h1, ang, asp, st.constrain, st.pads);
  if (Math.abs(prevAngle) < 1e-9 && !st.constrain && readState(node)) ensureLock(node);          // turning leaves gaps that Qwen will paint: keep the roll that made this picture
  const prevCrop = st.explicit ? st.crop : ac(prevAngle, st.aspect);
  let ratio = st.aspect;
  if (!ratio) {
    ratio = prevCrop[2] / prevCrop[3];
    if (S.fitRatio && near(prevCrop, ac(prevAngle, S.fitRatio), 3)) ratio = S.fitRatio;
  }
  const wasFitted = !st.explicit || near(prevCrop, ac(prevAngle, ratio), 3);
  if (wasFitted) {
    if (st.aspect) autoCropWidgets(node);              // locked: the automatic crop already has that aspect
    else { writeCrop(node, ac(angle, ratio)); S.fitRatio = ratio; }
    return;
  }
  const [pw, ph] = G.paddedSize(st.w1, st.h1, prevAngle, st.pads);
  const [nw, nh] = G.paddedSize(st.w1, st.h1, angle, st.pads);
  const ox = st.crop[0] + st.crop[2] / 2 - pw / 2, oy = st.crop[1] + st.crop[3] / 2 - ph / 2;
  let r = [nw / 2 + ox - st.crop[2] / 2, nh / 2 + oy - st.crop[3] / 2, st.crop[2], st.crop[3]];
  r = G.shrinkToFit(r, okFn(st));
  if (r[2] < 8 || r[3] < 8) autoCropWidgets(node); else writeCrop(node, r);
}

// ---------------------------------------------------------------- picture loading
function viewUrl(name, type) {
  let sub = "", file = name;
  const i = name.lastIndexOf("/");
  if (i >= 0) { sub = name.slice(0, i); file = name.slice(i + 1); }
  return api.apiURL(`/view?filename=${encodeURIComponent(file)}&type=${type}&subfolder=${encodeURIComponent(sub)}&r=${Date.now()}`);
}
function imgUrl(info) {
  return api.apiURL(`/view?filename=${encodeURIComponent(info.filename)}&type=${info.type || "temp"}` +
    `&subfolder=${encodeURIComponent(info.subfolder || "")}&r=${Date.now()}`);
}

// a view-sized copy: redrawing a 4000 px picture every frame while dragging is what made it laggy
function makeThumb(img) {
  try {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const k = Math.min(1, 2048 / Math.max(w, h));
    if (!(k < 1)) return img;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  } catch (e) { return img; }
}

// the picture to draw: the full-resolution file whenever the screen can show more than the thumbnail holds
function viewImg(node, s, shownW) {
  if (node.__lcDragging || !s.full || s.full === s.img) return s.img;
  const zoom = (app.canvas && app.canvas.ds && app.canvas.ds.scale) || 1, dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  return shownW * zoom * dpr > (s.img.width || 0) * 0.9 ? s.full : s.img;
}

function loadInto(node, slot, url, dims, tag, full, onFail) {
  const img = new Image();
  img.onload = () => {
    const thumb = full ? img : makeThumb(img);          // thumb: cheap to redraw while dragging; full: used when you zoom in or rest
    node.__lc[slot] = { img: thumb, full: img, w: dims ? dims[0] : img.naturalWidth, h: dims ? dims[1] : img.naturalHeight, tag };
    node.setDirtyCanvas(true, true);
  };
  img.onerror = () => {
    if (onFail && !img.__retried) { img.__retried = true; img.src = url + "&retry=1"; return; }          // one more try before giving up
    if (onFail) { console.error("[LightCraft] could not load the History picture:", url); onFail(); }
    else node.__lc[slot] = null;
    node.setDirtyCanvas(true, true);
  };
  img.src = url;
}

// called from draw: follows the image widget no matter how its value changed
function syncFile(node) {
  const S = node.__lc, name = val(node, "image");
  if (S.loadedName === name) return;
  const first = S.loadedName === undefined;
  S.loadedName = name;
  S.file = null;
  if (!first) {                       // a different picture: start the crop fresh
    autoCropWidgets(node); resetPads(node);
    put(node, "rotation_degrees", 0);
    S.lastAngle = 0; S.fitRatio = null;
  }
  if (name && name !== "none") loadInto(node, "file", viewUrl(name, "input"), null, name);
}

function openPicker(node) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const body = new FormData();
      body.append("image", f);
      body.append("type", "input");
      body.append("overwrite", "true");
      const r = await api.fetchApi("/upload/image", { method: "POST", body });
      const j = await r.json();
      const name = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
      const w = W(node, "image");
      if (w.options && Array.isArray(w.options.values) && !w.options.values.includes(name)) w.options.values.push(name);
      node.__lc.loadedName = null;          // force a fresh reload (and crop reset) even for an overwritten name
      w.value = name;
      node.setDirtyCanvas(true, true);
    } catch (e) { console.error("[LightCraft] upload failed", e); }
  };
  inp.click();
}

// every node reachable from this node's outputs
function downstreamIds(node) {
  const seen = new Set(), stack = [node];
  while (stack.length) {
    const n = stack.pop();
    (n.outputs || []).forEach((_, i) => {
      const list = n.getOutputNodes ? n.getOutputNodes(i) : [];
      (list || []).forEach((t) => { if (!seen.has(String(t.id))) { seen.add(String(t.id)); stack.push(t); } });
    });
  }
  return seen;
}

// A node cannot take its own downstream result as an input (that would be a loop), so the panel
// listens for results arriving at the Save / Preview nodes after it.
function onExecutedEvent(ev) {
  const d = ev && ev.detail;
  const images = d && d.output && d.output.images;
  if (!images || !images.length || !app.graph) return;
  for (const n of app.graph._nodes || []) {
    if ((n.comfyClass || n.type) !== CLS || !n.__lc || isLinked(n, "compare_image")) continue;
    if (downstreamIds(n).has(String(d.node))) loadInto(n, "after", imgUrl(images[0]), null, images[0].filename, true);
  }
}

// ---------------------------------------------------------------- drawing helpers
function viewMap(node, st, vx, vy, vw, vh) {
  const S = node.__lc, w2 = st.W3, h2 = st.H3, m = 14, k = st.constrain ? 1 : 1.3;      // room around the canvas for the orange dots
  if (S.frozen) { const s = S.frozen.s; return { s, ox: S.frozen.oxU - st.pads[0] * s, oy: S.frozen.oyU - st.pads[1] * s, w2, h2 }; }
  const s = Math.min((vw - 2 * m) / (w2 * k), (vh - 2 * m) / (h2 * k));
  return { s, ox: vx + (vw - w2 * s) / 2, oy: vy + (vh - h2 * s) / 2, w2, h2 };
}

function drawOverlay(ctx, mode, x, y, w, h) {
  if (mode === "off") return;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.38)";
  ctx.lineWidth = 1;
  let xs = [], ys = [];
  if (mode === "thirds") { xs = [1 / 3, 2 / 3]; ys = [1 / 3, 2 / 3]; }
  else if (mode === "golden") { xs = [0.382, 0.618]; ys = [0.382, 0.618]; }
  else {
    const nx = clamp(Math.round(w / 36), 4, 14), ny = clamp(Math.round(h / 36), 4, 14);
    for (let i = 1; i < nx; i++) xs.push(i / nx);
    for (let i = 1; i < ny; i++) ys.push(i / ny);
  }
  ctx.beginPath();
  xs.forEach((f) => { ctx.moveTo(Math.round(x + w * f) + 0.5, y); ctx.lineTo(Math.round(x + w * f) + 0.5, y + h); });
  ys.forEach((f) => { ctx.moveTo(x, Math.round(y + h * f) + 0.5); ctx.lineTo(x + w, Math.round(y + h * f) + 0.5); });
  ctx.stroke();
  ctx.restore();
}

function drawHandles(ctx, x, y, w, h, hot, col) {
  ctx.save();
  ctx.lineCap = "butt";
  const L = Math.min(22, w / 3, h / 3), bar = Math.min(15, w / 5, h / 5);
  const line = (zone, pts) => {
    const on = hot === zone;
    ctx.strokeStyle = on ? "#ffffff" : (col || "#e2e2e2");
    ctx.lineWidth = on ? 4.5 : 3;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
  };
  line("tl", [[x, y + L], [x, y], [x + L, y]]);
  line("tr", [[x + w - L, y], [x + w, y], [x + w, y + L]]);
  line("bl", [[x, y + h - L], [x, y + h], [x + L, y + h]]);
  line("br", [[x + w - L, y + h], [x + w, y + h], [x + w, y + h - L]]);
  line("t", [[x + w / 2 - bar, y], [x + w / 2 + bar, y]]);
  line("b", [[x + w / 2 - bar, y + h], [x + w / 2 + bar, y + h]]);
  line("l", [[x, y + h / 2 - bar], [x, y + h / 2 + bar]]);
  line("r", [[x + w, y + h / 2 - bar], [x + w, y + h / 2 + bar]]);
  ctx.restore();
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

const fitInto = (w, h, x, y, bw, bh) => {
  const k = Math.min(bw / w, bh / h), rw = w * k, rh = h * k;
  return [x + (bw - rw) / 2, y + (bh - rh) / 2, rw, rh];
};

function pill(ctx, text, x, y, right) {
  ctx.save();
  ctx.font = FONT;
  const tw = ctx.measureText(text).width + 14, px = right ? x - tw : x;
  rr(ctx, px, y, tw, 18, 9); ctx.fillStyle = "rgba(0,0,0,0.62)"; ctx.fill();
  ctx.fillStyle = "#ececec"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, px + tw / 2, y + 9.5);
  ctx.restore();
}

// ---------------------------------------------------------------- the compare view
function drawCompare(ctx, node, vx, vy, vw, vh) {
  const S = node.__lc, A = S.before, B = S.after, m = 10;
  S.cmp = null;
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.fillStyle = C.label;
  if (!A && !B) {
    const lines = ["Run the workflow once.", "Before = what this node outputs.",
                   "After = the picture that reaches a Save / Preview node", "further down, or the compare_image input."];
    lines.forEach((t, i) => ctx.fillText(t, vx + vw / 2, vy + vh / 2 - 27 + i * 18));
    return;
  }
  ctx.imageSmoothingQuality = "high";
  const ref = A || B;
  const clipLo = !!props(node).lc_clip_lo, clipHi = !!props(node).lc_clip_hi;
  const driftOn = !!props(node).lc_drift && A && B, drift = driftOn ? driftFor(A.img, B.img) : null;
  const draw = (P, r) => {
    if (P) {
      ctx.drawImage(P.img, r[0], r[1], r[2], r[3]);
      if (clipLo || clipHi) { const o = overlayFor(P.img, clipLo, clipHi); if (o) ctx.drawImage(o, r[0], r[1], r[2], r[3]); }   // blue = crushed blacks, red = blown whites
      if (drift && (P === B || P === S.__dB)) { drawDrift(ctx, drift, r); pill(ctx, fmtMoved(drift.pct), r[0] + r[2] - 6, r[1] + r[3] - 24, true); }   // red = pixels that moved between Before and After
      return;
    }
    ctx.fillStyle = "#1d1d1d"; ctx.fillRect(r[0], r[1], r[2], r[3]);
    ctx.fillStyle = C.label; ctx.textAlign = "center"; ctx.fillText(S.cmpMissing || "not available yet", r[0] + r[2] / 2, r[1] + r[3] / 2);
  };
  // only one of the two pictures exists (not upscaled yet, or no Before): show that one full size instead of an empty half
  const both = !!(A && B), mode = both ? S.cmpMode : (A ? "before" : "after");
  const single = both ? "" : (S.cmpMissing && S.cmpMissing !== "loading…" ? " · " + S.cmpMissing : (S.cmpMissing ? " · " + S.cmpMissing : ""));
  // the real pixel sizes, written above the pictures (Upscale tab)
  const dimTxt = (t, P) => (P && P.dim ? `${t}  ${P.dim[0]} × ${P.dim[1]}` : t);
  const dimHead = (cx, cy, text, col) => { ctx.save(); ctx.font = "11.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = col || "#bdbdc4"; ctx.fillText(text, cx, cy); ctx.restore(); };
  if (S.cmpDims && mode !== "side") { vy += 20; vh -= 20; }
  if (S.cmpDims && mode !== "side") {
    const k = A && B && A.dim && B.dim ? B.dim[0] / A.dim[0] : 0;
    const t = [A && A.dim ? dimTxt("Before", A) : "", B && B.dim ? dimTxt("After", B) : ""].filter(Boolean).join("   →   ") + (k > 1.01 ? `   (${k.toFixed(2).replace(/\.?0+$/, "")}×)` : "");
    if (t) dimHead(vx + vw / 2, vy - 10, t);
  }
  if (mode === "side") {
    const hw = (vw - 3 * m) / 2, top = vy + m + 18, bh = vh - 2 * m - 18;
    const r1 = fitInto((A || ref).w, (A || ref).h, vx + m, top, hw, bh);
    const r2 = fitInto((B || ref).w, (B || ref).h, vx + 2 * m + hw, top, hw, bh);
    draw(A, r1); draw(B, r2);
    if (S.cmpDims) { if (A && A.dim) dimHead(r1[0] + r1[2] / 2, vy + m + 8, dimTxt("Before", A)); if (B && B.dim) dimHead(r2[0] + r2[2] / 2, vy + m + 8, dimTxt("After", B)); }
    pill(ctx, "Before", r1[0] + 6, r1[1] + 6); pill(ctx, "After", r2[0] + 6, r2[1] + 6);
    S.cmp = { mode, r: r1 };
    return;
  }
  const r = fitInto(ref.w, ref.h, vx + m, vy + m, vw - 2 * m, vh - 2 * m);
  // zoom: wheel over the picture zooms toward the pointer, up to the real pixels (and past); drag pans. The full-size picture is fetched only while zoomed.
  const realW = (ref.dim && ref.dim[0]) || ref.w, z100 = Math.max(1, realW / r[2]), zMax = Math.max(3, z100 * 2);
  S.cmpZ = clamp(S.cmpZ || 1, 1, zMax);
  const Z = S.cmpZ, pan = S.cmpPan || (S.cmpPan = [0.5, 0.5]);
  pan[0] = clamp(pan[0], 0, 1); pan[1] = clamp(pan[1], 0, 1);
  const R = Z > 1.001 ? [r[0] + r[2] / 2 - pan[0] * r[2] * Z, r[1] + r[3] / 2 - pan[1] * r[3] * Z, r[2] * Z, r[3] * Z] : r;   // where the picture is drawn
  const hi = (P) => (P && Z > 1.15 && P.hiFn && P.hiFn()) || P;                                                                // the full-size file once zoomed in
  const dA = hi(A), dB = hi(B); S.__dB = dB;
  S.cmp = { mode, r, both, z: Z, R, z100 };
  wheelZone(node, "cmp:wheel", r[0], r[1], r[2], r[3], (dy, at) => {
    const z0 = S.cmpZ || 1, z1 = clamp(z0 * (dy < 0 ? 1.25 : 0.8), 1, zMax);
    if (z1 === z0) return;
    const R0 = S.cmp.R, px = at[0], py = at[1];
    const fx = (px - R0[0]) / R0[2], fy = (py - R0[1]) / R0[3];                 // the point under the pointer stays under it
    S.cmpZ = z1 < 1.02 ? 1 : z1;
    if (S.cmpZ === 1) S.cmpPan = [0.5, 0.5];
    else S.cmpPan = [clamp(fx - (px - (r[0] + r[2] / 2)) / (r[2] * z1), 0, 1), clamp(fy - (py - (r[1] + r[3] / 2)) / (r[3] * z1), 0, 1)];
    node.setDirtyCanvas(true, true);
  });
  const drawZ = (P, Pd) => { ctx.save(); ctx.beginPath(); ctx.rect(r[0], r[1], r[2], r[3]); ctx.clip(); ctx.imageSmoothingQuality = "high"; draw(Pd || P, R); ctx.restore(); };
  if (Z > 1.001) { pill(ctx, Z >= z100 * 0.98 && Z <= z100 * 1.02 ? "100%" : Math.round(Z / z100 * 100) + "%", r[0] + r[2] - 6, r[1] + r[3] - 6, true); }
  if (mode === "split") {
    const dx = r[0] + r[2] * S.split;
    ctx.save(); ctx.beginPath(); ctx.rect(r[0], r[1], dx - r[0], r[3]); ctx.clip(); drawZ(A, dA); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(dx, r[1], r[0] + r[2] - dx, r[3]); ctx.clip(); drawZ(B, dB); ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(dx, r[1]); ctx.lineTo(dx, r[1] + r[3]); ctx.stroke();
    const ky = r[1] + r[3] / 2;
    ctx.beginPath(); ctx.arc(dx, ky, 11, 0, Math.PI * 2); ctx.fillStyle = "#2a2a2a"; ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("↔", dx, ky + 0.5);
    if (dx - r[0] > 54) pill(ctx, "Before", r[0] + 6, r[1] + 6);
    if (r[0] + r[2] - dx > 54) pill(ctx, "After", r[0] + r[2] - 6, r[1] + 6, true);
  } else if (mode === "before") { drawZ(A, dA); pill(ctx, "Before" + single, r[0] + 6, r[1] + 6); }
  else { drawZ(B, dB); pill(ctx, "After" + single, r[0] + 6, r[1] + 6); }
}

function cmpDown(node, { ev, pos }) {
  const S = node.__lc, c = S.cmp;
  if (!c) return;
  const dxLine = c.mode === "split" ? c.r[0] + c.r[2] * S.split : 0;
  if (c.z > 1.001 && !(c.mode === "split" && Math.abs(pos[0] - dxLine) < 16)) {                       // zoomed in: dragging moves the picture (the divider is still grabbed by its line)
    const p0 = (S.cmpPan || [0.5, 0.5]).slice();
    drag({ node, ev, cursor: "grabbing", onMove: (dx, dy) => {
      S.cmpPan = [clamp(p0[0] - dx / (c.r[2] * c.z), 0, 1), clamp(p0[1] - dy / (c.r[3] * c.z), 0, 1)];
      node.setDirtyCanvas(true, true);
    } });
    return;
  }
  if (c.mode === "split") {
    const rx = c.r[0], rw = c.r[2];
    const set = (px) => { S.split = clamp((px - rx) / rw, 0, 1); };
    set(pos[0]);
    node.setDirtyCanvas(true, true);
    drag({ node, ev, cursor: "ew-resize", onMove: (dx) => set(pos[0] + dx) });
  } else if ((c.mode === "before" || c.mode === "after") && c.both) {      // click to flip between the two (only when both exist)
    S.cmpMode = c.mode === "before" ? "after" : "before";
    node.setDirtyCanvas(true, true);
  }
}

// ---------------------------------------------------------------- the editor widget
const TABS = [["compare", "Auto"], ["browse", "Browse"], ["crop", "Crop"], ["face", "Face"], ["color", "Color"], ["finish", "Skin pass"]];
const finT = (t) => t === "finish" || t === "browse";       // both show the saved-pictures browser
const EDIT_SUBS = TABS.slice(1);
const CREAM_FULL = "#f3ead8";
const PANEL_MIN_W = 780;
const HIST_MAX = 12, PANEL_W = 178, PANEL_GAP = 8, HIST_ROW = 38;


// ---- auto snapshot: leaving the Face or Crop tab with something changed bakes it into a History picture, and the tabs carry on from it
async function bakePending(node) {
  const S = node.__lc;
  if (S.baking) return;
  const st = readState(node);
  const tag = st && st.s && st.s.tag;
  if (!st || !tag || !isLinked(node, "image_in") && !val(node, "image")) return;
  const faceAct = faceActive(node);
  const cropWant = !st.padded && (Math.abs(st.angle) > 1e-6 || st.explicit || !["original", "free"].includes(st.aspectName));
  if (!faceAct && !cropWant) return;
  const params = { rotation_degrees: st.angle, crop_aspect_ratio: st.aspectName, constrain_crop: st.constrain, crop_x: st.explicit ? st.crop[0] : 0, crop_y: st.explicit ? st.crop[1] : 0,
                   crop_width: st.explicit ? st.crop[2] : 0, crop_height: st.explicit ? st.crop[3] : 0 };
  const face_data = val(node, "face_data"), snap = JSON.stringify([face_data, params, val(node, "history_pick")]);
  const body = { file: tag, type: /^lc_(src|hist)_/.test(String(tag)) ? "temp" : "input", face_data: faceAct ? face_data : "{}", crop: cropWant, params };
  S.baking = true; S.bakeFail = false; node.setDirtyCanvas(true, true);
  try {
    const r = await api.fetchApi("/lightcraft/bake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j || !j.baked || !j.baked.length || !j.file) { S.bakeFail = true; return; }
    const now = readState(node);
    const cur = JSON.stringify([val(node, "face_data"), { rotation_degrees: now ? now.angle : 0, crop_aspect_ratio: now ? now.aspectName : "", constrain_crop: now ? now.constrain : false, crop_x: now && now.explicit ? now.crop[0] : 0, crop_y: now && now.explicit ? now.crop[1] : 0,
                   crop_width: now && now.explicit ? now.crop[2] : 0, crop_height: now && now.explicit ? now.crop[3] : 0 }, val(node, "history_pick")]);
    if (cur !== snap) { S.bakeFail = true; return; }                  // you changed something while it was baking: that result no longer fits
    const note = j.baked.map((x) => x[0].toUpperCase() + x.slice(1)).join(" + ");
    const e = { f: j.file, type: j.type || "temp", w: j.w, h: j.h, t: Date.now(), label: "Edit", note };
    if (j.baked.length === 1 && j.baked[0] === "face") e.reopen = { parent: String(val(node, "history_pick") || ""), sliders: faceSliders(node) };       // the Face tab can take this back to sliders
    histAdd(node, e);
    pickHistory(node, e, { keepCrop: !j.baked.includes("crop"), keepFace: !j.baked.includes("face") });
  } catch (err) {
    console.error("[LightCraft] could not snapshot your edit:", err); S.bakeFail = true;
  } finally {
    S.baking = false; node.setDirtyCanvas(true, true);
  }
}

// Coming back to the Face tab on a picture that the tab itself baked: go back to the picture before the bake and give the sliders their values,
// so you see (and can fine-tune) what you did instead of default sliders on an already reshaped picture. Leaving the tab bakes again.
function reopenFace(node) {
  try {
    const h = histList(node), cur = props(node).lc_hist_cur, e = h.find((x) => x.f === cur);
    if (!e || !e.reopen || Object.values(faceSliders(node) || {}).some((v) => Math.abs(v) > 1e-6)) return;
    const m = /::([^\s\[]+)\s*\[/.exec(e.reopen.parent) || /^([^\s\[:]+)\s*\[/.exec(e.reopen.parent);
    const parent = m ? h.find((x) => x.f === m[1]) : h.find((x) => x.label === "Source");
    if (!parent) return;
    pickHistory(node, parent, { keepCrop: true, keepFace: true });
    faceSetSliders(node, e.reopen.sliders);
    node.__lcFace && (node.__lcFace.tried = null);
  } catch (err) { console.error("[LightCraft] could not reopen the Face edit:", err); }
}

// The files of the edit in progress: the pinned Source, the state you are on, every picture a tab is showing, the roll it came from
function tempKeep(node) {
  const p = props(node), S = node.__lc || {}, k = new Set();
  const all = histList(node), src = all.find((e) => e.label === "Source");
  if (src) k.add(src.f);
  if (p.lc_hist_cur) k.add(p.lc_hist_cur);
  if (p.lc_origin) k.add(p.lc_origin);
  Object.values(S).forEach((v) => { if (v && typeof v === "object" && typeof v.tag === "string") k.add(v.tag); });
  const m = /::([^\s\[]+)/.exec(String(val(node, "history_pick") || "")); if (m) k.add(m[1]);
  return k;
}
function clearTemp(node, keep) {                 // after TEMP decimate: History rows whose picture is gone disappear; the edit in progress stays
  const p = props(node), S = node.__lc, k = keep || tempKeep(node);
  p.lc_history = histList(node).filter((e) => k.has(e.f));
  if (!p.lc_history.some((e) => e.f === p.lc_hist_cur)) p.lc_hist_cur = (p.lc_history[p.lc_history.length - 1] || {}).f || null;
  S.thumbs = {}; S.pick = null;
  node.setDirtyCanvas(true, true);
}

function setTab(node, id) {
  const S = node.__lc, prev = S.tab;
  if ((prev === "face" || prev === "crop") && id !== prev) bakePending(node);               // done with that tab: keep what you made
  S.tab = id;
  if (id === "face" && prev !== "face") reopenFace(node);
  if (finT(id) && !finT(prev)) finRefresh(node);              // the Upscale tab looks at the saved folder
  if (id !== "compare" && (readState(node) || finT(id))) lockRoll();                       // Color, Face and Crop all edit THIS picture: the roulette dice stop on the roll that made it (a no-op if already locked)
  else if (id === "compare" && prev !== "compare") unlockRoll();             // the Compare tab is for new rolls again
  const d = 0;                                   // the node keeps its size on every tab
  const wNeed = id === "color" ? Math.max(node.size[0], COLOR_MIN_NODE_W)
    : id === "face" ? Math.max(node.size[0], FACE_MIN_NODE_W)
    : finT(id) ? Math.max(node.size[0], FIN_MIN_NODE_W)
    : panelOpen(node) ? Math.max(node.size[0], PANEL_MIN_W) : node.size[0];       // room for the History panel (and the Color panel)
  if (d || wNeed !== node.size[0]) node.setSize([wNeed, node.size[1] + d]);   // the picture keeps its size
  node.setDirtyCanvas(true, true);
}
// Browse -> Edit: any saved picture becomes the document. Layer 0 is a lossless copy of it; the saved file is never changed.
function openDocument(node, x) {
  const S = node.__lc, p = props(node);
  p.lc_doc = x.rel; p.lc_doc_name = x.name || x.rel;
  p.lc_history = []; p.lc_hist_cur = null; p.lc_origin = undefined; S.thumbs = {}; S.pick = null;
  put(node, "history_pick", `open::${x.rel} [output]`);
  put(node, "face_data", "{}"); put(node, "color_data", "{}"); put(node, "crop_src", "");
  try { autoCropWidgets(node); resetPads(node); } catch (e) { /* a fresh document starts with a clean crop */ }
  finDocOpened(node);
  setTab(node, "crop");
  Promise.resolve(app.queuePrompt(0, 1)).catch((e) => console.error("[LightCraft] could not open the picture", e));       // an Edit run: only this node runs, it loads the picture
}
setDocOpener(openDocument);
setTabHook((node, id) => setTab(node, id));
function ensureLock(node) { if (readState(node)) lockRoll(); }        // gaps painted by Qwen must land on the SAME picture: freeze the roulette dice
const ORANGE = "#ff8a2a";
const GAP_GRAY = "#808080";

// ---- a small slider for the tool areas (drawn and dragged like the node's own sliders)
// double-click a mini slider to put it back to its default
const MINI_DEFAULT = { "pd:0": 0, "pd:1": 0, "pd:2": 0, "pd:3": 0, "pd:blend": 32, "mk:size": 40, "mk:grow": 0, "mk:smooth": 0,
  "mk:soft": 0, "mk:ctx": 1.6, "mk:mp": 1.5, "rf:mp": 1 };
function miniSlider(ctx, node, id, x, y, w, label, value, min, max, fmt, set, done) {
  const tx0 = x + 78, tx1 = x + w - 50, ty = y + 9, span = tx1 - tx0;
  const f = clamp((value - min) / (max - min), 0, 1);
  ctx.save();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
  ctx.fillText(label, x, ty);
  ctx.textAlign = "right"; ctx.fillText(fmt(value), x + w, ty);
  ctx.lineCap = "round"; ctx.lineWidth = 3;
  ctx.strokeStyle = C.track; ctx.beginPath(); ctx.moveTo(tx0, ty); ctx.lineTo(tx1, ty); ctx.stroke();
  ctx.strokeStyle = C.fill; ctx.beginPath(); ctx.moveTo(tx0, ty); ctx.lineTo(tx0 + f * span, ty); ctx.stroke();
  ctx.beginPath(); ctx.arc(tx0 + f * span, ty, 5, 0, Math.PI * 2);
  ctx.fillStyle = C.thumb; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = C.thumbEdge; ctx.stroke();
  ctx.restore();
  hit(node, "ed:" + id, x, y - 4, w, 26, ({ ev, pos }) => {
    const now = performance.now(), last = node.__lcMini;
    node.__lcMini = { id, t: now, x: ev.clientX, y: ev.clientY };
    if (MINI_DEFAULT[id] !== undefined && last && last.id === id && now - last.t < 450
        && Math.abs(last.x - ev.clientX) < 12 && Math.abs(last.y - ev.clientY) < 12) {
      node.__lcMini = null;
      set(MINI_DEFAULT[id]);
      if (done) done();
      node.setDirtyCanvas(true, true);
      return;
    }
    const cur = value;
    const base = pos[0] >= tx0 - 6 ? min + clamp((pos[0] - tx0) / span, 0, 1) * (max - min) : cur;
    set(base);
    node.setDirtyCanvas(true, true);
    drag({ node, ev, cursor: "ew-resize", onMove: (dx) => set(base + (dx / span) * (max - min)), onUp: () => { if (done) done(); } });
  }, "ew-resize");
}

const props = (node) => (node.properties = node.properties || {});




























// ---- history: every picture LightCraft Stitch produces is kept as a temp state (ComfyUI deletes them when it closes)
function histList(node) {
  const p = props(node);
  if (!Array.isArray(p.lc_history)) p.lc_history = [];
  return p.lc_history;
}
function histAdd(node, e) {
  const h = histList(node), last = h[h.length - 1];
  if (h.some((x) => x.f === e.f)) { props(node).lc_hist_cur = e.f; node.setDirtyCanvas(true, true); return; }
  const fp = faceSliders(node);
  if (fp && Object.values(fp).some((v) => Math.abs(v) > 1e-6)) props(node).lc_face_last = fp;         // the sliders this run was made with
  const cur = props(node).lc_hist_cur, ci = h.findIndex((x) => x.f === cur);
  if (ci >= 0 && ci < h.length - 1 && !e.run) h.splice(ci + 1);                                      // made from an older layer: the ones above it are replaced, like Photoshop history
  else if (e.run && last && last.run === e.run && last.label !== "Source") h.pop();                        // two recorders in one run = one state, the later (more finished) one wins
  h.push(e);
  while (h.length > HIST_MAX) h.splice(1, 1);        // never drop the Source (index 0)
  props(node).lc_hist_cur = e.f;
  node.setDirtyCanvas(true, true);
}
const histLabel = (node, e, i) => (e.label === "Source" ? "Source" : `Edit ${histList(node).slice(0, i + 1).filter((x) => x.label !== "Source").length}${e.note ? " · " + e.note : ""}`);

function histThumb(node, e) {
  const S = node.__lc;
  S.thumbs = S.thumbs || {};
  let t = S.thumbs[e.f];
  if (t) return t.cv;
  t = S.thumbs[e.f] = { cv: null };
  const img = new Image();
  img.onload = () => {
    try {
      const k = 64 / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * k)); c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      t.cv = c;
    } catch (err) { t.cv = img; }
    node.setDirtyCanvas(true, true);
  };
  img.onerror = () => {                                  // the temp file is gone (ComfyUI was restarted): forget the state
    const h = histList(node), i = h.findIndex((x) => x.f === e.f);
    if (i > 0 && h.length > 1) h.splice(i, 1);        // a lost temp file is forgotten, but never the Source
    node.setDirtyCanvas(true, true);
  };
  img.src = viewUrl(e.f, e.type || "temp");
  return null;
}

// go back to a state: it becomes the picture being edited (a new crop), like clicking a step in Photoshop's History
function pickHistory(node, e, opt = {}) {
  const S = node.__lc, source = e.label === "Source";
  const step = (name, fn) => { try { fn(); } catch (err) { console.error("[LightCraft] history pick, step '" + name + "' failed:", err); } };   // one failing step must never stop the picture from loading
  step("pick", () => { put(node, "history_pick", source ? "" : `${props(node).lc_origin || ""}::${e.f} [${e.type || "temp"}]`); props(node).lc_hist_cur = e.f; });
  S.pickFail = null;
  step("load", () => loadInto(node, source ? "linked" : "pick", viewUrl(e.f, e.type || "temp"), e.w && e.h ? [e.w, e.h] : null, e.f, false, () => { S.pickFail = e.f; if (!source) S.pick = null; }));   // first: every tab reads this picture
  if (source) S.pick = null;
  step("crop", () => { if (opt.keepCrop) return; autoCropWidgets(node); resetPads(node); put(node, "rotation_degrees", 0); S.lastAngle = 0; S.fitRatio = null; });
  step("face", () => {
    if (opt.keepFace) return;
    if (source) { const fp = props(node).lc_face_last; if (fp && !Object.values(faceSliders(node) || {}).some((v) => Math.abs(v) > 1e-6)) faceSetSliders(node, fp); }
    else if (faceSliders(node) && Object.values(faceSliders(node)).some((v) => Math.abs(v) > 1e-6)) faceSetSliders(node, null);     // the reshape is already in that picture
  });
  step("color", () => { if (node.__lcColor) { node.__lcColor.base = null; node.__lcColor.shader = null; node.__lcColor.result = null; node.__lcColor.lastSig = ""; } });     // the Color tab grades the new picture
  step("face-reset", () => { if (node.__lcFace) node.__lcFace.tried = null; });                       // the Face tab looks for the face again
  step("graph", () => { if (app.graph && app.graph.change) app.graph.change(); });
  node.setDirtyCanvas(true, true);
}

function onHistoryEvent(ev) {
  const d = ev && ev.detail;
  if (!d || !app.graph) return;
  const id = String(d.node), tail = id.split(":").pop();                       // inside a subgraph the id looks like "12:812"
  const n = (app.graph.getNodeById && (app.graph.getNodeById(Number(id)) || app.graph.getNodeById(Number(tail))))
    || (app.graph._nodes || []).find((x) => String(x.id) === id || String(x.id) === tail);
  if (!n || !n.__lc || (n.comfyClass || n.type) !== CLS) return;
  histAdd(n, { f: d.file, type: d.type || "temp", w: d.w, h: d.h, t: d.t || Date.now(), label: "Edit", run: d.run || "" });
  // the run's finished picture becomes what every tab works on (face, crop, color), so the next edit builds on it and an
  // outpaint that is done does not run again. (Short wait: a run can report two states, the later one is the one to keep.)
  const S = n.__lc;
  clearTimeout(S.adoptT);
  S.adoptT = setTimeout(() => {
    try {
      const h = histList(n), last = h[h.length - 1];
      if (!last || last.label === "Source" || S.baking) return;
      if (String(val(n, "history_pick") || "").endsWith(`::${last.f} [${last.type || "temp"}]`)) return;      // already the picture in the tabs
      pickHistory(n, last);
    } catch (err) { console.error("[LightCraft] could not move the tabs to the new picture:", err); }
  }, 500);
}



// ---- the History panel on the right (with the histogram on top in the Compare tab)
const clock = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const STRIP_W = 20;
const panelOpen = (node) => props(node).lc_panel !== false;
function togglePanel(node) {
  const p = props(node);
  p.lc_panel = p.lc_panel === false;
  if (p.lc_panel !== false && node.size[0] < PANEL_MIN_W) node.setSize([PANEL_MIN_W, node.size[1]]);
  if (app.graph && app.graph.change) app.graph.change();
  node.setDirtyCanvas(true, true);
}
// a faintly glowing orange arrow: points right while the panel is open (click to tuck it away), left when shut
function drawPanelStrip(ctx, node, x, y, w, h, open) {
  ctx.save();
  rr(ctx, x, y, w, h, 6); ctx.fillStyle = "#161618"; ctx.fill();
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.stroke();
  const cx = x + w / 2, cy = y + h / 2, d = open ? 1 : -1;
  ctx.shadowColor = ORANGE; ctx.shadowBlur = 9;
  ctx.strokeStyle = "rgba(255,138,42,0.8)"; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(cx - 3 * d, cy - 8); ctx.lineTo(cx + 3 * d, cy); ctx.lineTo(cx - 3 * d, cy + 8); ctx.stroke();
  ctx.restore();
  hit(node, "ed:panelToggle", x, y, w, h, () => togglePanel(node), "pointer");
}

// ---- clipping warnings (Lightroom's triangles): a small histogram of the picture being compared, and the
// two switches that paint blown whites (red) / crushed blacks (blue) over the Compare tab
const CLIP_BLOCK_H = 80;
function checkbox(ctx, node, id, x, y, on, color, label, fn) {
  drawCheckbox(ctx, x, y, on, color, label);
  hit(node, "ed:" + id, x - 2, y - 3, 78, 18, fn, "pointer");
}
function drawClipBlock(ctx, node, px, py, pw) {
  const S = node.__lc, p = props(node);
  const pics = S.tab === "color" ? S.colorPics : finT(S.tab) ? S.finPics : null;
  const A0 = pics ? pics.before : S.before, B0 = pics ? pics.after : S.after;
  const P = S.cmpMode === "before" ? (A0 || B0) : (B0 || A0);       // what the Compare / Color tab shows
  const an = P ? analysisFor(P.img) : null;
  const hx = px + 6, hw = pw - 12;
  const rects = drawHistogram(ctx, hx, py + 2, hw, 34, an, { lo: !!p.lc_clip_lo, hi: !!p.lc_clip_hi, help: !!S.histHelp });
  const toggle = (key) => () => { p[key] = !p[key]; node.setDirtyCanvas(true, true); };
  hit(node, "ed:clip:help", rects.help[0], rects.help[1], rects.help[2], rects.help[3], () => { helpReset(); S.histHelp = !S.histHelp; node.setDirtyCanvas(true, true); }, "pointer");
  hit(node, "ed:clip:tlo", rects.lo[0], rects.lo[1], rects.lo[2], rects.lo[3], toggle("lc_clip_lo"), "pointer");
  hit(node, "ed:clip:thi", rects.hi[0], rects.hi[1], rects.hi[2], rects.hi[3], toggle("lc_clip_hi"), "pointer");
  ctx.font = "10px Inter, 'Segoe UI', sans-serif"; ctx.textBaseline = "middle"; ctx.fillStyle = "#8a8a92";
  if (an) {
    ctx.textAlign = "left"; ctx.fillText(fmtPercent(percent(an.nLo, an.n)), hx + 4, py + 29);
    ctx.textAlign = "right"; ctx.fillText(fmtPercent(percent(an.nHi, an.n)), hx + hw - 4, py + 29);
  }
  checkbox(ctx, node, "clip:lo", px + 8, py + 43, !!p.lc_clip_lo, CLIP_LO, pw < 160 ? "Shad." : "Shadows", toggle("lc_clip_lo"));
  checkbox(ctx, node, "clip:hi", px + 8 + Math.round(pw * 0.5) - 6, py + 43, !!p.lc_clip_hi, CLIP_HI, pw < 160 ? "High." : "Highlights", toggle("lc_clip_hi"));
  checkbox(ctx, node, "clip:drift", px + 8, py + 62, !!p.lc_drift, DRIFT_COL, "Pixel drift", toggle("lc_drift"));          // purple = the pixels that moved between Before and After
  S.tipDrift = [px + 6, py + 59, 110, 18];
}

function drawPanel(ctx, node, px, py, pw, ph) {
  const S = node.__lc, st = readState(node);
  ctx.save();
  rr(ctx, px, py, pw, ph, 6); ctx.fillStyle = "#18181a"; ctx.fill();
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); rr(ctx, px, py, pw, ph, 6); ctx.clip();
  const head = (t, y) => { ctx.font = "600 10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = C.head; ctx.fillText(t, px + 10, y); };

  // --- history
  // the histogram + clipping warnings sit at the top of the panel, in the Compare tab only
  let hy = py + 6;
  if (S.tab === "compare" || S.tab === "color" || finT(S.tab)) {
    drawClipBlock(ctx, node, px, py + 2, pw);
    hy = py + 2 + CLIP_BLOCK_H + 6;
    ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(px + 8, hy - 3.5); ctx.lineTo(px + pw - 8, hy - 3.5); ctx.stroke();
  }
  head("HISTORY", hy + 11);
  if (S.baking) { ctx.font = "10px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "right"; ctx.fillStyle = ORANGE; ctx.fillText("saving edit…", px + pw - 8, hy + 11); }
  else if (S.bakeFail) { ctx.font = "10px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "right"; ctx.fillStyle = "#ff6a5a"; ctx.fillText("edit not saved", px + pw - 8, hy + 11); }
  else if (S.pickFail) { ctx.font = "10px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "right"; ctx.fillStyle = "#ff6a5a"; ctx.fillText("picture missing", px + pw - 8, hy + 11); }
  // Snapshot sits at the top of the History bar: bake the Color panel's edits as a layer, then keep adding on top
  {
    const colourCan = canSnapshot(node), faceCan = faceActive(node) && !S.baking, can = colourCan || faceCan, n = snapshotCount(node), bx = px + 5, bw = pw - 10, by = hy + 20;
    rr(ctx, bx, by, bw, 22, 5); ctx.fillStyle = can ? "#4a3220" : C.btn; ctx.fill(); ctx.strokeStyle = can ? ORANGE : "#4a4a4a"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = can ? "#ffe7d1" : "#8a8a8a"; ctx.font = "600 11.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((faceCan && !colourCan ? "Keep face edit" : "Make layer") + (n ? " · " + n : ""), bx + bw / 2, by + 11.5, bw - 8);
    // a face edit (sliders moved) is baked into the History right now, a Color edit becomes a layer: either one enables the button
    if (can) hit(node, "ed:hi:snap", bx, by, bw, 22, () => { if (faceCan) bakePending(node); if (colourCan) takeSnapshot(node); }, "pointer");
  }
  // Save image: writes the picture as it is now (all layers, crop, face, colour) with the normal Image Saver. Available on every tab.
  {
    const ff = node.__lcFin || {}, can = hasEdit(node) && !S.baking && !ff.running && !faceActive(node), bx = px + 5, bw = pw - 10, by = hy + 48;
    rr(ctx, bx, by, bw, 24, 5); ctx.fillStyle = can ? ORANGE : C.btn; ctx.fill();
    ctx.fillStyle = can ? "#1e1e1e" : "#8a8a8a"; ctx.font = "700 12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(ff.running ? "Saving…" : /^Saved/.test(ff.msg || "") ? "✓ " + ff.msg : "Save image", bx + bw / 2, by + 12.5, bw - 8);
    if (can) hit(node, "ed:hi:saveimg", bx, by, bw, 24, () => saveEditOnly(node), "pointer");
  }
  const all = histList(node), src = all.length && all[0].label === "Source" ? all[0] : null;
  const rest = (src ? all.slice(1) : all.slice()).reverse();                  // newest first; the Source is pinned below them, always there as the fallback
  const top = hy + 78, rows = Math.max(2, Math.floor((py + ph - top - 52) / HIST_ROW)), room = rows - (src ? 1 : 0);
  const shown = rest.slice(0, room), cur = props(node).lc_hist_cur;
  if (!all.length) {
    ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = C.label;
    ctx.fillText("Edits appear here.", px + 10, top + 12);
  }
  const drawRow = (e, k, hid) => {
    const ry = top + k * HIST_ROW, act = e.f === cur;
    rr(ctx, px + 5, ry, pw - 10, HIST_ROW - 3, 4);
    ctx.fillStyle = act ? "#2a2a2e" : "#1e1e21"; ctx.fill();
    if (act) { ctx.strokeStyle = ORANGE; ctx.lineWidth = 1; ctx.stroke(); }
    const th = histThumb(node, e);
    rr(ctx, px + 9, ry + 3, 30, HIST_ROW - 9, 3); ctx.fillStyle = "#101012"; ctx.fill();
    if (th) {
      const tw = th.width || 30, tH = th.height || 30, sc = Math.min(28 / tw, (HIST_ROW - 11) / tH);
      ctx.drawImage(th, px + 10 + (28 - tw * sc) / 2, ry + 4 + (HIST_ROW - 11 - tH * sc) / 2, tw * sc, tH * sc);
    }
    const idx = histList(node).indexOf(e);
    ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = "#ececec";
    ctx.fillText(histLabel(node, e, idx), px + 46, ry + 11);
    ctx.fillStyle = C.label; ctx.fillText(`${clock(e.t)}${e.w ? `  ${e.w}×${e.h}` : ""}`, px + 46, ry + 25);
    hit(node, hid, px + 5, ry, pw - 10, HIST_ROW - 3, () => pickHistory(node, e), "pointer");
  };
  shown.forEach((e, k) => drawRow(e, k, "ed:hi:row:" + k));
  if (src) drawRow(src, shown.length, "ed:hi:src");
  ctx.font = "10px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = "#6a6a72";
  ctx.fillText("Temp files · gone when ComfyUI closes", px + 10, py + ph - 38, pw - 14);
  tempButton(ctx, node, px + 5, py + ph - 28, pw - 10, 22, (k) => clearTemp(node, k), tempKeep);            // the TEMP decimate button: frees the old pictures, keeps the edit in progress
  if (S.histHelp && (S.tab === "compare" || S.tab === "color" || finT(S.tab))) {                    // the plain-words card for the histogram, over the whole panel
    const r = drawHistHelp(ctx, px + 2, py + 2, pw - 4, ph - 4);
    hit(node, "ed:clip:helpcard", r[0], r[1], r[2], r[3], () => { S.histHelp = helpClick(); node.setDirtyCanvas(true, true); }, "pointer");
  }
  ctx.restore();
}

function resetAngle(node) {
  const prev = node.__lc.lastAngle;
  put(node, "rotation_degrees", 0);
  refitCrop(node, prev);
  if (app.graph && app.graph.change) app.graph.change();
  node.setDirtyCanvas(true, true);
}

// the output size rule: Resize to megapixels when it is on; otherwise a canvas bigger than the input is scaled back to the input's pixel count
function resizeOf(node, st) {
  const steps = val(node, "resolution_steps") || 16;
  if (val(node, "resize_to_megapixels")) return { on: true, mp: val(node, "megapixels") || 2, steps };
  const keep = val(node, "keep_input_size");
  if (keep === true && st.crop[2] * st.crop[3] > st.w1 * st.h1) return { on: true, mp: (st.w1 * st.h1) / 1e6, steps };
  return { on: false, mp: 2, steps };
}
const finalOf = (node, st) => G.finalSize(st.crop[2], st.crop[3], [0, 0, 0, 0], 1, resizeOf(node, st));

// ---- the settings cog + the Output drawer that slides up from the bottom
const easeExpo = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2);
const DRAWER_H = 214;
function drawerE(node, open) {
  const S = node.__lc, now = performance.now(), target = open ? 1 : 0;
  if (S.drT === undefined) { S.drT = target; S.drE = target; S.drA = null; }
  if (!S.drA && S.drT !== target) S.drA = { from: S.drT, to: target, start: now };
  if (S.drA && S.drA.to !== target) S.drA = { from: S.drE, to: target, start: now };
  if (S.drA) {
    const a = S.drA, p = clamp((now - a.start) / (a.to > a.from ? 520 : 400), 0, 1);
    S.drE = a.from + (a.to - a.from) * easeExpo(p);
    if (p >= 1) { S.drT = a.to; S.drE = a.to; S.drA = null; } else requestAnimationFrame(() => node.setDirtyCanvas(true, false));
  } else S.drE = S.drT;
  return S.drE;
}

function drawCog(ctx, node, cx, cy, open) {
  const r = 8.5, teeth = 8, ri = r * 0.74;
  ctx.save();
  rr(ctx, cx - 12, cy - 12, 24, 24, 6);
  ctx.fillStyle = open ? "#2a1c12" : "#1b1b1e"; ctx.fill();
  ctx.shadowColor = "rgba(255,138,42," + (open ? 0.85 : 0.45) + ")"; ctx.shadowBlur = open ? 12 : 8;
  ctx.strokeStyle = open ? "rgba(255,138,42,0.95)" : "rgba(255,138,42,0.6)"; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i * Math.PI) / teeth - Math.PI / 2 / teeth, rad = i % 2 ? ri : r;
    const aa = a - Math.PI / (2 * teeth) * 0.0;
    const px = cx + Math.cos(aa) * rad, py = cy + Math.sin(aa) * rad;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.moveTo(cx + r * 0.32, cy); ctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2, true);
  ctx.fillStyle = open ? "rgba(255,138,42,0.95)" : "rgba(255,170,110,0.8)"; ctx.fill("evenodd");
  ctx.restore();
  hit(node, "ed:cog", cx - 13, cy - 13, 26, 26, () => { node.__lc.drawerOpen = !node.__lc.drawerOpen; node.setDirtyCanvas(true, true); }, "pointer");
}

function drawOutputDrawer(ctx, node, y, width) {
  const S = node.__lc, e = drawerE(node, !!S.drawerOpen);
  if (e < 0.005) return;
  const bottom = y + editH() + (S.extra || 0), top = bottom - DRAWER_H * e;
  const x = 6, w = width - 12, h = DRAWER_H;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, top - 14, width, bottom - top + 14 + 4); ctx.clip();
  ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = -4;
  rr(ctx, x, top, w, h, 10); ctx.fillStyle = "#18181a"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,138,42,0.35)"; ctx.lineWidth = 1; ctx.stroke();
  const live = e > 0.98, ix = x + 14, iw = w - 28;
  ctx.globalAlpha = clamp((e - 0.25) / 0.75, 0, 1);
  if (live) hit(node, "ed:drawer:bg", x, top, w, h, () => {});                      // clicks on the drawer never reach what is behind it
  ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = C.head;
  ctx.fillText("Output size", ix, top + 20);
  const st = readState(node);
  if (st) {
    const [fw, fh] = finalOf(node, st);
    ctx.font = FONT; ctx.textAlign = "right"; ctx.fillStyle = C.label; ctx.fillText(`${fw} × ${fh} px`, ix + iw - 30, top + 20);
  }
  ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(ix, top + 33.5); ctx.lineTo(ix + iw, top + 33.5); ctx.stroke();
  const close = () => { S.drawerOpen = false; node.setDirtyCanvas(true, true); };
  ctx.font = "16px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#9c9c9c"; ctx.fillText("×", ix + iw - 8, top + 19);
  if (live) hit(node, "ed:drawer:close", ix + iw - 22, top + 6, 28, 26, close, "pointer");

  const done = () => { if (app.graph && app.graph.change) app.graph.change(); node.setDirtyCanvas(true, true); };
  const on = !!val(node, "resize_to_megapixels");
  let ry = top + 46;
  drawCheckbox(ctx, ix, ry, on, ORANGE, "Resize to megapixels");
  if (live) hit(node, "ed:drawer:resize", ix - 2, ry - 5, 190, 22, () => { put(node, "resize_to_megapixels", !on); done(); }, "pointer");
  ry += 26;
  ctx.globalAlpha *= on ? 1 : 0.45;
  const mp = val(node, "megapixels") || 2;
  const setMp = (v) => { put(node, "megapixels", clamp(Math.round(v * 20) / 20, 0.1, 16)); };
  if (live && on) miniSlider(ctx, node, "dr:mp", ix, ry, iw, "Megapixels", mp, 0.1, 16, (v) => v.toFixed(2) + " MP", setMp, done);
  else { ctx.font = FONT; ctx.textAlign = "left"; ctx.fillStyle = C.label; ctx.fillText("Megapixels", ix, ry + 9); ctx.textAlign = "right"; ctx.fillText(mp.toFixed(2) + " MP", ix + iw, ry + 9); }
  ry += 28;
  const chips = [0.5, 1, 2, 3.5, 4, 8], cw = (iw - (chips.length - 1) * 5) / chips.length;
  chips.forEach((v, i) => {
    const cx = ix + i * (cw + 5), sel = Math.abs(mp - v) < 0.026;
    rr(ctx, cx, ry, cw, 22, 5); ctx.fillStyle = sel ? "#5a5a5a" : C.btn; ctx.fill();
    ctx.fillStyle = sel ? "#fff" : "#d0d0d0"; ctx.font = FONT; ctx.textAlign = "center"; ctx.fillText(String(v), cx + cw / 2, ry + 11.5);
    if (live && on) hit(node, "ed:drawer:mp:" + v, cx, ry, cw, 22, () => { setMp(v); done(); }, "pointer");
  });
  ctx.globalAlpha = clamp((e - 0.25) / 0.75, 0, 1);
  ry += 32;
  const mw = W(node, "resize_method");
  ctx.font = FONT; ctx.textAlign = "left"; ctx.fillStyle = C.label; ctx.fillText("Method", ix, ry + 13);
  rr(ctx, ix + 74, ry, iw - 74, 26, 5); ctx.fillStyle = C.well; ctx.fill(); ctx.strokeStyle = C.wellEdge; ctx.stroke();
  ctx.textAlign = "center"; ctx.fillStyle = "#ececec"; ctx.fillText(String(mw ? mw.value : ""), ix + 74 + (iw - 74) / 2, ry + 13.5);
  ctx.fillStyle = "#777"; ctx.fillText("▾", ix + iw - 12, ry + 13);
  if (live && mw) hit(node, "ed:drawer:method", ix + 74, ry, iw - 74, 26, ({ ev }) => pickFromMenu(mw.options.values, ev, (v) => { mw.value = v; done(); }), "pointer");
  ry += 36;
  const stepsNow = val(node, "resolution_steps") || 16;
  ctx.font = FONT; ctx.textAlign = "left"; ctx.fillStyle = C.label; ctx.fillText("Round to ×", ix, ry + 11);
  const steps = [1, 8, 16, 32, 64], sw = (iw - 74 - (steps.length - 1) * 5) / steps.length;
  steps.forEach((v, i) => {
    const cx = ix + 74 + i * (sw + 5), sel = stepsNow === v;
    rr(ctx, cx, ry, sw, 22, 5); ctx.fillStyle = sel ? "#5a5a5a" : C.btn; ctx.fill();
    if (sel) { ctx.strokeStyle = "#8c8c8c"; ctx.stroke(); }
    ctx.fillStyle = sel ? "#fff" : "#d0d0d0"; ctx.textAlign = "center"; ctx.fillText(String(v), cx + sw / 2, ry + 11.5);
    if (live) hit(node, "ed:drawer:steps:" + v, cx, ry, sw, 22, () => { put(node, "resolution_steps", v); done(); }, "pointer");
  });
  ctx.restore();
}

function drawEditor(ctx, node, w, y) {
  const width = node.size[0], S = node.__lc;
  const reg = node.__lcHits;
  finFrameStart(node);
  S.tipDrift = null;
  if (reg) for (const k of Array.from(reg.keys())) if (k.startsWith("ed:") || k === "slider:rotation_degrees" || k === "angle:reset") reg.delete(k);   // tabs swap their controls
  if (node.__lcDrops) node.__lcDrops.clear();
  if (node.__lcWheel) node.__lcWheel.clear();
  const vh = viewH(S);
  hit(node, "ed:bg", 0, y, width, editH() + (S.extra || 0), () => {});          // swallow stray clicks
  syncFile(node);
  const st = readState(node);
  if (st) faceAutoRefresh(node, st);                                        // a new picture gets its face found again (sliders stay)
  const tab = S.tab, crop = tab === "crop";

  ctx.save();
  // --- title bar
  ctx.fillStyle = C.head;
  loadBrandFonts();
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.font = `400 19px ${DISPLAY}`; ctx.fillStyle = ORANGE;               // brand: the name in Audiowide, the page in Montserrat Alternates
  ctx.fillText("LightCraft", M, y + 12);
  const brandW = ctx.measureText("LightCraft").width;
  ctx.font = `600 13px ${UI}`; ctx.fillStyle = C.head;
  ctx.fillText("Edit Page", M + brandW + 10, y + 12.5);
  if (rollLocked()) {                                                       // the roulette dice are stopped: a small lock chip, click to give them back
    const tx = M + brandW + 10 + ctx.measureText("Edit Page").width + 12, cw0 = 96;
    rr(ctx, tx, y + 3, cw0, 18, 9); ctx.fillStyle = "rgba(255,138,42,0.12)"; ctx.fill(); ctx.strokeStyle = ORANGE; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = ORANGE; ctx.fillStyle = ORANGE; ctx.lineWidth = 1.4;                                   // the lock glyph
    ctx.beginPath(); ctx.arc(tx + 14, y + 10.5, 2.6, Math.PI, 0); ctx.stroke();
    ctx.fillRect(tx + 10.5, y + 10.5, 7, 5.5);
    ctx.font = `600 11px ${UI}`; ctx.textAlign = "left"; ctx.fillStyle = "#ffd2a8";
    ctx.fillText("Roll locked", tx + 24, y + 12.5);
    hit(node, "ed:rolllock", tx, y + 3, cw0, 18, () => { unlockRoll(); node.setDirtyCanvas(true, true); }, "pointer");
  }
  if (st) {
    const [fw, fh] = finalOf(node, st);
    ctx.font = FONT; ctx.textAlign = "right"; ctx.fillStyle = C.label;
    ctx.fillText(`${fw} × ${fh} px`, width - M, y + 12);
  }
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(M, y + TITLE_H - 3.5); ctx.lineTo(width - M, y + TITLE_H - 3.5); ctx.stroke();

  // --- tabs (a small orange dot says the tab holds a change)
  const ty0 = y + TITLE_H + 3;
  const tabH = 36, ROLL_W = 98, FULL_W = 92, MAIN_W = 112, GAP = 5;
  const tabRects = {};
  const nowT = performance.now(), dtf = Math.min(64, nowT - (S.fxT || nowT)); S.fxT = nowT;
  const gk = 1 - Math.exp(-dtf / 80);
  let moving = false;
  const gl = (key, target, eps = 0.004) => {
    const v = S[key] === undefined ? target : S[key];
    let n = v + (target - v) * gk;
    if (Math.abs(target - n) < eps) n = target; else moving = true;
    S[key] = n; return n;
  };
  loadSlab();
  const isAuto = tab === "compare";
  if (!isAuto) S.lastSub = tab;
  const modeP = gl("modeEdit", isAuto ? 0 : 1, 0.01);                          // 0 = Auto, 1 = Edit: the two sides slide and fade (brand ease, no jiggle)
  const subX0 = M + 2 * MAIN_W + 2 * GAP + 7, SUBS = EDIT_SUBS, subW = (width - M - subX0 - (SUBS.length - 1) * GAP) / SUBS.length;
  [["compare", "Auto"], ["edit", "Edit"]].forEach(([id, label], i) => {
    const tx = M + i * (MAIN_W + GAP), on = id === "compare" ? isAuto : !isAuto;
    rr(ctx, tx, ty0, MAIN_W, tabH, 6);
    ctx.fillStyle = on ? "#5a5a5a" : C.btn; ctx.fill();
    if (on) { ctx.strokeStyle = "#8c8c8c"; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.fillStyle = on ? "#ffffff" : "#d4d4d4";
    ctx.font = tabFont(16); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, tx + MAIN_W / 2, ty0 + tabH / 2 + 1);
    hit(node, "ed:tab:" + id, tx, ty0, MAIN_W, tabH, () => { tipHide(node); setTab(node, id === "compare" ? "compare" : (S.lastSub || "browse")); }, "pointer");
    tabRects[id === "compare" ? "compare" : "edit"] = [tx, ty0, MAIN_W, tabH];
  });
  if (modeP > 0.02) {                                                           // Edit: the sub-tabs slide in from the right
    ctx.save(); ctx.globalAlpha = modeP;
    const dx = (1 - modeP) * 36;
    SUBS.forEach(([id, label], i) => {
      const tx = subX0 + i * (subW + GAP) + dx, on = tab === id;
      rr(ctx, tx, ty0, subW, tabH, 6);
      ctx.fillStyle = on ? CREAM_FULL : C.btn; ctx.fill();
      if (on) { ctx.strokeStyle = "#fff6e4"; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = on ? "#1e1e1e" : "#d4d4d4";
      ctx.font = tabFont(subW < 84 ? 13 : 15); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, tx + subW / 2, ty0 + tabH / 2 + 1);
      if (modeP > 0.5) hit(node, "ed:tab:" + id, tx, ty0, subW, tabH, () => { tipHide(node); setTab(node, id); }, "pointer");
      tabRects[id] = [tx, ty0, subW, tabH];
      if ((id === "color" && colorActive(node)) || (id === "face" && faceActive(node)) || (id === "crop" && !val(node, "constrain_crop") && PAD_NAMES.some((n) => val(node, n) > 0))) {
        ctx.fillStyle = ORANGE; ctx.beginPath(); ctx.arc(tx + subW - 9, ty0 + 9, 3, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.restore();
  }
  if (modeP < 0.98) {                                                           // Auto: Roll all + Full mode slide out to the left when Edit opens
    ctx.save(); ctx.globalAlpha = 1 - modeP;
    ctx.translate(-modeP * 36, 0);
  {                                                                          // Roll all: unlock the dice and give every roulette a new seed
    const rx = subX0, cy = ty0 + tabH / 2;
    ctx.save();
    rr(ctx, rx, ty0, ROLL_W, tabH, 6); ctx.fillStyle = ORANGE; ctx.shadowColor = "rgba(255,138,42,0.8)"; ctx.shadowBlur = 14; ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "#1e1e1e"; ctx.fillStyle = "#1e1e1e"; ctx.lineWidth = 2.2; ctx.lineCap = "round";
    const ax = rx + 19, r = 6.5, e = Math.PI * 1.85;
    ctx.beginPath(); ctx.arc(ax, cy, r, Math.PI * 0.2, e); ctx.stroke();       // a circular arrow
    const px = ax + r * Math.cos(e), py = cy + r * Math.sin(e), tx2 = -Math.sin(e), ty2 = Math.cos(e), nx = Math.cos(e), ny = Math.sin(e);
    ctx.beginPath(); ctx.moveTo(px + tx2 * 5, py + ty2 * 5); ctx.lineTo(px + nx * 4, py + ny * 4); ctx.lineTo(px - nx * 4, py - ny * 4); ctx.closePath(); ctx.fill();
    ctx.font = `700 15px ${UI}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("Roll all", rx + 32, cy + 1);
    ctx.restore();
    if (modeP < 0.5) hit(node, "ed:rollall", rx, ty0, ROLL_W, tabH, () => {
      tipHide(node);
      if (S.tab !== "compare") setTab(node, "compare");                     // back on Compare (this also gives the dice back)
      rollAll();                                                            // ...and every roulette gets a new seed
      node.setDirtyCanvas(true, true);
    }, "pointer");
  }
  {                                                                          // AUTO: every run does the skin pass (and the eyes), the grade comes after
    const fx = subX0 + ROLL_W + 5, FW = Math.max(FULL_W, Math.min(196, width - fx - M)), wired = isLinked(node, "full_mode");
    const pr = node.properties = node.properties || {}, on = wired ? null : !!pr.lc_full;
    const skinOn = pr.lc_auto_skin !== false, eyesOn = pr.lc_auto_eyes !== false && skinOn;
    const paused = on && tab !== "compare" && tab !== "finish";                 // the edit tabs never run the skin pass
    ctx.save();
    rr(ctx, fx, ty0, FW, tabH, 6);
    ctx.fillStyle = on ? "#2b2013" : C.btn;
    if (on) { ctx.shadowColor = "rgba(255,138,42,0.45)"; ctx.shadowBlur = 10; }       // a faint orange glow while AUTO is on
    ctx.fill(); ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
    ctx.strokeStyle = on ? ORANGE : "#3c3c42"; ctx.lineWidth = on ? 1.6 : 1; ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.font = `700 15px ${UI}`; ctx.fillStyle = wired ? "#8e8e96" : on ? (paused ? "#b98a5a" : ORANGE) : "#9a9aa2";
    ctx.fillText(wired ? "AUTO wired" : on ? "AUTO ON" : "AUTO OFF", fx + 10, ty0 + tabH / 2 + (paused ? -4 : 1));
    if (paused) { ctx.font = `10px ${UI}`; ctx.fillStyle = "#8e8e96"; ctx.fillText("paused in Edit", fx + 10, ty0 + tabH / 2 + 9); }
    ctx.restore();
    if (!wired && modeP < 0.5) hit(node, "ed:full", fx, ty0, FW, tabH, () => {
      tipHide(node); pr.lc_full = !on;
      if (app.graph && app.graph.change) app.graph.change(); node.setDirtyCanvas(true, true);
    }, "pointer");
    if (!wired) {                                                               // what AUTO does: Skin pass, and Eyes on top of it (the eyes need the skin pass)
      const cx0 = fx + FW - 74;
      drawCheckbox(ctx, cx0, ty0 + 5, skinOn, null, "Skin");
      drawCheckbox(ctx, cx0, ty0 + 20, eyesOn, null, "Eyes");
      if (modeP < 0.5) {
        hit(node, "ed:auto:skin", cx0 - 2, ty0 + 2, 74, 16, () => { pr.lc_auto_skin = !skinOn; node.setDirtyCanvas(true, true); }, "pointer");
        hit(node, "ed:auto:eyes", cx0 - 2, ty0 + 17, 74, 16, () => { if (skinOn) pr.lc_auto_eyes = !eyesOn; node.setDirtyCanvas(true, true); }, "pointer");
      }
    }
    tabRects.full = [fx, ty0, FW, tabH];
  }
    ctx.restore();
  }
  S.tabRects = tabRects;

  // --- file row (crop) / info row (other tabs)
  const fy = y + TITLE_H + TAB_H;
  const linked = isLinked(node, "image_in");
  const nameW = width - 2 * M - 70;
  if (crop) {
    rr(ctx, M, fy + 4, nameW, 26, 5); ctx.fillStyle = C.well; ctx.fill();
    ctx.strokeStyle = C.wellEdge; ctx.stroke();
    ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = linked ? C.label : "#ececec";
    ctx.fillText(fitText(ctx, linked ? "Using the connected image_in" : (val(node, "image") || "none"), nameW - 24), M + 10, fy + 18);
    ctx.fillStyle = "#777"; ctx.textAlign = "right"; ctx.fillText("▾", M + nameW - 8, fy + 18);
    const bx = M + nameW + 6;
    rr(ctx, bx, fy + 4, 64, 26, 5); ctx.fillStyle = C.btn; ctx.fill();
    ctx.fillStyle = "#d0d0d0"; ctx.textAlign = "center"; ctx.fillText("Open…", bx + 32, fy + 18);
    if (!linked) {
      hit(node, "ed:file", M, fy + 4, nameW, 26, ({ ev }) => {
        const wi = W(node, "image");
        pickFromMenu(wi.options.values, ev, (v) => { wi.value = v; node.setDirtyCanvas(true, true); });
      }, "pointer");
      hit(node, "ed:open", bx, fy + 4, 64, 26, () => { openPicker(node); }, "pointer");
    }
  } else {
    rr(ctx, M, fy + 4, width - 2 * M, 26, 5); ctx.fillStyle = C.well; ctx.fill();
    ctx.strokeStyle = C.wellEdge; ctx.stroke();
    const dim = (P) => (P ? `${P.w} × ${P.h}` : "—");
    const msg = tab === "compare" ? `Before ${dim(S.before)}      After ${dim(S.after)}`
      : tab === "color" ? `Original ${dim(S.before)}      Graded: live preview, applied to the output on run`
      : tab === "face" ? "Reshape the face. Live preview here, applied to the picture before the crop when you run."
      : finT(tab) ? (finView(node) === "grid" ? (tab === "browse" ? "Pick the picture you want to edit. Any saved picture works. Double-click to open it." : "Your saved pictures. Orange glow = already upscaled (it has an _up twin).") : S.finPics ? `${S.finPics.name}      ${S.finPics.edit ? "Press Upscale your edit: it is saved first, then upscaled" : S.finPics.hasUp ? "Before = saved picture, After = its _up twin" : "Not upscaled yet: tick it and press Upscale"}` : "Pick a saved picture from the list on the right.")
      : "Crop, straighten and pad the picture. The padded gray is what an outpaint pass paints.";
    ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = "#ececec";
    ctx.fillText(fitText(ctx, msg, width - 2 * M - 20), M + 10, fy + 18);
  }

  // --- picture view
  const vx = M, vy = fy + FILE_H, fullW = width - 2 * M;
  // ONE calm motion for everything on the right: widths glide (no panel ever closes all the way just to open again), and the contents
  // slide in from the right while fading in, and slide back out to the right while fading out.
  const pOpen = panelOpen(node) && !finT(tab);                        // the History bar slides away in the Upscale tab
  gl("panelT", pOpen ? 1 : 0);
  const sideTarget = tab === "color" ? CP_W : tab === "face" ? FACE_W : finT(tab) ? FIN_W : 0;
  gl("sideW", sideTarget, 0.4);
  const ce = gl("presC", tab === "color" ? 1 : 0), fe = gl("presF", tab === "face" ? 1 : 0), ue = gl("presU", finT(tab) ? 1 : 0);
  const histW = PANEL_W - (PANEL_W - HIST_NARROW) * clamp(S.sideW / 180, 0, 1);       // the History bar narrows while a side panel is out
  const pw = STRIP_W + (histW - STRIP_W) * S.panelT;
  const cw = S.sideW, cgap = cw > 1 ? PANEL_GAP * clamp(cw / 40, 0, 1) : 0;
  const pe = Math.max(ce, fe, ue);
  const vw = fullW - pw - PANEL_GAP - cw - cgap;
  ctx.save();
  rr(ctx, vx, vy, vw, vh, 6); ctx.clip();
  ctx.fillStyle = "#141414"; ctx.fillRect(vx, vy, vw, vh);

  if (tab === "compare") {
    // a face edit made after the last run is not in the "Before" picture yet: show it live, so Compare never looks stale
    const live = st && faceActive(node) && S.runFace !== val(node, "face_data") ? faceLivePicture(node, st) : null;
    if (live) {
      const keep = [S.before, S.after];                      // Before = the picture as it came in, After = with your face edit
      S.before = live.before; S.after = live.after;
      try { drawCompare(ctx, node, vx, vy, vw, vh); } finally { S.before = keep[0]; S.after = keep[1]; }
      ctx.fillStyle = "rgba(255,138,42,0.9)"; ctx.beginPath(); ctx.arc(vx + vw - 14, vy + 14, 4, 0, Math.PI * 2); ctx.fill();
    } else drawCompare(ctx, node, vx, vy, vw, vh);
  }
  else if (tab === "color") {
    const pics = st ? colorPictures(node, st) : null;
    S.colorPics = pics;
    if (!pics) {
      ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(linked ? "Run the workflow once to show the connected picture here." : "Choose a picture in the Crop tab.", vx + vw / 2, vy + vh / 2);
    } else {                                                            // the Compare layout, with the live grade as "After"
      const keep = [S.before, S.after];
      S.before = pics.before; S.after = pics.after;
      try { drawCompare(ctx, node, vx, vy, vw, vh); } finally { S.before = keep[0]; S.after = keep[1]; }
      if (pics.waiting) { ctx.fillStyle = "rgba(255,138,42,0.9)"; ctx.beginPath(); ctx.arc(vx + vw - 14, vy + 14, 4, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  else if (finT(tab)) {
    const pics = finishPictures(node), fv = finView(node), HEAD = 32;
    S.finPics = pics;
    const hy = vy + HEAD, hh = vh - HEAD;                                  // the head row (Grid / Single / size) lives above the picture
    if (fv === "grid") { S.cmp = null; drawFinishGrid(ctx, node, vx, hy, vw, hh, { fitText }); }
    else if (!pics) {
      S.cmp = null;
      if (tab === "browse") drawFinishStrip(ctx, node, vx + 4, vy + vh - STRIP_H - 4, vw - 8, STRIP_H, { fitText });
      ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const fin = node.__lcFin;
      ctx.fillText(tab === "finish" ? "Nothing to compare yet. In Browse, press the magnifier on a picture." : (fin && fin.loading ? "Looking in the saved folder…" : "Pick a saved picture from the list on the right."), vx + vw / 2, vy + vh / 2);
    } else {                                                            // the Compare layout: the saved picture against its _up twin
      const keep = [S.before, S.after];
      S.before = pics.before; S.after = pics.after; S.cmpMissing = pics.note || (pics.hasUp ? "loading…" : "no skin pass yet"); S.cmpDims = true;
      try { drawCompare(ctx, node, vx, tab === "finish" ? vy : hy, vw, tab === "finish" ? vh : hh - STRIP_H - 8); } finally { S.before = keep[0]; S.after = keep[1]; S.cmpMissing = null; S.cmpDims = false; }
      if (tab === "browse") drawFinishStrip(ctx, node, vx + 4, vy + vh - STRIP_H - 4, vw - 8, STRIP_H, { fitText });
    }
    // drawn last so its buttons win over the picture's own click areas
    if (tab === "browse") drawFinishHead(ctx, node, vx + 8, vy + 4, ue, gl("finSel", fv === "grid" ? 0 : 1), gl("finGrid", fv === "grid" ? 1 : 0), { fitText });
  }
  else if (tab === "face") drawFaceView(ctx, node, st, vx, vy, vw, vh);
  else if (!st) {
    S.map = null;
    ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const msg = linked ? ["Run the workflow once to show the connected", "picture here, then crop it with the handles."]
                       : ["Choose a picture with Open…", "or connect an image to image_in."];
    ctx.fillText(msg[0], vx + vw / 2, vy + vh / 2 - 8);
    ctx.fillText(msg[1], vx + vw / 2, vy + vh / 2 + 10);
  } else {
    const map = viewMap(node, st, vx, vy, vw, vh);
    S.map = { ...map, vx, vy, vw, vh };
    const { s, ox, oy } = map;
    const [cx, cy, cw, ch] = st.crop;
    const X = (v) => ox + v * s, Y = (v) => oy + v * s;

    if (!st.constrain) { ctx.fillStyle = GAP_GRAY; ctx.fillRect(X(0), Y(0), map.w2 * s, map.h2 * s); }          // gaps (turned corners, padding) show flat gray: Qwen paints them on run
    ctx.save();
    ctx.translate(X(st.pads[0] + st.w2 / 2), Y(st.pads[1] + st.h2 / 2));
    ctx.rotate((st.angle * Math.PI) / 180);
    ctx.imageSmoothingQuality = node.__lcDragging ? "low" : "high";
    ctx.drawImage(viewImg(node, st.s, st.s.w * s), (-st.s.w * s) / 2, (-st.s.h * s) / 2, st.s.w * s, st.s.h * s);
    ctx.restore();

    // dim everything outside the crop
    const rx = X(cx), ry = Y(cy), rw = cw * s, rh = ch * s;
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.beginPath(); ctx.rect(vx, vy, vw, vh); ctx.rect(rx, ry, rw, rh); ctx.fill("evenodd");

    // crop box, guides, handles
    ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5, Math.round(rw), Math.round(rh));
    drawOverlay(ctx, S.rotating ? "grid" : S.overlay, rx, ry, rw, rh);
    drawHandles(ctx, rx, ry, rw, rh, S.dragZone || S.hover);
    if (!st.constrain) drawCanvasDots(ctx, node, st, map);
    ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText(`${Math.round(cw)} × ${Math.round(ch)}` + (st.padded ? `   canvas ${Math.round(st.W3)} × ${Math.round(st.H3)}` : ""), vx + 8, vy + vh - 10);
  }
  ctx.restore();

  if (cw > 1) {                                                                  // one shared panel body; the contents of the outgoing / incoming tab cross-fade inside it
    const sx = vx + vw + cgap;
    ctx.save();
    rr(ctx, sx, vy, cw, vh, 6); ctx.fillStyle = "#18181a"; ctx.fill(); ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.stroke();
    node.__lcNoBg = true;
    try {
      if (ce > 0.01) drawColorPanel(ctx, node, sx, vy, cw, vh, ce);
      if (fe > 0.01) drawFacePanel(ctx, node, sx, vy, cw, vh, fe, () => readState(node));
      if (ue > 0.01) drawFinishPanel(ctx, node, sx, vy, cw, vh, ue, { button, miniSlider, checkbox, fitText, tempButton, onCleared: (k) => clearTemp(node, k), keepFn: tempKeep, drawClip: (c, n, x, y, w) => drawClipBlock(c, n, x, y, w) });
    } finally { node.__lcNoBg = false; }
    ctx.restore();
  }
  if (moving) requestAnimationFrame(() => node.setDirtyCanvas(true, true));
  {
    const px = vx + vw + PANEL_GAP + cw + cgap;
    if (S.panelT > 0.02) {
      ctx.save(); ctx.beginPath(); ctx.rect(px, vy, pw - STRIP_W, vh); ctx.clip();
      drawPanel(ctx, node, px, vy, histW - STRIP_W - 4, vh);
      ctx.restore();
    }
    if (S.panelT > 0.02 || !finT(tab)) drawPanelStrip(ctx, node, px + pw - STRIP_W, vy, STRIP_W, vh, pOpen);
  }
  const viewHitTop = tab === "browse" ? 32 : 0, viewHitH = tab === "browse" ? vh - STRIP_H - 8 - viewHitTop : vh;                  // in the Upscale compare view the strip below the picture keeps its own clicks
  if (tab !== "face" && !(finT(tab) && finView(node) === "grid")) hit(node, "ed:view", vx, vy + viewHitTop, vw, viewHitH, (c) => {
    if (S.tab === "crop") viewDown(node, c);
    else if (S.tab === "compare" || S.tab === "color" || finT(S.tab)) cmpDown(node, c);
  }, "default", (pos) => {
    if (S.tab === "compare" || S.tab === "color" || finT(S.tab)) return S.cmp && S.cmp.mode === "split" ? "ew-resize" : (S.cmp ? "pointer" : "default");
    const z = hoverZone(node, pos);
    if (z !== S.hover) { S.hover = z; node.setDirtyCanvas(true, true); }
    return zoneCursor(z);
  });

  // --- controls under the picture
  const ay = vy + vh + 6, gap = 5;
  const hint = (t, yy) => { ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label; ctx.fillText(fitText(ctx, t, width - 2 * M), M, yy); };
  if (tab === "crop") {
    const cur = val(node, "crop_aspect_ratio") || "original";
    const bw = (width - 2 * M - 4 * gap) / 5;
    ASPECT_ROWS.forEach((row, ri) => row.forEach((name, ci) => {
      button(ctx, node, "asp:" + name, M + ci * (bw + gap), ay + ri * 30, bw, 25, ASPECT_LABEL[name] || name, cur === name,
        () => { put(node, "crop_aspect_ratio", name); aspectChanged(node); node.setDirtyCanvas(true, true); });
    }));
    ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
    const cap = cur === "free" ? "Free · any shape" : cur === "original" ? "Original · shape of the picture"
      : `${cur} · ${ASPECT_NAME[cur] || ""}`;
    ctx.fillText(cap, M, ay + 71);
    if (st) { ctx.textAlign = "right"; ctx.fillText(`crop ${Math.round(st.crop[2])} × ${Math.round(st.crop[3])}`, width - M, ay + 71); }
    drawAngle(ctx, node, ay + 80);
  } else if (finT(tab) && finView(node) === "grid") {
    drawFinishBar(ctx, node, M, ay, vx + vw - M, { button, fitText });
    hint(tab === "browse" ? "Click a picture to choose it, double-click to edit it. The magnifier shows it big (Esc goes back). Stars are shared with the Station." : "Click a picture to tick it, the magnifier opens it next to its _up twin. Stars are shared with the Station.", ay + 42);
  } else if (tab === "compare" || tab === "color" || finT(tab)) {
    const bw = (width - 2 * M - 3 * gap) / 4;
    CMP_MODES.forEach(([id, label], i) => {
      button(ctx, node, "cmp:" + id, M + i * (bw + gap), ay, bw, 25, label, S.cmpMode === id,
        () => { S.cmpMode = id; node.setDirtyCanvas(true, true); });
    });
    hint(S.cmpMode === "split" ? "Drag in the picture to move the divider."
      : (S.cmpMode === "before" || S.cmpMode === "after") ? "Click the picture to flip between Before and After."
      : "Before on the left, After on the right.", ay + 42);
  } else if (tab === "face") {
    hint(rollLocked() ? "Roll locked: the roulette dice are stopped, so Run keeps this picture. Open Compare (or click the lock) for a new roll." : "Find face, then drag the sliders (double-click one to zero it). “Points” nudges a landmark, “Guides” draws the outlines.", ay + 8);
    hint("Warping stretches pixels a little. A light skin pass afterwards hides it. Hold “Before” to see the original.", ay + 28);
  }

  // --- tool row
  const ty = ay + bottomH(tab) - 6;
  if (crop) {
    button(ctx, node, "tool:ov", M, ty, 92, 24, "Grid: " + S.overlay[0].toUpperCase() + S.overlay.slice(1), false,
      () => { S.overlay = OVERLAYS[(OVERLAYS.indexOf(S.overlay) + 1) % OVERLAYS.length]; node.setDirtyCanvas(true, true); });
    button(ctx, node, "tool:fill", M + 98, ty, 112, 24, st && st.constrain ? "Fill gaps · OFF" : "Fill gaps · ON", !(st && st.constrain), () => {
      const now = !!val(node, "constrain_crop"), st0 = readState(node);
      put(node, "constrain_crop", !now);
      if (!now && st0 && st0.explicit) { const st1 = readState(node); const r = G.shrinkToFit(st1.crop, okFn(st1)); if (r[2] >= 8 && r[3] >= 8) writeCrop(node, r); else autoCropWidgets(node); }
      if (app.graph && app.graph.change) app.graph.change();
      node.setDirtyCanvas(true, true);
    });
    if (st && !st.constrain) {
      const on = st.padded, cur = st.oAspectName, lab = "Canvas · " + (ASPECT_LABEL[cur] || cur);
      button(ctx, node, "tool:canvas", M + 216, ty, 128, 24, lab, on, ({ ev } = {}) => {
        const w = W(node, "outpaint_aspect");
        pickFromMenu(w.options.values, ev, (v) => { w.value = v; outAspectChanged(node); node.setDirtyCanvas(true, true); });
      });
    }
    {                                                          // the mouse shortcuts, in the free space between the buttons and Reset
      const lx = M + 352, lw = Math.min(vx + vw, width - M - 72) - lx;
      if (lw > 90) {
        ctx.save(); ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
        ctx.fillText(fitText(ctx, "Drag white: crop  ·  Shift: from centre", lw), lx, ty + 6);
        ctx.fillText(fitText(ctx, "Drag orange: grow canvas  ·  Drag outside: angle", lw), lx, ty + 19);
        ctx.restore();
      }
    }
    button(ctx, node, "tool:reset", width - M - 64, ty, 64, 24, "Reset", false, () => { resetCrop(node); });
  } else if (tab === "color") {
    ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
    ctx.fillText("Original on one side, your grade on the other. The grade is applied to the output when you run.", M, ty + 12);
  } else if (tab === "compare") {
    ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
    ctx.fillText(isLinked(node, "compare_image") ? "After comes from compare_image." : "After follows the Save / Preview after this node.", M, ty + 12);
  } else if (tab === "face") {
    hint("Face reshaping runs first, so the crop and colour follow the new shape.", ty + 12);
  } else if (finT(tab)) {
    if (finView(node) === "compare") {
      ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
      ctx.fillText(fitText(ctx, "Purple = pixels that moved between the saved picture and its _up twin (switch it on in the panel).", width - 2 * M), M, ty + 12);
    } else {
      ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
      ctx.fillText(fitText(ctx, "Saved pictures only: the folder your Image Saver writes to.", width - 2 * M), M, ty + 12);
    }
  }
  drawOutputDrawer(ctx, node, y, width);
  drawCog(ctx, node, M + 12, y + editH() + (S.extra || 0) - BAR_H / 2 - 1, S.drawerOpen);          // bottom left; drawn last so it stays on top of the drawer and closes it
  ctx.restore();
  const tipRects = { ...(S.tabRects || {}), ...finTipRects(node, tab) };
  if (S.tipDrift && (tab === "compare" || tab === "color" || finT(tab))) tipRects["fin:drift"] = S.tipDrift;
  drawTabTips(ctx, node, tipRects, width);
}

// the Angle slider (a normal hidden widget underneath) is drawn here, inside the Crop tab only
function drawAngle(ctx, n, y) {
  const w = W(n, "rotation_degrees"), row = ROWS.rotation_degrees;
  if (!w) return;
  drawSlider(ctx, n, w, row.spec, y);
  sliderHit(n, w, row.spec, y, { onChange: () => refitCrop(n, n.__lc.lastAngle), resetOnDouble: true });
  const gx = n.size[0] - M - 64, gy = y + 8;                 // its own reset button (double-click on the row works too)
  ctx.save();
  ctx.font = "15px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = Math.abs(w.value) > 1e-9 ? "#e8e8ea" : "#55555c";
  ctx.fillText("\u21ba", gx, gy);
  ctx.restore();
  hit(n, "angle:reset", gx - 11, y - 3, 22, 22, () => resetAngle(n), "pointer");
}

function resetCrop(node) {
  const S = node.__lc;
  autoCropWidgets(node); resetPads(node);
  put(node, "rotation_degrees", 0);
  put(node, "crop_aspect_ratio", "original");
  put(node, "outpaint_aspect", "original");
  S.lastAngle = 0; S.fitRatio = null;
  node.setDirtyCanvas(true, true);
}

// an explicit crop adopts a newly chosen aspect ratio (centred, as large as fits)
function aspectChanged(node) {
  const st = readState(node);
  node.__lc.fitRatio = null;
  if (!st || !st.explicit) return;
  if (!st.aspect) return;
  const [x, y, cw, ch] = st.crop;
  let w = Math.min(cw, ch * st.aspect), h = w / st.aspect;
  const cxm = x + cw / 2, cym = y + ch / 2;
  const r = G.shrinkToFit([cxm - w / 2, cym - h / 2, w, h], okFn(st));
  if (r[2] >= 8 && r[3] >= 8) writeCrop(node, r);
  else autoCropWidgets(node);
}

// ---------------------------------------------------------------- the outpaint canvas: an orange frame of dots around the picture (Crop tab)
const OUT_REACH = 0.75;                      // how far past each side the frame may grow in one run (x the picture's size); run again on the result for more
const OUT_SET = 11;                          // the dots sit this many screen pixels outside the canvas so they never hide the crop handles

// new margins; a hand-made crop stays on the same picture content
function setPads(node, st0, pads) {
  const lim = [OUT_REACH * st0.w2, OUT_REACH * st0.h2, OUT_REACH * st0.w2, OUT_REACH * st0.h2];
  const np = pads.map((v, i) => Math.round(clamp(v, 0, lim[i])));
  PAD_NAMES.forEach((n, i) => put(node, n, np[i]));
  if (st0.explicit) {
    const dx = np[0] - st0.pads[0], dy = np[1] - st0.pads[1];
    const W3 = st0.w2 + np[0] + np[2], H3 = st0.h2 + np[1] + np[3];
    const cw = Math.min(st0.crop[2], W3), ch = Math.min(st0.crop[3], H3);
    writeCrop(node, [clamp(st0.crop[0] + dx, 0, W3 - cw), clamp(st0.crop[1] + dy, 0, H3 - ch), cw, ch]);
  }
}

// the frame must hold the whole turned picture; with a locked shape it grows from its centre to do so
function containFrame(r, aspect, w2, h2) {
  let [x, y, w, h] = r;
  if (aspect) {
    const k = Math.max(1, w2 / w, h2 / h);
    if (k > 1) { const cx = x + w / 2, cy = y + h / 2; w *= k; h *= k; x = cx - w / 2; y = cy - h / 2; }
    x = Math.min(0, Math.max(x, w2 - w)); y = Math.min(0, Math.max(y, h2 - h));
    return [x, y, w, h];
  }
  const x0 = Math.min(x, 0), y0 = Math.min(y, 0), x1 = Math.max(x + w, w2), y1 = Math.max(y + h, h2);
  return [x0, y0, x1 - x0, y1 - y0];
}

// a shape was picked for the canvas: the smallest frame of that shape that holds the picture (Free leaves it alone)
function outAspectChanged(node) {
  const st = readState(node);
  if (!st || !st.oAspect) return;
  if (st.oAspectName === "original" && !st.padded) return;
  ensureLock(node);
  setPads(node, st, G.minPads(st.oAspect, st.w2, st.h2));
  node.setDirtyCanvas(true, true);
}

// the orange frame on screen (outset a little), in node units
function outRect(st, map) {
  const { s, ox, oy } = map, g = OUT_SET / zoom();
  return [ox - g, oy - g, st.W3 * s + 2 * g, st.H3 * s + 2 * g];
}

function drawCanvasDots(ctx, node, st, map) {
  const S = node.__lc, [rx, ry, rw, rh] = outRect(st, map), hot = S.outHot || S.outDrag;
  ctx.save();
  ctx.strokeStyle = "rgba(255,138,42,0.3)"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  ctx.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5, Math.round(rw), Math.round(rh));
  ctx.setLineDash([]);
  [["tl", rx, ry], ["tr", rx + rw, ry], ["bl", rx, ry + rh], ["br", rx + rw, ry + rh]].forEach(([z, x, y]) => {
    ctx.beginPath(); ctx.arc(x, y, hot === z ? 6.5 : 5, 0, Math.PI * 2);
    ctx.shadowColor = "rgba(255,138,42,0.7)"; ctx.shadowBlur = hot === z ? 12 : 6;
    ctx.fillStyle = "rgba(255,138,42,0.97)"; ctx.fill(); ctx.shadowBlur = 0;
    ctx.lineWidth = 1.2; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.stroke();
  });
  ctx.restore();
}

// which part of the orange frame is under the pointer: a corner dot, or (only outside the crop box) an edge
function outZone(st, map, px, py, cropZone) {
  const [rx, ry, rw, rh] = outRect(st, map), g = 11 / zoom();
  const near = (a, b) => Math.hypot(px - a, py - b) <= g;
  if (near(rx, ry)) return "tl"; if (near(rx + rw, ry)) return "tr";
  if (near(rx, ry + rh)) return "bl"; if (near(rx + rw, ry + rh)) return "br";
  if (cropZone !== "rotate") return null;
  const e = 5 / zoom(), inX = px >= rx && px <= rx + rw, inY = py >= ry && py <= ry + rh;
  if (inY && Math.abs(px - rx) <= e) return "l"; if (inY && Math.abs(px - rx - rw) <= e) return "r";
  if (inX && Math.abs(py - ry) <= e) return "t"; if (inX && Math.abs(py - ry - rh) <= e) return "b";
  return null;
}

function outDown(node, { ev }, zone) {
  const S = node.__lc, st = readState(node);
  const map = S.map, { s } = map;
  ensureLock(node);
  const f0 = [-st.pads[0], -st.pads[1], st.W3, st.H3], aspect = st.oAspect;
  S.frozen = { s, oxU: map.ox + st.pads[0] * s, oyU: map.oy + st.pads[1] * s };           // the view holds still while the frame grows
  const L = (S.map.vx + 8 - S.frozen.oxU) / s, T = (S.map.vy + 8 - S.frozen.oyU) / s;
  const R = (S.map.vx + S.map.vw - 8 - S.frozen.oxU) / s, B = (S.map.vy + S.map.vh - 8 - S.frozen.oyU) / s;
  const lim = [OUT_REACH * st.w2, OUT_REACH * st.h2];
  const ok = (r) => r[0] >= Math.max(-lim[0], L) - 0.5 && r[1] >= Math.max(-lim[1], T) - 0.5
    && r[0] + r[2] <= Math.min(st.w2 + lim[0], R) + 0.5 && r[1] + r[3] <= Math.min(st.h2 + lim[1], B) + 0.5;
  let cur = containFrame(f0.slice(), aspect, st.w2, st.h2);
  S.outDrag = zone;
  drag({
    node, ev, cursor: zoneCursor(zone),
    onMove: (dx, dy, e) => {
      const cand = containFrame(resizeRect(zone, f0, dx / s, dy / s, aspect, !!(e && e.shiftKey)), aspect, st.w2, st.h2);
      cur = G.clampToward(cur, cand, ok);
      setPads(node, st, [-cur[0], -cur[1], cur[0] + cur[2] - st.w2, cur[1] + cur[3] - st.h2]);
    },
    onUp: () => { S.outDrag = null; S.frozen = null; },
  });
}

// ---------------------------------------------------------------- dragging inside the picture view
// Zones, in node units. g is the grab radius (screen pixels converted to node units).
function zoneAt(px, py, rx, ry, rw, rh, g) {
  const e = g * 0.75;
  const nL = Math.abs(px - rx) <= g, nR = Math.abs(px - rx - rw) <= g;
  const nT = Math.abs(py - ry) <= g, nB = Math.abs(py - ry - rh) <= g;
  const inX = px >= rx - g && px <= rx + rw + g, inY = py >= ry - g && py <= ry + rh + g;
  if (nT && nL) return "tl"; if (nT && nR) return "tr";
  if (nB && nL) return "bl"; if (nB && nR) return "br";
  if (inY && Math.abs(px - rx) <= e) return "l";
  if (inY && Math.abs(px - rx - rw) <= e) return "r";
  if (inX && Math.abs(py - ry) <= e) return "t";
  if (inX && Math.abs(py - ry - rh) <= e) return "b";
  if (px > rx && px < rx + rw && py > ry && py < ry + rh) return "move";
  return "rotate";
}

const CURSORS = { tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize",
  l: "ew-resize", r: "ew-resize", t: "ns-resize", b: "ns-resize", move: "move", rotate: "crosshair" };
const zoneCursor = (z) => CURSORS[z && z[0] === "o" && z.length > 1 ? z.slice(1) : z] || "default";

function hoverZone(node, pos) {
  const S = node.__lc, st = readState(node);
  if (!st || !S.map) return null;
  const { s, ox, oy } = S.map, [cx, cy, cw, ch] = st.crop;
  const cz = zoneAt(pos[0], pos[1], ox + cx * s, oy + cy * s, cw * s, ch * s, GRAB / zoom());
  const oz = st.constrain ? null : outZone(st, S.map, pos[0], pos[1], cz);
  S.outHot = oz;
  return oz ? "o" + oz : cz;
}

// dx / dy are how far the grabbed edge(s) moved, in picture pixels
// center (Shift held): the opposite edges move the other way, so the frame grows or shrinks around its own middle
function resizeRect(z, c0, dx, dy, aspect, center) {
  const MIN = 8;
  let x0 = c0[0], y0 = c0[1], x1 = x0 + c0[2], y1 = y0 + c0[3];
  if (z.includes("l")) x0 = Math.min(x0 + dx, x1 - MIN);
  if (z.includes("r")) x1 = Math.max(x1 + dx, x0 + MIN);
  if (z.includes("t")) y0 = Math.min(y0 + dy, y1 - MIN);
  if (z.includes("b")) y1 = Math.max(y1 + dy, y0 + MIN);
  let w = x1 - x0, h = y1 - y0;
  if (aspect) {
    if (z.length === 2) {                                   // corner: follow the larger move
      if (w / aspect > h) h = w / aspect; else w = h * aspect;
      if (z.includes("l")) x0 = x1 - w; else x1 = x0 + w;
      if (z.includes("t")) y0 = y1 - h; else y1 = y0 + h;
    } else if (z === "l" || z === "r") {                    // side: height follows, centred
      h = w / aspect; const cy = c0[1] + c0[3] / 2; y0 = cy - h / 2;
    } else {                                                // top / bottom
      w = h * aspect; const cx = c0[0] + c0[2] / 2; x0 = cx - w / 2;
    }
  }
  if (center) {
    const nw = Math.max(MIN, c0[2] + 2 * (w - c0[2])), nh = Math.max(MIN, c0[3] + 2 * (h - c0[3]));
    return [c0[0] + c0[2] / 2 - nw / 2, c0[1] + c0[3] / 2 - nh / 2, nw, nh];
  }
  return [x0, y0, w, h];
}

function viewDown(node, { ev, pos }) {
  const S = node.__lc, st = readState(node);
  if (!st || !S.map) return;
  const { s, ox, oy } = S.map;
  const [cx, cy, cw, ch] = st.crop;
  const zone = zoneAt(pos[0], pos[1], ox + cx * s, oy + cy * s, cw * s, ch * s, GRAB / zoom());
  const oz = st.constrain ? null : outZone(st, S.map, pos[0], pos[1], zone);
  if (oz) { outDown(node, { ev, pos }, oz); return; }                    // an orange dot / edge: grow the canvas
  const ok = okFn(st);
  S.dragZone = zone;
  const done = () => { S.dragZone = null; S.rotating = false; };

  if (zone === "rotate") {                       // outside the box: drag around it to straighten
    const ccx = ox + (cx + cw / 2) * s, ccy = oy + (cy + ch / 2) * s;
    const a0 = Math.atan2(pos[1] - ccy, pos[0] - ccx), ang0 = st.angle;
    S.rotating = true;
    S.lastAngle = st.angle;
    drag({
      node, ev, cursor: "crosshair",
      onMove: (dx, dy) => {
        let d = ((Math.atan2(pos[1] + dy - ccy, pos[0] + dx - ccx) - a0) * 180) / Math.PI;
        d = ((d + 540) % 360) - 180;
        put(node, "rotation_degrees", clamp(Math.round((ang0 + d) * 20) / 20, -45, 45));
        refitCrop(node, S.lastAngle);
      },
      onUp: done,
    });
    return;
  }

  const cur0 = st.crop.slice();
  if (!st.explicit) writeCrop(node, cur0);
  let cur = cur0.slice();
  const c0 = cur0.slice();
  S.fitRatio = null;
  drag({
    node, ev, cursor: zoneCursor(zone),
    onMove: (dx, dy, e) => {
      const px = dx / s, py = dy / s;
      const cand = zone === "move" ? [c0[0] + px, c0[1] + py, c0[2], c0[3]] : resizeRect(zone, c0, px, py, st.aspect, !!(e && e.shiftKey));
      cur = G.clampToward(cur, cand, ok);
      writeCrop(node, cur);
    },
    onUp: done,
  });
}

// ---------------------------------------------------------------- the remaining rows
function drawLabeledCombo(ctx, node, w, y, label) {
  const width = node.size[0];
  ctx.save();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label;
  ctx.fillText(label, M, y + 15);
  const wx = M + 96, ww = width - M - wx;
  rr(ctx, wx, y + 3, ww, 26, 5); ctx.fillStyle = C.well; ctx.fill();
  ctx.strokeStyle = C.wellEdge; ctx.lineWidth = 1; ctx.stroke();
  ctx.textAlign = "center"; ctx.fillStyle = "#777";
  ctx.fillText("‹", wx + 10, y + 15); ctx.fillText("›", wx + ww - 10, y + 15);
  ctx.fillStyle = "#ececec";
  ctx.fillText(fitText(ctx, w.value, ww - 48), wx + ww / 2, y + 16);
  ctx.restore();
  hit(node, "combo:" + w.name, wx, y + 3, ww, 26, ({ ev, pos }) => {
    const vals = w.options.values, i = vals.indexOf(w.value);
    const set = (v) => { w.value = v; if (w.callback) w.callback(v, app.canvas, node); node.setDirtyCanvas(true, true); };
    if (pos[0] < wx + 22) set(vals[(i + vals.length - 1) % vals.length]);
    else if (pos[0] > wx + ww - 22) set(vals[(i + 1) % vals.length]);
    else pickFromMenu(vals, ev, set);
  }, "pointer");
}

function drawCheck(ctx, node, w, y, label, head) {
  const width = node.size[0];
  let top = y;
  ctx.save();
  if (head) {
    ctx.fillStyle = C.head; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(head, M, y + 12);
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M, y + HEAD_H - 3.5); ctx.lineTo(width - M, y + HEAD_H - 3.5); ctx.stroke();
    top = y + HEAD_H;
  }
  rr(ctx, M, top + 5, 14, 14, 3);
  ctx.fillStyle = w.value ? "#d4d4d4" : C.well; ctx.fill();
  ctx.strokeStyle = w.value ? "#d4d4d4" : "#666"; ctx.lineWidth = 1; ctx.stroke();
  if (w.value) {
    ctx.strokeStyle = "#1c1c1c"; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(M + 3.5, top + 12); ctx.lineTo(M + 6.5, top + 15); ctx.lineTo(M + 11, top + 8.5); ctx.stroke();
  }
  ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillStyle = w.value ? C.labelHot : C.label;
  ctx.fillText(label, M + 24, top + 13);
  ctx.restore();
  hit(node, "check:" + w.name, M, top, width - 2 * M, 26, () => {
    w.value = !w.value;
    if (w.callback) w.callback(w.value, app.canvas, node);
    node.setDirtyCanvas(true, true);
  }, "pointer");
}

// ---------------------------------------------------------------- node setup
function setupNode(node) {
  if (node.__lc) return;
  node.__lc = { overlay: "thirds", lastAngle: 0, fitRatio: null, hover: null,
                tab: "compare", cmpMode: "split", split: 0.5, before: null, after: null,
              };
  node.__lcHoverOut = () => {
    const S = node.__lc; S.hover = null;
    if (node.__lcTip) node.__lcTip.hov = null;
    node.setDirtyCanvas(true, true);
  };

  const first = node.widgets.find((w) => w.name === "image");
  if (panelOpen(node) && node.size[0] < PANEL_MIN_W) node.size[0] = PANEL_MIN_W;       // room for the History panel
  // The picture view grows with the node: whatever height the user adds becomes picture.
  const grow = () => editH() + (node.__lc.extra || 0);
  first.computeSize = (width) => [width, grow()];
  first.computeLayoutSize = () => ({ minHeight: grow(), minWidth: 0 });          // no maxHeight: the node can be dragged taller, the picture takes the extra
  const baseCompute = node.computeSize;
  node.computeSize = function () {            // the minimum size must not include the growth
    const r = baseCompute.apply(this, arguments);
    return [r[0], r[1] - (this.__lc.extra || 0)];
  };
  const prevResize = node.onResize;
  node.onResize = function (size) {
    if (prevResize) prevResize.apply(this, arguments);
    const base = node.computeSize()[1];
    const extra = Math.max(0, Math.round((size || node.size)[1] - base));
    if (extra !== node.__lc.extra) { node.__lc.extra = extra; node.setDirtyCanvas(true, true); }
  };
  first.draw = (ctx, n, _w, y) => drawEditor(ctx, n, first, y);
  // This widget is the whole editor. LiteGraph must never treat a click on it as "open the image list" (it did when zoomed far out).
  first.onClick = () => {};
  first.mouse = () => true;
  const prevCfg = node.onConfigure;
  node.onConfigure = function () {            // a workflow saved with the old, tab-dependent height: grow to the fixed size
    if (prevCfg) prevCfg.apply(this, arguments);
    node.__lc.extra = 0;
    const need = node.computeSize()[1];
    if (node.size[1] < need) node.setSize([node.size[0], need]);
    else node.__lc.extra = Math.max(0, Math.round(node.size[1] - need));          // the rows that moved into the drawer become picture
  };

  for (const name of HIDDEN) {
    const w = W(node, name);
    if (!w) continue;
    w.computeSize = () => [0, -4];
    w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
    w.draw = () => {};
  }

  for (const [name, row] of Object.entries(ROWS)) {
    const w = W(node, name);
    if (!w) continue;
    if (name === "rotation_degrees" || DRAWER_WIDGETS.includes(name)) {        // drawn inside the Crop tab / the settings drawer, no row of their own
      if (row.max !== undefined) w.options.max = row.max;
      w.__lcDefault = w.value;
      w.computeSize = () => [0, -4];
      w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
      w.draw = () => {};
      continue;
    }
    if (row.kind === "slider") {
      if (row.max !== undefined) w.options.max = row.max;
      if (row.min !== undefined) w.options.min = row.min;
      w.__lcDefault = w.value;
      fixedSize(w, rowHeight(row.spec));
      w.draw = (ctx, n, _w, y) => {
        drawSlider(ctx, n, w, row.spec, y);
        sliderHit(n, w, row.spec, y, {});
      };
    } else {
      fixedSize(w, row.h);
      w.draw = (ctx, n, _w, y) => {
        hit(n, "row:" + name, 0, y, n.size[0], row.h, () => {});
        if (row.kind === "combo") drawLabeledCombo(ctx, n, w, y, row.label);
        else drawCheck(ctx, n, w, y, row.label, row.head);
      };
    }
  }

  W(node, "rotation_degrees").callback = () => { refitCrop(node, node.__lc.lastAngle); };
  W(node, "crop_aspect_ratio").callback = () => aspectChanged(node);

  node.color = "#1e1e1e";
  node.bgcolor = C.panel;
  node.setSize([Math.max(420, node.size[0]), node.computeSize()[1]]);

  // pictures arrive after execution
  const prevExec = node.onExecuted;
  node.onExecuted = function (msg) {
    if (prevExec) prevExec.apply(this, arguments);
    const S = node.__lc;
    if (msg && msg.lc_finish) return;                          // an Upscale run: the Edit Page just loaded a saved picture, the tabs stay as they are
    if (msg && msg.lc_pick_stale) {                            // a new picture arrived: the old history pick no longer applies
      put(node, "history_pick", ""); props(node).lc_hist_cur = props(node).lc_origin;
    }
    const og = msg && msg.lc_origin && msg.lc_origin[0];
    if (og) {                                                  // a new incoming picture = a new document: fresh history
      const p = props(node);
      if (p.lc_origin !== og.filename || !histList(node).length) {
        const fresh = p.lc_origin !== undefined && p.lc_origin !== og.filename;
        p.lc_origin = og.filename;
        p.lc_history = [{ f: og.filename, type: og.type || "temp", w: og.w, h: og.h, t: Date.now(), label: "Source" }];
        p.lc_hist_cur = og.filename; S.thumbs = {}; S.pick = null;
        if (fresh) { put(node, "history_pick", ""); }
      }
    }
    const src = msg && msg.lc_source && msg.lc_source[0];
    if (src) {
      const dm = msg.lc_dims && msg.lc_dims[0], cs = val(node, "crop_src");
      if (dm && cs && cs !== `${dm[0]}x${dm[1]}`) { autoCropWidgets(node); resetPads(node); }          // the old crop was made on another size
      loadInto(node, "linked", viewUrl(src.filename, src.type), dm, src.filename);
    }
    const b = msg && msg.lc_before && msg.lc_before[0];
    if (b) { loadInto(node, "before", imgUrl(b), null, b.filename, true); S.runFace = val(node, "face_data"); S.runSig = editSig(node); }
    const a = msg && msg.lc_after && msg.lc_after[0];
    if (a) loadInto(node, "after", imgUrl(a), null, a.filename, true);
    else if (!isLinked(node, "compare_image")) { S.after = null; node.setDirtyCanvas(true, true); }   // stale until the nodes after this one finish
  };
  const prevConn = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    if (prevConn) prevConn.apply(this, arguments);
    node.setDirtyCanvas(true, true);
  };
}

app.registerExtension({
  name: "LightCraft.CropCompare",
  setup() {
    api.addEventListener("executed", onExecutedEvent);
    api.addEventListener("executed", finOnExecuted);
    setRegionHistAdder((n, e) => { histAdd(n, e); const S = n.__lc; if (S) { put(n, "history_pick", `${props(n).lc_origin || ""}::${e.f} [${e.type || "temp"}]`); S.thumbs = {}; } });
    api.addEventListener("execution_error", finOnError);
    api.addEventListener("execution_interrupted", finOnError);
    api.addEventListener("status", finOnStatus);
    const queue = api.queuePrompt.bind(api);                      // the Upscale tab trims the prompt on its way to the server (nothing in the saved workflow changes)
    api.queuePrompt = async (number, data, options) => queue(number, rewritePrompt(data), options);
    api.addEventListener("lightcraft.history", onHistoryEvent);
    // Q / E step through the Edit Page tabs (Auto, Browse, Crop, Face, Color, Upscale) for the node under the mouse, or the selected one; 0-5 are star ratings in Browse / Upscale
    window.addEventListener("keydown", (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey || ev.repeat) return;
      const code = ev.code || "", isQE = code === "KeyQ" || code === "KeyE", isDigit = /^(Digit|Numpad)[0-5]$/.test(code);
      if (!isQE && !isDigit) return;
      const a = document.activeElement, tag = a && a.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (a && a.isContentEditable)) return;
      const c = app.canvas, sel = c && c.selected_nodes ? Object.values(c.selected_nodes) : [];
      const isEdit = (x) => x && (x.comfyClass || x.type) === CLS && x.__lc;
      const node = isEdit(c && c.node_over) ? c.node_over : sel.find(isEdit);
      if (!node) return;
      if (isQE) {                                          // Q = the tab before, E = the tab after; it stops at the ends (no wrap). ComfyUI's own Q (queue panel) stays out of the way while the pointer is on the Edit Page.
        ev.preventDefault(); ev.stopPropagation();
        const i = TABS.findIndex((t) => t[0] === node.__lc.tab), j = i + (code === "KeyE" ? 1 : -1);
        if (i < 0 || j < 0 || j >= TABS.length) return;
        tipHide(node); setTab(node, TABS[j][0]);
        return;
      }
      if (finT(node.__lc.tab) && finKey(node, +code.slice(-1))) { ev.preventDefault(); ev.stopPropagation(); node.setDirtyCanvas(true, true); }       // the digits rate pictures (like the Station)
    }, true);
    // Esc in Browse: the big view goes back to the grid
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
      const a = document.activeElement, tag = a && a.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (a && a.isContentEditable)) return;
      const c = app.canvas, sel = c && c.selected_nodes ? Object.values(c.selected_nodes) : [];
      const isEdit = (x) => x && (x.comfyClass || x.type) === CLS && x.__lc;
      const node = isEdit(c && c.node_over) ? c.node_over : sel.find(isEdit);
      if (node && finBackToGrid(node)) { ev.preventDefault(); ev.stopPropagation(); }
    }, true);
  },
  nodeCreated(node) {
    if ((node.comfyClass || node.type) !== CLS) return;
    try { setupNode(node); }
    catch (e) { console.error("[LightCraft] Crop & Compare setup failed", e); }
  },
});
