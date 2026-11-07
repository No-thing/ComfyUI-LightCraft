import { app } from "../../scripts/app.js";
import { C, M, FONT, rr, SPECS, presetsReady, presetData } from "./lightcraft_ui.js";
import { hit, drag, wheelZone } from "./lc_interact.js";
import { pickPreset } from "./lc_preset_picker.js";

// Edit Page > Color tab. The Color tab keeps the Compare layout (split / side by side / before / after); the original
// LightCraft Color panel (LUT, FX, Grain, Lens) slides in on the right and the History bar shrinks to make room.
//
// Preview: when only the LUT is in use the picture is graded live in the browser (WebGL2 shader, same maths as
// grade() in lightcraft_look_nodes.py). FX / Grain / Lens are rendered by the same Python code the node uses
// (a small proxy picture goes to /lightcraft/color_preview, debounced), so the preview is exact.
// The settings live in ONE hidden JSON widget (color_data). On run Python applies them to the full-size output.

const ORANGE = "#ff8a2a";
const WIDGET = "color_data";
const PROXY_MAX = 1100;
export const CP_W = 312, HIST_NARROW = 132, COLOR_MIN_NODE_W = 920;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const W = (node, name) => node.widgets && node.widgets.find((w) => w.name === name);

const SECTIONS = {
  lut:   { label: "LUT",   cls: "LightCraftGrade" },
  fx:    { label: "FX",    cls: "LightCraftFX" },
  grain: { label: "Grain", cls: "LightCraftGrain" },
  lens:  { label: "Lens",  cls: "LightCraftLens" },
};
const IDS = Object.keys(SECTIONS);
const TABS = [["start", "Start"], ...IDS.map((id) => [id, SECTIONS[id].label])];

// slider tables come from the server: { cls: { name: [type, min, max, default, step] } }
const table = (id) => (presetData().sliders || {})[SECTIONS[id].cls] || {};
const defaultsOf = (id) => { const p = {}; for (const [k, v] of Object.entries(table(id))) p[k] = v[3]; return p; };
const ready = () => IDS.every((id) => Object.keys(table(id)).length);

// ---------------------------------------------------------------- state (one hidden JSON widget)
function parse(raw) {
  let d = null;
  try { d = JSON.parse(raw || "{}"); } catch (e) { d = null; }
  if (d && d.p && !d.lut) d = { lut: { on: true, preset: d.preset || "", p: d.p } };        // first version: a LUT only
  const out = { seed: Number((d && d.seed) || 0) };
  out.layers = ((d && Array.isArray(d.layers)) ? d.layers : []).filter((l) => l && l.s && typeof l.s === "object").slice(0, 12)
    .map((l) => ({ name: String(l.name || "Layer").slice(0, 60), on: l.on !== false, s: l.s }));
  for (const id of IDS) {
    const sec = (d && d[id]) || {};
    out[id] = { on: sec.on !== false, preset: sec.preset || "", p: { ...defaultsOf(id), ...(sec.p || {}) } };
  }
  return out;
}

export function readColor(node) {
  const w = W(node, WIDGET), raw = w ? w.value : "";
  const K = node.__lcColor || (node.__lcColor = { raw: null, data: null, ver: -1 });
  if (K.raw !== raw || !K.data || (!K.ready && ready())) {
    K.data = parse(raw); K.raw = raw; K.ready = ready(); K.ver++;
  }
  return K.data;
}

function writeColor(node, data, done) {
  const w = W(node, WIDGET);
  if (!w) return;
  const K = node.__lcColor || (node.__lcColor = {});
  K.data = data; K.raw = JSON.stringify(data); K.ver = (K.ver || 0) + 1;
  w.value = K.raw;
  if (done) {
    if (w.callback) { try { w.callback(w.value, app.canvas, node); } catch (e) { /* ignore */ } }
    if (app.graph && app.graph.change) app.graph.change();
  }
  node.setDirtyCanvas(true, true);
}

const sectionActive = (id, sec) => sec.on && Object.entries(table(id)).some(([k, v]) => k !== "strength" && sec.p[k] !== v[3]);
const layersOn = (d) => (d.layers || []).some((l) => l.on);
export const colorActive = (node) => { try { const d = readColor(node); return layersOn(d) || IDS.some((id) => sectionActive(id, d[id])); } catch (e) { return false; } };

