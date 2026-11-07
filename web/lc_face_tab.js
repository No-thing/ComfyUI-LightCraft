import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { C, M, FONT, rr } from "./lightcraft_ui.js";
import { hit, drag, wheelZone } from "./lc_interact.js";
import { EYE_COLORS, regionOpts, regionRun, drawRegionCompare, drawRegionBig } from "./lc_region_job.js";

// Edit Page > Face tab: local face reshaping (a Liquify built from face landmarks).
//
//   * "Find face" runs Google's MediaPipe Face Landmarker IN THE BROWSER (478 points). Its files are downloaded once by
//     the server (lc_face_assets.py) the first time you press the button; nothing leaves your computer afterwards.
//   * Each slider is one or more soft round regions around a landmark (see build_ops in lc_face.py, ported here line for
//     line). The regions add up to one smooth displacement field. The preview draws it with a WebGL shader, Python
//     applies the identical field to the full-size picture on run, so what you see is what you get.
//   * Everything lives in ONE hidden JSON widget (face_data): the landmarks, the slider values, the size of the picture.

const ORANGE = "#ff8a2a";
const WIDGET = "face_data";
const PROXY_MAX = 1600;
export const FACE_W = 276;
export const FACE_MIN_NODE_W = 900;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const W = (node, name) => node.widgets && node.widgets.find((w) => w.name === name);

export const GROUPS = [
  ["eyes", "Eyes", [["eye_size", "Size"], ["eye_width", "Width"], ["eye_open", "Openness"], ["eye_tilt", "Tilt"], ["eye_spacing", "Spacing"]]],
  ["nose", "Nose", [["nose_size", "Size"], ["nose_width", "Nostril width"], ["nose_bridge", "Bridge"], ["nose_tip", "Tip lift"]]],
  ["lips", "Lips", [["lip_fullness", "Fullness"], ["lip_upper", "Upper lip"], ["lip_lower", "Lower lip"], ["lip_width", "Width"], ["lip_corners", "Corners"], ["lip_height", "Mouth height"]]],
  ["shape", "Face shape", [["jaw_width", "Jaw width"], ["chin_length", "Chin length"], ["chin_width", "Chin width"], ["cheek_fullness", "Cheeks"]]],
  ["brows", "Brows and forehead", [["brow_height", "Brow height"], ["brow_tilt", "Brow tilt"], ["forehead_height", "Forehead"]]],
];
export const SLIDERS = GROUPS.flatMap((g) => g[2].map((r) => r[0]));
// the landmarks you can drag by hand when the finder was a little off (MediaPipe numbering)
const HANDLES = [33, 133, 159, 145, 263, 362, 386, 374, 6, 1, 129, 358, 61, 291, 0, 13, 14, 17];

// ---------------------------------------------------------------- the ops (mirror of lc_face.py build_ops)
const MAX_OPS = 40, CUT = 4.5;
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const op = (c, sx, sy, pivot, t, m) => ({ c, s: [sx, sy], pv: pivot || c, t: t || [0, 0], m: m || [0, 0, 0, 0] });
const scaleOp = (c, sx, sy, kx, ky, pivot) => op(c, sx, sy, pivot, [0, 0], [-kx, 0, 0, -ky]);
const moveOp = (c, sx, sy, dx, dy) => op(c, sx, sy, null, [-dx, -dy], [0, 0, 0, 0]);
const rotateOp = (c, sx, sy, pivot, phi) => { const co = Math.cos(phi), si = Math.sin(phi); return op(c, sx, sy, pivot, [0, 0], [co - 1, si, -si, co - 1]); };

// The face's own axes as the camera sees them (mirror of pose() in lc_face.py): the columns of A are the picture-plane
// projections of the face's unit "right" and "down" directions. Roll turns them, yaw / pitch shorten them.
// zpx = depth in pixels of landmarks 33, 263, 61, 291 (MediaPipe z times the picture width); without it only the roll is known.
export function pose(P, zpx) {
  const z = zpx && zpx.length >= 4 ? zpx : [0, 0, 0, 0];
  const L = P(33), R = P(263), ML = P(61), MR = P(291);
  const r = [R[0] - L[0], R[1] - L[1], z[1] - z[0]];
  const em = [(L[0] + R[0]) / 2, (L[1] + R[1]) / 2, (z[0] + z[1]) / 2];
  let d = [(ML[0] + MR[0]) / 2 - em[0], (ML[1] + MR[1]) / 2 - em[1], (z[2] + z[3]) / 2 - em[2]];
  const rn = Math.hypot(r[0], r[1], r[2]) || 1, u = r.map((a) => a / rn);
  const dot = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  d = d.map((a, i) => a - u[i] * dot);
  const dn = Math.hypot(d[0], d[1], d[2]);
  const v = dn > 1e-6 ? d.map((a) => a / dn) : [-u[1], u[0], 0];
  let A = [[u[0], v[0]], [u[1], v[1]]];
  if (Math.abs(A[0][0] * A[1][1] - A[0][1] * A[1][0]) < 0.3) {                // an extreme turn: trust only the roll
    const ln = Math.hypot(r[0], r[1]) || 1, ux = r[0] / ln, uy = r[1] / ln;
    A = [[ux, -uy], [uy, ux]];
  }
  return { o: [em[0], em[1]], A };
}
const mv = (M, p) => [M[0][0] * p[0] + M[0][1] * p[1], M[1][0] * p[0] + M[1][1] * p[1]];
function toImage(op0, o, A, Ai) {                                              // an op made in the face's frontal frame -> picture pixels
  const c = mv(A, op0.c), pv = mv(A, op0.pv), t = mv(A, op0.t), m = op0.m;
  const Mq = [[m[0], m[1]], [m[2], m[3]]];
  const AM = [0, 1].map((i) => [0, 1].map((j) => A[i][0] * Mq[0][j] + A[i][1] * Mq[1][j]));
  const Mp = [0, 1].map((i) => [0, 1].map((j) => AM[i][0] * Ai[0][j] + AM[i][1] * Ai[1][j]));
  const [sx, sy] = op0.s;
  return { c: [o[0] + c[0], o[1] + c[1]], pv: [o[0] + pv[0], o[1] + pv[1]], t, m: [Mp[0][0], Mp[0][1], Mp[1][0], Mp[1][1]],
    g: [Ai[0][0] / sx, Ai[0][1] / sx, Ai[1][0] / sy, Ai[1][1] / sy] };
}

