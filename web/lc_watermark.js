import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { DISPLAY, UI, loadBrandFonts } from "./lc_brand.js";
import { hit, drag, wheelZone } from "./lc_interact.js";

// Watermark node: an image loader with a drag-to-crop, drawn on the node itself exactly like the Edit Page
// (same canvas drawing + mouse system that already works there; no HTML block inside the node, so nothing can
// end up narrow, stale or oversized). //  - the picture frame fills the node (anchored to its corners): drag the node's corner and the frame grows with it
//  - Upload / From input folder: pick the transparent PNG
//  - drag on the picture: draw the crop box; pull its corners / sides; drag inside it to move it
//  - wheel: zoom the picture inside the crop (around the crop centre);  Shift + drag: slide the picture inside the crop
//  - the node's own Angle slider turns the picture around the exact centre of the crop (the orange cross)
//  - Reset clears crop, zoom and angle;  Placement folds open corner / size / opacity / margin
// Stored: crop as JSON (fractions of the mark + zoom) in the hidden crop_box value, the picture name in the hidden watermark value.
const ORANGE = "#ff8a2a", CREAM = "#f3ead8", PANEL = "#18181a", RULE = "#444444", BTN = "#383838", BTN_HOT = "#4a4a4a", WELL = "#1d1d1d", WELL_EDGE = "#3d3d3d", LABEL = "#9c9c9c";
const GRAB = 9, MIN_PX = 20, MIN_W = 300, PAD = 10;
const FH_MIN = 240;                                                 // the picture frame fills the node (anchored to its corners); never smaller than this tall
const Y_BTN1 = 30, Y_FRAME = 66, BH = 28, BELOW = 8 + BH + 6 + 20, HT_MIN = Y_FRAME + FH_MIN + BELOW;
const PLACE = ["position", "size_percent", "opacity_percent", "margin_percent", "free_x_percent", "free_y_percent"];

const wget = (node, n) => node.widgets && node.widgets.find((w) => w.name === n);
const num = (node, n, d = 0) => { const w = wget(node, n); const v = w ? Number(w.value) : NaN; return Number.isFinite(v) ? v : d; };
function put(node, n, v) {
  const w = wget(node, n); if (!w) return;
  w.value = v;
  if (w.callback) { try { w.callback(v, app.canvas, node); } catch (e) { /* ignore */ } }
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function hideWidget(w) {
  if (!w) return;
  if (!w._lcKept) w._lcKept = { cs: own(w, "computeSize") ? w.computeSize : null, cl: own(w, "computeLayoutSize") ? w.computeLayoutSize : null, dr: own(w, "draw") ? w.draw : null, had: [own(w, "computeSize"), own(w, "computeLayoutSize"), own(w, "draw")] };
  w.hidden = true; w.computeSize = () => [0, -4]; w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 }); w.draw = () => {};
}
function showWidget(w) {
  if (!w || !w._lcKept) return;
  const k = w._lcKept; w.hidden = false;
  if (k.had[0]) w.computeSize = k.cs; else delete w.computeSize;
  if (k.had[1]) w.computeLayoutSize = k.cl; else delete w.computeLayoutSize;
  if (k.had[2]) w.draw = k.dr; else delete w.draw;
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
const R = (a, x, y) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];     // clockwise on screen (y down)
const HID = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const handlesOf = (b) => HID.map(([sx, sy]) => [b.x + (sx + 1) * b.w / 2, b.y + (sy + 1) * b.h / 2]);