// ---------------------------------------------------------------- snapshots: bake the current edits as a layer, then keep editing on top
function snapshotName(d) {
  const names = IDS.filter((id) => sectionActive(id, d[id])).map((id) => d[id].preset || SECTIONS[id].label);
  return names.join(" + ") || "Layer";
}
export function snapshotCount(node) { try { return (readColor(node).layers || []).length; } catch (e) { return 0; } }
export function canSnapshot(node) { try { const d = readColor(node); return IDS.some((id) => sectionActive(id, d[id])); } catch (e) { return false; } }
export function takeSnapshot(node) {
  const d = readColor(node);
  if (!IDS.some((id) => sectionActive(id, d[id]))) return;
  const s = { seed: d.seed }; IDS.forEach((id) => { s[id] = JSON.parse(JSON.stringify(d[id])); });
  const kept = (d.layers || []).slice(-11);                                                         // 12 layers at most: the oldest one is replaced, never refused
  const nd = { seed: d.seed, layers: [...kept, { name: snapshotName(d), on: true, s }] };
  IDS.forEach((id) => { nd[id] = { on: true, preset: "", p: defaultsOf(id) }; });                      // the live edits start clean on top of the new layer
  writeColor(node, nd, true);
}
function setLayers(node, fn) { const d = readColor(node); writeColor(node, { ...d, layers: fn((d.layers || []).map((l) => ({ ...l }))) }, true); }