// P: (i) -> [x, y] in pixels; params: slider -> -100..100; zpx: see pose()
export function buildOps(P0, params, zpx) {
  const g = (k) => (Number(params[k]) || 0) / 100;
  const { o: org, A } = pose(P0, zpx);
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  const Ai = [[A[1][1] / det, -A[0][1] / det], [-A[1][0] / det, A[0][0] / det]];
  // everything below is laid out in the face's own frame (x along the eyes, y down the face), where it is square-on
  const P = (i) => { const q = P0(i); return mv(Ai, [q[0] - org[0], q[1] - org[1]]); };
  const ops = [];
  const fs = Math.max(dist(P(33), P(263)), 1);
  for (const eye of [{ outer: 33, inner: 133, top: 159, bottom: 145 }, { outer: 263, inner: 362, top: 386, bottom: 374 }]) {
    const o = P(eye.outer), i = P(eye.inner);
    const c = lerp(lerp(o, i, 0.5), lerp(P(eye.top), P(eye.bottom), 0.5), 0.5);
    const ew = Math.max(dist(o, i), 1), sgn = o[0] > i[0] ? 1 : -1;
    const sx = 0.62 * ew, sy = 0.42 * ew;
    if (g("eye_size")) ops.push(scaleOp(c, sx, sy, 0.22 * g("eye_size"), 0.22 * g("eye_size")));
    if (g("eye_width")) ops.push(scaleOp(c, sx, sy, 0.22 * g("eye_width"), 0));
    if (g("eye_open")) ops.push(scaleOp(c, sx, sy, 0, 0.40 * g("eye_open")));
    if (g("eye_tilt")) ops.push(rotateOp(c, 0.66 * ew, 0.46 * ew, lerp(i, o, 0.3), -sgn * 0.20 * g("eye_tilt")));
    if (g("eye_spacing")) ops.push(moveOp(c, 0.72 * ew, 0.62 * ew, sgn * 0.075 * fs * g("eye_spacing"), 0));
  }
  const tip = P(1), bridge = P(6), al = P(129), ar = P(358);
  const nw = Math.max(dist(al, ar), 1), nc = lerp(bridge, tip, 0.62);
  if (g("nose_size")) ops.push(scaleOp(nc, 0.50 * nw, 0.60 * nw, 0.12 * g("nose_size"), 0.12 * g("nose_size")));
  if (g("nose_width")) ops.push(scaleOp(lerp(al, ar, 0.5), 0.42 * nw, 0.30 * nw, 0.20 * g("nose_width"), 0));
  if (g("nose_bridge")) ops.push(scaleOp(lerp(bridge, tip, 0.35), 0.20 * nw, 0.45 * nw, 0.28 * g("nose_bridge"), 0));
  if (g("nose_tip")) ops.push(moveOp(tip, 0.26 * nw, 0.26 * nw, 0, -0.10 * nw * g("nose_tip")));
  const ml = P(61), mr = P(291), mw = Math.max(dist(ml, mr), 1), mc = lerp(ml, mr, 0.5);
  const tOut = P(0), tIn = P(13), bIn = P(14), bOut = P(17), mid = lerp(tIn, bIn, 0.5);
  if (g("lip_fullness")) ops.push(scaleOp(mid, 0.30 * mw, 0.20 * mw, 0.04 * g("lip_fullness"), 0.50 * g("lip_fullness")));
  if (g("lip_upper")) ops.push(scaleOp(lerp(tIn, tOut, 0.5), 0.34 * mw, 0.12 * mw, 0, 0.55 * g("lip_upper"), tIn));
  if (g("lip_lower")) ops.push(scaleOp(lerp(bIn, bOut, 0.5), 0.34 * mw, 0.14 * mw, 0, 0.55 * g("lip_lower"), bIn));
  if (g("lip_width")) for (const m of [ml, mr]) ops.push(moveOp(m, 0.17 * mw, 0.15 * mw, (m[0] > mc[0] ? 1 : -1) * 0.065 * mw * g("lip_width"), 0));      // the two corners: only the lips, never the cheeks or jaw
  if (g("lip_corners")) for (const m of [ml, mr]) ops.push(moveOp(m, 0.17 * mw, 0.17 * mw, 0, -0.11 * mw * g("lip_corners")));
  if (g("lip_height")) ops.push(moveOp(mc, 0.62 * mw, 0.40 * mw, 0, -0.12 * mw * g("lip_height")));
  // face shape: jaw corners, chin, cheeks (mirror of lc_face.py)
  const chin = P(152), chinTop = P(175);
  if (g("jaw_width")) for (const j of [P(172), P(397)]) ops.push(moveOp(j, 0.21 * fs, 0.24 * fs, (j[0] > chin[0] ? 1 : -1) * 0.065 * fs * g("jaw_width"), 0));
  if (g("chin_length")) ops.push(moveOp(chin, 0.22 * fs, 0.21 * fs, 0, 0.08 * fs * g("chin_length")));
  if (g("chin_width")) ops.push(scaleOp(lerp(chin, chinTop, 0.4), 0.18 * fs, 0.16 * fs, 0.22 * g("chin_width"), 0));
  if (g("cheek_fullness")) for (const c of [P(50), P(280)]) ops.push(scaleOp(c, 0.21 * fs, 0.20 * fs, 0.11 * g("cheek_fullness"), 0.11 * g("cheek_fullness")));
  // brows and forehead
  for (const brow of [{ outer: 70, inner: 107, arch: 105 }, { outer: 300, inner: 336, arch: 334 }]) {
    const arch = P(brow.arch), bo = P(brow.outer), bi = P(brow.inner), sg = bo[0] > bi[0] ? 1 : -1;
    if (g("brow_height")) ops.push(moveOp(arch, 0.28 * fs, 0.14 * fs, 0, -0.05 * fs * g("brow_height")));
    if (g("brow_tilt")) ops.push(rotateOp(arch, 0.32 * fs, 0.15 * fs, bi, -sg * 0.16 * g("brow_tilt")));
  }
  if (g("forehead_height")) { const fm = P(151), ft = P(10); ops.push(scaleOp(lerp(fm, ft, 0.5), 0.56 * fs, 0.32 * fs, 0, 0.085 * g("forehead_height"), fm)); }
  return ops.slice(0, MAX_OPS).map((q) => toImage(q, org, A, Ai));
}

// ---------------------------------------------------------------- state (one hidden JSON widget)
function parse(raw) {
  let d = null;
  try { d = JSON.parse(raw || "{}"); } catch (e) { d = null; }
  if (!d || typeof d !== "object") d = {};
  const p = {};
  for (const k of SLIDERS) p[k] = Number((d.p || {})[k]) || 0;
  return { faces: Array.isArray(d.faces) ? d.faces : [], sel: Number(d.sel) || 0, p, on: d.on !== false, src: String(d.src || ""), zs: Array.isArray(d.zs) ? d.zs : [], pic: String(d.pic || "") };
}

