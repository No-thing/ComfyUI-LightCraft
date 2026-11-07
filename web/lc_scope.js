// Histogram + clipping warnings (Lightroom Classic style), shared by the Crop & Compare panel and the
// standalone LightCraft Scope node. `analyze` is pure (no DOM) so it can be unit-tested.
//   shadows  = blue overlay,  highlights = red overlay.  A pixel counts as clipped only when ALL channels are
//   at (or within one step of) pure black / pure white, so saturated colours and gradients are not flagged.

export const CLIP_LO = "#3a7bff", CLIP_HI = "#ff3b30";
const LO_RGB = [58, 123, 255], HI_RGB = [255, 59, 48];

export function analyze(data, w, h, hiT = 254, loT = 1) {
  const n = w * h;
  const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
  const hi = new Uint8Array(n), lo = new Uint8Array(n);
  let nHi = 0, nLo = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    hist.r[r]++; hist.g[g]++; hist.b[b]++;
    hist.l[(r * 54 + g * 183 + b * 19) >> 8]++;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mn >= hiT) { hi[p] = 1; nHi++; }          // blown white = every channel at the top; one saturated channel is just a strong colour
    if (mx <= loT) { lo[p] = 1; nLo++; }          // crushed black = every channel at the bottom
  }
  return { w, h, n, hist, hi, lo, nHi, nLo };
}

// RGBA bytes for the overlay: only the wanted warnings are painted, everything else is transparent
export function overlayRGBA(an, showLo, showHi) {
  const out = new Uint8ClampedArray(an.n * 4);
  for (let p = 0, i = 0; p < an.n; p++, i += 4) {
    const c = showHi && an.hi[p] ? HI_RGB : showLo && an.lo[p] ? LO_RGB : null;
    if (c) { out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255; }
  }
  return out;
}

export const percent = (count, n) => (n ? (100 * count) / n : 0);
export const fmtPercent = (v) => (v <= 0 ? "0%" : v < 0.1 ? "<0.1%" : v < 10 ? v.toFixed(1) + "%" : Math.round(v) + "%");

// ---- canvas side (browser only)
const analyses = new WeakMap();
const overlays = new WeakMap();

export function analysisFor(img, maxSide = 2048) {
  if (!img) return null;
  const hit = analyses.get(img);
  if (hit) return hit;
  try {
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return null;
    const k = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0, w, h);
    const an = analyze(x.getImageData(0, 0, w, h).data, w, h);
    analyses.set(img, an);
    return an;
  } catch (e) { return null; }       // e.g. a picture the browser will not let us read
}

export function overlayFor(img, showLo, showHi) {
  const an = analysisFor(img);
  if (!an || (!showLo && !showHi)) return null;
  const key = (showLo ? "l" : "") + (showHi ? "h" : "");
  let m = overlays.get(img);
  if (!m) overlays.set(img, (m = {}));
  if (m[key]) return m[key];
  const c = document.createElement("canvas");
  c.width = an.w; c.height = an.h;
  c.getContext("2d").putImageData(new ImageData(overlayRGBA(an, showLo, showHi), an.w, an.h), 0, 0);
  return (m[key] = c);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

// The histogram with Lightroom's two warning triangles in its top corners. Returns the two hit rectangles.
// `on` says which overlays are switched on (their triangle gets a white outline); a triangle is filled with
// its warning colour while that kind of clipping exists in the picture.
export function drawHistogram(ctx, x, y, w, h, an, on = {}) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 4); ctx.fillStyle = "#121214"; ctx.fill();
  ctx.clip();
  if (an) {
    let peak = 1;                                         // ignore the end bins, they are where clipping piles up
    for (const k of ["r", "g", "b", "l"]) for (let i = 1; i < 255; i++) peak = Math.max(peak, an.hist[k][i]);
    const plot = (arr, style) => {
      ctx.fillStyle = style;
      ctx.beginPath(); ctx.moveTo(x, y + h);
      for (let px = 0; px <= w; px++) {
        const v = arr[Math.min(255, Math.floor((px / w) * 256))];
        ctx.lineTo(x + px, y + h - Math.min(1, Math.sqrt(v / peak)) * (h - 3));
      }
      ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill();
    };
    plot(an.hist.l, "rgba(200,200,200,0.38)");
    ctx.globalCompositeOperation = "lighter";
    plot(an.hist.r, "rgba(255,60,60,0.5)");
    plot(an.hist.g, "rgba(60,220,90,0.5)");
    plot(an.hist.b, "rgba(70,110,255,0.5)");
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();
  const s = Math.max(9, Math.min(13, h * 0.3)), pad = 4;
  const tri = (cx, cy, dir, color, lit, active) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx + dir * s, cy); ctx.lineTo(cx, cy + s); ctx.closePath();
    ctx.fillStyle = lit ? color : "#3a3a3e"; ctx.fill();
    ctx.strokeStyle = active ? "#ffffff" : "#6a6a70"; ctx.lineWidth = active ? 1.5 : 1; ctx.stroke();
    ctx.restore();
  };
  tri(x + pad, y + pad, 1, CLIP_LO, an && an.nLo > 0, on.lo);
  tri(x + w - pad, y + pad, -1, CLIP_HI, an && an.nHi > 0, on.hi);
  const hr = 7, hcx = x + w / 2, hcy = y + pad + hr;                                    // the "?" that opens the explainer
  ctx.save();
  ctx.beginPath(); ctx.arc(hcx, hcy, hr, 0, Math.PI * 2); ctx.fillStyle = on.help ? "#ff8a2a" : "#2a2a2e"; ctx.fill();
  ctx.strokeStyle = on.help ? "#ffffff" : "#6a6a70"; ctx.lineWidth = 1; ctx.stroke();
  ctx.font = "700 10px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = on.help ? "#101012" : "#d8d8d8";
  ctx.fillText("?", hcx, hcy + 0.5);
  ctx.restore();
  return { help: [hcx - hr - 2, hcy - hr - 2, 2 * hr + 4, 2 * hr + 4], lo: [x, y, s + 2 * pad, s + 2 * pad], hi: [x + w - s - 2 * pad, y, s + 2 * pad, s + 2 * pad] };
}

