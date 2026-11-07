// Pixel drift: the pixels that MOVED between two pictures, painted neon purple (the same idea as the histogram's clipping overlay).
// What it does, in order:
//   1. both pictures are shrunk to the same small grid (that already rubs out the extra sharpness an upscale adds);
//   2. the second one is lined up with the first (an upscale rounds its size to a multiple of 32, so it is a few pixels off or cropped);
//   3. the slow brightness / contrast / colour drift is removed from both, so a tone change is NOT counted as movement;
//   4. every cell whose edges / detail changed more than the threshold becomes a red block.
// Edges that slid sideways, a hand that changed shape, a moved earring: purple. Finer skin texture, a slightly different tone: nothing.

const GRID = 480, BLUR = 1.2, T0 = 11, T1 = 42, HP = 11, SEARCH = 10;
const cache = new WeakMap();                                           // picture A -> { b, res }

// the picture drawn into a w x h grid at rect r (grid units); returns luma + which cells the picture covers
function lumaGrid(img, w, h, r) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const c = cv.getContext("2d", { willReadFrequently: true });
  c.imageSmoothingQuality = "high";
  try { if ("filter" in c) c.filter = `blur(${BLUR}px)`; } catch (e) { /* older browsers: the shrink alone is enough */ }
  c.drawImage(img, r[0], r[1], r[2], r[3]);
  const d = c.getImageData(0, 0, w, h).data, luma = new Float32Array(w * h), cover = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < luma.length; i++, j += 4) { luma[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]; cover[i] = d[j + 3] > 250 ? 1 : 0; }
  return { luma, cover };
}

// separable box blur (radius k) with clamped edges
function boxBlur(src, w, h, k) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * k + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let s = 0;
    for (let x = -k; x <= k; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + k + 1)] - src[row + Math.max(0, x - k)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -k; y <= k; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + k + 1) * w + x] - tmp[Math.max(0, y - k) * w + x];
    }
  }
  return out;
}
const highPass = (g, w, h) => { const lo = boxBlur(g, w, h, HP), out = new Float32Array(g.length); for (let i = 0; i < g.length; i++) out[i] = g[i] - lo[i]; return out; };

// how far the second picture sits from the first when it is drawn at offset (dx, dy): mean |difference| over a sparse sample of covered cells
function misfit(ha, hb, ca, cb, w, h, dx, dy) {
  let s = 0, n = 0;
  for (let y = 12; y < h - 12; y += 3) for (let x = 12; x < w - 12; x += 3) {
    const xb = x + dx, yb = y + dy;
    if (xb < 0 || yb < 0 || xb >= w || yb >= h) continue;
    const i = y * w + x, j = yb * w + xb;
    if (!ca[i] || !cb[j]) continue;
    s += Math.abs(ha[i] - hb[j]); n++;
  }
  return n > 50 ? s / n : Infinity;
}

// -> { cv: purple overlay canvas (transparent where nothing moved), pct: share of the picture that moved } or null
export function driftFor(a, b) {
  if (!a || !b) return null;
  const m = cache.get(a);
  if (m && m.b === b) return m.res;
  let res = null;
  try {
    const aw = a.naturalWidth || a.width, ah = a.naturalHeight || a.height;
    const bw = b.naturalWidth || b.width, bh = b.naturalHeight || b.height;
    if (!aw || !ah || !bw || !bh) return null;
    const w = Math.min(GRID, aw), h = Math.max(1, Math.round(w * ah / aw));
    const sx = bw / aw, sy = bh / ah, k = w / aw;
    const A = lumaGrid(a, w, h, [0, 0, w, h]), ha = highPass(A.luma, w, h);
    // B is drawn at A's scale (rounding the size to a multiple of 32 crops or pads the edge, it does not stretch). The true scale is not known
    // exactly, so a few likely ones are tried (the width's, the height's, the nearer round numbers) and the one that lines up best wins.
    const cands = [...new Set([sx, sy, Math.max(sx, sy), Math.min(sx, sy), Math.round(sx * 2) / 2, Math.round(sy * 2) / 2, Math.round(Math.max(sx, sy) * 4) / 4].map((v) => +v.toFixed(4)))].filter((v) => v > 0.05);
    let B = null, hb = null, best = [0, 0], bf = Infinity;
    for (const s of cands) {
      const Bs = lumaGrid(b, w, h, [0, 0, bw / s * k, bh / s * k]), hbs = highPass(Bs.luma, w, h);
      for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) {
        const f = misfit(ha, hbs, A.cover, Bs.cover, w, h, dx, dy);
        if (f < bf - (dx || dy ? 0.05 : 0)) { bf = f; best = [dx, dy]; B = Bs; hb = hbs; }
      }
    }
    if (!B) return null;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const c = cv.getContext("2d"), im = c.createImageData(w, h);
    let moved = 0, seen = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, xb = x + best[0], yb = y + best[1];
      if (xb < 0 || yb < 0 || xb >= w || yb >= h) continue;
      const j = yb * w + xb;
      if (!A.cover[i] || !B.cover[j]) continue;                        // outside what both pictures show: not counted
      seen++;
      const d = Math.abs(ha[i] - hb[j]);
      if (d <= T0) continue;
      moved++;
      const t = Math.min(1, (d - T0) / (T1 - T0));
      im.data[i * 4] = 190; im.data[i * 4 + 1] = 60; im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = Math.round(120 + 135 * t);
    }
    c.putImageData(im, 0, 0);
    res = { cv, pct: seen ? (100 * moved) / seen : 0, shift: best };
  } catch (e) { console.error("[LightCraft] pixel drift failed:", e); return null; }
  cache.set(a, { b, res });
  return res;
}

// draw the purple layer over rect r (blocks stay blocks: no smoothing, so you see the literal moved pixels)
export function drawDrift(ctx, res, r) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(res.cv, r[0], r[1], r[2], r[3]);
  ctx.restore();
}

export const DRIFT_COL = "#be3cff";                       // neon purple: red already means blown highlights
export const fmtMoved = (p) => (p < 0.05 ? "nothing moved" : p < 10 ? `${p.toFixed(1)}% moved` : `${Math.round(p)}% moved`);