export function readFace(node) {
  const w = W(node, WIDGET), raw = w ? w.value : "";
  const K = node.__lcFace || (node.__lcFace = {});
  if (K.raw !== raw || !K.data) { K.data = parse(raw); K.raw = raw; K.ver = (K.ver || 0) + 1; }
  return K.data;
}

function writeFace(node, data, done) {
  const w = W(node, WIDGET);
  if (!w) return;
  const K = node.__lcFace || (node.__lcFace = {});
  K.data = data; K.raw = JSON.stringify(data); K.ver = (K.ver || 0) + 1;
  w.value = K.raw;
  if (done) {
    if (w.callback) { try { w.callback(w.value, app.canvas, node); } catch (e) { /* ignore */ } }
    if (app.graph && app.graph.change) app.graph.change();
  }
  node.setDirtyCanvas(true, true);
}

// History: a picked result already has the reshape in it, so its sliders go back to zero; the Source gets the last sliders back
export function faceSliders(node) { try { return { ...readFace(node).p }; } catch (e) { return null; } }
export function faceSetSliders(node, p) {
  try {
    const d = readFace(node), q = {};
    for (const k of SLIDERS) q[k] = p ? Number(p[k]) || 0 : 0;
    writeFace(node, { ...d, p: q }, true);
  } catch (e) { /* the Face tab is optional */ }
}

const anyMove = (d) => SLIDERS.some((k) => Math.abs(d.p[k]) > 1e-6);
export const faceActive = (node) => { try { const d = readFace(node); return d.on && d.faces.length > 0 && anyMove(d); } catch (e) { return false; } };

// flat [x0, y0, x1, y1, ...] (0..1) -> (i) => [x, y] in pixels of a w x h picture
const pointer = (flat, w, h) => (i) => [flat[2 * i] * w, flat[2 * i + 1] * h];

// ---------------------------------------------------------------- the warp, drawn by WebGL2
const VERT = `#version 300 es
in vec2 aPos; out vec2 vUV;
void main(){ vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform vec2 uSize; uniform int uN; uniform vec4 uOp[${MAX_OPS * 4}];
in vec2 vUV; out vec4 o;
const float CUT = ${CUT.toFixed(1)};
void main(){
  vec2 p = vUV * uSize; vec2 off = vec2(0.0); float e0 = exp(-CUT);
  for (int i = 0; i < ${MAX_OPS}; i++) {
    if (i >= uN) break;
    vec4 a = uOp[i * 4]; vec4 b = uOp[i * 4 + 1]; vec4 c = uOp[i * 4 + 2]; vec4 e = uOp[i * 4 + 3];
    vec2 dp = p - a.xy; vec2 d = vec2(b.z * dp.x + b.w * dp.y, c.x * dp.x + c.y * dp.y); float r2 = dot(d, d);
    if (r2 < 2.0 * CUT) {
      float w = max((exp(-0.5 * r2) - e0) / (1.0 - e0), 0.0);
      vec2 q = p - a.zw;
      off += w * (b.xy + vec2(c.z * q.x + c.w * q.y, e.x * q.x + e.y * q.y));
    }
  }
  o = texture(uTex, (p + off) / uSize);
}`;

let GL = null;
function engine() {
  if (GL) return GL.fail ? null : GL;
  try {
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("no webgl2");
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    const U = {};
    for (const n of ["uTex", "uSize", "uN", "uOp"]) U[n] = gl.getUniformLocation(prog, n);
    GL = { cv, gl, tex, U, src: null };
  } catch (e) { console.warn("[LightCraft] Face preview needs WebGL2:", e); GL = { fail: true }; return null; }
  return GL;
}

// draws src (canvas / image, w x h) through the ops -> a fresh canvas, or null without WebGL
export function renderWarp(src, w, h, ops) {
  const E = engine();
  if (!E) return null;
  const { gl, cv, U } = E;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  gl.viewport(0, 0, w, h);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, E.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const data = new Float32Array(MAX_OPS * 16);
  ops.slice(0, MAX_OPS).forEach((o, i) => data.set([o.c[0], o.c[1], o.pv[0], o.pv[1], o.t[0], o.t[1], o.g[0], o.g[1], o.g[2], o.g[3], o.m[0], o.m[1], o.m[2], o.m[3], 0, 0], i * 16));
  gl.uniform1i(U.uTex, 0);
  gl.uniform2f(U.uSize, w, h);
  gl.uniform1i(U.uN, Math.min(ops.length, MAX_OPS));
  gl.uniform4fv(U.uOp, data);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d").drawImage(cv, 0, 0);
  return out;
}

// ---------------------------------------------------------------- the picture (a proxy of the source)
function baseProxy(node, st) {
  const K = node.__lcFace || (node.__lcFace = {});
  const src = st.s.full || st.s.img;
  if (!src) return null;
  const k = Math.min(1, PROXY_MAX / Math.max(st.s.w, st.s.h));
  const w = Math.max(2, Math.round(st.s.w * k)), h = Math.max(2, Math.round(st.s.h * k));
  const key = `${st.s.w}x${st.s.h}|${w}x${h}|${st.s.tag || ""}|${src.width}`;
  if (!K.base || K.base.src !== src || K.base.key !== key) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const c = cv.getContext("2d");
    c.imageSmoothingQuality = "high";
    c.drawImage(src, 0, 0, src.width || st.s.w, src.height || st.s.h, 0, 0, w, h);
    K.base = { src, key, img: cv, w, h };
    K.warp = null;
  }
  return K.base;
}

const zOf = (d, w) => { const z = d.zs[clamp(d.sel, 0, Math.max(0, d.faces.length - 1))]; return Array.isArray(z) && z.length >= 4 ? z.slice(0, 4).map((v) => v * w) : null; };
// the Edit Page names every picture it shows lc_src_<id>.png; the face belongs to ONE such picture (a new random roll has another id)
const picId = (st) => { const m = /^lc_src_([0-9a-f]{16})\.png$/.exec(String((st.s && st.s.tag) || "")); return m ? m[1] : ""; };
const sameSource = (d, st) => (!d.src || d.src === `${st.s.w}x${st.s.h}`) && (!d.pic || !picId(st) || d.pic === picId(st));
const stale = (d, st) => d.faces.length > 0 && !sameSource(d, st);
const selFace = (d) => (d.faces.length ? d.faces[clamp(d.sel, 0, d.faces.length - 1)] : null);

