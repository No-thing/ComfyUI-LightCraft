import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { C, FONT, rr } from "./lightcraft_ui.js";
import { hit, drag } from "./lc_interact.js";

// Edit Page > Edit tab: paint a mask with a round red brush, write a prompt (the trigger word of a LoRA, say), press Run.
// Only the painted area is redrawn by the Flux edit group in the workflow; the rest of the picture stays exactly as it was.
//
//   * The mask is a grey picture kept in a TEMP file (lc_mask_<id>.png in ComfyUI's temp folder). It is uploaded through ComfyUI's own
//     /upload/image route and deleted with the rest of the temp folder when ComfyUI closes, so nothing piles up.
//   * Everything else (file name, prompt, strength, brush settings) lives in ONE hidden JSON widget (edit_data).
//   * The mask is painted on the SOURCE picture. On run, Python carries it through the same straighten / crop / resize as the picture.

const ORANGE = "#ff8a2a";
const WIDGET = "edit_data";
const PROXY_MAX = 1600;
export const EDIT_W = 262;
export const EDIT_MIN_NODE_W = 900;
export const EDIT_HIDDEN = [WIDGET];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const W = (node, name) => node.widgets && node.widgets.find((w) => w.name === name);
const DEFAULTS = { on: true, mask: "", has: false, src: "", rev: 0, prompt: "", denoise: 0.8, size: 10, feather: 40, mode: "add" };
const SLIDERS = { size: [1, 100, "Size", (v) => String(Math.round(v))], feather: [0, 100, "Feather", (v) => String(Math.round(v))], denoise: [0.05, 1, "Strength", (v) => v.toFixed(2)] };
const ROW_H = 28;

// ---------------------------------------------------------------- the data (one hidden JSON widget)
export function parseEdit(raw) {
  let d = {};
  try { d = JSON.parse(raw || "{}"); } catch (e) { d = {}; }
  if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
  const o = { ...DEFAULTS, ...d };
  o.on = o.on !== false;
  o.mode = o.mode === "erase" ? "erase" : "add";
  o.size = clamp(Number(o.size) || DEFAULTS.size, 1, 100);
  o.feather = clamp(Number.isFinite(Number(o.feather)) ? Number(o.feather) : DEFAULTS.feather, 0, 100);
  o.denoise = clamp(Number(o.denoise) || DEFAULTS.denoise, 0.05, 1);
  o.prompt = String(o.prompt || "");
  o.rev = Math.max(0, Math.round(Number(o.rev) || 0));
  o.has = !!o.has && /^lc_mask_[0-9a-f]{8,32}\.png$/.test(String(o.mask || ""));
  return o;
}

export function readEdit(node) {
  const w = W(node, WIDGET), raw = w ? w.value : "";
  const K = node.__lcEdit || (node.__lcEdit = {});
  if (K.raw !== raw || !K.data) { K.data = parseEdit(raw); K.raw = raw; }
  return K.data;
}

function writeEdit(node, data, done) {
  const w = W(node, WIDGET);
  if (!w) return;
  const K = node.__lcEdit || (node.__lcEdit = {});
  K.data = data; K.raw = JSON.stringify(data);
  w.value = K.raw;
  if (done) {
    if (w.callback) { try { w.callback(w.value, app.canvas, node); } catch (e) { /* ignore */ } }
    if (app.graph && app.graph.change) app.graph.change();
  }
  node.setDirtyCanvas(true, true);
}

export function editActive(node) { const d = readEdit(node); return d.on && d.has; }

// ---------------------------------------------------------------- the mask (a canvas of the picture's proxy size, painted red; the alpha is the mask)
const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n / 2)), (b) => b.toString(16).padStart(2, "0")).join("");

