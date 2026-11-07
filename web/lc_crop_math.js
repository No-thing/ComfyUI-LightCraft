// Pure geometry helpers for the Crop & Turn editor. No DOM, no ComfyUI imports, so it can be
// unit-tested in Node. Everything here must agree with lc_geometry.py.

export const ASPECTS = ["free", "original", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];

const rad = (d) => (d * Math.PI) / 180;

export function aspectValue(name, w1, h1) {
  if (name === "free") return null;
  if (name === "original") return w1 / Math.max(1, h1);
  const [a, b] = String(name).split(":").map(Number);
  return a > 0 && b > 0 ? a / b : null;
}

// the same ratio in the other orientation ("4:5" <-> "5:4"); "free"/"original" are unchanged
export function swapAspect(name) {
  const [a, b] = String(name).split(":");
  if (b === undefined) return name;
  const flipped = `${b}:${a}`;
  return ASPECTS.includes(flipped) ? flipped : name;
}

// size after quarter turns
export function turnedSize(srcW, srcH, turns) {
  return turns % 2 ? [srcH, srcW] : [srcW, srcH];
}

export function canvasSize(w1, h1, angle) {
  const c = Math.abs(Math.cos(rad(angle))), s = Math.abs(Math.sin(rad(angle)));
  return [Math.max(1, Math.ceil(w1 * c + h1 * s - 1e-6)), Math.max(1, Math.ceil(w1 * s + h1 * c - 1e-6))];
}

// largest centred crop on the straightened canvas: [x, y, w, h]
export function autoCrop(w1, h1, angle, aspect, constrain, pads) {
  const [w2, h2] = canvasSize(w1, h1, angle);
  if (constrain === false) {                       // the crop may leave the picture (gray corners / padding get painted): same as lc_geometry.fill_crop
    const [pl, pt, pr, pb] = pads || [0, 0, 0, 0];
    if (pl || pt || pr || pb) return [0, 0, w2 + pl + pr, h2 + pt + pb];
    if (Math.abs(angle) < 1e-6 && !aspect) return [0, 0, w2, h2];
    let fw, fh;
    if (!aspect || Math.abs(aspect - w1 / Math.max(1, h1)) < 1e-6) { fw = w1; fh = h1; }
    else { fw = Math.min(w1, h1 * aspect); fh = fw / aspect; }
    fw = Math.max(1, Math.trunc(fw)); fh = Math.max(1, Math.trunc(fh));
    return [Math.floor((w2 - fw) / 2), Math.floor((h2 - fh) / 2), fw, fh];
  }
  if (!constrain || Math.abs(angle) < 1e-6) {
    if (!aspect) return [0, 0, w2, h2];
    const cw = Math.min(w2, h2 * aspect), ch = cw / aspect;
    return [Math.trunc((w2 - cw) / 2), Math.trunc((h2 - ch) / 2), Math.trunc(cw), Math.trunc(ch)];
  }
  const c = Math.abs(Math.cos(rad(angle))), s = Math.abs(Math.sin(rad(angle)));
  let cw, ch;
  if (!aspect) {
    const longW = w1 >= h1;
    const [sl, ss] = longW ? [w1, h1] : [h1, w1];
    if (ss <= 2 * s * c * sl || Math.abs(s - c) < 1e-10) {
      const x = 0.5 * ss;
      [cw, ch] = longW ? [x / s, x / c] : [x / c, x / s];
    } else {
      const cos2 = c * c - s * s;
      cw = (w1 * c - h1 * s) / cos2;
      ch = (h1 * c - w1 * s) / cos2;
    }
  } else {
    const k = Math.min(w1 / (aspect * c + s), h1 / (aspect * s + c));
    cw = k * aspect;
    ch = k;
  }
  cw = Math.max(1, Math.trunc(cw));
  ch = Math.max(1, Math.trunc(ch));
  return [Math.floor((w2 - cw) / 2), Math.floor((h2 - ch) / 2), cw, ch];
}