function warpedPicture(node, st, base) {
  const K = node.__lcFace, d = readFace(node), face = selFace(d);
  if (!d.on || !face || !anyMove(d) || !sameSource(d, st) || face.length < 936) return null;
  const sig = JSON.stringify([d.p, d.sel, K.ver, base.w, base.h]);
  if (!K.warp || K.warp.sig !== sig || K.warp.base !== base) {
    const ops = buildOps(pointer(face, base.w, base.h), d.p, zOf(d, base.w));
    const out = renderWarp(base.img, base.w, base.h, ops);
    K.warp = out ? { sig, base, img: out, ops } : null;
  }
  return K.warp ? K.warp.img : null;
}

// the reshaped picture as {img, w, h} for the Compare tab (null when there is no reshape to show)
export function faceLivePicture(node, st) {
  try {
    const base = baseProxy(node, st);
    const img = base ? warpedPicture(node, st, base) : null;
    return img ? { before: { img: base.img, w: base.w, h: base.h }, after: { img, w: base.w, h: base.h } } : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- guide lines (eyes, nose, lips) that move with the warp
// Landmark loops (MediaPipe numbering). They are drawn a little outside the feature, like Photoshop's Liquify face guides.
const EYE_LOOPS = [[33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7], [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249]];
const LIP_LOOP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
const grow = (pts, k) => { const c = pts.reduce((a, q) => [a[0] + q[0] / pts.length, a[1] + q[1] / pts.length], [0, 0]); return pts.map((q) => [c[0] + (q[0] - c[0]) * k, c[1] + (q[1] - c[1]) * k]); };
// the guide loops for one face, in the picture's pixels: [{group, pts}]
function guideLoops(P) {
  const out = [];
  for (const l of EYE_LOOPS) out.push({ group: "eyes", pts: grow(l.map(P), 1.32) });
  out.push({ group: "lips", pts: grow(LIP_LOOP.map(P), 1.22) });
  const b = lerp(P(6), P(1), 0.3), al = P(129), ar = P(358), n2 = P(2), n98 = P(98), n327 = P(327);       // from the middle of the bridge down around the nostrils
  const nose = [b, lerp(b, al, 0.55), al, n98, n2, n327, ar, lerp(b, ar, 0.55)];
  out.push({ group: "nose", pts: grow(nose, 1.12) });
  return out;
}
// where a source point ends up in the warped picture: the shader samples source = p + off(p), so solve p = s - off(p)
function fieldAt(ops, x, y) {
  let ox = 0, oy = 0;
  for (const o of ops) {
    const dx = x - o.c[0], dy = y - o.c[1], a = o.g[0] * dx + o.g[1] * dy, b = o.g[2] * dx + o.g[3] * dy, r2 = a * a + b * b;
    if (r2 >= 2 * CUT) continue;
    const w = Math.max((Math.exp(-0.5 * r2) - Math.exp(-CUT)) / (1 - Math.exp(-CUT)), 0), qx = x - o.pv[0], qy = y - o.pv[1];
    ox += w * (o.t[0] + o.m[0] * qx + o.m[1] * qy); oy += w * (o.t[1] + o.m[2] * qx + o.m[3] * qy);
  }
  return [ox, oy];
}
export function warpPoint(ops, s) {
  if (!ops || !ops.length) return s;
  let p = [s[0], s[1]];
  for (let i = 0; i < 6; i++) { const f = fieldAt(ops, p[0], p[1]); p = [s[0] - f[0], s[1] - f[1]]; }
  return p;
}
function smoothLoop(ctx, q) {                                                   // a closed Catmull-Rom curve through the points
  const n = q.length;
  ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = q[(i - 1 + n) % n], p1 = q[i], p2 = q[(i + 1) % n], p3 = q[(i + 2) % n];
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  ctx.closePath();
}
function drawGuides(ctx, node, face, ops, base, ix, iy, iw, ih) {
  const K = node.__lcFace, P = pointer(face, base.w, base.h);
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const L of guideLoops(P)) {
    const q = L.pts.map((pt) => { const m = warpPoint(ops, pt); return [ix + (m[0] / base.w) * iw, iy + (m[1] / base.h) * ih]; });
    const hot = K.hot === L.group;
    smoothLoop(ctx, q);
    ctx.strokeStyle = "rgba(0,0,0,0.38)"; ctx.lineWidth = hot ? 3.2 : 2.6; ctx.stroke();                 // a soft dark edge keeps the line readable on light skin
    smoothLoop(ctx, q);
    ctx.strokeStyle = hot ? "rgba(255,255,255,0.98)" : "rgba(235,235,240,0.72)"; ctx.lineWidth = hot ? 1.5 : 1.1; ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- finding the face (MediaPipe, in the browser)
const fileUrl = (name) => api.apiURL("/lightcraft/face_file/" + name);
async function landmarker(K) {
  if (K.lm) return K.lm;
  if (K.lmLoading) return K.lmLoading;
  K.lmLoading = (async () => {
    K.status = "Checking the face model…";
    let st = await (await fetch(api.apiURL("/lightcraft/face_setup"))).json();
    if (!st.ready) {
      K.status = "Downloading the face model (about 12 MB, once)…";
      const r = await fetch(api.apiURL("/lightcraft/face_setup"), { method: "POST" });
      st = await r.json();
      if (!st.ready) throw new Error(st.error || "The face model could not be downloaded.");
    }
    K.status = "Starting the face finder…";
    const mod = await import(/* @vite-ignore */ fileUrl("vision_bundle.mjs"));
    const fileset = await mod.FilesetResolver.forVisionTasks(api.apiURL("/lightcraft/face_file"));
    const make = (delegate) => mod.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: fileUrl("face_landmarker.task"), delegate },
      runningMode: "IMAGE", numFaces: 4, minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3,
    });
    try { K.lm = await make("GPU"); } catch (e) { K.lm = await make("CPU"); }
    return K.lm;
  })();
  try { return await K.lmLoading; } finally { K.lmLoading = null; }
}