// a small checkbox with a label and a dot in the warning's colour (the caller registers the mouse region)
export function drawCheckbox(ctx, x, y, on, color, label) {
  const ORANGE = "#ff8a2a";
  ctx.save();
  roundRect(ctx, x, y, 12, 12, 3);
  ctx.fillStyle = "#101012"; ctx.fill(); ctx.strokeStyle = on ? ORANGE : "#55555c"; ctx.lineWidth = 1.2; ctx.stroke();
  if (on) { ctx.strokeStyle = ORANGE; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(x + 2.8, y + 6.4); ctx.lineTo(x + 5.2, y + 8.8); ctx.lineTo(x + 9.4, y + 3.6); ctx.stroke(); }
  ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = on ? "#ececec" : "#9c9c9c";
  ctx.fillText(label, x + 17, y + 6.5);
  if (color) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 17 + ctx.measureText(label).width + 6, y + 6.5, 2.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

// ---- the "what is this?" card for the histogram, in plain words. The caller draws it last (over everything) while the "?" is on.
const HELP = [
  ["h", "What is this graph? Your ComfyUI is not broken."],
  ["p", "It is a histogram. It shows how much of the picture is dark, middle or bright. Left side = darks, right side = brights. A tall hill means lots of pixels at that brightness. Red, green and blue hills are the colour channels, the grey one is the overall brightness."],
  ["h", "Why is my picture red or blue?"],
  ["p", "Click a little triangle (or tick Shadows / Highlights) and the picture is painted with warnings. BLUE = crushed shadows, pure black. RED = blown highlights, pure white. It is only a see-through overlay: it never changes your picture or the saved file. Click again to turn it off."],
  ["h", "What does clipping mean?"],
  ["p", "Every pixel has a brightness from 0 (black) to 255 (white). Clipping means a pixel hit the end of that scale, so everything beyond it is cut off and flattened to one value. The triangle lights up when something is clipped and the % beside it tells how much of the picture."],
  ["h", "Black is fine, white is not."],
  ["p", "Pure black is rarely a problem: dark corners, night scenes and deep contrast are often meant to be black and you lose almost nothing you could see. Pure white is different: blown highlights become flat white blobs with no skin, cloth or sky texture left, and that detail cannot be brought back. Small red spots on lights or sparkles are fine. Red on faces, skin or clothes: lower the exposure or highlights."],
];

function wrap(ctx, text, maxW) {
  const out = []; let line = "";
  for (const w of text.split(" ")) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

let helpPage = 0;
// a click on the card: page 1 -> page 2 -> closed. Returns true while the card should stay open.
export function helpClick() { if (helpPage === 0) { helpPage = 1; return true; } helpPage = 0; return false; }
export function helpReset() { helpPage = 0; }

// draws the card inside (x, y, w, h) and returns the close-button rectangle
export function drawHistHelp(ctx, x, y, w, h) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 6); ctx.fillStyle = "rgba(20,20,22,0.97)"; ctx.fill(); ctx.strokeStyle = "#ff8a2a"; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); roundRect(ctx, x, y, w, h, 6); ctx.clip();
  const size = w < 260 ? 10 : 11, lh = size + 3.5, pad = 10;
  let cy = y + pad + 6;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const items = HELP.slice(helpPage * 4, helpPage * 4 + 4);
  for (const [kind, text] of items) {
    ctx.font = kind === "h" ? `700 ${size + 0.5}px Inter, 'Segoe UI', sans-serif` : `${size}px Inter, 'Segoe UI', sans-serif`;
    ctx.fillStyle = kind === "h" ? "#ff8a2a" : "#d4d4d8";
    for (const ln of wrap(ctx, text, w - 2 * pad - (kind === "h" && cy < y + 20 ? 22 : 0))) { ctx.fillText(ln, x + pad, cy); cy += lh; }
    cy += kind === "h" ? 1 : 5;
  }
  ctx.font = `${size}px Inter, 'Segoe UI', sans-serif`; ctx.fillStyle = "#8a8a92"; ctx.fillText(helpPage === 0 ? "Click this card for page 2 of 2  ›" : "Click this card to close  ✕", x + pad, y + h - 11);
  ctx.restore();
  return [x, y, w, h];
}