// ---------------------------------------------------------------- the shader
const VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uC0, uCS;
uniform float uTemp, uTint, uEv, uContrast, uFade, uSat, uVib, uBw, uStrength, uBal, uBlend, uOn;
uniform vec3 uTv0, uTv1, uTv2;      // hue colour - its luma, for shadows / midtones / highlights
uniform vec3 uGs;                   // their saturations
in vec2 vUv; out vec4 o;
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c){ return dot(c, LW); }
vec3 s2l(vec3 x){ x = max(x, 0.0); return mix(pow((x + 0.055) / 1.055, vec3(2.4)), x / 12.92, lessThanEqual(x, vec3(0.04045))); }
vec3 l2s(vec3 x){ x = max(x, 0.0); return mix(1.055 * pow(max(x, vec3(1e-8)), vec3(1.0 / 2.4)) - 0.055, x * 12.92, lessThanEqual(x, vec3(0.0031308))); }
float sm(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
void main(){
  vec3 img = texture(uTex, uC0 + vec2(vUv.x, 1.0 - vUv.y) * uCS).rgb;
  if (uOn < 0.5) { o = vec4(img, 1.0); return; }
  vec3 x = img;
  if (uTemp != 0.0 || uTint != 0.0 || uEv != 0.0) {
    vec3 lin = s2l(x);
    if (uTemp != 0.0 || uTint != 0.0) {
      vec3 g = vec3(exp2(0.45 * uTemp), exp2(-0.30 * uTint), exp2(-0.45 * uTemp));
      g /= dot(g, LW);
      lin *= g;
    }
    if (uEv != 0.0) lin *= exp2(uEv);
    x = l2s(lin);
    x = mix(x, 0.8 + 0.2 * tanh((x - 0.8) / 0.2), greaterThan(x, vec3(0.8)));
  }
  if (uContrast != 0.0) { vec3 xs = clamp(x, 0.0, 1.0); x = x + uContrast * (xs * xs * (3.0 - 2.0 * xs) - xs); }
  if (uFade != 0.0) x = uFade * 0.2 + x * (1.0 - uFade * 0.25);
  if (uSat != 0.0 || uVib != 0.0) {
    float lum = luma(x);
    float mx = max(x.r, max(x.g, x.b)), mn = min(x.r, min(x.g, x.b));
    float chroma = clamp(mx - mn, 0.0, 1.0);
    float a = 1.7320508 * (x.g - x.b), b = 2.0 * x.r - x.g - x.b;
    float hue = (a == 0.0 && b == 0.0) ? 0.0 : atan(a, b) * 57.29578;
    float skin = exp(-pow((mod((hue - 25.0) + 180.0, 360.0) - 180.0) / 30.0, 2.0));
    float f = max(1.0 + uSat + uVib * pow(1.0 - chroma, 1.5) * (1.0 - 0.6 * skin), 0.0);
    x = lum + (x - lum) * f;
  }
  if (uBw != 0.0) x = x + (luma(x) - x) * uBw;
  if (uGs.x != 0.0 || uGs.y != 0.0 || uGs.z != 0.0) {
    float lum = clamp(luma(x), 0.0, 1.0);
    float centre = 0.5 - 0.2 * uBal, width = 0.05 + 0.25 * uBlend;
    float wsh = 1.0 - sm(centre - 0.25 - width, centre - 0.25 + width, lum);
    float whi = sm(centre + 0.25 - width, centre + 0.25 + width, lum);
    float wmid = max(1.0 - wsh - whi, 0.0);
    if (uGs.x > 0.0) x += uTv0 * (0.3 * uGs.x) * wsh;
    if (uGs.y > 0.0) x += uTv1 * (0.3 * uGs.y) * wmid;
    if (uGs.z > 0.0) x += uTv2 * (0.3 * uGs.z) * whi;
  }
  x = clamp(x, 0.0, 1.0);
  if (uStrength < 1.0) x = img + (x - img) * uStrength;
  o = vec4(x, 1.0);
}`;

function hueRGB(h) {                                            // same table as _hue_rgb in lightcraft_nodes.py
  h = (((h % 360) + 360) % 360) / 60;
  const xx = 1 - Math.abs((h % 2) - 1);
  return [[1, xx, 0], [xx, 1, 0], [0, 1, xx], [0, xx, 1], [xx, 0, 1], [1, 0, xx]][Math.floor(h) % 6];
}
const tvOf = (hue) => {
  const c = hueRGB(hue), ly = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] - ly, c[1] - ly, c[2] - ly];
};

function engine() {
  if (engine.e !== undefined) return engine.e;
  engine.e = null;
  try {
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    const U = {};
    for (const n of ["uTex", "uC0", "uCS", "uTemp", "uTint", "uEv", "uContrast", "uFade", "uSat", "uVib", "uBw", "uStrength", "uBal", "uBlend", "uOn", "uTv0", "uTv1", "uTv2", "uGs"]) U[n] = gl.getUniformLocation(prog, n);
    engine.e = { cv, gl, tex, U, img: null, key: "" };
  } catch (e) {
    console.warn("[LightCraft] WebGL2 not available for the Color tab:", e);
    engine.e = null;
  }
  return engine.e;
}

// Render `p` over `src` (an image / canvas) into the shared canvas at w x h. crop = [x, y, w, h] in 0..1 of the picture.
export function renderGrade(src, srcW, srcH, p, on, w, h, crop) {
  const E = engine();
  if (!E) return null;
  const { cv, gl, tex, U } = E;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  gl.viewport(0, 0, w, h);
  if (E.img !== src) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    E.img = src;
  }
  gl.uniform1i(U.uTex, 0);
  gl.uniform2f(U.uC0, crop[0], crop[1]);
  gl.uniform2f(U.uCS, crop[2], crop[3]);
  gl.uniform1f(U.uTemp, p.temperature / 100);
  gl.uniform1f(U.uTint, p.tint / 100);
  gl.uniform1f(U.uEv, p.exposure);
  gl.uniform1f(U.uContrast, p.contrast / 100);
  gl.uniform1f(U.uFade, p.fade / 100);
  gl.uniform1f(U.uSat, p.saturation / 100);
  gl.uniform1f(U.uVib, p.vibrance / 100);
  gl.uniform1f(U.uBw, p.bw / 100);
  gl.uniform1f(U.uStrength, p.strength / 100);
  gl.uniform1f(U.uBal, p.grade_balance / 100);
  gl.uniform1f(U.uBlend, p.grade_blending / 100);
  gl.uniform1f(U.uOn, on ? 1 : 0);
  gl.uniform3fv(U.uTv0, tvOf(p.shadows_hue));
  gl.uniform3fv(U.uTv1, tvOf(p.midtones_hue));
  gl.uniform3fv(U.uTv2, tvOf(p.highlights_hue));
  gl.uniform3f(U.uGs, p.shadows_sat / 100, p.midtones_sat / 100, p.highlights_sat / 100);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return cv;
}

// ---------------------------------------------------------------- preview pictures (before = proxy of the crop, after = graded)
const fit = (w, h, x, y, bw, bh) => {
  const k = Math.min(bw / w, bh / h), rw = w * k, rh = h * k;
  return [x + (bw - rw) / 2, y + (bh - rh) / 2, rw, rh];
};

function baseProxy(node, st) {
  const K = node.__lcColor || (node.__lcColor = {});
  const src = st.s.img || st.s.full;
  if (!src) return null;
  let crop = [0, 0, st.s.w, st.s.h];
  if (!st.angle && st.crop && !st.padded) crop = [st.crop[0], st.crop[1], st.crop[2], st.crop[3]];          // an unrotated crop is previewed
  const k = Math.min(1, PROXY_MAX / Math.max(crop[2], crop[3]));
  const w = Math.max(2, Math.round(crop[2] * k)), h = Math.max(2, Math.round(crop[3] * k));
  const sx = (src.width || st.s.w) / st.s.w;                                                    // the thumb can be smaller than the real size
  const key = `${st.s.w}x${st.s.h}|${crop.map((v) => Math.round(v)).join(",")}|${w}x${h}|${st.s.tag || ""}|${src.width}`;
  if (!K.base || K.base.src !== src || K.base.key !== key) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const c = cv.getContext("2d");
    c.imageSmoothingQuality = "high";
    c.drawImage(src, crop[0] * sx, crop[1] * sx, crop[2] * sx, crop[3] * sx, 0, 0, w, h);
    K.base = { src, key, img: cv, w, h, id: `${node.id}:${key}:${Math.random().toString(36).slice(2, 8)}`, sent: false };
    K.result = null; K.lastSig = "";
  }
  return K.base;
}

function request(node, base, sig, state) {
  const K = node.__lcColor;
  K.pending = { sig, state };
  if (K.busy) return;
  const go = async () => {
    const job = K.pending; K.pending = null;
    if (!job) return;
    K.busy = true;
    try {
      const send = async (withImage) => {
        const fd = new FormData();
        fd.append("key", base.id);
        fd.append("state", job.state);
        if (withImage) { const blob = await new Promise((r) => base.img.toBlob(r, "image/png")); fd.append("image", blob, "p.png"); }
        return fetch("/lightcraft/color_preview", { method: "POST", body: fd });
      };
      let r = await send(!base.sent);
      if (r.status === 409) r = await send(true);
      if (r.ok) {
        base.sent = true;
        const url = URL.createObjectURL(await r.blob());
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
        if (K.base === base) { K.result = { img, w: base.w, h: base.h, sig: job.sig }; }
        URL.revokeObjectURL(url);
      } else {
        let msg = ""; try { msg = (await r.json()).error; } catch (e) { /* not json */ }
        K.error = msg || `preview failed (${r.status})`;
      }
    } catch (e) { K.error = String(e.message || e); }
    K.busy = false;
    node.setDirtyCanvas(true, true);
    if (K.pending) go();
  };
  clearTimeout(K.timer);
  K.timer = setTimeout(go, 90);
}

// -> { before, after } as {img, w, h}; null when there is no picture yet
export function colorPictures(node, st) {
  const base = baseProxy(node, st);
  if (!base) return null;
  const K = node.__lcColor, d = readColor(node);
  const before = { img: base.img, w: base.w, h: base.h };
  const sig = JSON.stringify(d);
  if (!layersOn(d) && !IDS.some((id) => sectionActive(id, d[id]))) return { before, after: before };
  const onlyLut = !layersOn(d) && !["fx", "grain", "lens"].some((id) => sectionActive(id, d[id]));
  if (onlyLut) {                                                // instant: the shader
    if (!K.shader || K.shader.sig !== sig || K.shader.base !== base) {
      const cv = renderGrade(base.img, base.w, base.h, d.lut.p, d.lut.on, base.w, base.h, [0, 0, 1, 1]);
      if (cv) {
        const out = document.createElement("canvas"); out.width = base.w; out.height = base.h;
        out.getContext("2d").drawImage(cv, 0, 0);
        K.shader = { sig, base, pic: { img: out, w: base.w, h: base.h } };
      } else K.shader = null;
    }
    if (K.shader) return { before, after: K.shader.pic };
  }
  if (K.lastSig !== sig) { K.lastSig = sig; request(node, base, sig, JSON.stringify({ ...d, lut: d.lut })); }
  return { before, after: K.result || before, waiting: !K.result || K.result.sig !== sig };
}

// ---------------------------------------------------------------- the slide animation (exponential in-out)
const easeInOutExpo = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2);
const DUR_IN = 560, DUR_OUT = 440;

// 0 = closed .. 1 = fully open; keeps itself drawing until the animation is done
export function colorOpenness(node, open) {
  const K = node.__lcColor || (node.__lcColor = {});
  const now = performance.now(), target = open ? 1 : 0;
  if (K.t === undefined) { K.t = target; K.e = target; K.anim = null; }
  if (!K.anim && K.t !== target) K.anim = { from: K.t, to: target, start: now };
  if (K.anim && K.anim.to !== target) K.anim = { from: K.e, to: target, start: now };
  if (K.anim) {
    const a = K.anim, dur = a.to > a.from ? DUR_IN : DUR_OUT;
    const p = clamp((now - a.start) / dur, 0, 1);
    const e = easeInOutExpo(p);
    K.e = a.from + (a.to - a.from) * e;
    if (p >= 1) { K.t = a.to; K.e = a.to; K.anim = null; }
    else requestAnimationFrame(() => node.setDirtyCanvas(true, false));
  } else K.e = K.t;
  return K.e;
}

// ---------------------------------------------------------------- panel pieces
function btn(ctx, node, id, x, y, w, h, text, on, fn) {
  rr(ctx, x, y, w, h, 5);
  ctx.fillStyle = on ? "#5a5a5a" : C.btn; ctx.fill();
  if (on) { ctx.strokeStyle = "#8c8c8c"; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = on ? "#ffffff" : "#d0d0d0";
  ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  hit(node, "ed:" + id, x, y, w, h, fn, "pointer");
}

function fitText(ctx, text, maxW) {
  let t = String(text);
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

function setSection(node, id, patch, done) {
  const d = readColor(node);
  writeColor(node, { ...d, [id]: { ...d[id], ...patch } }, done);
}

function setPreset(node, id, name) {
  presetsReady.then(() => {
    const { presets, none } = presetData();
    const t = (presets[SECTIONS[id].cls] || {})[name];
    const d = readColor(node), p = defaultsOf(id);
    if ("strength" in p) p.strength = d[id].p.strength;           // keep the Amount, like the Color node
    if (t) for (const k of Object.keys(p)) if (k !== "strength" && k in t) p[k] = t[k];
    setSection(node, id, { preset: name === none ? "" : name, p }, true);
  });
}

function resetSection(node, id) { setSection(node, id, { preset: "", p: defaultsOf(id) }, true); }

function drawDot(ctx, node, id, x, y, on, fn) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2);
  ctx.strokeStyle = on ? ORANGE : "#55555c"; ctx.lineWidth = 1.5; ctx.stroke();
  if (on) { ctx.beginPath(); ctx.arc(x, y, 2.8, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill(); }
  ctx.restore();
  hit(node, "ed:" + id, x - 10, y - 12, 20, 24, fn, "pointer");
}

function drawDropdown(ctx, node, id, x, y, w) {
  const { presets, none } = presetData(), d = readColor(node);
  const vals = [none, ...Object.keys(presets[SECTIONS[id].cls] || {})];
  ctx.save();
  rr(ctx, x, y, w, 28, 5); ctx.fillStyle = C.well; ctx.fill();
  ctx.strokeStyle = C.wellEdge; ctx.lineWidth = 1; ctx.stroke();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.fillStyle = "#777"; ctx.fillText("‹", x + 11, y + 14); ctx.fillText("›", x + w - 11, y + 14);
  ctx.fillStyle = d[id].preset ? "#ececec" : C.label;
  ctx.fillText(fitText(ctx, d[id].preset || "None", w - 52), x + w / 2, y + 14.5);
  ctx.restore();
  hit(node, "ed:cp:dd:" + id, x, y, w, 28, ({ ev, pos }) => {
    const i = Math.max(0, vals.indexOf(d[id].preset || none));
    if (pos[0] < x + 24) setPreset(node, id, vals[(i + vals.length - 1) % vals.length]);
    else if (pos[0] > x + w - 24) setPreset(node, id, vals[(i + 1) % vals.length]);
    else {
      pickPreset({ event: ev, cls: SECTIONS[id].cls, none, names: vals.filter((v) => v !== none), current: d[id].preset || none, onPick: (v) => setPreset(node, id, v) });
    }
  }, "pointer");
}

// a slider in the panel (same look as the Color node's), only live while inside the visible part
const ROW_H = 28, HEAD_H = 28;
const rowH = (spec) => ROW_H + (spec.head ? HEAD_H : 0);
function drawPanelSlider(ctx, node, id, key, x, y, w, vis, plain, noHead) {
  const [type, min, max, def, step] = table(id)[key];
  const spec0 = (SPECS[SECTIONS[id].cls] || {})[key] || { label: key };
  const spec = plain ? { ...spec0, head: undefined, label: plain } : noHead ? { ...spec0, head: undefined } : spec0;                  // plain: no heading, own label (the Start page)
  const d = readColor(node), v = d[id].p[key], hot = Math.abs(v - def) > 1e-9;
  let top = y;
  ctx.save();
  if (spec.head) {
    ctx.fillStyle = C.head; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(spec.head, x, y + 13);
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y + HEAD_H - 4.5); ctx.lineTo(x + w, y + HEAD_H - 4.5); ctx.stroke();
    top = y + HEAD_H;
  }
  const dec = type === "f" ? (spec.dec || 2) : 0;
  const shown = (min < 0 && v > 0 ? "+" : "") + (dec ? Number(v).toFixed(dec) : String(Math.round(v))) + (spec.unit || "");
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = hot ? C.labelHot : C.label;
  ctx.fillText(spec.label, x, top + 8);
  ctx.textAlign = "right"; ctx.fillText(shown, x + w, top + 8);
  const ty = top + ROW_H - 9, f = clamp((v - min) / (max - min), 0, 1), px = x + f * w;
  ctx.lineCap = "round"; ctx.lineWidth = 3;
  if (spec.grad) {
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    spec.grad.forEach((c, i) => g.addColorStop(i / (spec.grad.length - 1), c));
    ctx.strokeStyle = g; ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x + w, ty); ctx.stroke();
  } else {
    ctx.strokeStyle = C.track; ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x + w, ty); ctx.stroke();
    const ox = min < 0 ? x + ((0 - min) / (max - min)) * w : x;
    if (Math.abs(px - ox) > 0.5) { ctx.strokeStyle = hot ? C.fillHot : C.fill; ctx.beginPath(); ctx.moveTo(ox, ty); ctx.lineTo(px, ty); ctx.stroke(); }
    if (min < 0) { ctx.lineWidth = 1; ctx.strokeStyle = "#777"; ctx.beginPath(); ctx.moveTo(ox, ty - 5); ctx.lineTo(ox, ty + 5); ctx.stroke(); }
  }
  ctx.beginPath(); ctx.arc(px, ty, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = hot ? C.thumbHot : C.thumb; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = C.thumbEdge; ctx.stroke();
  ctx.restore();
  if (!vis) return;
  const set = (val, done) => {
    let n = clamp(val, min, max);
    n = Number((Math.round(n / step) * step).toFixed(type === "f" ? 2 : 0));
    const cur = readColor(node);
    if (cur[id].p[key] !== n) writeColor(node, { ...cur, [id]: { ...cur[id], preset: cur[id].preset, p: { ...cur[id].p, [key]: n } } }, done);
    else if (done) writeColor(node, cur, true);
  };
  hit(node, `ed:cp:s:${id}:${key}`, x - 4, y + (spec.head ? HEAD_H : 0) - 2, w + 8, ROW_H, ({ ev, pos }) => {
    const now = performance.now(), last = node.__lcColorLast;                                // double-click = back to default
    node.__lcColorLast = { key: id + key, t: now, x: ev.clientX, y: ev.clientY };
    if (last && last.key === id + key && now - last.t < 450 && Math.abs(last.x - ev.clientX) < 12 && Math.abs(last.y - ev.clientY) < 12) {
      node.__lcColorLast = null; set(def, true); return;
    }
    if (ev.altKey) { app.canvas.prompt("Value", readColor(node)[id].p[key], (s) => { const n = parseFloat(s); if (!Number.isNaN(n)) set(n, true); }, ev); return; }
    const base = min + clamp((pos[0] - x) / w, 0, 1) * (max - min);
    set(base, false);
    drag({ node, ev, cursor: "ew-resize", onMove: (dx) => set(base + (dx / w) * (max - min), false), onUp: () => set(readColor(node)[id].p[key], true) });
  }, "ew-resize");
}

// ---------------------------------------------------------------- groups: only what a look uses is open
const GROUP_H = 28, PINNED = new Set(["Filter", "Detail", "Vignette"]);            // always open: strength, sharpen, vignette (and the lens basics)
function groupsOf(node, tab) {
  const specs = SPECS[SECTIONS[tab].cls] || {}, d = readColor(node)[tab].p, T = table(tab);
  const groups = [];
  for (const k of Object.keys(specs)) {
    if (!(k in T)) continue;
    const sp = specs[k] || {};
    if (sp.head || !groups.length) groups.push({ head: sp.head || "", keys: [] });
    groups[groups.length - 1].keys.push(k);
  }
  const K = node.__lcColor || (node.__lcColor = {});
  K.groupOpen = K.groupOpen || {};
  groups.forEach((g) => {
    g.active = g.keys.some((k) => k !== "strength" && Math.abs((d[k] ?? T[k][3]) - T[k][3]) > 1e-9);
    const ov = K.groupOpen[tab + ":" + g.head];
    g.open = ov !== undefined ? ov : (g.active || PINNED.has(g.head) || !g.head || (tab === "lens" && g.head === "Lens") || groups.length <= 2);
    g.h = (g.head ? GROUP_H : 0) + (g.open ? g.keys.length * ROW_H : 0);
  });
  return groups;
}

// ---------------------------------------------------------------- the panel
// e = openness 0..1 (the slide animation); the content fades and slides a little further than the frame
export function drawColorPanel(ctx, node, px, py, pw, ph, e) {
  const S = node.__lc, K = node.__lcColor || (node.__lcColor = {});
  if (pw < 8) return;
  if (!S.colorTab) S.colorTab = "start";
  ctx.save();
  ctx.beginPath(); rr(ctx, px, py, pw, ph, 6); ctx.clip();
  if (!node.__lcNoBg) {
  ctx.fillStyle = "#18181a"; ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; rr(ctx, px, py, pw, ph, 6); ctx.stroke();
  }
  const shift = (1 - e) * 48;
  ctx.globalAlpha = clamp((e - 0.2) / 0.8, 0, 1);
  const ix = px + 12 + shift, iw = CP_W - 24;                    // laid out at full width, so it slides rather than squeezes
  ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  const reg = node.__lcHits;
  if (!ready()) {
    ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("Loading looks…", ix, py + 24);
    ctx.restore(); return;
  }
  const d = readColor(node), tab = S.colorTab, clickable = e > 0.98;

  ctx.fillStyle = C.head; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Color", ix, py + 17);
  if (K.error) { ctx.fillStyle = "#e07a5f"; ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "right"; ctx.fillText(fitText(ctx, K.error, iw - 170), ix + iw - 100, py + 17); }
  ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(ix, py + 29.5); ctx.lineTo(ix + iw, py + 29.5); ctx.stroke();

  const tw = (iw - 4 * 4) / 5, ty = py + 38;
  TABS.forEach(([id, label], i) => {
    const tx = ix + i * (tw + 4);
    const on = tab === id;
    rr(ctx, tx, ty, tw, 26, 5); ctx.fillStyle = on ? "#5a5a5a" : C.btn; ctx.fill();
    if (on) { ctx.strokeStyle = "#8c8c8c"; ctx.stroke(); }
    ctx.fillStyle = on ? "#fff" : "#d0d0d0"; ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, tx + tw / 2, ty + 13.5);
    if (id !== "start" && sectionActive(id, d[id])) { ctx.fillStyle = ORANGE; ctx.beginPath(); ctx.arc(tx + tw - 7, ty + 6, 2.8, 0, Math.PI * 2); ctx.fill(); }
    if (clickable) hit(node, "ed:cp:tab:" + id, tx, ty, tw, 26, () => { S.colorTab = id; node.setDirtyCanvas(true, true); }, "pointer");
  });

  const cy = ty + 36, viewH = py + ph - cy - 6;
  const clipRect = () => { ctx.beginPath(); ctx.rect(px + 2, cy - 2, pw - 4, viewH + 4); ctx.clip(); };
  const done = () => {};

  if (tab === "start") {
    const RS = 68, STR = { lut: ["strength", "Strength"], fx: ["strength", "Strength"], grain: ["grain_amount", "Amount"], lens: ["strength", "Strength"] };
    const nl = (d.layers || []).length, total = IDS.length * RS + 80 + (nl ? 34 + nl * 30 : 0), maxScroll = Math.max(0, total - viewH);
    K.scroll = K.scroll || {};
    K.scroll.start = clamp(K.scroll.start || 0, 0, maxScroll);
    const sc = K.scroll.start;
    if (clickable) wheelZone(node, "cp:wheel", px, py, pw, ph, (dy) => { K.scroll.start = clamp((K.scroll.start || 0) + dy * 0.7, 0, maxScroll); node.setDirtyCanvas(true, false); });
    ctx.save(); clipRect();
    const inView = (y0, h) => clickable && y0 >= cy - 6 && y0 + h <= cy + viewH + 6;
    IDS.forEach((id, i) => {
      const ry = cy + i * RS + 6 - sc, sec = d[id];
      if (ry + RS < cy - 4 || ry > cy + viewH + 4) return;
      drawDot(ctx, node, "cp:on:" + id, ix + 8, ry + 14, sec.on, () => setSection(node, id, { on: !sec.on }, true));
      ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = sec.on ? "#ececec" : C.label;
      ctx.fillText(SECTIONS[id].label, ix + 26, ry + 14);
      drawDropdown(ctx, node, id, ix + 74, ry, iw - 74);
      const [key, label] = STR[id];
      if (key in table(id)) drawPanelSlider(ctx, node, id, key, ix + 74, ry + 30, iw - 74 - 10, inView(ry + 30, 28), label);       // how strongly the look is applied
    });
    const by = cy + IDS.length * RS + 14 - sc;
    ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = C.label;
    ctx.fillText("Pick a look, set how strong. Fine-tune in its tab.", ix, by + 6);
    if (by + 20 < cy + viewH) btn(ctx, node, "cp:resetall", ix, by + 20, iw, 28, "Reset all", false, () => {
      const nd = { seed: 0 }; for (const id of IDS) nd[id] = { on: true, preset: "", p: defaultsOf(id) };
      writeColor(node, nd, true);
    });
    if (nl) {                                                      // the snapshot layers, oldest first (they are applied in this order, then your live edits)
      let ly = by + 64;
      ctx.font = "600 12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = C.head;
      ctx.fillText("Layers (baked, under your live edits)", ix, ly + 6);
      ly += 20;
      d.layers.forEach((l, i) => {
        const yy = ly + i * 30;
        if (yy + 28 < cy - 4 || yy > cy + viewH + 4) return;
        rr(ctx, ix, yy, iw - 10, 26, 5); ctx.fillStyle = C.well; ctx.fill(); ctx.strokeStyle = C.wellEdge; ctx.lineWidth = 1; ctx.stroke();
        drawDot(ctx, node, "cp:layer:" + i, ix + 14, yy + 13, l.on, () => setLayers(node, (a) => { a[i].on = !a[i].on; return a; }));
        ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = l.on ? "#ececec" : C.label;
        ctx.fillText(fitText(ctx, (i + 1) + "  " + l.name, iw - 90), ix + 30, yy + 13.5);
        ctx.textAlign = "center"; ctx.fillStyle = "#9a9a9a"; ctx.fillText("\u00d7", ix + iw - 24, yy + 12.5);
        if (inView(yy, 26)) hit(node, "ed:cp:layerx:" + i, ix + iw - 38, yy, 28, 26, () => setLayers(node, (a) => { a.splice(i, 1); return a; }), "pointer");
      });
    }
    ctx.restore();
    if (maxScroll > 0) {
      const th = Math.max(24, viewH * (viewH / total)), tyy = cy + (viewH - th) * (sc / maxScroll);
      rr(ctx, px + pw - 6, tyy, 3, th, 1.5); ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.fill();
    }
  } else {
    const sec = d[tab];
    drawDot(ctx, node, "cp:on:" + tab, ix + 8, cy + 14, sec.on, () => setSection(node, tab, { on: !sec.on }, true));
    drawDropdown(ctx, node, tab, ix + 26, cy, iw - 26 - 64);
    btn(ctx, node, "cp:reset:" + tab, ix + iw - 58, cy, 58, 28, "Reset", false, () => resetSection(node, tab));
    const top = cy + 38, vh = py + ph - top - 6;
    const groups = groupsOf(node, tab);
    const total = groups.reduce((a, g) => a + g.h, 0) + ((tab === "grain" || tab === "fx") ? 40 : 0);
    const maxScroll = Math.max(0, total - vh);
    K.scroll = K.scroll || {};
    K.scroll[tab] = clamp(K.scroll[tab] || 0, 0, maxScroll);
    const sc = K.scroll[tab];
    if (clickable) wheelZone(node, "cp:wheel", px, py, pw, ph, (dy) => { K.scroll[tab] = clamp((K.scroll[tab] || 0) + dy * 0.7, 0, maxScroll); node.setDirtyCanvas(true, false); });
    ctx.save();
    ctx.beginPath(); ctx.rect(px + 2, top - 2, pw - 4, vh + 4); ctx.clip();
    let yy = top - sc;
    for (const g of groups) {
      const gy = yy;
      if (g.head) {                                                           // the group header: click to fold / unfold
        ctx.fillStyle = g.active ? C.head : C.label; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText((g.open ? "\u25be " : "\u25b8 ") + g.head, ix, gy + 13);
        if (g.active) { ctx.beginPath(); ctx.arc(ix + iw - 18, gy + 13, 3, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill(); }
        ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ix, gy + GROUP_H - 4.5); ctx.lineTo(ix + iw - 10, gy + GROUP_H - 4.5); ctx.stroke();
        if (clickable && gy > top - 6 && gy + GROUP_H < top + vh + 6) hit(node, `ed:cp:grp:${tab}:${g.head}`, ix, gy, iw - 10, GROUP_H, () => {
          const K2 = node.__lcColor; K2.groupOpen[tab + ":" + g.head] = !g.open; node.setDirtyCanvas(true, true);
        }, "pointer");
      }
      if (g.head) yy += GROUP_H;
      if (g.open) for (const k of g.keys) {
        if (yy + ROW_H > top - 4 && yy < top + vh + 4) drawPanelSlider(ctx, node, tab, k, ix, yy, iw - 10, clickable && yy >= top - 6 && yy + ROW_H <= top + vh + 6, undefined, true);
        yy += ROW_H;
      }
    }
    if (tab === "grain" || tab === "fx") {                                   // the seed (grain, leaks, dust)
      rr(ctx, ix, yy + 8, iw - 10, 28, 5); ctx.fillStyle = C.well; ctx.fill(); ctx.strokeStyle = C.wellEdge; ctx.stroke();
      ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = C.label; ctx.fillText(tab === "fx" ? "Seed (leaks, dust)" : "Seed", ix + 30, yy + 22);
      ctx.textAlign = "center"; ctx.fillStyle = "#777"; ctx.fillText("‹", ix + 12, yy + 21); ctx.fillText("›", ix + iw - 22, yy + 21);
      ctx.textAlign = "right"; ctx.fillStyle = "#ececec"; ctx.fillText(String(d.seed), ix + iw - 36, yy + 22);
      if (clickable && yy > top - 6 && yy + 40 < top + vh + 6) hit(node, "ed:cp:seed", ix, yy + 8, iw - 10, 28, ({ pos }) => {
        const cur = readColor(node);
        if (pos[0] < ix + 26) writeColor(node, { ...cur, seed: Math.max(0, cur.seed - 1) }, true);
        else if (pos[0] > ix + iw - 36) writeColor(node, { ...cur, seed: cur.seed + 1 }, true);
        else app.canvas.prompt("Seed", cur.seed, (s) => { const n = parseInt(s, 10); if (!Number.isNaN(n) && n >= 0) writeColor(node, { ...cur, seed: n }, true); }, null);
      }, "pointer");
    }
    ctx.restore();
    if (maxScroll > 0) {                                                     // a thin scroll indicator
      const th = Math.max(24, vh * (vh / total)), tyy = top + (vh - th) * (sc / maxScroll);
      rr(ctx, px + pw - 6, tyy, 3, th, 1.5); ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.fill();
    }
  }
  ctx.restore();
}

export const COLOR_HIDDEN = [WIDGET];