function setup(node) {
  loadBrandFonts();
  let FW = 220, FH = FH_MIN;                                        // the frame's size right now (set from the node's size every draw)
  const S = { img: null, name: "", C: null, s: 1, locked: false, box: null, msg: "Upload a transparent PNG, or pick one from the input folder", hov: "", placeOpen: false };
  node.__wm = S;

  const getCrop = () => { try { const w = wget(node, "crop_box"); const d = w && w.value ? JSON.parse(w.value) : null; return d && d.w > 0 && d.h > 0 ? d : null; } catch (e) { return null; } };
  const cropOrFull = () => getCrop() || { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  const getZ = () => { const c = getCrop(); const z = c ? Number(c.z) : 1; return Number.isFinite(z) && z > 0 ? z : 1; };
  const P = () => { const c = cropOrFull(); return { x: S.img.naturalWidth * c.cx, y: S.img.naturalHeight * c.cy }; };
  const dimsPx = () => { const c = cropOrFull(); return { w: S.img.naturalWidth * c.w, h: S.img.naturalHeight * c.h }; };
  const theta = () => num(node, "angle_degrees", 0) * Math.PI / 180;
  const modified = () => S.img && (!!getCrop() || Math.abs(num(node, "angle_degrees", 0)) > 0.001);
  const redraw = () => { try { node.setDirtyCanvas(true, true); } catch (e) { /* ignore */ } };

  function store(p, w, h, z) {
    const iw = S.img.naturalWidth, ih = S.img.naturalHeight;
    put(node, "crop_box", JSON.stringify({ cx: +(p.x / iw).toFixed(5), cy: +(p.y / ih).toFixed(5), w: +Math.max(0.01, w / iw).toFixed(5), h: +Math.max(0.01, h / ih).toFixed(5), z: +(z || getZ()).toFixed(4) }));
  }
  function fit() {
    if (!S.img) return;
    const m = 14;
    S.s = Math.max(0.0001, Math.min((FW - 2 * m) / S.img.naturalWidth, (FH - 2 * m) / S.img.naturalHeight));
    S.C = [FW / 2, FH / 2];
  }
  function resetAll() {
    if (!S.img) return;
    put(node, "crop_box", ""); put(node, "angle_degrees", 0); fit(); redraw();
    if (app.graph && app.graph.change) app.graph.change();
  }
  function placeBox(base, cx2, cy2, w2px, h2px) {                  // box to a new place; the picture stays where it is on screen
    const ang = theta(), s = S.s, z = getZ();
    const [ddx, ddy] = R(-ang, (cx2 - base.C[0]) / (s * z), (cy2 - base.C[1]) / (s * z));
    S.C = [cx2, cy2];
    store({ x: base.P.x + ddx, y: base.P.y + ddy }, w2px / s, h2px / s);
  }
  const hitHandle = (px, py) => {
    if (!S.box || !getCrop()) return null;
    const hs = handlesOf(S.box);
    for (let i = 0; i < hs.length; i++) if (Math.abs(px - hs[i][0]) <= GRAB && Math.abs(py - hs[i][1]) <= GRAB) return HID[i];
    return null;
  };
  const insideBox = (px, py) => S.box && getCrop() && px >= S.box.x && px <= S.box.x + S.box.w && py >= S.box.y && py <= S.box.y + S.box.h;

  // ---- picking the picture
  function load() {
    const w = wget(node, "watermark"), name = w ? String(w.value || "") : "";
    if (!name || name === "none") { S.img = null; S.name = ""; S.msg = "Upload a transparent PNG, or pick one from the input folder"; redraw(); return; }
    if (name === S.name && S.img) { redraw(); return; }
    S.name = name; S.msg = "Loading…"; redraw();
    const i = new Image();
    const sl = name.lastIndexOf("/"), fn = sl >= 0 ? name.slice(sl + 1) : name, sub = sl >= 0 ? name.slice(0, sl) : "";
    i.onload = () => { S.img = i; fit(); redraw(); };
    i.onerror = () => { S.img = null; S.msg = `Could not load "${fn}". Pick another picture.`; redraw(); };
    i.src = api.apiURL(`/view?filename=${encodeURIComponent(fn)}&type=input&subfolder=${encodeURIComponent(sub)}&rand=${Date.now()}`);
  }
  function setMark(name) {                                          // a new picture always starts clean
    put(node, "watermark", name); put(node, "crop_box", ""); put(node, "angle_degrees", 0);
    S.img = null; S.name = ""; S.C = null; load();
    if (app.graph && app.graph.change) app.graph.change();
  }
  function upload() {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/png,image/webp";
    inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      try {
        const fd = new FormData(); fd.append("image", f); fd.append("type", "input"); fd.append("overwrite", "true");
        const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!r.ok) throw new Error(`upload failed (${r.status})`);
        const j = await r.json();
        setMark(j.subfolder ? `${j.subfolder}/${j.name}` : j.name);
      } catch (e) { S.msg = `Upload did not work: ${e.message || e}`; redraw(); }
    };
    inp.click();
  }
  async function pickFolder(ev) {
    try {
      const r = await api.fetchApi("/lightcraft/input_images"), j = await r.json();
      if (!j.files || !j.files.length) { S.img = null; S.msg = "No PNG / WebP files in the input folder yet. Use Upload."; redraw(); return; }
      const LG = window.LiteGraph;
      if (LG && LG.ContextMenu) new LG.ContextMenu(j.files, { event: ev, callback: (v) => setMark(typeof v === "string" ? v : (v && (v.content || v.value)) || "") });
    } catch (e) { S.msg = "Could not read the input folder. Use Upload."; redraw(); }
  }
  function togglePlace() {
    S.placeOpen = !S.placeOpen;
    for (const n of PLACE) { const w = wget(node, n); if (S.placeOpen) showWidget(w); else hideWidget(w); }
    try { const h = node.computeSize()[1]; node.setSize([node.size[0], Math.max(h, node.size[1] + (h - (S.lastCs || h)))]); S.lastCs = h; } catch (e) { /* ignore */ }
    redraw();
  }

  // ---- drawing + mouse
  function button(ctx, id, x, y, w, label, { on = false, hot = false, fn }) {
    rr(ctx, x, y, w, BH, 6);
    const hv = S.hov === id;
    if (on) { ctx.fillStyle = CREAM; ctx.fill(); }
    else if (hot) { ctx.save(); ctx.shadowColor = "rgba(255,138,42,0.55)"; ctx.shadowBlur = 10; ctx.fillStyle = "#4a3220"; ctx.fill(); ctx.restore(); ctx.strokeStyle = ORANGE; ctx.lineWidth = 1; ctx.stroke(); }
    else { ctx.fillStyle = hv ? BTN_HOT : BTN; ctx.fill(); }
    ctx.font = `700 13px ${UI}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = on ? "#1e1e1e" : hot ? "#ffe7d1" : "#d4d4d4";
    ctx.fillText(label, x + w / 2, y + BH / 2 + 1);
    hit(node, id, x, y, w, BH, ({ ev }) => fn(ev), "pointer", () => { if (S.hov !== id) { S.hov = id; redraw(); } return "pointer"; });
  }
  const wrap = (ctx, text, maxW) => {
    const out = []; let line = "";
    for (const wd of String(text).split(" ")) { const t = line ? line + " " + wd : wd; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = wd; } else line = t; }
    if (line) out.push(line); return out;
  };

  function drawFrame(ctx, fx, fy) {
    ctx.save(); ctx.translate(fx, fy);
    rr(ctx, 0, 0, FW, FH, 6); ctx.fillStyle = WELL; ctx.fill(); ctx.strokeStyle = WELL_EDGE; ctx.lineWidth = 1; ctx.stroke();
    ctx.save(); rr(ctx, 1, 1, FW - 2, FH - 2, 5); ctx.clip();
    if (!S.img) {
      S.box = null;
      ctx.fillStyle = LABEL; ctx.font = `500 12px ${UI}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const ls = wrap(ctx, S.msg, FW - 24); ls.forEach((l, i) => ctx.fillText(l, FW / 2, FH / 2 + (i - (ls.length - 1) / 2) * 16));
    } else {
      if (!S.C) fit();
      const p = P(), d = dimsPx(), ang = theta(), [cx, cy] = S.C, s = S.s, z = getZ();
      const bw = d.w * s, bh = d.h * s, bx = cx - bw / 2, by = cy - bh / 2;
      S.box = { x: bx, y: by, w: bw, h: bh };
      const paintImage = () => {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.translate(-p.x * s * z, -p.y * s * z);
        ctx.drawImage(S.img, 0, 0, S.img.naturalWidth * s * z, S.img.naturalHeight * s * z); ctx.restore();
      };
      ctx.save(); ctx.globalAlpha = 0.4; paintImage(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
      for (let yy = 0; yy < bh; yy += 8) for (let xx = 0; xx < bw; xx += 8) { ctx.fillStyle = ((xx + yy) / 8) % 2 ? "#2c2c30" : "#242428"; ctx.fillRect(bx + xx, by + yy, 8, 8); }
      paintImage(); ctx.restore();
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.strokeRect(bx, by, bw, bh);
      ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let k = 1; k < 3; k++) { ctx.moveTo(bx + bw * k / 3, by); ctx.lineTo(bx + bw * k / 3, by + bh); ctx.moveTo(bx, by + bh * k / 3); ctx.lineTo(bx + bw, by + bh * k / 3); }
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,138,42,0.95)"; ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();
      ctx.fillStyle = ORANGE;
      if (getCrop()) for (const [hx, hy] of handlesOf(S.box)) ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
      const lab = `${Math.round(d.w)} × ${Math.round(d.h)}`;
      ctx.font = `600 11px ${UI}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const lw = ctx.measureText(lab).width + 10, ly = Math.max(3, by - 17);
      ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.fillRect(bx, ly, lw, 15); ctx.fillStyle = "#ffffff"; ctx.fillText(lab, bx + 5, ly + 8);
    }
    ctx.restore(); ctx.restore();
  }

  function frameDown({ ev, pos }, fx, fy) {
    if (!S.img || !S.box) return;
    const p0 = [pos[0] - fx, pos[1] - fy];
    const base = { P: P(), C: [...S.C] }, b = { ...S.box };
    const h = hitHandle(p0[0], p0[1]);
    const kind = h ? "size" : (insideBox(p0[0], p0[1]) && ev.shiftKey) ? "pan" : insideBox(p0[0], p0[1]) ? "move" : "draw";
    const ar = kind === "size" ? b.w / b.h : (kind === "draw" && S.locked ? b.w / b.h : 0);
    drag({ node, ev, cursor: kind === "move" || kind === "pan" ? "move" : "crosshair", onMove: (dx, dy) => {
      const px = p0[0] + dx, py = p0[1] + dy;
      const clx = (v) => Math.max(0, Math.min(FW, v)), cly = (v) => Math.max(0, Math.min(FH, v));
      if (kind === "pan") {
        const [ddx, ddy] = R(-theta(), dx / (S.s * getZ()), dy / (S.s * getZ()));
        store({ x: base.P.x - ddx, y: base.P.y - ddy }, b.w / S.s, b.h / S.s);
      } else if (kind === "move") {
        const nx = Math.max(b.w / 2, Math.min(FW - b.w / 2, b.x + b.w / 2 + dx)), ny = Math.max(b.h / 2, Math.min(FH - b.h / 2, b.y + b.h / 2 + dy));
        placeBox(base, nx, ny, b.w, b.h);
      } else if (kind === "draw") {
        let x0 = clx(p0[0]), y0 = cly(p0[1]), x1 = clx(px), y1 = cly(py);
        if (ar) { const w = Math.abs(x1 - x0), hh = w / ar; y1 = y0 + (y1 >= y0 ? hh : -hh); }
        const lx = Math.min(x0, x1), ly = Math.min(y0, y1), w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
        if (w >= 3 && hh >= 3) placeBox(base, lx + w / 2, ly + hh / 2, w, hh);
      } else {
        let x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h;
        const [sx, sy] = h, qx = clx(px), qy = cly(py);
        if (sx < 0) x0 = Math.min(qx, x1 - MIN_PX); if (sx > 0) x1 = Math.max(qx, x0 + MIN_PX);
        if (sy < 0) y0 = Math.min(qy, y1 - MIN_PX); if (sy > 0) y1 = Math.max(qy, y0 + MIN_PX);
        if (S.locked) {
          let w = x1 - x0, hh = y1 - y0;
          if (sy && !sx) w = hh * ar; else hh = w / ar;
          if (sx < 0) x0 = x1 - w; else if (sx > 0) x1 = x0 + w; else { const m = b.x + b.w / 2; x0 = m - w / 2; x1 = m + w / 2; }
          if (sy < 0) y0 = y1 - hh; else if (sy > 0) y1 = y0 + hh; else { const m = b.y + b.h / 2; y0 = m - hh / 2; y1 = m + hh / 2; }
        }
        placeBox(base, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0);
      }
    } });
  }
  function frameCursor(pos, fx, fy) {
    if (!S.img) return "default";
    const px = pos[0] - fx, py = pos[1] - fy, h = hitHandle(px, py);
    return h ? (h[0] && h[1] ? (h[0] * h[1] > 0 ? "nwse-resize" : "nesw-resize") : h[0] ? "ew-resize" : "ns-resize") : insideBox(px, py) ? "move" : "crosshair";
  }
  function zoomBy(dy) {
    if (!S.img) return;
    const c = cropOrFull(), z = Math.max(0.2, Math.min(8, getZ() * Math.exp(-dy * 0.0015)));
    put(node, "crop_box", JSON.stringify({ cx: c.cx, cy: c.cy, w: c.w, h: c.h, z: +z.toFixed(4) }));
    redraw(); if (app.graph && app.graph.change) app.graph.change();
  }

  // the editor itself: one custom widget at the bottom of the node, always the same height
  const widget = {
    name: "mark_editor", type: "mark_editor", value: "", options: { serialize: false }, serialize: false,
    computeSize: (width) => [width, HT_MIN],
    computeLayoutSize: () => ({ minHeight: HT_MIN, minWidth: 0 }),
    draw(ctx, n, width, y) {
      const W = n.size[0], avail = Math.max(HT_MIN, n.size[1] - y - 6);
      const nfw = Math.max(120, W - 2 * PAD - 8), nfh = Math.max(FH_MIN, avail - Y_FRAME - BELOW);
      if (nfw !== FW || nfh !== FH) { FW = nfw; FH = nfh; fit(); }          // the node was resized: the frame follows, the picture is fitted again
      const fx = PAD + 4, fy = y + Y_FRAME, Y_B2 = Y_FRAME + FH + 8, Y_IN = Y_B2 + BH + 6;
      ctx.save();
      rr(ctx, 4, y, W - 8, avail - 2, 6); ctx.fillStyle = PANEL; ctx.fill(); ctx.strokeStyle = RULE; ctx.lineWidth = 1; ctx.stroke();
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = `400 17px ${DISPLAY}`; ctx.fillStyle = ORANGE; ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
      ctx.fillText("Watermark", PAD + 4, y + 17);
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.shadowColor = "transparent";
      ctx.font = `500 11px ${UI}`; ctx.fillStyle = LABEL; ctx.textAlign = "right";
      ctx.fillText("drag to crop · wheel zooms", W - PAD - 4, y + 17);
      const bw = (W - 2 * PAD - 8 - 8) / 2, x0 = PAD + 4;
      button(ctx, "wm:up", x0, y + Y_BTN1, bw, "Upload…", { fn: upload });
      button(ctx, "wm:pick", x0 + bw + 8, y + Y_BTN1, bw, "From input folder…", { fn: pickFolder });
      drawFrame(ctx, fx, fy);
      hit(node, "wm:frame", fx, fy, FW, FH, (a) => frameDown(a, fx, fy), "crosshair", (pos) => frameCursor(pos, fx, fy));
      wheelZone(node, "wm:wheel", fx, fy, FW, FH, (dy) => zoomBy(dy));
      const b3 = (W - 2 * PAD - 16 - 8) / 3;
      button(ctx, "wm:aspect", x0, y + Y_B2, b3, S.locked ? "Aspect: locked" : "Aspect: free", { on: S.locked, fn: () => { S.locked = !S.locked; redraw(); } });
      button(ctx, "wm:place", x0 + b3 + 8, y + Y_B2, b3, S.placeOpen ? "Placement ▴" : "Placement ▾", { fn: togglePlace });
      button(ctx, "wm:reset", x0 + 2 * (b3 + 8), y + Y_B2, b3, "Reset", { hot: !!modified(), fn: resetAll });
      ctx.font = `500 11px ${UI}`; ctx.fillStyle = LABEL; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      if (S.img) {
        const d = dimsPx(), a = num(node, "angle_degrees", 0), nm = S.name.split("/").pop();
        let t = `${nm} · ${Math.round(d.w)} × ${Math.round(d.h)} px`;
        if (Math.abs(getZ() - 1) > 0.001) t += ` · zoom ${Math.round(getZ() * 100)}%`;
        if (Math.abs(a) > 0.001) t += ` · ${a.toFixed(1)}°`;
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y + Y_IN - 8, W - 2 * PAD - 8, 20); ctx.clip(); ctx.fillText(t, x0, y + Y_IN + 2); ctx.restore();
      }
      ctx.restore();
    },
  };
  node.__lcHoverOut = () => { if (S.hov) { S.hov = ""; redraw(); } };
  return { widget, load };
}

app.registerExtension({
  name: "LightCraft.Watermark",
  nodeCreated(node) {
    if (node.comfyClass !== "LightCraftWatermark") return;
    try {
      hideWidget(wget(node, "crop_box")); hideWidget(wget(node, "watermark"));          // the editor owns these two values
      for (const n of PLACE) hideWidget(wget(node, n));                                  // folded away behind the Placement button
      const ed = setup(node);
      if (node.addCustomWidget) node.addCustomWidget(ed.widget); else node.widgets.push(ed.widget);
      const ang = wget(node, "angle_degrees");
      if (ang) { const cb = ang.callback; ang.callback = function () { const r = cb ? cb.apply(this, arguments) : undefined; try { node.setDirtyCanvas(true, true); } catch (e) { /* cosmetic */ } return r; }; }
      const onCfg = node.onConfigure;
      node.onConfigure = function () {
        const r = onCfg ? onCfg.apply(this, arguments) : undefined;
        for (const w of node.widgets || []) {                                            // values saved by an older version of this node: put back what does not fit
          try {
            if (w.type === "combo" && w.options && Array.isArray(w.options.values) && !w.options.values.includes(w.value)) w.value = w.options.values[0];
            else if (w.type === "number" && !Number.isFinite(Number(w.value))) w.value = w.options && Number.isFinite(w.options.default) ? w.options.default : (w.options && Number.isFinite(w.options.min) ? w.options.min : 0);
          } catch (e) { /* ignore */ }
        }
        for (const n of PLACE) hideWidget(wget(node, n));
        setTimeout(ed.load, 60); return r;
      };
      const onRes = node.onResize;
      node.onResize = function (size) { if (size && size[0] < MIN_W) size[0] = MIN_W; return onRes ? onRes.apply(this, arguments) : undefined; };
      node.setSize([Math.max(MIN_W, node.size[0]), Math.max(node.computeSize()[1], 460)]);
      if (node.__wm) node.__wm.lastCs = node.computeSize()[1];
      setTimeout(ed.load, 200);
    } catch (e) {
      console.error("[LightCraft] the Watermark editor could not start; the node still works with its plain fields:", e);
    }
  },
});