async function findFaces(node, st, quiet) {
  const K = node.__lcFace || (node.__lcFace = {});
  if (K.busy) return;
  K.busy = true; K.error = ""; K.status = quiet ? "New picture: looking for the face again…" : "";
  node.setDirtyCanvas(true, true);
  try {
    const lm = await landmarker(K);
    K.status = "Looking for faces…";
    node.setDirtyCanvas(true, true);
    const base = baseProxy(node, st);
    const res = lm.detect(base.img);
    const found = (res.faceLandmarks || []).map((f) => {
      const flat = [];
      for (const p of f) flat.push(Math.round(p.x * 1e4) / 1e4, Math.round(p.y * 1e4) / 1e4);
      const z = [33, 263, 61, 291].map((i) => Math.round((f[i].z || 0) * 1e4) / 1e4);       // depth of the eye and mouth corners: how far the head is turned
      return { flat, z, cx: f.reduce((a, q) => a + q.x, 0) / f.length };
    }).filter((f) => f.flat.length >= 936).sort((a, b) => a.cx - b.cx);                      // left to right; each face keeps its own depth values
    const faces = found.map((f) => f.flat), zs = found.map((f) => f.z);
    if (!faces.length) {
      K.error = "No face found. Try a larger, front-facing face.";
      if (quiet) { const cur = readFace(node); writeFace(node, { ...cur, faces: [], zs: [], sel: 0, src: `${st.s.w}x${st.s.h}`, pic: picId(st) }, true); }   // never keep the old face on a new picture
    } else {
      const cur = readFace(node);
      writeFace(node, { ...cur, faces, zs, sel: 0, src: `${st.s.w}x${st.s.h}`, pic: picId(st) }, true);
      K.status = quiet ? (faces.length > 1 ? `New picture: found ${faces.length} faces.` : "New picture: face found again, sliders kept. Reset starts clean.") : faces.length > 1 ? `Found ${faces.length} faces. Click one to pick it.` : "Face found. Move the sliders.";
    }
  } catch (e) {
    K.error = String((e && e.message) || e);
    K.lm = null;
  }
  K.busy = false;
  node.setDirtyCanvas(true, true);
}

// A new picture (another roll, another image) never keeps the old face: the landmarks are found again by themselves and
// the slider values carry over. Only runs for people who already use the Face tab (the model is then downloaded).
export function faceAutoRefresh(node, st) {
  const K = node.__lcFace || (node.__lcFace = {});
  if (!st || !st.s || K.busy) return;
  const d = readFace(node), id = picId(st);
  if (!d.faces.length || !stale(d, st)) return;
  const key = id + "|" + st.s.w + "x" + st.s.h;
  if (K.tried === key) return;                                           // once per picture
  K.tried = key;
  const go = () => { if (K.busy) setTimeout(go, 150); else findFaces(node, st, true); };
  go();
}

// ---------------------------------------------------------------- the slide animation (same exponential in-out as the Color panel)
const easeInOutExpo = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2);
const DUR_IN = 560, DUR_OUT = 440;
export function faceOpenness(node, open) {
  const K = node.__lcFace || (node.__lcFace = {});
  const now = performance.now(), target = open ? 1 : 0;
  if (K.t === undefined) { K.t = target; K.e = target; K.anim = null; }
  if (!K.anim && K.t !== target) K.anim = { from: K.t, to: target, start: now };
  if (K.anim && K.anim.to !== target) K.anim = { from: K.e, to: target, start: now };
  if (K.anim) {
    const a = K.anim, dur = a.to > a.from ? DUR_IN : DUR_OUT;
    const p = clamp((now - a.start) / dur, 0, 1);
    K.e = a.from + (a.to - a.from) * easeInOutExpo(p);
    if (p >= 1) { K.t = a.to; K.e = a.to; K.anim = null; } else requestAnimationFrame(() => node.setDirtyCanvas(true, false));
  } else K.e = K.t;
  return K.e;
}

// ---------------------------------------------------------------- the picture view
const fit = (w, h, x, y, bw, bh) => { const k = Math.min(bw / w, bh / h), rw = w * k, rh = h * k; return [x + (bw - rw) / 2, y + (bh - rh) / 2, rw, rh]; };
function fitText(ctx, text, maxW) {
  let t = String(text);
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

export function drawFaceView(ctx, node, st, vx, vy, vw, vh) {
  const S = node.__lc, K = node.__lcFace || (node.__lcFace = {});
  const base = st ? baseProxy(node, st) : null;
  ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (!base) { ctx.fillText("Choose a picture in the Crop tab, or run the workflow once.", vx + vw / 2, vy + vh / 2); return; }
  faceAutoRefresh(node, st);
  const d = readFace(node), face = selFace(d);
  const ok = !!face && sameSource(d, st);
  const placing = !!S.facePoints;                                        // while the points are shown the original is drawn, so they sit on the features
  const warped = !K.hold && !placing ? warpedPicture(node, st, base) : null;
  const [ix, iy, iw, ih] = fit(base.w, base.h, vx + 6, vy + 6, vw - 12, vh - 12);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(warped || base.img, ix, iy, iw, ih);
  K.map = [ix, iy, iw, ih];
  if (face && ok && S.faceGuides !== false) drawGuides(ctx, node, face, warped && K.warp ? K.warp.ops : null, base, ix, iy, iw, ih);

  if (face && !ok) {
    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(vx, vy + vh - 30, vw, 30);
    ctx.fillStyle = "#ffcf9e"; ctx.font = FONT; ctx.textAlign = "center"; ctx.fillText("This is a different picture than the one the face was found on. Press Find face again.", vx + vw / 2, vy + vh - 15);
  }
  if (ok) {
    const X = (x) => ix + x * iw, Y = (y) => iy + y * ih;
    // other faces: a thin box that can be clicked to pick that one
    d.faces.forEach((f, n) => {
      if (n === d.sel) return;
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (let i = 0; i < f.length; i += 2) { x0 = Math.min(x0, f[i]); x1 = Math.max(x1, f[i]); y0 = Math.min(y0, f[i + 1]); y1 = Math.max(y1, f[i + 1]); }
      ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1; ctx.strokeRect(X(x0), Y(y0), (x1 - x0) * iw, (y1 - y0) * ih); ctx.setLineDash([]);
      hit(node, "ed:face:pick:" + n, X(x0), Y(y0), (x1 - x0) * iw, (y1 - y0) * ih, () => { writeFace(node, { ...readFace(node), sel: n }, true); }, "pointer");
    });
    if (S.facePoints) {
      for (const idx of HANDLES) {
        const px = X(face[2 * idx]), py = Y(face[2 * idx + 1]);
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,138,42,0.95)"; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.stroke();
        hit(node, "ed:face:pt:" + idx, px - 8, py - 8, 16, 16, ({ ev }) => {
          const x0 = readFace(node).faces[readFace(node).sel][2 * idx], y0 = readFace(node).faces[readFace(node).sel][2 * idx + 1];
          drag({
            node, ev, cursor: "grabbing",
            onMove: (dx, dy) => {
              const cur = readFace(node), faces = cur.faces.map((f) => f.slice());
              faces[cur.sel][2 * idx] = clamp(x0 + dx / iw, 0, 1); faces[cur.sel][2 * idx + 1] = clamp(y0 + dy / ih, 0, 1);
              writeFace(node, { ...cur, faces }, false);
            },
            onUp: () => writeFace(node, readFace(node), true),
          });
        }, "grab");
      }
    }
  }
  if (K.hold || (placing && ok)) {
    const label = K.hold ? "Original" : "Original · drag the points", lw = K.hold ? 70 : 170;
    ctx.fillStyle = "rgba(0,0,0,0.55)"; rr(ctx, vx + 10, vy + 10, lw, 22, 5); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = FONT; ctx.textAlign = "center"; ctx.fillText(label, vx + 10 + lw / 2, vy + 21.5);
  }
  if (!face) {
    ctx.fillStyle = "rgba(0,0,0,0.5)"; rr(ctx, vx + vw / 2 - 150, vy + vh - 44, 300, 30, 6); ctx.fill();
    ctx.fillStyle = "#e6e6e6"; ctx.font = FONT; ctx.textAlign = "center"; ctx.fillText("Press “Find face” in the panel to begin.", vx + vw / 2, vy + vh - 29);
  }
  if (K.busy) { ctx.fillStyle = "rgba(255,138,42,0.9)"; ctx.beginPath(); ctx.arc(vx + vw - 14, vy + 14, 4, 0, Math.PI * 2); ctx.fill(); }
  drawRegionBig(ctx, node, vx, vy, vw, vh, (id, hx, hy, hw, hh, fn) => hit(node, "ed:" + id, hx, hy, hw, hh, fn, "pointer"));
}

