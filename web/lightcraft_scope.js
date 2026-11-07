import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { C, M, FONT, rr } from "./lightcraft_ui.js";
import { hit } from "./lc_interact.js";
import { drawHistHelp, helpClick, helpReset, analysisFor, overlayFor, drawHistogram, drawCheckbox, percent, fmtPercent, CLIP_LO, CLIP_HI } from "./lc_scope.js";

// LightCraft Scope: the picture, its histogram, and Lightroom's clipping warnings. Click the little
// triangles in the histogram's corners (or the two boxes) to paint crushed blacks blue and blown whites red.

const CLS = "LightCraftScope";
const HIST_H = 84, ROW_H = 26, MIN_W = 300;
const props = (node) => (node.properties = node.properties || {});

function previewH(node) {
  const S = node.__sc, w = node.size[0] - 2 * M;
  if (!S.img) return 150;
  const asp = (S.img.naturalWidth || S.img.width) / Math.max(1, S.img.naturalHeight || S.img.height);
  return Math.round(Math.min(520, Math.max(110, w / asp)));
}
const bodyH = (node) => 8 + previewH(node) + 8 + HIST_H + 6 + ROW_H + 6;

function fit(node) {
  const h = bodyH(node) + (LiteGraph_titleH());
  if (Math.abs(node.size[1] - h) > 1) node.setSize([node.size[0], h]);
}
const LiteGraph_titleH = () => ((window.LiteGraph && window.LiteGraph.NODE_TITLE_HEIGHT) || 30) + 4;

function drawScope(ctx, node) {
  const S = node.__sc, p = props(node), w = node.size[0], iw = w - 2 * M;
  ctx.save();
  const py = 8, ph = previewH(node);
  rr(ctx, M, py, iw, ph, 6); ctx.fillStyle = "#141414"; ctx.fill();
  const an = S.img ? analysisFor(S.img) : null;
  if (S.img) {
    const asp = (S.img.naturalWidth || S.img.width) / Math.max(1, S.img.naturalHeight || S.img.height);
    let dw = iw, dh = iw / asp;
    if (dh > ph) { dh = ph; dw = ph * asp; }
    const dx = M + (iw - dw) / 2, dy = py + (ph - dh) / 2;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(S.img, dx, dy, dw, dh);
    if (p.lc_clip_lo || p.lc_clip_hi) { const o = overlayFor(S.img, !!p.lc_clip_lo, !!p.lc_clip_hi); if (o) ctx.drawImage(o, dx, dy, dw, dh); }
  } else {
    ctx.font = FONT; ctx.fillStyle = C.label; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Run the workflow to see the picture here.", w / 2, py + ph / 2);
  }
  const hy = py + ph + 8;
  const rects = drawHistogram(ctx, M, hy, iw, HIST_H, an, { lo: !!p.lc_clip_lo, hi: !!p.lc_clip_hi, help: !!S.help });
  const toggle = (key) => () => { p[key] = !p[key]; node.setDirtyCanvas(true, true); };
  hit(node, "ed:clip:help", rects.help[0], rects.help[1], rects.help[2], rects.help[3], () => { helpReset(); S.help = !S.help; node.setDirtyCanvas(true, true); }, "pointer");
  hit(node, "ed:clip:tlo", rects.lo[0], rects.lo[1], rects.lo[2], rects.lo[3], toggle("lc_clip_lo"), "pointer");
  hit(node, "ed:clip:thi", rects.hi[0], rects.hi[1], rects.hi[2], rects.hi[3], toggle("lc_clip_hi"), "pointer");
  const ry = hy + HIST_H + 6 + 6;
  ctx.font = "10px Inter, 'Segoe UI', sans-serif"; ctx.textBaseline = "middle"; ctx.fillStyle = "#8a8a92";
  if (an) {
    ctx.textAlign = "left"; ctx.fillText(fmtPercent(percent(an.nLo, an.n)), M + 4, hy + HIST_H - 9);
    ctx.textAlign = "right"; ctx.fillText(fmtPercent(percent(an.nHi, an.n)), M + iw - 4, hy + HIST_H - 9);
  }
  drawCheckbox(ctx, M, ry, !!p.lc_clip_lo, CLIP_LO, "Shadows");
  hit(node, "ed:clip:lo", M - 2, ry - 3, 90, 18, toggle("lc_clip_lo"), "pointer");
  drawCheckbox(ctx, M + 110, ry, !!p.lc_clip_hi, CLIP_HI, "Highlights");
  hit(node, "ed:clip:hi", M + 108, ry - 3, 90, 18, toggle("lc_clip_hi"), "pointer");
  if (S.help) {
    const r = drawHistHelp(ctx, M, py, iw, Math.min(ph + HIST_H + 40, 420));
    hit(node, "ed:clip:helpcard", r[0], r[1], r[2], r[3], () => { S.help = helpClick(); node.setDirtyCanvas(true, true); }, "pointer");
  } else if (node.__lcHits) node.__lcHits.delete("ed:clip:helpcard");
  ctx.restore();
}

function setupNode(node) {
  if (node.__sc) return;
  node.__sc = { img: null };
  node.color = "#1e1e1e"; node.bgcolor = C.panel;
  node.size = [Math.max(MIN_W, node.size[0] || 0, 360), node.size[1]];
  fit(node);
  node.onDrawForeground = function (ctx) { drawScope(ctx, this); };
  const prevResize = node.onResize;
  node.onResize = function () { if (prevResize) prevResize.apply(this, arguments); fit(this); };
  const prevExec = node.onExecuted;
  node.onExecuted = function (msg) {
    if (prevExec) prevExec.apply(this, arguments);
    const info = msg && msg.lc_scope && msg.lc_scope[0];
    if (!info) return;
    const img = new Image();
    img.onload = () => { this.__sc.img = img; fit(this); this.setDirtyCanvas(true, true); };
    img.src = api.apiURL(`/view?filename=${encodeURIComponent(info.filename)}&type=${info.type || "temp"}&subfolder=${encodeURIComponent(info.subfolder || "")}&r=${Date.now()}`);
  };
}

app.registerExtension({
  name: "LightCraft.Scope",
  nodeCreated(node) {
    if ((node.comfyClass || node.type) !== CLS) return;
    try { setupNode(node); } catch (e) { console.error("[LightCraft] Scope setup failed", e); }
  },
});