// size of the straightened canvas plus the Outpaint tab's margins
export function paddedSize(w1, h1, angle, pads) {
  const [w2, h2] = canvasSize(w1, h1, angle), [pl, pt, pr, pb] = pads || [0, 0, 0, 0];
  return [w2 + pl + pr, h2 + pt + pb];
}

// The smallest frame of this aspect that holds the whole canvas (w2 x h2), as margins [left, top, right, bottom], centred.
export function minPads(aspect, w2, h2) {
  if (!aspect) return [0, 0, 0, 0];
  const w = Math.max(w2, h2 * aspect), h = w / aspect;
  const px = Math.round((w - w2) / 2), py = Math.round((h - h2) / 2);
  return [px, py, Math.round(w - w2) - px, Math.round(h - h2) - py];
}

// is the rect [x,y,w,h] (canvas px) entirely on picture pixels?
export function insidePicture(r, w1, h1, angle, eps = 0.5) {
  const [w2, h2] = canvasSize(w1, h1, angle);
  const cos = Math.cos(rad(angle)), sin = Math.sin(rad(angle));
  const [x, y, w, h] = r;
  for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
    const dx = px - w2 / 2, dy = py - h2 / 2;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    if (Math.abs(u) > w1 / 2 + eps || Math.abs(v) > h1 / 2 + eps) return false;
  }
  return true;
}

export function insideCanvas(r, w1, h1, angle) {
  const [w2, h2] = canvasSize(w1, h1, angle);
  return r[0] >= -0.5 && r[1] >= -0.5 && r[0] + r[2] <= w2 + 0.5 && r[1] + r[3] <= h2 + 0.5;
}

// Move from `prev` towards `next` as far as `ok` allows (so dragging slides along the limit).
export function clampToward(prev, next, ok) {
  if (ok(next)) return next;
  let lo = 0, hi = 1;
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    const cand = prev.map((v, k) => v + (next[k] - v) * t);
    if (ok(cand)) lo = t; else hi = t;
  }
  return prev.map((v, k) => v + (next[k] - v) * lo);
}

// Shrink `r` about its centre until it fits (used after the angle changes).
export function shrinkToFit(r, ok) {
  if (ok(r)) return r;
  const [x, y, w, h] = r;
  const cx = x + w / 2, cy = y + h / 2;
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    if (ok([cx - (w * t) / 2, cy - (h * t) / 2, w * t, h * t])) lo = t; else hi = t;
  }
  return [cx - (w * lo) / 2, cy - (h * lo) / 2, w * lo, h * lo];
}

// final output size (mirrors process() steps 4 and 6)
export function finalSize(cw, ch, pad, multiple, resize) {
  let fw = cw + pad[0] + pad[2], fh = ch + pad[1] + pad[3];
  const m = Math.max(1, multiple);
  fw += (m - (fw % m)) % m;
  fh += (m - (fh % m)) % m;
  if (resize && resize.on) {
    const steps = Math.max(1, resize.steps);
    const scale = Math.sqrt((Math.max(0.01, resize.mp) * 1e6) / (fw * fh));
    // Python's round() is banker's rounding; Math.round differs only on exact .5
    const snap = (v) => Math.max(steps, Math.round((v * scale) / steps) * steps);
    return [snap(fw), snap(fh)];
  }
  return [fw, fh];
}

// Straightened-canvas point <-> source-picture point (the picture sits rotated by `angle` in the
// middle of the canvas). Used to paint masks in source pixels while looking at the cropped view.
export function canvasToSource(cx, cy, w1, h1, angle) {
  const [w2, h2] = canvasSize(w1, h1, angle);
  const c = Math.cos(rad(angle)), s = Math.sin(rad(angle));
  const dx = cx - w2 / 2, dy = cy - h2 / 2;
  return [dx * c + dy * s + w1 / 2, -dx * s + dy * c + h1 / 2];
}
export function sourceToCanvas(sx, sy, w1, h1, angle) {
  const [w2, h2] = canvasSize(w1, h1, angle);
  const c = Math.cos(rad(angle)), s = Math.sin(rad(angle));
  const u = sx - w1 / 2, v = sy - h1 / 2;
  return [u * c - v * s + w2 / 2, u * s + v * c + h2 / 2];
}