// ---------------------------------------------------------------- the panel
const ROW_H = 28, HEAD_H = 30;

// the Face protect nodes of the workflow (they sit inside the AusBoss box, so the subgraphs are searched too)
function faceProtectNodes() {
  const out = [], walk = (g, d) => { if (!g || d > 5) return; for (const n of (g._nodes || g.nodes || [])) { if ((n.comfyClass || n.type) === "LightCraftFaceProtect") out.push(n); if (n.subgraph) walk(n.subgraph, d + 1); } };
  try { walk(app.graph, 0); } catch (e) { /* none */ }
  return out;
}

// a small illustrator-style eye: almond outline, coloured iris with a ring, pupil, highlight
const IRIS = [["#9aa0a8", "#6f747c"], ["#8a5a30", "#4a2c17"], ["#b08a3e", "#6b5326"], ["#5a9ad8", "#2f6aa8"], ["#2fa0c8", "#16688f"], ["#5aa862", "#2f6f38"], ["#b08a3e", "#3f78c0"], ["#b08a3e", "#3f9a58"]];
function drawEyeChip(ctx, x, y, w, h, i, on, dim) {
  rr(ctx, x, y, w, h, 6); ctx.fillStyle = on ? "#3a2a1c" : "#2c2c2e"; ctx.fill();
  ctx.strokeStyle = on ? ORANGE : "#3d3d3d"; ctx.lineWidth = on ? 1.6 : 1; ctx.stroke();
  const cx = x + w / 2, cy = y + h / 2, a = w * 0.34, e = h * 0.27, ir = h * 0.27;
  ctx.save(); ctx.globalAlpha *= dim ? 0.45 : 1;
  ctx.beginPath(); ctx.moveTo(cx - a, cy); ctx.quadraticCurveTo(cx, cy - e * 2.1, cx + a, cy); ctx.quadraticCurveTo(cx, cy + e * 2.1, cx - a, cy); ctx.closePath();
  ctx.fillStyle = "#efe9de"; ctx.fill();
  ctx.save(); ctx.clip();
  const [c0, c1] = IRIS[i] || IRIS[0];
  const g = ctx.createRadialGradient(cx, cy, ir * 0.15, cx, cy, ir); g.addColorStop(0, c0); g.addColorStop(0.5, c0); g.addColorStop(1, c1);
  ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  if (i === 0 && ctx.createConicGradient) { const cg = ctx.createConicGradient(0, cx, cy); ["#d96a6a", "#d9b36a", "#6ad98a", "#6aa8d9", "#a86ad9", "#d96a6a"].forEach((c, k) => cg.addColorStop(k / 5, c)); ctx.globalAlpha *= 0.85; ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2); ctx.fillStyle = cg; ctx.fill(); ctx.globalAlpha /= 0.85; }
  ctx.beginPath(); ctx.arc(cx, cy, ir * 0.42, 0, Math.PI * 2); ctx.fillStyle = "#121212"; ctx.fill();
  ctx.beginPath(); ctx.arc(cx - ir * 0.34, cy - ir * 0.36, ir * 0.2, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.moveTo(cx - a, cy); ctx.quadraticCurveTo(cx, cy - e * 2.1, cx + a, cy); ctx.strokeStyle = "#151515"; ctx.lineWidth = 1.8; ctx.lineCap = "round"; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - a, cy); ctx.quadraticCurveTo(cx, cy + e * 2.1, cx + a, cy); ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function btn(ctx, node, id, x, y, w, h, text, on, fn, off) {
  rr(ctx, x, y, w, h, 5);
  ctx.fillStyle = on ? "#5a5a5a" : C.btn; ctx.fill();
  if (on) { ctx.strokeStyle = "#8c8c8c"; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = off ? "#6a6a6a" : on ? "#ffffff" : "#d0d0d0";
  ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  if (!off) hit(node, "ed:" + id, x, y, w, h, fn, "pointer");
}

function setSlider(node, key, value, done) {
  const cur = readFace(node), n = Math.round(clamp(value, -100, 100));
  if (cur.p[key] !== n) writeFace(node, { ...cur, p: { ...cur.p, [key]: n } }, done);
  else if (done) writeFace(node, cur, true);
}

function drawSlider(ctx, node, key, label, x, y, w, vis) {
  const d = readFace(node), v = d.p[key], hot = v !== 0;
  ctx.save();
  ctx.font = FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = hot ? C.labelHot : C.label;
  ctx.fillText(label, x, y + 8);
  ctx.textAlign = "right"; ctx.fillText((v > 0 ? "+" : "") + v, x + w, y + 8);
  const ty = y + ROW_H - 9, px = x + ((v + 100) / 200) * w, ox = x + w / 2;
  ctx.lineCap = "round"; ctx.lineWidth = 3;
  ctx.strokeStyle = C.track; ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x + w, ty); ctx.stroke();
  if (Math.abs(px - ox) > 0.5) { ctx.strokeStyle = hot ? C.fillHot : C.fill; ctx.beginPath(); ctx.moveTo(ox, ty); ctx.lineTo(px, ty); ctx.stroke(); }
  ctx.lineWidth = 1; ctx.strokeStyle = "#777"; ctx.beginPath(); ctx.moveTo(ox, ty - 5); ctx.lineTo(ox, ty + 5); ctx.stroke();
  ctx.beginPath(); ctx.arc(px, ty, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = hot ? C.thumbHot : C.thumb; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = C.thumbEdge; ctx.stroke();
  ctx.restore();
  if (!vis) return;
  hit(node, `ed:fp:s:${key}`, x - 4, y - 2, w + 8, ROW_H, ({ ev, pos }) => {
    const now = performance.now(), last = node.__lcFaceLast;                              // double-click = back to 0
    node.__lcFaceLast = { key, t: now, x: ev.clientX, y: ev.clientY };
    if (last && last.key === key && now - last.t < 450 && Math.abs(last.x - ev.clientX) < 12 && Math.abs(last.y - ev.clientY) < 12) { node.__lcFaceLast = null; setSlider(node, key, 0, true); return; }
    if (ev.altKey) { app.canvas.prompt("Value", readFace(node).p[key], (s) => { const n = parseFloat(s); if (!Number.isNaN(n)) setSlider(node, key, n, true); }, ev); return; }
    const base = -100 + clamp((pos[0] - x) / w, 0, 1) * 200;
    setSlider(node, key, base, false);
    const K = node.__lcFace; K.hot = { eye: "eyes", nose: "nose", lip: "lips" }[key.split("_")[0]];
    drag({ node, ev, cursor: "ew-resize", onMove: (dx) => setSlider(node, key, base + (dx / w) * 200, false), onUp: () => { K.hot = null; setSlider(node, key, readFace(node).p[key], true); } });
  }, "ew-resize");
}

export function drawFacePanel(ctx, node, px, py, pw, ph, e, getState) {
  const S = node.__lc, K = node.__lcFace || (node.__lcFace = {});
  if (pw < 8) return;
  ctx.save();
  ctx.beginPath(); rr(ctx, px, py, pw, ph, 6); ctx.clip();
  if (!node.__lcNoBg) {
  ctx.fillStyle = "#18181a"; ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; rr(ctx, px, py, pw, ph, 6); ctx.stroke();
  }
  ctx.globalAlpha = clamp((e - 0.2) / 0.8, 0, 1);
  const ix = px + 12 + (1 - e) * 48, iw = FACE_W - 24;
  ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  const d = readFace(node), clickable = e > 0.98, st = getState();

  ctx.fillStyle = C.head; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Face", ix, py + 17);
  // on / off dot
  const dotX = ix + iw - 8, dotY = py + 17;
  ctx.beginPath(); ctx.arc(dotX, dotY, 5, 0, Math.PI * 2); ctx.fillStyle = d.on ? ORANGE : "#3a3a3a"; ctx.fill(); ctx.strokeStyle = "#8c8c8c"; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "right"; ctx.fillText(d.on ? "On" : "Off", dotX - 10, dotY);
  if (clickable) hit(node, "ed:fp:on", dotX - 40, dotY - 10, 50, 20, () => writeFace(node, { ...readFace(node), on: !readFace(node).on }, true), "pointer");
  ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(ix, py + 29.5); ctx.lineTo(ix + iw, py + 29.5); ctx.stroke();

  // find + status
  let y = py + 38;
  const have = d.faces.length > 0;
  if (clickable) btn(ctx, node, "fp:find", ix, y, iw, 28, K.busy ? "Working…" : have ? "Find face again" : "Find face", !have && !K.busy, () => { const s = getState(); if (s) findFaces(node, s); });
  else { rr(ctx, ix, y, iw, 28, 5); ctx.fillStyle = C.btn; ctx.fill(); }
  y += 34;
  ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const msg = K.error || K.status || (have ? (d.faces.length > 1 ? `${d.faces.length} faces found. Click one in the picture.` : "Face found.") : "Finds the face on this picture.");
  ctx.fillStyle = K.error ? "#e07a5f" : C.label;
  ctx.fillText(fitText(ctx, msg, iw), ix, y + 6);
  y += 18;

  // ---- Eyes: one big button, eye colour as little eye pictures, an optional own-words box. Nothing else to choose.
  {
    const oe = regionOpts(node, "eyes"), ok = clickable && have && !K.busy && !K.rgBusy;
    const head = (t, right) => {
      ctx.fillStyle = C.head; ctx.font = "600 12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(t, ix, y + 11);
      if (right) { ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "right"; ctx.fillText(fitText(ctx, right, iw * 0.62), ix + iw, y + 11); }
      ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ix, y + 21.5); ctx.lineTo(ix + iw, y + 21.5); ctx.stroke();
      y += 28;
    };
    head("Eyes");
    // the main button
    rr(ctx, ix, y, iw, 34, 7);
    if (ok) { ctx.save(); ctx.shadowColor = "rgba(255,138,42,0.45)"; ctx.shadowBlur = 10; ctx.fillStyle = "#4a3220"; ctx.fill(); ctx.restore(); ctx.strokeStyle = ORANGE; ctx.lineWidth = 1.3; ctx.stroke(); }
    else { ctx.fillStyle = C.btn; ctx.fill(); }
    ctx.fillStyle = ok ? "#ffe7d1" : "#7d7d7d"; ctx.font = "700 13.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(K.rgBusy ? "Working…" : "Fix eyes", ix + iw / 2, y + 17.5);
    if (ok) hit(node, "ed:fp:rg:eyes", ix, y, iw, 34, () => regionRun(node, "eyes"), "pointer");
    y += 44;
    // colour
    const own = !!oe.eyeText, cur = EYE_COLORS[oe.eyeIdx] || EYE_COLORS[0];
    head("Eye colour", own ? "your own words" : cur[0].replace(" (read from the picture)", ""));
    const cols = 4, gap = 6, cw = (iw - gap * (cols - 1)) / cols, chH = 32;
    EYE_COLORS.forEach((ec, i) => {
      const cx = ix + (i % cols) * (cw + gap), cy = y + Math.floor(i / cols) * (chH + gap);
      drawEyeChip(ctx, cx, cy, cw, chH, i, i === oe.eyeIdx && !own, own);
      if (clickable) hit(node, "ed:fp:rg:col" + i, cx, cy, cw, chH, () => { const pr = (node.properties = node.properties || {}); pr.lc_rg_eye = i; pr.lc_rg_eyetext = ""; node.setDirtyCanvas(true, true); }, "pointer");
    });
    y += Math.ceil(EYE_COLORS.length / cols) * (chH + gap) + 2;
    // own words
    rr(ctx, ix, y, iw, 28, 6); ctx.fillStyle = "#121214"; ctx.fill(); ctx.strokeStyle = own ? ORANGE : "#3d3d3d"; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = own ? "#ececec" : "#7a7a80";
    ctx.fillText(fitText(ctx, own ? oe.eyeText : "Or describe them: violet with silver flecks…", iw - (own ? 34 : 16)), ix + 9, y + 14.5);
    if (own) { ctx.fillStyle = "#9c9c9c"; ctx.textAlign = "center"; ctx.fillText("✕", ix + iw - 14, y + 14.5); }
    if (clickable) {
      hit(node, "ed:fp:rg:eyetxt", ix, y, own ? iw - 28 : iw, 28, () => {
        const set = (v) => { const pr = (node.properties = node.properties || {}); pr.lc_rg_eyetext = String(v || "").trim(); node.setDirtyCanvas(true, true); };
        const title = "Eye colour in your own words, e.g. violet iris with silver flecks.";
        if (app.canvas && app.canvas.prompt) app.canvas.prompt("Eyes", oe.eyeText || "", set, window.event); else set(window.prompt(title, oe.eyeText || ""));
      }, "text");
      if (own) hit(node, "ed:fp:rg:eyeclr", ix + iw - 28, y, 28, 28, () => { (node.properties = node.properties || {}).lc_rg_eyetext = ""; node.setDirtyCanvas(true, true); }, "pointer");
    }
    y += 38;
    // lips: keep the original ones after the skin pass (the Flux skin pass tends to thin them)
    const fps = faceProtectNodes();
    if (fps.length) {
      head("Lips");
      const on = fps.some((n) => { const w = W(n, "lips"); return !w || w.value !== false; });
      const tg = () => { for (const n of fps) { const w = W(n, "lips"); if (w) { w.value = !on; if (w.callback) { try { w.callback(w.value); } catch (e) { /* cosmetic */ } } } } if (app.graph && app.graph.change) app.graph.change(); node.setDirtyCanvas(true, true); };
      rr(ctx, ix, y, 18, 18, 4); ctx.fillStyle = on ? "#4a3220" : "#121214"; ctx.fill(); ctx.strokeStyle = on ? ORANGE : "#5a5a5a"; ctx.lineWidth = 1.2; ctx.stroke();
      if (on) { ctx.strokeStyle = "#ffe7d1"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ix + 4.5, y + 9.5); ctx.lineTo(ix + 8, y + 13); ctx.lineTo(ix + 14, y + 5.5); ctx.stroke(); }
      ctx.fillStyle = on ? "#ececec" : C.label; ctx.font = FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText("Keep my original lips", ix + 26, y + 9.5);
      ctx.fillStyle = "#7a7a80"; ctx.font = "10px Inter, 'Segoe UI', sans-serif"; ctx.fillText("The skin pass puts them back untouched.", ix + 26, y + 24);
      if (clickable) hit(node, "ed:fp:rg:lips", ix, y - 2, iw, 34, tg, "pointer");
      y += 40;
    }
    if (K.rgCmp) y += drawRegionCompare(ctx, node, ix, y, iw, (id, hx, hy, hw, hh, fn) => { if (clickable) hit(node, "ed:" + id, hx, hy, hw, hh, fn, "pointer"); });
  }

  // small tools: guide lines, points, hold-to-compare, reset
  const tw = (iw - 12) / 4;
  btn(ctx, node, "fp:guides", ix, y, tw, 26, "Guides", S.faceGuides !== false, () => { S.faceGuides = S.faceGuides === false; node.setDirtyCanvas(true, true); });
  btn(ctx, node, "fp:points", ix + (tw + 4), y, tw, 26, "Points", !!S.facePoints, () => { S.facePoints = !S.facePoints; node.setDirtyCanvas(true, true); });
  rr(ctx, ix + 2 * (tw + 4), y, tw, 26, 5); ctx.fillStyle = K.hold ? "#5a5a5a" : C.btn; ctx.fill();
  ctx.fillStyle = K.hold ? "#fff" : "#d0d0d0"; ctx.textAlign = "center"; ctx.font = FONT; ctx.fillText("Before", ix + 2 * (tw + 4) + tw / 2, y + 13.5);
  if (clickable) hit(node, "ed:fp:hold", ix + 2 * (tw + 4), y, tw, 26, ({ ev }) => {          // hold the button to see the original
    K.hold = true; node.setDirtyCanvas(true, true);
    drag({ node, ev, onMove: () => {}, onUp: () => { K.hold = false; node.setDirtyCanvas(true, true); } });
  }, "pointer");
  btn(ctx, node, "fp:reset", ix + 3 * (tw + 4), y, tw, 26, "Reset", false, () => { const cur = readFace(node); const p = {}; for (const k of SLIDERS) p[k] = 0; writeFace(node, { ...cur, p }, true); });
  y += 34;

  // the sliders, in a scrolling list
  const top = y, vh = py + ph - top - 6;
  const total = GROUPS.reduce((a, g) => a + HEAD_H + g[2].length * ROW_H, 0) + 8;
  const maxScroll = Math.max(0, total - vh);
  K.scroll = clamp(K.scroll || 0, 0, maxScroll);
  if (clickable) wheelZone(node, "fp:wheel", px, py, pw, ph, (dy) => { K.scroll = clamp((K.scroll || 0) + dy * 0.7, 0, maxScroll); node.setDirtyCanvas(true, false); });
  ctx.save();
  ctx.beginPath(); ctx.rect(px + 2, top - 2, pw - 4, vh + 4); ctx.clip();
  let yy = top - K.scroll;
  const dim = !have;
  if (dim) ctx.globalAlpha *= 0.45;
  for (const [gid, glabel, rows] of GROUPS) {
    ctx.fillStyle = C.head; ctx.font = "600 12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(glabel, ix, yy + 13);
    const moved = rows.some(([k]) => d.p[k] !== 0);
    if (moved) {
      ctx.fillStyle = C.label; ctx.font = FONT; ctx.textAlign = "right"; ctx.fillText("Reset", ix + iw - 10, yy + 13);
      if (clickable && yy > top - 6 && yy + HEAD_H < top + vh + 6) hit(node, "ed:fp:rg:" + gid, ix + iw - 56, yy + 2, 50, 20, () => {
        const cur = readFace(node), p = { ...cur.p }; for (const [k] of rows) p[k] = 0; writeFace(node, { ...cur, p }, true);
      }, "pointer");
    }
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ix, yy + HEAD_H - 4.5); ctx.lineTo(ix + iw - 10, yy + HEAD_H - 4.5); ctx.stroke();
    yy += HEAD_H;
    for (const [k, label] of rows) {
      if (yy + ROW_H > top - 4 && yy < top + vh + 4) drawSlider(ctx, node, k, label, ix, yy, iw - 10, clickable && have && yy >= top - 6 && yy + ROW_H <= top + vh + 6);
      yy += ROW_H;
    }
  }
  ctx.restore();
  if (maxScroll > 0) {
    const th = Math.max(24, vh * (vh / total)), tyy = top + (vh - th) * (K.scroll / maxScroll);
    rr(ctx, px + pw - 6, tyy, 3, th, 1.5); ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.fill();
  }
  ctx.restore();
}

export const FACE_HIDDEN = [WIDGET];