function maskFor(node, st) {
  const K = node.__lcEdit || (node.__lcEdit = {});
  const key = `${st.s.w}x${st.s.h}`;
  if (K.cv && K.key === key) return K;
  const k = Math.min(1, PROXY_MAX / Math.max(st.s.w, st.s.h));
  const cv = document.createElement("canvas");
  cv.width = Math.max(2, Math.round(st.s.w * k)); cv.height = Math.max(2, Math.round(st.s.h * k));
  K.cv = cv; K.key = key; K.k = k; K.fresh = true;
  const d = readEdit(node);
  if (d.has && d.src && d.src !== key) writeEdit(node, { ...d, mask: "", has: false, src: "" }, true);      // another picture: the old mask does not belong here
  else if (d.has) { K.painted = true; loadMask(node, d.mask, cv); }                                                                  // same picture, page reloaded: bring the temp file back
  return K;
}

function loadMask(node, name, cv) {
  const url = api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=temp&rand=${Math.random()}`);
  const img = new Image();
  img.onload = () => {
    const c = cv.getContext("2d");
    const t = document.createElement("canvas"); t.width = cv.width; t.height = cv.height;
    const tc = t.getContext("2d"); tc.drawImage(img, 0, 0, t.width, t.height);
    const id = tc.getImageData(0, 0, t.width, t.height), o = c.createImageData(t.width, t.height);
    for (let i = 0; i < id.data.length; i += 4) { o.data[i] = 255; o.data[i + 1] = 40; o.data[i + 2] = 40; o.data[i + 3] = id.data[i]; }
    c.putImageData(o, 0, 0);
    node.setDirtyCanvas(true, true);
  };
  img.onerror = () => {                                                                                         // the temp file is gone (ComfyUI was restarted): start clean
    const d = readEdit(node);
    if (d.has && d.mask === name) writeEdit(node, { ...d, mask: "", has: false }, true);
  };
  img.src = url;
}

const radiusPx = (K, d) => Math.max(1, Math.max(K.cv.width, K.cv.height) * 0.0025 * d.size);       // brush radius in mask pixels

function stamp(K, d, x, y) {
  K.painted = true;
  const c = K.cv.getContext("2d"), r = radiusPx(K, d), erase = d.mode === "erase";
  c.save();
  c.globalCompositeOperation = erase ? "destination-out" : "source-over";
  const hard = 1 - d.feather / 100;
  if (d.feather <= 1) { c.fillStyle = "rgba(255,40,40,1)"; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }
  else {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,40,40,1)"); g.addColorStop(clamp(hard * 0.95, 0, 0.95), "rgba(255,40,40,1)"); g.addColorStop(1, "rgba(255,40,40,0)");
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

function stroke(K, d, a, b) {                                                                                    // stamps along the line a -> b
  const r = radiusPx(K, d), step = Math.max(1, r * 0.18), len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / step));
  for (let i = 1; i <= n; i++) stamp(K, d, a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n);
}

function anyPaint(K) {
  const { width: w, height: h } = K.cv, a = K.cv.getContext("2d").getImageData(0, 0, w, h).data;
  for (let i = 3; i < a.length; i += 4) if (a[i] > 8) return true;
  return false;
}

function greyBlob(K) {
  const { width: w, height: h } = K.cv, src = K.cv.getContext("2d").getImageData(0, 0, w, h);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const c = cv.getContext("2d"), out = c.createImageData(w, h);
  for (let i = 0; i < src.data.length; i += 4) { const a = src.data[i + 3]; out.data[i] = out.data[i + 1] = out.data[i + 2] = a; out.data[i + 3] = 255; }
  c.putImageData(out, 0, 0);
  return new Promise((res) => cv.toBlob(res, "image/png"));
}

// after a stroke: wait a moment, then send the mask to ComfyUI's temp folder (one stable file name per node, overwritten each time)
function scheduleUpload(node, st) {
  const K = node.__lcEdit;
  clearTimeout(K.timer);
  K.timer = setTimeout(() => uploadNow(node, st), 450);
}

async function uploadNow(node, st) {
  const K = node.__lcEdit;
  if (!K || !K.cv) return;
  let d = readEdit(node);
  try {
    if (!anyPaint(K)) { writeEdit(node, { ...d, mask: d.mask, has: false, src: "", rev: d.rev + 1 }, true); K.error = null; return; }
    K.busy = true; node.setDirtyCanvas(true, true);
    const blob = await greyBlob(K);
    const name = /^lc_mask_[0-9a-f]{8,32}\.png$/.test(d.mask) ? d.mask : `lc_mask_${randHex(16)}.png`;
    const fd = new FormData();
    fd.append("image", blob, name); fd.append("type", "temp"); fd.append("overwrite", "true");
    const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`upload failed (${r.status})`);
    const j = await r.json();
    d = readEdit(node);
    writeEdit(node, { ...d, mask: j.name || name, has: true, src: `${st.s.w}x${st.s.h}`, rev: d.rev + 1 }, true);
    K.error = null;
  } catch (e) {
    console.error("[LightCraft] Edit tab: could not save the mask", e);
    K.error = "Could not save the mask. Is ComfyUI still running?";
  } finally { K.busy = false; node.setDirtyCanvas(true, true); }
}

function resetMask(node) {
  const K = node.__lcEdit;
  if (K && K.cv) { K.cv.getContext("2d").clearRect(0, 0, K.cv.width, K.cv.height); K.painted = false; }
  clearTimeout(K && K.timer);
  const d = readEdit(node);
  writeEdit(node, { ...d, has: false, src: "", rev: d.rev + 1 }, true);
}

// ---------------------------------------------------------------- the picture + brush
const fit = (w, h, x, y, bw, bh) => { const k = Math.min(bw / w, bh / h), rw = w * k, rh = h * k; return [x + (bw - rw) / 2, y + (bh - rh) / 2, rw, rh]; };

export function drawEditView(ctx, node, st, vx, vy, vw, vh) {
  ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const src = st && (st.s.full || st.s.img);
  if (!st || !src) { ctx.fillText("Choose a picture in the Crop tab, or run the workflow once.", vx + vw / 2, vy + vh / 2); return; }
  const K = maskFor(node, st), d = readEdit(node);
  const [ix, iy, iw, ih] = fit(st.s.w, st.s.h, vx + 6, vy + 6, vw - 12, vh - 12);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, src.width || st.s.w, src.height || st.s.h, ix, iy, iw, ih);
  ctx.save(); ctx.globalAlpha = d.on ? 0.6 : 0.2; ctx.drawImage(K.cv, ix, iy, iw, ih); ctx.restore();
  K.map = [ix, iy, iw, ih];
  const sc = iw / K.cv.width;                                                                                    // screen px per mask px

  const toMask = (pos) => [(pos[0] - ix) / sc, (pos[1] - iy) / sc];
  hit(node, "ed:edit:paint", ix, iy, iw, ih, ({ ev, pos }) => {
    if (!readEdit(node).on) writeEdit(node, { ...readEdit(node), on: true }, false);
    const dd = readEdit(node), p0 = toMask(pos);
    clearTimeout(K.timer);
    stamp(K, dd, p0[0], p0[1]);
    let last = p0;
    K.drawing = pos.slice();
    drag({
      node, ev, cursor: "none",
      onMove: (dx, dy) => { const cur = toMask([pos[0] + dx, pos[1] + dy]); stroke(K, readEdit(node), last, cur); last = cur; K.hover = [pos[0] + dx, pos[1] + dy]; },
      onUp: () => { K.drawing = null; scheduleUpload(node, st); },
    });
  }, "none", (pos) => { K.hover = pos.slice(); node.setDirtyCanvas(true, false); return "none"; });

  // the brush ring (size follows the slider, the inner ring shows where the feather starts)
  const hp = K.hover;
  if (hp && hp[0] >= ix && hp[0] <= ix + iw && hp[1] >= iy && hp[1] <= iy + ih) {
    const r = radiusPx(K, d) * sc, inner = r * clamp(1 - d.feather / 100, 0, 1);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.beginPath(); ctx.arc(hp[0], hp[1], r + 0.8, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = d.mode === "erase" ? "rgba(120,200,255,0.95)" : "rgba(255,255,255,0.95)"; ctx.beginPath(); ctx.arc(hp[0], hp[1], r, 0, Math.PI * 2); ctx.stroke();
    if (inner > 2) { ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.beginPath(); ctx.arc(hp[0], hp[1], inner, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
  if (!d.has && !K.painted) {
    ctx.fillStyle = "rgba(0,0,0,0.5)"; rr(ctx, vx + vw / 2 - 170, vy + vh - 44, 340, 30, 6); ctx.fill();
    ctx.fillStyle = "#e6e6e6"; ctx.font = FONT; ctx.textAlign = "center"; ctx.fillText("Paint over the area you want to change.", vx + vw / 2, vy + vh - 29);
  }
  if (K.busy) { ctx.fillStyle = "rgba(255,138,42,0.9)"; ctx.beginPath(); ctx.arc(vx + vw - 14, vy + 14, 4, 0, Math.PI * 2); ctx.fill(); }
}

// ---------------------------------------------------------------- the panel
function btn(ctx, node, id, x, y, w, h, text, on, fn) {
  rr(ctx, x, y, w, h, 5);
  ctx.fillStyle = on ? "#5a5a5a" : C.btn; ctx.fill();
  if (on) { ctx.strokeStyle = "#8c8c8c"; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = on ? "#ffffff" : "#d0d0d0";
  ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  hit(node, "ed:" + id, x, y, w, h, fn, "pointer");
}

function setKey(node, key, v, done) {
  const d = readEdit(node), [lo, hi] = SLIDERS[key];
  const n = key === "denoise" ? Math.round(clamp(v, lo, hi) * 100) / 100 : Math.round(clamp(v, lo, hi));
  if (d[key] !== n) writeEdit(node, { ...d, [key]: n }, done);
  else if (done) writeEdit(node, d, true);
}

function slider(ctx, node, key, x, y, w, vis) {
  const [lo, hi, label, fmt] = SLIDERS[key], d = readEdit(node), v = d[key];
  ctx.save();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label; ctx.fillText(label, x, y + 8);
  ctx.textAlign = "right"; ctx.fillText(fmt(v), x + w, y + 8);
  const ty = y + ROW_H - 9, px = x + ((v - lo) / (hi - lo)) * w;
  ctx.lineCap = "round"; ctx.lineWidth = 3;
  ctx.strokeStyle = C.track; ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x + w, ty); ctx.stroke();
  ctx.strokeStyle = C.fill; ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(px, ty); ctx.stroke();
  ctx.beginPath(); ctx.arc(px, ty, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = C.thumb; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = C.thumbEdge; ctx.stroke();
  ctx.restore();
  if (!vis) return;
  hit(node, `ed:ep:s:${key}`, x - 4, y - 2, w + 8, ROW_H, ({ ev, pos }) => {
    const now = performance.now(), last = node.__lcEditLast;                                                       // double-click = back to the default
    node.__lcEditLast = { key, t: now, x: ev.clientX, y: ev.clientY };
    if (last && last.key === key && now - last.t < 450 && Math.abs(last.x - ev.clientX) < 12 && Math.abs(last.y - ev.clientY) < 12) { node.__lcEditLast = null; setKey(node, key, DEFAULTS[key], true); return; }
    const at = (px2) => lo + clamp((px2 - x) / w, 0, 1) * (hi - lo);
    setKey(node, key, at(pos[0]), false);
    drag({ node, ev, cursor: "ew-resize", onMove: (dx) => setKey(node, key, at(pos[0] + dx), false), onUp: () => setKey(node, key, readEdit(node)[key], true) });
  }, "ew-resize");
}

export function drawEditPanel(ctx, node, px, py, pw, ph, e, getState) {
  const K = node.__lcEdit || (node.__lcEdit = {});
  if (pw < 8) return;
  ctx.save();
  ctx.beginPath(); rr(ctx, px, py, pw, ph, 6); ctx.clip();
  if (!node.__lcNoBg) { ctx.fillStyle = "#18181a"; ctx.fillRect(px, py, pw, ph); ctx.strokeStyle = C.rule; ctx.lineWidth = 1; rr(ctx, px, py, pw, ph, 6); ctx.stroke(); }
  ctx.globalAlpha = clamp((e - 0.2) / 0.8, 0, 1);
  const ix = px + 12 + (1 - e) * 48, iw = EDIT_W - 24;
  ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  const d = readEdit(node), clickable = e > 0.98, st = getState();

  ctx.fillStyle = C.head; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Edit", ix, py + 17);
  const dotX = ix + iw - 8, dotY = py + 17;
  ctx.beginPath(); ctx.arc(dotX, dotY, 5, 0, Math.PI * 2); ctx.fillStyle = d.on ? ORANGE : "#3a3a3a"; ctx.fill(); ctx.strokeStyle = "#8c8c8c"; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "right"; ctx.fillText(d.on ? "On" : "Off", dotX - 10, dotY);
  if (clickable) hit(node, "ed:ep:on", dotX - 40, dotY - 10, 50, 20, () => writeEdit(node, { ...readEdit(node), on: !readEdit(node).on }, true), "pointer");
  ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(ix, py + 29.5); ctx.lineTo(ix + iw, py + 29.5); ctx.stroke();

  let y = py + 40;
  // brush: add / erase
  const half = (iw - 6) / 2;
  if (clickable) {
    btn(ctx, node, "ep:add", ix, y, half, 28, "+  Paint", d.mode === "add", () => writeEdit(node, { ...readEdit(node), mode: "add" }, true));
    btn(ctx, node, "ep:erase", ix + half + 6, y, half, 28, "−  Erase", d.mode === "erase", () => writeEdit(node, { ...readEdit(node), mode: "erase" }, true));
  } else { rr(ctx, ix, y, iw, 28, 5); ctx.fillStyle = C.btn; ctx.fill(); }
  y += 38;
  slider(ctx, node, "size", ix, y, iw, clickable); y += ROW_H + 6;
  slider(ctx, node, "feather", ix, y, iw, clickable); y += ROW_H + 6;
  if (clickable) btn(ctx, node, "ep:reset", ix, y, iw, 28, "Reset mask", false, () => resetMask(node));
  else { rr(ctx, ix, y, iw, 28, 5); ctx.fillStyle = C.btn; ctx.fill(); }
  y += 40;

  // prompt
  ctx.fillStyle = C.head; ctx.font = "600 12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText("Prompt", ix, y + 8);
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ix, y + 19.5); ctx.lineTo(ix + iw, y + 19.5); ctx.stroke();
  y += 26;
  rr(ctx, ix, y, iw, 54, 5); ctx.fillStyle = C.well; ctx.fill(); ctx.strokeStyle = C.wellEdge; ctx.stroke();
  ctx.font = "11px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillStyle = d.prompt ? "#ececec" : "#777";
  const words = (d.prompt || "Click here. Type the trigger word of your LoRA and what you want.").split(/\s+/);
  let line = "", ly = y + 6, lines = 0;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > iw - 16 && line) { ctx.fillText(line, ix + 8, ly); ly += 14; lines++; line = w; if (lines >= 3) { line = ""; break; } } else line = t;
  }
  if (line && lines < 3) ctx.fillText(line, ix + 8, ly);
  if (clickable) hit(node, "ed:ep:prompt", ix, y, iw, 54, ({ ev }) => {
    const set = (s) => { if (s !== null && s !== undefined) writeEdit(node, { ...readEdit(node), prompt: String(s).slice(0, 800) }, true); };
    if (app.canvas && app.canvas.prompt) app.canvas.prompt("Edit prompt", readEdit(node).prompt, set, ev); else set(window.prompt("Edit prompt", readEdit(node).prompt));
  }, "text");
  y += 62;
  slider(ctx, node, "denoise", ix, y, iw, clickable); y += ROW_H + 8;

  // status
  ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  const hasSrc = !!(st && st.s);
  const msg = K.error ? K.error : !hasSrc ? "Choose a picture first." : K.busy ? "Saving the mask…" : d.has ? "Mask saved. Press Run: only the painted area is redrawn." : "Nothing painted yet.";
  ctx.fillStyle = K.error ? "#e07a5f" : d.has ? "#ffcf9e" : C.label;
  const words2 = msg.split(" "); let l2 = "", yy = y;
  for (const w of words2) { const t = l2 ? l2 + " " + w : w; if (ctx.measureText(t).width > iw && l2) { ctx.fillText(l2, ix, yy); yy += 13; l2 = w; } else l2 = t; }
  if (l2) ctx.fillText(l2, ix, yy);
  ctx.restore();
}