// ---------------------------------------------------------------- mask refine preview
// The same steps the node runs (fill holes -> grow / shrink -> smooth -> soften), on an alpha array,
// so the overlay can show the result while the sliders move. Radii are in this array's pixels.
function edt1(f, n, d, v, z) {             // exact 1-D squared distance transform (Felzenszwalb)
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) k--; else break;
    }
    if (s <= z[k]) { v[0] = q; z[0] = -Infinity; z[1] = Infinity; k = 0; continue; }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k]; d[q] = (q - p) * (q - p) + f[p];
  }
}

// squared distance from every pixel to the nearest pixel where isTarget(i) is true
function distSq(w, h, isTarget) {
  const INF = 1e20, out = new Float64Array(w * h);
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = isTarget(y * w + x) ? 0 : INF;
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

function boxPass(src, dst, w, h, r, horizontal) {      // running-sum box blur, edges replicated
  const len = horizontal ? w : h, lines = horizontal ? h : w, step = horizontal ? 1 : w, stride = horizontal ? w : 1;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[base + Math.min(len - 1, Math.max(0, i)) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = acc * inv;
      acc += src[base + Math.min(len - 1, i + r + 1) * step] - src[base + Math.max(0, i - r) * step];
    }
  }
}

export function gaussBlur(a, w, h, sigma) {            // 3 box passes ~ a Gaussian of this sigma
  if (!(sigma > 0.3)) return Float32Array.from(a);
  const n = 3, wi = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wi); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let cur = Float32Array.from(a), tmp = new Float32Array(a.length);
  for (let i = 0; i < n; i++) {
    const r = ((i < m ? wl : wu) - 1) / 2;
    boxPass(cur, tmp, w, h, r, true); boxPass(tmp, cur, w, h, r, false);
  }
  return cur;
}

// a: alpha 0..255 (Uint8 array-like). Returns Uint8ClampedArray alpha.
export function refineAlpha(a, w, h, o) {
  const grow = o.grow || 0, smooth = o.smooth || 0, feather = o.feather || 0, N = w * h;
  let b = new Uint8Array(N);
  for (let i = 0; i < N; i++) b[i] = a[i] > 127 ? 1 : 0;
  const active = grow || smooth || o.fill;
  if (active) {
    if (o.fill) {                                      // whatever the outside cannot reach is a hole
      const seen = new Uint8Array(N), stack = [];
      const push = (i) => { if (!b[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
      for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
      }
      for (let i = 0; i < N; i++) if (!b[i] && !seen[i]) b[i] = 1;
    }
    if (grow > 0.5) {
      const d = distSq(w, h, (i) => b[i] === 1), r2 = grow * grow;
      for (let i = 0; i < N; i++) b[i] = d[i] <= r2 ? 1 : 0;
    } else if (grow < -0.5) {
      const d = distSq(w, h, (i) => b[i] === 0), r2 = grow * grow;
      for (let i = 0; i < N; i++) b[i] = d[i] > r2 ? 1 : 0;
    }
    if (smooth > 0.3) {
      const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = b[i];
      const g = gaussBlur(f, w, h, smooth);
      for (let i = 0; i < N; i++) b[i] = g[i] > 0.5 ? 1 : 0;
    }
  }
  const out = new Uint8ClampedArray(N);
  if (feather > 0.3) {
    const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = active ? b[i] : (a[i] / 255);
    const g = gaussBlur(f, w, h, feather);
    for (let i = 0; i < N; i++) out[i] = g[i] * 255 + 0.5;
  } else if (active) for (let i = 0; i < N; i++) out[i] = b[i] * 255;
  else for (let i = 0; i < N; i++) out[i] = a[i];
  return out;
}
