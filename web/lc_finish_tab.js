import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { C, FONT, rr } from "./lightcraft_ui.js";
import { hit, wheelZone, drag } from "./lc_interact.js";
import { confirmBox, settingOn, SETTING_UNSAVED } from "./lc_dialog.js";
import { regionJob, injectRegion } from "./lc_region_job.js";

// The Edit Page's last tab: Upscale.
//   * It lists the pictures the workflow SAVED (the folder the Image Saver writes to, read from the saver node itself, so a renamed
//     folder is followed automatically), with the same star ratings as the LightCraft Station.
//   * Options + the Upscale button write straight into the AusBoss nodes of the workflow (Megapixels, Fast, Restore strength).
//   * Upscale queues one run per ticked picture. Only the upscale part of the graph runs (the prompt is trimmed on its way to the
//     server, nothing in the saved workflow changes), the roulette dice are locked, and the result is saved next to the original as
//     "<name>_up" by the second Image Saver. The original's full metadata is then copied onto it (lc_finish.py).
//   * Pictures that already have an "_up" twin glow faintly orange. Pixel drift (red) shows what moved between the two.

export const FIN_W = 312, FIN_MIN_NODE_W = 920;
const ORANGE = "#ff8a2a", CREAM = "#f3ead8";
const ROW_H = 48;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const UP_RE = /^(.*)_up(_\d+)?$/i;
const enc = encodeURIComponent;
let openDoc = null, goTab = null, EXPORT = null;
// the picture you are editing: an opened document, or (a fresh render you jumped straight into) the layer picked in the History
const pickOf = (node) => { const w = (node.widgets || []).find((v) => v.name === "history_pick"); return w && w.value ? String(w.value) : ""; };
// a fingerprint of everything the Edit Page was set to: tells whether the picture shown in the Skin pass tab is from an older run
export const editSig = (node) => { try { return JSON.stringify((node.widgets || []).map((w) => w.value)); } catch (e) { return ""; } };
export function hasEdit(node) {
  const f = F(node), p = node.properties || {}, pick = pickOf(node);
  if (p.lc_doc) return !f.skipDoc;
  return !!pick && !(f.skipDoc && f.skipPick === pick);
}
export function finDocOpened(node) { F(node).upDoc = true; F(node).skipDoc = false; if (node.properties) delete node.properties.lc_exSig; }

// ---- opening another picture must not silently throw away edits that were never exported
const wv = (node, n) => { const w = (node.widgets || []).find((v) => v.name === n); return w ? w.value : undefined; };
const docSig = (node) => JSON.stringify([((node.properties && node.properties.lc_history) || []).length, wv(node, "face_data") || "{}", wv(node, "color_data") || "{}"]);
function docDirty(node) {
  const p = node.properties || {};
  if (!p.lc_doc) return false;
  if (p.lc_exSig !== undefined) return docSig(node) !== p.lc_exSig;                  // exported once: dirty only if something changed since
  return ((p.lc_history || []).length > 1) || (wv(node, "face_data") || "{}") !== "{}" || (wv(node, "color_data") || "{}") !== "{}";
}
function openGuarded(node, x) {
  const f = F(node), p = node.properties || {};
  if (p.lc_doc && p.lc_doc !== x.rel && docDirty(node) && settingOn(SETTING_UNSAVED, true)) {
    if (f.asking) return;                                                         // a box is already open
    f.asking = true;
    confirmBox({
      title: "Unsaved edits",
      text: `Your edit of ${p.lc_doc_name || p.lc_doc} has not been saved. Opening another picture will replace it. Use "Save image" or "Skin pass your edit" in the Skin pass tab first if you want to keep it.`,
      ok: "Replace it", cancel: "Keep editing", settingId: SETTING_UNSAVED,
    }).then((yes) => { f.asking = false; if (yes && openDoc) openDoc(node, x); });
    return;
  }
  if (openDoc) openDoc(node, x);
}
// Esc in Browse: from the big view back to the grid
export function finBackToGrid(node) {
  const f = F(node);
  if (node.__lc && node.__lc.tab === "browse" && f.view === "compare") { f.view = "grid"; node.setDirtyCanvas(true, true); return true; }
  return false;
}
export function setTabHook(fn) { goTab = fn; }
export function setDocOpener(fn) { openDoc = fn; }
const editMode = (node) => !!(node.__lc && node.__lc.tab === "browse");      // Browse: choose a picture to edit. Upscale: tick pictures to upscale.

// ---------------------------------------------------------------- state
function F(node) {
  return node.__lcFin || (node.__lcFin = {
    files: [], sel: new Set(), cur: null, scroll: 0, minStar: 0, loading: false, loaded: false, err: "", folder: "", nDirs: 1,
    thumbs: {}, imgs: {}, running: false, done: 0, total: 0, msg: "", jobs: {}, tips: {}, decim: null,
  });
}
const jget = async (url) => {
  const r = await api.fetchApi(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

// ---------------------------------------------------------------- finding things in the graph (also inside subgraphs)
function allNodes(g, out = [], depth = 0) {
  if (!g) return out;
  for (const n of (g._nodes || g.nodes || [])) {
    out.push(n);
    if (n.subgraph && depth < 5) allNodes(n.subgraph, out, depth + 1);
  }
  return out;
}
const cls = (n) => n.comfyClass || n.type;
const widget = (n, name) => (n && n.widgets ? n.widgets.find((w) => w.name === name) : null);
const isLinkedIn = (n, name) => !!(n.inputs && n.inputs.some((i) => i.name === name && i.link != null));

function savers() { return allNodes(app.graph).filter((n) => cls(n) === "Image Saver"); }
// the saver that writes the normal pictures: its filename is typed in, not wired from the Edit Page
function mainSaver() { const l = savers(); return l.find((n) => !isLinkedIn(n, "filename")) || l[0] || null; }

// "No_Thing3.0/%time_format<%Y-%m-%d>" -> "No_Thing3.0" (everything before the first changing part)
export function saverBase() {
  const s = mainSaver();
  const w = widget(s, "path");
  if (!s) return null;
  const parts = String((w && w.value) || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const keep = [];
  for (const p of parts) { if (p.includes("%")) break; keep.push(p); }
  return keep.join("/");
}

function ausNodes() {
  const all = allNodes(app.graph), t = (n) => cls(n);
  const lw = (n) => { const w = widget(n, "loras"); return w ? String(w.value || "") : ""; };
  return {
    tiled: all.find((n) => t(n) === "AUSBOSS_NODES_TiledUpscale"),
    lora: all.find((n) => t(n) === "AUSBOSS_NODES_LoraLoader" && /restore/i.test(lw(n))),
    steps: all.find((n) => t(n) === "AUSBOSS_NODES_Integer" && /step/i.test(n.title || "")),
    split: all.find((n) => t(n) === "LightCraftTileSplit" && /cut into/i.test(n.title || "")),     // the skin pass tile cutter: 2 or 4 tiles
    flux: all.find((n) => t(n) === "KSampler" && /flux skin pass/i.test(n.title || "")),            // the Flux skin pass (replaces the Qwen tiled redraw)
  };
}

// the LightCraftGrain node that sits after the upscale (it is named "Re-grain ..."): the Upscale tab fills it from the Color tab and turns it on or off
const reGrainNode = () => allNodes(app.graph).find((n) => cls(n) === "LightCraftGrain" && /re-?grain/i.test(n.title || "")) || null;
// the three "use my Color tab on the upscale" switches: all OFF until the user turns them on (stored in the Edit Page's properties)
const useOf = (node, k) => !!(node && node.properties && node.properties["lc_use_" + k] === true);
const reGrainOn = (node) => useOf(node, "grain");
// the Color tab's settings with only the allowed sections left on (the live edit and every snapshot layer)
function colorSubset(colorData, allow) {
  let st; try { st = typeof colorData === "string" ? JSON.parse(colorData) : JSON.parse(JSON.stringify(colorData)); } catch (e) { return null; }
  if (!st || typeof st !== "object") return null;
  let any = false;
  const cut = (s) => { for (const k of ["lut", "fx", "lens", "grain"]) { if (s && s[k] && typeof s[k] === "object") { if (allow[k] && s[k].on !== false) any = true; else s[k].on = false; } } };
  cut(st); (Array.isArray(st.layers) ? st.layers : []).forEach((l) => { if (l && l.on !== false) cut(l.s); });
  return any ? JSON.stringify(st) : null;
}

// the grain that was baked into the saved picture = the Color tab's grain (live settings first, else the newest snapshot layer that has grain)
// three switches, shared by the Upscale tab and the Browse batch panel (both read the same properties)
function useToggles(ctx, node, H, ix, y, iw, dis, touch, regTip, o) {
  const rows = [["grade", "Use grade (LUT)"], ["fx", "Use FX (+ lens)"], ["grain", "Use grain"]];
  for (const [k, label] of rows) {
    if (k === "grain" && !o.grain) continue;
    const on = useOf(node, k), tg = () => { if (!dis) { node.properties = node.properties || {}; node.properties["lc_use_" + k] = !on; touch(node); } };
    H.checkbox(ctx, node, "fin:use_" + k, ix, y + 2, on, null, label, tg);
    hit(node, "ed:fin:use_" + k, ix - 2, y - 2, iw, 20, tg, "pointer");
    node.__lcFin && (node.__lcFin.tips["fin:use_" + k] = [ix, y - 2, iw, 20]);
    y += 22;
  }
  return y + 2;
}

function grainSettings(colorData) {
  let st; try { st = typeof colorData === "string" ? JSON.parse(colorData) : colorData; } catch (e) { return null; }
  if (!st || typeof st !== "object") return null;
  const pick = (s, seedAdd) => {
    const g = s && s.grain; if (!g || g.on === false || !g.p || !(+g.p.grain_amount > 0)) return null;
    const p = {}; for (const [k, v] of Object.entries(g.p)) if (/^grain_/.test(k) && typeof v === "number") p[k] = v;
    p.grain_seed = (+s.seed || 0) + seedAdd; return p;
  };
  const live = pick(st, 0);
  if (live) return live;
  const layers = Array.isArray(st.layers) ? st.layers : [];
  for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; if (l && l.on !== false) { const p = pick(l.s, 7919 * (i + 1)); if (p) return p; } }
  return null;
}

function loraList(n) {
  try { const a = JSON.parse(widget(n, "loras").value); return Array.isArray(a) ? a : null; } catch (e) { return null; }
}
const isTurbo = (e) => /turbo|viggle/i.test(e.name || "");
const isRestore = (e) => /restore/i.test(e.name || "");

function setW(w, v) { w.value = v; if (w.callback) { try { w.callback(v); } catch (e) { /* cosmetic */ } } }
function touch(node) { if (app.graph && app.graph.change) app.graph.change(); node.setDirtyCanvas(true, true); }

export function finOptions() {
  const N = ausNodes(), o = { ok: !!(N.flux || (N.tiled && N.lora && N.steps)), flux: !!N.flux, dn: 0.65, mp: 4, fast: true, restore: 1, steps: 8, grain: !!reGrainNode() };
  if (N.flux) { const st = widget(N.flux, "steps"), dn = widget(N.flux, "denoise"); o.steps = st ? +st.value || 2 : 2; o.dn = dn ? +dn.value || 0.65 : 0.65; const tw = widget(N.split, "tiles"); o.tiles = tw && String(tw.value).startsWith("2") ? 2 : 4; o.hasTiles = !!tw; return o; }
  const w = widget(N.tiled, "megapixels"); if (w) o.mp = +w.value || 4;
  const list = N.lora ? loraList(N.lora) : null;
  if (list) { const t = list.find(isTurbo), r = list.find(isRestore); if (t) o.fast = t.enabled !== false; if (r) o.restore = +r.strength; }
  const sw = widget(N.steps, "value"); if (sw) o.steps = +sw.value || 8;
  return o;
}
function setMp(v) { const w = widget(ausNodes().tiled, "megapixels"); if (w) setW(w, v); }
function setFast(on) {
  const N = ausNodes(), list = N.lora ? loraList(N.lora) : null;
  if (list) { const t = list.find(isTurbo); if (t) t.enabled = on; setW(widget(N.lora, "loras"), JSON.stringify(list)); }
  const sw = widget(N.steps, "value"); if (sw) setW(sw, on ? 8 : 25);          // the turbo LoRA is made for 8 steps, without it the model wants about 25
}
function setRestore(v) {
  const N = ausNodes(), list = N.lora ? loraList(N.lora) : null;
  if (!list) return;
  const r = list.find(isRestore); if (r) r.strength = v;
  setW(widget(N.lora, "loras"), JSON.stringify(list));
}

// ---------------------------------------------------------------- the saved pictures
// Upscaled pictures live in a mirror of the saved folder: "No_Thing3.0/2026-10-24" -> "No_Thing3.0_Upscaled/2026-10-24" (same rule as lightcraft_crop_node.upscaled_sub)
const SUF = "_SkinPass";
const OLD_SUF = ["_Upscaled"];                                               // older mirror folders: still listed, so old pictures stay visible
const SHOWN = 15;                                                            // the browser opens with the newest pictures only
export function upscaledSub(sub) {
  const parts = String(sub || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return "SkinPass";
  if (![SUF, ...OLD_SUF].some((q) => parts[0].endsWith(q)) && parts[0] !== "SkinPass" && parts[0] !== "Upscaled") parts[0] += SUF;
  return parts.join("/");
}
function originalSub(sub) {                                                  // the folder a skin-pass picture's original lives in
  const parts = String(sub || "").split("/").filter(Boolean);
  const q = parts.length ? [SUF, ...OLD_SUF].find((z) => parts[0].endsWith(z)) : null;
  if (q) parts[0] = parts[0].slice(0, -q.length);
  else if (parts.length && (parts[0] === "SkinPass" || parts[0] === "Upscaled")) parts.shift();
  return parts.join("/");
}
const inScope = (f, x) => (f.scope === "orig" ? !x.orig : f.scope === "up" ? !!x.orig : true);
export const finVisible = (node) => { const f = F(node); return f.files.filter((x) => x.r >= f.minStar && inScope(f, x)); };

export async function finRefresh(node, more) {
  const f = F(node);
  if (f.loading) return;
  f.loading = true; f.err = ""; f.lastRefresh = Date.now();
  if (more) f.showAll = true;
  try {
    const base = saverBase();
    if (base === null) throw new Error("No Image Saver in the workflow.");
    const roots = await jget("/lightcraft/lib/roots");
    const root = ((roots.roots || [])[0] || {}).path;
    if (!root) throw new Error("The output folder is not known.");
    const sep = root.includes("\\") ? "\\" : "/";
    const top = base ? root + sep + base.split("/").join(sep) : root;
    f.folder = base || "output";
    const rel = (abs) => abs.slice(root.length).replace(/\\/g, "/").replace(/^\/+/, "");
    const lists = [];
    // every folder that can hold pictures: the saver folder and the skin-pass mirror(s) (new name, and the older _Upscaled one)
    const mirrors = base ? [upscaledSub(base), ...OLD_SUF.map((q) => base.split("/")[0] + q + base.split("/").slice(1).map((z) => "/" + z).join(""))] : ["SkinPass", "Upscaled"];
    const roots2 = [top, ...mirrors.map((m) => root + sep + m.split("/").join(sep))];
    const dirs = [];
    for (let i = 0; i < roots2.length; i++) {
      try { const l = await jget(`/lightcraft/lib/list?path=${enc(roots2[i])}`); lists.push(l); for (const d of (l.dirs || [])) dirs.push(d); } catch (e) { /* the mirror may not exist yet */ }
    }
    dirs.sort((a, b) => b.name.localeCompare(a.name));                      // dated folders: newest first
    let nHave = lists.reduce((n, l) => n + (l.files || []).length, 0), used = 0;
    for (const d of dirs) {
      if (!f.showAll && nHave >= SHOWN) break;                               // enough for the first view
      try { const l = await jget(`/lightcraft/lib/list?path=${enc(d.path)}`); lists.push(l); nHave += (l.files || []).length; used++; } catch (e) { /* a folder that vanished */ }
    }
    f.moreDirs = used < dirs.length;
    const files = [];
    for (const l of lists) for (const x of (l.files || [])) {
      const r = rel(x.path), sub = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
      files.push({ name: x.name, abs: x.path, sub, rel: r, mtime: x.mtime, size: x.size, r: x.r || 0, stem: x.name.replace(/\.[^.]+$/, ""), ups: [], orig: null });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    f.nFound = files.length;
    if (!f.showAll && files.length > SHOWN) { f.moreDirs = true; files.length = SHOWN; }      // newest 15 first; the big button loads the rest
    const byKey = new Map(files.map((x) => [x.sub + "/" + x.stem, x]));
    for (const x of files) {
      const m = UP_RE.exec(x.stem);
      if (!m) continue;
      // the twin is named after its original: in the mirror folder, or (older pictures) right next to it
      const o = byKey.get(originalSub(x.sub) + "/" + m[1]) || byKey.get(x.sub + "/" + m[1]);
      if (o && o !== x) { x.orig = o; o.ups.push(x); }
    }
    f.files = files;
    const have = new Set(files.map((x) => x.rel));
    f.sel = new Set([...f.sel].filter((k) => have.has(k)));
    if (!f.cur || !files.some((x) => x.rel === f.cur)) f.cur = files.length ? files[0].rel : null;
    f.loaded = true;
  } catch (e) {
    const m = String(e.message || e);
    f.err = /HTTP 404/.test(m) ? "Browse could not reach LightCraft on the server. Restart ComfyUI, then hard-refresh the page (Ctrl+F5)." : m;
    f.loaded = true;
  }
  f.loading = false;
  node.setDirtyCanvas(true, true);
}

const curFile = (f) => f.files.find((x) => x.rel === f.cur) || null;

function imgOf(store, node, key, url) {
  let e = store[key];
  if (e) return e.ok ? e : null;
  e = store[key] = { ok: false };
  const img = new Image();
  img.onload = () => { e.img = img; e.w = img.naturalWidth; e.h = img.naturalHeight; e.ok = true; node.setDirtyCanvas(true, true); };
  img.onerror = () => { e.fail = true; };
  img.src = url;
  return null;
}
const thumbOf = (node, x) => imgOf(F(node).thumbs, node, x.abs + x.mtime, api.apiURL(`/lightcraft/lib/thumb?path=${enc(x.abs)}&s=160`));
// real pixel size of a saved picture (the preview we draw is scaled down), fetched once
function dimOf(node, x) {
  if (x.dim || x.dimReq) return;
  x.dimReq = true;
  api.fetchApi(`/lightcraft/lib/meta?path=${enc(x.abs)}`).then((r) => r.json()).then((m) => { if (m && m.w) { x.dim = [m.w, m.h]; node.setDirtyCanvas(true, true); } }).catch(() => { x.dimReq = false; });
}
const previewOf = (node, x) => imgOf(F(node).imgs, node, x.abs + x.mtime, api.apiURL(`/lightcraft/lib/preview?path=${enc(x.abs)}&s=1600`));

// the full-size picture for the compare view: only fetched while you are zoomed in, and only the last two are kept (light on memory and disk)
function hiOf(node, x) {
  const f = F(node), k = x.abs + x.mtime;
  f.hiMap = f.hiMap || {};
  if (!f.hiMap[k]) {
    const keys = Object.keys(f.hiMap); if (keys.length >= 2) delete f.hiMap[keys[0]];
    f.hiMap[k] = {};
  }
  return imgOf(f.hiMap[k], node, "full", api.apiURL(`/lightcraft/lib/preview?path=${enc(x.abs)}&s=4096`));
}

// what the picture view shows in this tab: the saved picture and its _up twin
export function finishPictures(node) {
  const f = F(node), S = node.__lc, doc = node.properties && node.properties.lc_doc;
  if (hasEdit(node) && S && S.tab === "finish") {                    // an open document: the Upscale tab shows YOUR EDIT (the last Edit run's picture)
    const a = S.after || S.before || S.linked;                       // the finished edit if the last run returned it, else the crop / face result, else the opened picture
    if (!a) return null;
    a.dim = [a.w, a.h];
    const stale = S.runSig !== undefined && S.runSig !== editSig(node);
    return { before: a, after: null, hasUp: false, name: `${doc ? (node.properties.lc_doc_name || doc) + " · " : ""}your edit`, edit: true, note: stale ? "older preview · saving uses your current edit" : "your edit · grey gaps are filled when saved" };
  }
  const c = curFile(f);
  if (!c) return null;
  const orig = c.orig || c, up = c.orig ? c : (c.ups[0] || null);
  dimOf(node, orig); if (up) dimOf(node, up);
  const b = previewOf(node, orig), a = up ? previewOf(node, up) : null;
  if (b) { b.dim = orig.dim || null; b.hiFn = () => hiOf(node, orig); }
  if (a) { a.dim = up.dim || null; a.hiFn = () => hiOf(node, up); }
  return { before: b, after: a, hasUp: !!up, name: orig.name };
}

// ---------------------------------------------------------------- stars
async function rate(node, x, k) {
  const v = x.r === k ? 0 : k;
  x.r = v;
  node.setDirtyCanvas(true, true);
  try { await api.fetchApi("/lightcraft/lib/mark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [x.abs], rating: v }) }); }
  catch (e) { console.error("[LightCraft] could not save the rating", e); }
}
function star(ctx, cx, cy, r, on) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? r * 0.45 : r;
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
  if (on) { ctx.fillStyle = ORANGE; ctx.fill(); } else { ctx.strokeStyle = "#5b5b62"; ctx.lineWidth = 1; ctx.stroke(); }
}

// ---------------------------------------------------------------- running it
let QUEUE_BUSY = false;                                       // a render is running: the browser stays quiet (no folder reads)
let JOB = null;                                               // { pick, file } while a Finish run is being queued

function promptEntries(out) { return Object.entries(out || {}); }
const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number");

// The server gets a trimmed copy of the prompt. A Finish run keeps only what the second Image Saver needs (the Edit Page loads the
// picked file, the AusBoss upscale redraws it); a normal run drops the second saver so it never runs on its own.
// Nodes that read ANOTHER node's widget by its id (no link) must find that node in the prompt: KJ WidgetToString ("id"), the Image Saver pack's Workflow Input Value ("node_id"),
// e.g. for the saver's model name or LoRA stack. (The real class name is "Workflow Input Value (Image Saver)", with spaces: the match must allow them, or the loader is cut from the prompt and the saver gets no model name.) Inside a subgraph the id may carry the subgraph's prefix ("112:100" reads "112:32").
function keepReferenced(out, keep) {
  for (const id of Array.from(keep)) {
    const n = out[id];
    if (!n || !/Widget|Input\s*Value|Workflow\s*Input/i.test(n.class_type || "")) continue;
    const ins = n.inputs || {};
    for (const key of ["id", "node_id", "nodeId"]) {
      const ref = ins[key];
      if (ref === undefined || ref === null || ref === "" || isLink(ref)) continue;
      const parent = String(id).includes(":") ? String(id).slice(0, String(id).lastIndexOf(":")) : "";
      for (const cand of [parent ? `${parent}:${ref}` : null, String(ref)]) if (cand && out[cand]) { keep.add(cand); break; }
    }
  }
}
// ---- no Qwen / no Flux: the models can be switched off (bypassed loaders) and the workflow still has to run, graded, to the saver.
// ComfyUI checks every node behind an output before it runs ANYTHING, even branches a lazy switch would never open, so a missing model
// anywhere behind the saver stops or empties the run. Here the branches that are not going to run, or cannot run, are cut out of the
// prompt copy (the workflow itself is not touched):
//   * the full-mode (Flux skin pass + eyes) side of a switch when this is not a full-mode run
//   * the Qwen outpaint side of a switch, when its models are missing (the gray area then stays gray: said in the console)
// Anything left that still lacks a model is an output nobody needs (Show Text and the like) and is dropped. If the part that DOES have to run
// is still broken, nothing is changed, so ComfyUI shows its normal red error.
const NEEDS = { KSampler: ["model"], CLIPTextEncode: ["clip"], TextEncodeQwenImage21: ["clip"], TextGenerate: ["clip"], VAEDecode: ["vae"], VAEEncode: ["vae"], LoraLoaderModelOnly: ["model"] };
export function cutUnusedBranches(out) {
  try {
    const memo = new Map();
    const live = (v) => isLink(v) && out[v[0]];
    const broken = (id, stack = new Set()) => {                    // this node, or anything behind it, lacks a model
      id = String(id);
      if (memo.has(id)) return memo.get(id);
      if (stack.has(id)) return false;
      stack.add(id);
      const n = out[id]; let bad = false;
      if (n) {
        for (const k of (NEEDS[n.class_type] || [])) if (!live(n.inputs && n.inputs[k])) bad = true;
        if (!bad) for (const v of Object.values(n.inputs || {})) if (live(v) && broken(v[0], stack)) { bad = true; break; }
      }
      stack.delete(id); memo.set(id, bad);
      return bad;
    };
    const crops = Object.entries(out).filter(([, n]) => n.class_type === "LightCraftCrop");
    const cropFull = new Map(crops.map(([id, n]) => [String(id), n.inputs && n.inputs.full_mode === true]));
    let cut = 0;
    for (const [, n] of Object.entries(out)) {
      if (n.class_type !== "LightCraftOutpaintSwitch" || !n.inputs || !live(n.inputs.painted)) continue;
      const o = n.inputs.outpaint, from = live(o) ? out[o[0]] : null;
      const fromFull = from && from.class_type === "LightCraftCrop" && (o[1] === 12 || o[1] === 13) && cropFull.get(String(o[0])) === false;
      const fromOut = from && from.class_type === "LightCraftCrop" && o[1] === 3;           // the Edit Page's own "outpaint" flag: the Qwen outpaint side
      if (fromFull || (fromOut && broken(n.inputs.painted[0]))) {
        if (!fromFull) console.warn("[LightCraft] the Qwen outpaint models are not available: the outpaint step is skipped for this run (a gray canvas stays gray).");
        delete n.inputs.painted; cut++;
      }
    }
    if (!cut && !Object.keys(out).some((id) => broken(id))) return;
    memo.clear();
    const keepers = Object.entries(out).filter(([, n]) => /^(Image Saver|SaveImage|PreviewImage|LightCraftCrop|LightCraftApplyGrade|LightCraftWatermark)$/.test(n.class_type));
    if (keepers.some(([id]) => broken(id))) return;                // what has to run is still broken: leave it to ComfyUI's own error
    for (const id of Object.keys(out)) if (broken(id)) delete out[id];
  } catch (e) { console.warn("[LightCraft] could not tidy the prompt:", e); }
}
export function rewritePrompt(data) {
  const out = data && data.output;
  if (!out) return data;
  // the Full mode button on the Edit Page feeds its full_mode input (unless something is wired to that input)
  for (const [id, n] of promptEntries(out)) {
    if (n.class_type !== "LightCraftCrop" || (n.inputs && isLink(n.inputs.full_mode))) continue;
    const nid = String(id).split(":").pop(), node = allNodes(app.graph).find((m) => cls(m) === "LightCraftCrop" && String(m.id) === nid) || null;
    if (node) {
      const tab = node.__lc && node.__lc.tab;                                // only the Auto and Upscale tabs run the whole way; Color / Face / Crop never upscale
      const pr = node.properties || {};
      n.inputs.full_mode = !!pr.lc_full && pr.lc_auto_skin !== false && (!tab || tab === "compare" || tab === "finish");
      if (pr.lc_auto_eyes === false || pr.lc_auto_skin === false) {          // the Eyes tick is off: the automatic Eyes pass gets no face, so it stays off
        for (const [, m] of promptEntries(out)) if (m.class_type === "LightCraftEyesOn" && m.inputs) m.inputs.face_data = "{}";
      }
    }
  }
  if (!JOB) cutUnusedBranches(out);
  // full mode saves the finished (upscaled) picture in the mirror folder: No_Thing3.0/<date> -> No_Thing3.0_Upscaled/<date>, same name and counter logic
  if (promptEntries(out).some(([, n]) => n.class_type === "LightCraftCrop" && n.inputs && n.inputs.full_mode === true && !JOB)) {
    for (const [, n] of promptEntries(out)) {
      if (n.class_type === "Image Saver" && typeof (n.inputs && n.inputs.filename) === "string" && typeof n.inputs.path === "string") n.inputs.path = upscaledSub(n.inputs.path);
    }
  }
  if (!JOB) {                                                    // Edit tabs with an open document: only the Edit Page runs, on that picture. No generation, no roulette, no seed can restart it.
    for (const [id, n] of promptEntries(out)) {
      if (n.class_type !== "LightCraftCrop") continue;
      const nid = String(id).split(":").pop(), node = allNodes(app.graph).find((m) => cls(m) === "LightCraftCrop" && String(m.id) === nid) || null;
      const tab = node && node.__lc && node.__lc.tab, doc = node && node.properties && node.properties.lc_doc;
      if (!(doc || (EXPORT && n.inputs.history_pick)) || !(["browse", "crop", "face", "color"].includes(tab) || (EXPORT && tab === "finish"))) continue;
      delete n.inputs.image_in; delete n.inputs.compare_image;
      n.inputs.full_mode = false;
      if (doc && !n.inputs.history_pick) n.inputs.history_pick = `open::${doc} [output]`;     // layer 0 = the document's own picture
      // keep what the Edit Page feeds (the Qwen outpaint, the grade): savers become previews so nothing lands in the folders until you export
      let savers = Object.entries(out).filter(([, m]) => (m.class_type === "Image Saver" || m.class_type === "SaveImage") && isLink(m.inputs && (m.inputs.images)));
      const keepE = new Set([id]), roots = [];
      if (EXPORT) {                                                  // Export: the normal saver stays a saver, writing "<name>_edit" next to the original; any other saver is just a preview
        const main = savers.find(([, m]) => m.class_type === "Image Saver" && typeof m.inputs.filename === "string" && typeof m.inputs.path === "string");
        if (!main) throw new Error("LightCraft: no normal Image Saver found to save your edit with.");
        if (EXPORT.name) { main[1].inputs.filename = EXPORT.name; main[1].inputs.path = EXPORT.dir; }       // a fresh render keeps the saver's own name and folder
        // film grain before an upscale only makes the upscale worse (the model treats grain as detail): the saved edit gets no grain, the Re-grain step puts it back afterwards
        try { const gd = JSON.parse(n.inputs.color_data || "{}"); if (gd.grain) gd.grain.on = false; n.inputs.color_data = JSON.stringify(gd); } catch (e) { /* no grade to strip */ }
        savers = savers.filter((e) => e !== main);
        roots.push(main[0]);
      }
      const rj = regionJob();
      if (rj && rj.node === node) {                                  // Eyes / Face button: only the Edit Page's picture + the redraw chain run, nothing is saved or previewed
        roots.push(injectRegion(out, id)); savers = [];
        for (const [sid] of Object.entries(out).filter(([, m]) => m.class_type === "Image Saver" || m.class_type === "SaveImage")) delete out[sid];
      }
      for (const [sid, m] of savers) { out["lc_prev_" + sid] = { class_type: "PreviewImage", inputs: { images: m.inputs.images }, _meta: { title: "Edit preview" } }; delete out[sid]; roots.push("lc_prev_" + sid); }
      const st = [...roots, id];
      while (st.length) {
        const k = String(st.pop());
        if (keepE.has(k) && k !== id && !roots.includes(k)) continue;
        keepE.add(k);
        for (const v of Object.values((out[k] && out[k].inputs) || {})) if (isLink(v) && out[v[0]] && !keepE.has(String(v[0]))) st.push(v[0]);
      }
      keepReferenced(out, keepE);
      for (const k of Object.keys(out)) if (!keepE.has(k)) delete out[k];
      return data;
    }
  }
  const second = promptEntries(out).filter(([, n]) => n.class_type === "Image Saver" && isLink(n.inputs && n.inputs.filename)
    && out[n.inputs.filename[0]] && out[n.inputs.filename[0]].class_type === "LightCraftCrop");
  if (!JOB) { for (const [id] of second) delete out[id]; return data; }
  if (!second.length) throw new Error("LightCraft Upscale: the workflow has no second Image Saver wired to the Edit Page (save_name / save_path). Load the updated workflow.");
  const [bid, b] = second[0], keep = new Set(), stack = [bid];
  const crop = out[b.inputs.filename[0]];
  crop.inputs.history_pick = JOB.pick;
  // the upscale smooths film grain away: put the Color tab's grain back on the upscaled picture (the Re-grain node sits right before the saver)
  const rg = Object.values(out).find((n) => n.class_type === "LightCraftGrain" && n._meta && /re-?grain/i.test(n._meta.title || ""));
  if (rg) {
    const gs = reGrainOn(finishNode()) ? grainSettings(crop.inputs.color_data) : null;
    rg.inputs.enabled = !!gs;
    if (gs) Object.assign(rg.inputs, gs);
  }
  // "Use grade" / "Use FX": the Color tab's LUT (grade) and FX + lens go on the big picture, before the grain (which comes last)
  {
    const fn = finishNode(), allow = { lut: useOf(fn, "grade"), fx: useOf(fn, "fx"), lens: useOf(fn, "fx"), grain: false };
    const gjson = (allow.lut || allow.fx) ? colorSubset(crop.inputs.color_data, allow) : null;
    const holder = rg || b, hk = rg ? "image" : "images";
    if (gjson && holder && isLink(holder.inputs[hk])) {
      out.lc_batch_grade = { class_type: "LightCraftApplyGrade", inputs: { image: holder.inputs[hk], grade: gjson }, _meta: { title: "Apply grade (upscale)" } };
      holder.inputs[hk] = ["lc_batch_grade", 0];
    }
  }
  // the Upscale-tab run feeds the saved picture (the Edit Page's `original`) straight into the upscale door: skip the switch that, in a normal full-mode run,
  // would pick the finished picture instead (its other branch would drag the whole generation chain into this prompt)
  for (const g of Object.values(out)) {
    const sw = g.class_type === "LightCraftOutpaintGate" && isLink(g.inputs.image) ? out[g.inputs.image[0]] : null;
    if (sw && sw.class_type === "LightCraftOutpaintSwitch" && isLink(sw.inputs.painted) && out[sw.inputs.painted[0]] === crop) g.inputs.image = sw.inputs.painted;
  }
  delete crop.inputs.image_in;                                  // before trimming: the generation in front of the Edit Page must not stay in the prompt
  while (stack.length) {
    const id = String(stack.pop());
    if (keep.has(id) || !out[id]) continue;
    keep.add(id);
    for (const v of Object.values(out[id].inputs || {})) if (isLink(v)) stack.push(v[0]);
  }
  keepReferenced(out, keep);
  for (const id of Object.keys(out)) if (!keep.has(id)) delete out[id];
  return data;
}

export async function finRun(node, only) {
  const f = F(node);
  if (f.running) return;
  const list = only || f.files.filter((x) => f.sel.has(x.rel));
  if (!list.length) return;
  if (!finOptions().ok) { f.err = "The skin pass nodes are missing in this workflow."; node.setDirtyCanvas(true, true); return; }
  f.running = true; f.queuedAll = false; f.done = 0; f.total = list.length; f.err = ""; f.msg = "";
  node.setDirtyCanvas(true, true);
  try {
    for (const x of list) {
      JOB = { pick: `finish::${x.rel} [output]`, file: x };
      await app.queuePrompt(0, 1);
    }
  } catch (e) {
    f.err = String(e.message || e);
    f.running = false; f.total = 0;
  } finally { JOB = null; }
  f.queuedAll = true;
  node.setDirtyCanvas(true, true);
}

function exportDoc(node) {
  const doc = node.properties.lc_doc || "", i = doc.lastIndexOf("/"), dir = i >= 0 ? doc.slice(0, i) : "", stem = doc.slice(i + 1).replace(/\.[^.]+$/, "");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { EXPORT = null; reject(new Error("Saving the edit took too long.")); }, 180000);
    EXPORT = { name: doc ? stem + "_edit" : "", dir, done: (im) => { clearTimeout(t); EXPORT = null; resolve(im); } };
    Promise.resolve(app.queuePrompt(0, 1)).catch((e) => { clearTimeout(t); EXPORT = null; reject(e); });
  });
}
// the Upscale tab on an open document: save the edit next to the original ("<name>_edit"), then upscale that file
export async function upscaleEdit(node) {
  const f = F(node);
  if (f.running || !hasEdit(node)) return;
  f.running = true; f.err = ""; f.msg = "Saving your edit…"; node.setDirtyCanvas(true, true);
  try {
    const im = await exportDoc(node);
    const rel = ((im.subfolder ? im.subfolder + "/" : "") + im.filename).replace(/\\/g, "/");
    for (let k = 0; k < 40 && f.loading; k++) await new Promise((r) => setTimeout(r, 100));
    await finRefresh(node);
    for (let k = 0; k < 40 && f.loading; k++) await new Promise((r) => setTimeout(r, 100));
    const same = (a, b) => String(a).replace(/\\/g, "/").toLowerCase() === String(b).toLowerCase();
    // the picture is saved for sure (the server just said so). If the browser list has not caught up (an older date folder, a slow disk), upscale it by its path anyway
    const x = f.files.find((v) => same(v.rel, rel)) || { rel, name: im.filename, ups: [] };
    f.upDoc = false; f.skipDoc = true; f.skipPick = pickOf(node); f.cur = rel; f.running = false; f.msg = "";
    await finRun(node, [x]);
  } catch (e) { f.err = String(e.message || e); f.running = false; f.msg = ""; node.setDirtyCanvas(true, true); }
}

// the manual fallback: save the edit, then make that saved file THE picture of this tab (use the normal "Skin pass this picture" button on it)
export async function bringEdit(node) {
  const f = F(node);
  if (f.running || !(pickOf(node) || (node.properties && node.properties.lc_doc))) return;
  f.running = true; f.err = ""; f.msg = "Bringing your edit here…"; node.setDirtyCanvas(true, true);
  try {
    const im = await exportDoc(node);
    const rel = ((im.subfolder ? im.subfolder + "/" : "") + im.filename).replace(/\\/g, "/");
    f.lastRefresh = 0; await finRefresh(node);
    for (let k = 0; k < 40 && f.loading; k++) await new Promise((r) => setTimeout(r, 100));
    f.upDoc = false; f.skipDoc = true; f.skipPick = pickOf(node); f.cur = rel; f.view = "compare"; f.msg = `Brought here: ${im.filename}`;
  } catch (e) { f.err = String(e.message || e); f.msg = ""; }
  f.running = false; node.setDirtyCanvas(true, true);
}

// finish the edit without upscaling: save it next to the original as "<name>_edit" (with the original's metadata) and stop
export async function saveEditOnly(node) {
  const f = F(node);
  if (f.running || !hasEdit(node)) return;
  f.running = true; f.err = ""; f.msg = "Saving your edit…"; node.setDirtyCanvas(true, true);
  try {
    const im = await exportDoc(node);
    f.msg = `Saved: ${im.filename}`;
    f.lastRefresh = 0; finRefresh(node);
  } catch (e) { f.err = String(e.message || e); }
  f.running = false; node.setDirtyCanvas(true, true);
}

function finishNode() { return allNodes(app.graph).find((n) => cls(n) === "LightCraftCrop" && n.__lcFin) || null; }
// a failed / stopped run must not leave the button spinning
export function finOnError(ev) {
  const node = finishNode(), f = node && node.__lcFin;
  if (!f || !f.running) return;
  f.running = false; f.queuedAll = false;
  f.err = ev && ev.type === "execution_interrupted" ? "Stopped." : "The skin pass failed. Details are in the ComfyUI window.";
  node.setDirtyCanvas(true, true);
}
// the queue went quiet: nothing more is coming (also covers a result that was already cached and sends no event)
const finTabNow = (node) => !!(node.__lc && (node.__lc.tab === "browse" || node.__lc.tab === "finish"));
// coming back to the window (files may have been saved, moved or deleted outside) refreshes the browser too
if (typeof window !== "undefined") {
  const back = () => { if (document.hidden) return; const n = finishNode(), f = n && n.__lcFin; if (f && f.loaded && finTabNow(n) && !f.loading && !f.running && !QUEUE_BUSY && Date.now() - (f.lastRefresh || 0) > 120000) finRefresh(n); };
  window.addEventListener("focus", back); document.addEventListener("visibilitychange", back);
}
export function finOnStatus(ev) {
  const node = finishNode(), f = node && node.__lcFin;
  const left = ev && ev.detail && ev.detail.exec_info && ev.detail.exec_info.queue_remaining;
  if (typeof left === "number") QUEUE_BUSY = left > 0;
  if (f && left === 0 && !f.running && node.__lc && finTabNow(node)) {         // the queue just went idle: new pictures were probably saved, so the browser looks again
    clearTimeout(f.idleT); f.idleT = setTimeout(() => { if (finTabNow(node) && !f.loading && !f.running) finRefresh(node); }, 1800);
  }
  if (!f || !f.running || !f.queuedAll || left !== 0) return;
  setTimeout(() => { if (f.running && f.queuedAll) { f.running = false; f.queuedAll = false; f.msg = `${f.done} done`; finRefresh(node); } }, 2500);
}

// results arriving from the server
export function finOnExecuted(ev) {
  const d = ev && ev.detail, out = d && d.output;
  if (!out || !app.graph) return;
  const nodes = allNodes(app.graph).filter((n) => cls(n) === "LightCraftCrop" && n.__lcFin);
  if (!nodes.length) return;
  const node = nodes[0], f = F(node);
  if (EXPORT && out.images && out.images[0] && out.images[0].type !== "temp") {       // the saved edit arrived: give it the original's metadata, then hand it on
    const im = out.images[0], ex = EXPORT, doc = node.properties.lc_doc || "", i = doc.lastIndexOf("/");
    if (!doc) { ex.done(im); return; }                                       // a fresh render: the saver already wrote it with the workflow's own metadata
    api.fetchApi("/lightcraft/finish/fixmeta", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: im.subfolder || ex.dir, orig_path: i >= 0 ? doc.slice(0, i) : "", orig: doc.slice(i + 1), up: im.filename, note: "Edited in LightCraft Edit Page" }) })
      .catch((e) => console.error("[LightCraft] metadata copy failed", e)).finally(() => { try { node.properties.lc_exSig = docSig(node); } catch (e) { /* only the unsaved-edits warning depends on it */ } ex.done(im); });
    return;
  }
  if (out.lc_finish && out.lc_finish[0]) { const j = out.lc_finish[0]; f.jobs[j.name] = j; return; }
  const im = out.images && out.images[0];
  if (!im) return;
  const stem = String(im.filename).replace(/\.[^.]+$/, ""), j = f.jobs[stem];
  if (!j) return;
  delete f.jobs[stem];
  const o = finOptions(), orig = j.src.replace(/\s*\[(output|input|temp)\]\s*$/, ""), origName = orig.slice(orig.lastIndexOf("/") + 1);
  const note = o.flux ? `Skin pass: Flux 2 Klein ${o.tiles || 4} tiles, ${o.steps} steps, denoise ${(+o.dn).toFixed(2)}` : `Upscaled: AusBoss Qwen tiled, ${o.mp} MP, ${o.steps} steps, restore ${(+o.restore).toFixed(2)}`;
  api.fetchApi("/lightcraft/finish/fixmeta", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: im.subfolder || j.path || "", orig_path: orig.includes("/") ? orig.slice(0, orig.lastIndexOf("/")) : "", orig: origName, up: im.filename, note }) })
    .catch((e) => console.error("[LightCraft] metadata copy failed", e))
    .finally(() => {
      f.done++;
      if (f.done >= f.total) { f.running = false; f.queuedAll = false; f.msg = `${f.done} done`; }
      f.cur = (im.subfolder ? im.subfolder + "/" : "") + im.filename;
      finRefresh(node);
    });
}

// ---------------------------------------------------------------- the TEMP decimate button (lives in the History panel)
export function tempButton(ctx, node, x, y, w, h, onCleared, keepFn) {
  const f = F(node), now = performance.now();
  if (f.decim && f.decim.t < now) { f.decim = null; }
  const armed = f.decim && f.decim.kind === "armed", done = f.decim && f.decim.kind === "done";
  const keep = () => { try { return keepFn ? [...keepFn(node)] : []; } catch (e) { return []; } };
  const ti = f.tinfo;                                                         // how much would be freed: asked now and then, only while the button is on screen
  if (!f.tbusy && (!ti || now - ti.t > 10000)) {
    f.tbusy = true;
    api.fetchApi("/lightcraft/finish/tempinfo", { method: "POST", body: JSON.stringify({ keep: keep() }) }).then((r) => r.json())
      .then((j) => { f.tinfo = { files: j.files, mb: j.mb, t: performance.now() }; }).catch(() => { f.tinfo = { files: 0, mb: 0, t: performance.now() }; })
      .finally(() => { f.tbusy = false; node.setDirtyCanvas(true, false); });
  }
  const sz = ti ? (ti.mb >= 1000 ? (ti.mb / 1024).toFixed(1) + " GB" : Math.round(ti.mb) + " MB") : "";
  rr(ctx, x, y, w, h, 5);
  ctx.fillStyle = armed ? "#5a2a1a" : C.btn; ctx.fill();
  ctx.strokeStyle = armed || done ? ORANGE : "#4a4a4a"; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = armed ? "#ffd2a8" : "#d0d0d0"; ctx.font = "600 11px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const opts = done ? [f.decim.text, `Freed ${f.decim.mb} MB`]
    : armed ? [`Click again: delete ${sz || "all"}`, "Click again", "Sure?"]
      : sz ? [`TEMP decimate · ${sz}`, `Decimate · ${sz}`, sz] : ["TEMP decimate", "Decimate"];
  const txt = opts.find((t) => ctx.measureText(t).width <= w - 10) || opts[opts.length - 1];                // the longest wording that fits the bar
  ctx.fillText(txt, x + w / 2, y + h / 2 + 0.5, w - 8);
  if (f.decim) setTimeout(() => node.setDirtyCanvas(true, false), Math.max(40, f.decim.t - now + 30));
  f.tipT = [x, y, w, h];
  hit(node, "ed:fin:temp", x, y, w, h, async () => {
    if (!armed) { f.decim = { kind: "armed", t: performance.now() + 3500 }; node.setDirtyCanvas(true, true); return; }
    try {
      const k = keep();
      const r = await api.fetchApi("/lightcraft/finish/clean", { method: "POST", body: JSON.stringify({ keep: k }) });
      const j = await r.json();
      f.decim = { kind: "done", t: performance.now() + 4000, mb: j.mb, text: `Freed ${j.mb} MB · ${j.files} file${j.files === 1 ? "" : "s"} · edit kept` };
      f.tinfo = { files: 0, mb: 0, t: performance.now() };
      if (onCleared) onCleared(new Set(k));
    } catch (e) { f.decim = { kind: "done", t: performance.now() + 4000, text: "Could not clean", mb: 0 }; }
    node.setDirtyCanvas(true, true);
  }, "pointer");
}

// ---------------------------------------------------------------- the right-hand panel: only the upscale controls
function setSteps(v) { const N = ausNodes(), w = N.flux ? widget(N.flux, "steps") : widget(N.steps, "value"); if (w) setW(w, Math.round(v)); }
function setTiles(n) {
  const N = ausNodes(), w = widget(N.split, "tiles"); if (!w) return;
  setW(w, n === 2 ? "2 tiles (fit the picture)" : "4 tiles (2 x 2, fit the picture)");
  N.split.title = n === 2 ? "Cut into 2 tiles" : "Cut into 4 tiles (2 x 2)";
}
function setDenoise(v) { const w = widget(ausNodes().flux, "denoise"); if (w) setW(w, v); }

export function drawFinishPanel(ctx, node, px, py, pw, ph, e, H) {
  const f = F(node);
  if (pw < 8) return;
  f.tips = {};
  ctx.save();
  ctx.beginPath(); rr(ctx, px, py, pw, ph, 6); ctx.clip();
  if (!node.__lcNoBg) {
  ctx.fillStyle = "#18181a"; ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; rr(ctx, px, py, pw, ph, 6); ctx.stroke();
  }
  ctx.globalAlpha = clamp((e - 0.2) / 0.8, 0, 1);
  const ix = px + 12 + (1 - e) * 48, iw = FIN_W - 24, clickable = e > 0.98;
  ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  if (clickable && !f.loaded && !f.loading) finRefresh(node);
  const o = finOptions(), regTip = (id, x, y, w, h) => { f.tips[id] = [x, y, w, h]; };
  if (editMode(node)) { drawBrowsePanel(ctx, node, px, py, pw, ph, ix, iw, clickable, H, regTip); ctx.restore(); return; }

  ctx.fillStyle = C.head; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Skin pass", ix, py + 17);
  ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(ix, py + 29.5); ctx.lineTo(ix + iw, py + 29.5); ctx.stroke();

  let y = py + 40;
  const dis = f.running, ok = clickable && !dis && o.ok;
  if (!o.ok) {
    ctx.font = "11px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#e07a5f";
    ctx.fillText("Skin pass nodes not found in this workflow.", ix, y + 10);
    y += 26;
  } else {
    if (o.flux) {                                                                   // Flux skin pass: no upscaler, only how many steps and how strong
      H.miniSlider(ctx, node, "fin:st", ix, y, iw, "Steps", o.steps, 1, 8, (v) => String(Math.round(v)), (v) => { if (ok) setSteps(v); }, () => touch(node));
      regTip("fin:st", ix, y - 2, iw, 22); y += 28;
      H.miniSlider(ctx, node, "fin:dn", ix, y, iw, "Denoise", o.dn, 0.3, 0.8, (v) => v.toFixed(2), (v) => { if (ok) setDenoise(Math.round(v * 100) / 100); }, () => touch(node));
      regTip("fin:dn", ix, y - 2, iw, 22); y += 30;
      if (o.hasTiles) {                                                               // 2 or 4 tiles, with a short explainer
        const hw = (iw - 6) / 2;
        ctx.font = "600 11px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = "#cfcfd4";
        ctx.fillText("Tiles", ix, y + 9); y += 20;
        H.button(ctx, node, "fin:t2", ix, y, hw, 24, "2 tiles", o.tiles === 2, () => { if (ok) { setTiles(2); touch(node); } });
        H.button(ctx, node, "fin:t4", ix + hw + 6, y, hw, 24, "4 tiles", o.tiles === 4, () => { if (ok) { setTiles(4); touch(node); } });
        regTip("fin:t2", ix, y, hw, 24); regTip("fin:t4", ix + hw + 6, y, hw, 24); y += 30;
        ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.fillStyle = "#8a8a92";
        const ex = o.tiles === 2 ? ["2 tiles: no seam crosses the face, so no ghosting.", "Slower. Also the better pick for smaller pictures."] : ["4 tiles: faster. A seam can rarely leave a faint ghost", "on a face. If you see one, switch to 2 tiles."];
        ex.forEach((ln, k) => ctx.fillText(H.fitText(ctx, ln, iw), ix, y + 5 + k * 13)); y += 32;
      }
    } else {
    const mp = (v) => (Math.round(v * 2) / 2).toFixed(1);
    H.miniSlider(ctx, node, "fin:mp", ix, y, iw, "Megapixels", o.mp, 1, 12, mp, (v) => { if (ok) setMp(Math.round(v * 2) / 2); }, () => touch(node));
    regTip("fin:mp", ix, y - 2, iw, 22); y += 28;
    H.miniSlider(ctx, node, "fin:st", ix, y, iw, "Steps", o.steps, 4, 40, (v) => String(Math.round(v)), (v) => { if (ok) setSteps(v); }, () => touch(node));
    regTip("fin:st", ix, y - 2, iw, 22); y += 28;
    H.miniSlider(ctx, node, "fin:rs", ix, y, iw, "Restore", o.restore, 0, 1.5, (v) => v.toFixed(2), (v) => { if (ok) setRestore(Math.round(v * 20) / 20); }, () => touch(node));
    regTip("fin:rs", ix, y - 2, iw, 22); y += 30;
    H.checkbox(ctx, node, "fin:fast", ix, y + 2, o.fast, null, "Fast · Turbo LoRA (8 steps)", () => { if (!dis) { setFast(!o.fast); touch(node); } });
    hit(node, "ed:fin:fast", ix - 2, y - 2, iw, 20, () => { if (!dis) { setFast(!o.fast); touch(node); } }, "pointer");
    regTip("fin:fast", ix, y - 2, iw, 20); y += 24;
    }
    y = useToggles(ctx, node, H, ix, y, iw, dis, touch, regTip, o);
    y += 6;
  }

  // --- the button
  let by2 = 0;
  const docEdit = hasEdit(node);              // an open document: the button saves the edit, then upscales it
  const target = docEdit ? { edit: true } : curFile(f) && !curFile(f).orig ? curFile(f) : null;       // otherwise: the picture you are looking at
  const sel = target ? 1 : 0, can = sel > 0 && true && o.ok && !f.running;
  // which picture the button will use, said in words, and (editing) a huge button so there is no doubt
  const wname = docEdit ? (node.properties.lc_doc_name || node.properties.lc_doc || "the picture in the Edit Page") + " (your edit)" : target && target.name ? target.name : "";
  ctx.font = "600 11.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = "#cfcfd4";
  ctx.fillText(H.fitText(ctx, wname ? "Working on: " + wname : "Working on: nothing chosen", iw), ix, y + 8); y += 20;
  const by = y, bh = docEdit ? 64 : 40;
  rr(ctx, ix, by, iw, bh, 7);
  if (can) { ctx.save(); ctx.shadowColor = "rgba(255,138,42,0.65)"; ctx.shadowBlur = 14; ctx.fillStyle = ORANGE; ctx.fill(); ctx.restore(); }
  else { ctx.fillStyle = f.running ? "#3a2a1c" : C.btn; ctx.fill(); }
  if (f.running) {
    const k = (performance.now() % 1400) / 1400;
    ctx.save(); rr(ctx, ix, by, iw, bh, 7); ctx.clip();
    const g = ctx.createLinearGradient(ix + (k * 1.6 - 0.3) * iw, 0, ix + (k * 1.6 - 0.1) * iw, 0);
    g.addColorStop(0, "rgba(255,138,42,0)"); g.addColorStop(0.5, "rgba(255,138,42,0.35)"); g.addColorStop(1, "rgba(255,138,42,0)");
    ctx.fillStyle = g; ctx.fillRect(ix, by, iw, bh); ctx.restore();
    requestAnimationFrame(() => node.setDirtyCanvas(true, false));
  }
  ctx.font = `700 ${docEdit ? 19 : 15}px Inter, 'Segoe UI', sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = can ? "#1e1e1e" : f.running ? "#ffd2a8" : "#7d7d7d";
  ctx.fillText(f.running ? `Skin pass ${Math.min(f.done + 1, f.total)} / ${f.total}…` : docEdit ? "Skin pass your edit  →" : target ? "Skin pass this picture" : "Skin pass", ix + iw / 2, by + bh / 2 + 0.5);
  if (clickable && can) hit(node, "ed:fin:go", ix, by, iw, bh, () => (docEdit ? upscaleEdit(node) : finRun(node, [target])), "pointer");
  regTip("fin:go", ix, by, iw, bh);
  const canBring = !!(pickOf(node) || (node.properties && node.properties.lc_doc));
  const bh2 = bh + (docEdit ? 32 : 0) + (canBring ? 32 : 0);
  if (canBring) {                                                         // fallback if anything above fails: bring the edit here as a saved picture, then use the normal button on it
    const yy = by + bh + (docEdit ? 38 : 6), sc = clickable && !f.running;
    rr(ctx, ix, yy, iw, 26, 6); ctx.strokeStyle = sc ? ORANGE : "#3a3a40"; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = "600 12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = sc ? "#ffd2a8" : "#5f5f66";
    ctx.fillText("Bring my edit here (manual)", ix + iw / 2, yy + 13.5);
    if (sc) hit(node, "ed:fin:bring", ix, yy, iw, 26, () => bringEdit(node), "pointer");
    f.tips["fin:bring"] = [ix, yy, iw, 26];
  }
  if (docEdit) {                                                          // finish the edit WITHOUT upscaling: just save it as name_edit next to the original
    const sy = by + bh + 6, sc = clickable && !f.running;
    rr(ctx, ix, sy, iw, 26, 6); ctx.strokeStyle = sc ? "#9a9aa2" : "#3a3a40"; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = "600 12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = sc ? "#d8d8d8" : "#5f5f66";
    ctx.fillText("Save image (no skin pass)", ix + iw / 2, sy + 13.5);
    if (sc) hit(node, "ed:fin:save", ix, sy, iw, 26, () => saveEditOnly(node), "pointer");
    f.tips["fin:save"] = [ix, sy, iw, 26];
  }
  ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const note = f.err || f.msg || (docEdit ? "Your edit is saved first, then skin-passed." : target ? "The roulette dice stay locked while this runs." : f.cur ? "This one is already an upscaled picture." : "Open a picture in Browse (double-click) to edit it, or press the magnifier to look at one here.");
  ctx.fillStyle = f.err ? "#e07a5f" : "#7a7a82";
  let nl = 0;
  if (f.err) {                                                               // an error is shown in full (up to 4 lines), not cut off
    const words = String(note).split(" "); let cur = "";
    const lines = [];
    for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > iw && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    lines.slice(0, 4).forEach((ln, k) => ctx.fillText(ln, ix, by + bh2 + 14 + k * 13));
    nl = Math.min(4, lines.length) - 1;
  } else ctx.fillText(H.fitText(ctx, note, iw), ix, by + bh2 + 14);
  if (H.drawClip && f.cur) H.drawClip(ctx, node, px, by + bh2 + 28 + nl * 13, pw);                  // histogram + highlight / shadow warnings + pixel drift for the compared picture

  // --- footer: counts + TEMP decimate
  const fy = py + ph - 62;
  ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#6a6a72";
  ctx.fillText(`${f.files.length} saved · ${f.files.filter((x) => x.ups.length).length} with skin pass · from ${f.folder || "…"}`, ix, fy + 8, iw);
  if (clickable) H.tempButton(ctx, node, ix, fy + 20, iw, 24, H.onCleared, H.keepFn);
  ctx.restore();
}

function drawBrowsePanel(ctx, node, px, py, pw, ph, ix, iw, clickable, H, regTip) {
  const f = F(node), p = node.properties || {};
  ctx.fillStyle = C.head; ctx.font = "600 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Edit a picture", ix, py + 17);
  ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(ix, py + 29.5); ctx.lineTo(ix + iw, py + 29.5); ctx.stroke();
  let y = py + 42;
  const x = f.files.find((v) => v.rel === f.editPick) || null;
  rr(ctx, ix, y, iw, 64, 8); ctx.fillStyle = "#232326"; ctx.fill(); ctx.strokeStyle = "#3b3b42"; ctx.stroke();
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.font = "600 12.5px Inter, 'Segoe UI', sans-serif"; ctx.fillStyle = x ? CREAM : "#7a7a82";
  ctx.fillText(H.fitText(ctx, x ? x.name : "No picture chosen", iw - 20), ix + 10, y + 18);
  if (x) dimOf(node, x);
  const d = x ? x.dim : null;
  ctx.font = "11px Inter, 'Segoe UI', sans-serif"; ctx.fillStyle = "#9a9aa2";
  ctx.fillText(x ? (d ? `${d[0]} × ${d[1]} px` : "reading size…") : "Click one in the grid.", ix + 10, y + 38);
  if (x && x.orig) { ctx.fillStyle = "#ffd2a8"; ctx.fillText("this one already has the skin pass", ix + 10, y + 54); }
  y += 76;
  const can = !!x && clickable, bh = 44;
  rr(ctx, ix, y, iw, bh, 8);
  if (can) { ctx.save(); ctx.shadowColor = "rgba(255,138,42,0.65)"; ctx.shadowBlur = 14; ctx.fillStyle = ORANGE; ctx.fill(); ctx.restore(); } else { ctx.fillStyle = C.btn; ctx.fill(); }
  ctx.font = "700 15px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = can ? "#1e1e1e" : "#7d7d7d";
  ctx.fillText("Edit this picture", ix + iw / 2, y + bh / 2 + 0.5);
  if (can) hit(node, "ed:fin:edit", ix, y, iw, bh, () => { openGuarded(node, x); }, "pointer");
  y += bh + 12;
  ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#7a7a82";
  const note = p.lc_doc ? `Now editing: ${p.lc_doc_name || p.lc_doc}. The saved file is never changed; every step is a layer.` : "It opens in Crop, then Face, Color and Skin pass. Nothing is generated while you edit.";
  const lines = []; let cur = "";
  for (const w of note.split(" ")) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > iw && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  lines.slice(0, 5).forEach((ln, k) => ctx.fillText(ln, ix, y + 6 + k * 14));
  // --- the batch upscale: tick pictures with the box in their corner, then press the button (settings live in the Upscale tab)
  y += 8 + lines.slice(0, 5).length * 14;
  ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(ix, y + 0.5); ctx.lineTo(ix + iw, y + 0.5); ctx.stroke(); y += 12;
  ctx.fillStyle = C.head; ctx.font = "600 12px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillText("Skin pass a batch", ix, y + 6); y += 20;
  const o = finOptions(), nSel = f.files.filter((v) => f.sel.has(v.rel)).length, canUp = clickable && nSel > 0 && o.ok && !f.running;
  ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.fillStyle = "#9a9aa2";
  ctx.fillText(o.ok ? (o.flux ? `Flux skin pass · ${Math.round(o.steps)} steps · denoise ${(+o.dn).toFixed(2)}  (change in the Skin pass tab)` : `${o.mp} MP · ${Math.round(o.steps)} steps${o.fast ? " · Fast" : ""}  (change in the Skin pass tab)`) : "AusBoss upscale nodes not found.", ix, y + 4, iw); y += 16;
  y = useToggles(ctx, node, H, ix, y + 2, iw, !!f.running, touch, null, o) + 4;                 // Use grade / FX / grain: off until switched on
  rr(ctx, ix, y, iw, 38, 7);
  if (canUp) { ctx.fillStyle = "#4a3220"; ctx.fill(); ctx.strokeStyle = ORANGE; ctx.lineWidth = 1.4; ctx.stroke(); } else { ctx.fillStyle = f.running ? "#3a2a1c" : C.btn; ctx.fill(); }
  ctx.font = "700 14px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = canUp ? "#ffe7d1" : f.running ? "#ffd2a8" : "#7d7d7d";
  ctx.fillText(f.running ? `Skin pass ${Math.min(f.done + 1, f.total)} / ${f.total}…` : nSel ? `Skin pass ${nSel} ticked` : "Skin pass ticked", ix + iw / 2, y + 19.5);
  if (canUp) hit(node, "ed:fin:go", ix, y, iw, 38, () => finRun(node), "pointer");
  regTip("fin:go", ix, y, iw, 38); y += 46;
  const pickable = finVisible(node).filter((v) => !v.orig && !v.ups.length), sw2 = (iw - 6) / 2;
  const mini = (id, x, w, text, on, fn) => {
    rr(ctx, x, y, w, 24, 5); ctx.fillStyle = on ? C.btn : "#232326"; ctx.fill();
    ctx.font = "11px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = on ? "#d8d8d8" : "#5f5f66"; ctx.fillText(text, x + w / 2, y + 12.5);
    if (clickable && on) hit(node, "ed:" + id, x, y, w, 24, fn, "pointer");
  };
  mini("fin:all", ix, sw2, "Select new", pickable.length > 0 && !f.running, () => { pickable.forEach((v) => f.sel.add(v.rel)); node.setDirtyCanvas(true, true); });
  mini("fin:clear", ix + sw2 + 6, sw2, "Clear selection", nSel > 0 && !f.running, () => { f.sel.clear(); node.setDirtyCanvas(true, true); });
  regTip("fin:tick", ix, y, iw, 24);
  if (f.err) { ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#e07a5f"; ctx.fillText(H.fitText(ctx, f.err, iw), ix, y + 40); }
  const fy = py + ph - 62;
  ctx.fillStyle = "#6a6a72"; ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillText(`${f.files.length} saved · ${f.files.filter((v) => v.ups.length).length} upscaled · from ${f.folder || "…"}`, ix, fy + 8, iw);
  if (clickable) H.tempButton(ctx, node, ix, fy + 20, iw, 24, H.onCleared, H.keepFn);
}

// ---------------------------------------------------------------- the picture area: a grid of the saved pictures (like the Station browser)
const GAP = 8;
export const SIZES = [["s", "S", 104], ["m", "M", 138], ["l", "L", 190]];
const dims = (f) => { const W = (SIZES.find((v) => v[0] === (f.size || "m")) || SIZES[1])[2], T = Math.round(W * 1.13); return { CELL_W: W, THUMB_H: T, CELL_H: T + 34 }; };

export function drawFinishGrid(ctx, node, vx, vy, vw, vh, H) {
  const f = F(node);
  f.cells = [];
  const { CELL_W, THUMB_H, CELL_H } = dims(f);
  const rows = finVisible(node);
  const cols = Math.max(1, Math.floor((vw - GAP) / (CELL_W + GAP))), gx = vx + Math.max(GAP, (vw - cols * (CELL_W + GAP) + GAP) / 2);
  const nrows = Math.ceil(rows.length / cols), bigH = f.moreDirs && rows.length ? 46 : 0, total = nrows * (CELL_H + GAP) + GAP + (bigH ? bigH + GAP : 0), maxS = Math.max(0, total - vh);
  f.scroll = clamp(f.scroll, 0, maxS);
  ctx.save();
  ctx.beginPath(); ctx.rect(vx, vy, vw, vh); ctx.clip();
  wheelZone(node, "fin:wheel", vx, vy, vw, vh, (dy) => { f.scroll = clamp(f.scroll + dy * 0.8, 0, maxS); node.setDirtyCanvas(true, false); });
  if (!rows.length) {
    ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = C.label;
    ctx.fillText(f.loading ? "Looking in the saved folder…" : f.err ? f.err : f.files.length ? "No picture has that many stars." : "Nothing saved there yet.", vx + vw / 2, vy + vh / 2);
  }
  rows.forEach((x, i) => {
    const cx = gx + (i % cols) * (CELL_W + GAP), cy = vy + GAP + Math.floor(i / cols) * (CELL_H + GAP) - f.scroll;
    if (cy + CELL_H < vy - 4 || cy > vy + vh + 4) return;
    const ticked = f.sel.has(x.rel), chosen = editMode(node) && f.editPick === x.rel, framed = editMode(node) ? chosen : f.sel.has(x.rel), isUp = !!x.orig, done = x.ups.length > 0, cur = f.cur === x.rel;
    ctx.save();
    if (done) { ctx.shadowColor = "rgba(255,138,42,0.6)"; ctx.shadowBlur = 12; }                  // already upscaled: a faint orange glow
    rr(ctx, cx, cy, CELL_W, CELL_H, 7); ctx.fillStyle = "#1c1c1f"; ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
    ctx.strokeStyle = done ? ORANGE : framed ? CREAM : "#2c2c31"; ctx.lineWidth = done || framed ? 2.2 : 1; ctx.stroke();       // orange frame = upscaled, creamy white frame = chosen
    ctx.restore();
    if (framed && done) { rr(ctx, cx + 3.5, cy + 3.5, CELL_W - 7, CELL_H - 7, 5); ctx.strokeStyle = CREAM; ctx.lineWidth = 1.6; ctx.stroke(); }
    f.cells.push({ x: cx, y: cy, w: CELL_W, h: CELL_H, file: x });
    // thumbnail
    const t = thumbOf(node, x);
    ctx.save(); rr(ctx, cx + 3, cy + 3, CELL_W - 6, THUMB_H - 3, 5); ctx.clip();
    ctx.fillStyle = "#101012"; ctx.fillRect(cx + 3, cy + 3, CELL_W - 6, THUMB_H - 3);
    if (t) { const k = Math.min((CELL_W - 6) / t.w, (THUMB_H - 3) / t.h), w = t.w * k, h = t.h * k; ctx.drawImage(t.img, cx + (CELL_W - w) / 2, cy + 3 + (THUMB_H - 3 - h) / 2, w, h); }
    if (framed) { ctx.fillStyle = "rgba(243,234,216,0.10)"; ctx.fillRect(cx + 3, cy + 3, CELL_W - 6, THUMB_H - 3); }
    ctx.restore();
    // tick box (top-left), magnifier (top-right), UP badge (bottom-left of the picture)
    rr(ctx, cx + 8, cy + 8, 16, 16, 4); ctx.fillStyle = ticked ? CREAM : "rgba(0,0,0,0.55)"; ctx.fill(); ctx.strokeStyle = ticked ? CREAM : "#9a9aa2"; ctx.lineWidth = 1; ctx.stroke();
    if (ticked) { ctx.strokeStyle = "#1e1e1e"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx + 11.5, cy + 16.5); ctx.lineTo(cx + 15, cy + 20); ctx.lineTo(cx + 20.5, cy + 12.5); ctx.stroke(); }
    rr(ctx, cx + CELL_W - 26, cy + 8, 18, 18, 9); ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fill();
    ctx.strokeStyle = "#e8e8e8"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(cx + CELL_W - 18.6, cy + 16.4, 3.6, 0, Math.PI * 2); ctx.moveTo(cx + CELL_W - 15.8, cy + 19.2); ctx.lineTo(cx + CELL_W - 12.6, cy + 22.4); ctx.stroke();
    if (done || isUp) {
      rr(ctx, cx + 8, cy + THUMB_H - 22, 26, 15, 7.5); ctx.fillStyle = isUp ? "rgba(0,0,0,0.65)" : ORANGE; ctx.fill();
      if (isUp) { ctx.strokeStyle = ORANGE; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = isUp ? "#ffd2a8" : "#1e1e1e"; ctx.font = "700 9.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("UP", cx + 21, cy + THUMB_H - 14.5);
    }
    // name + stars
    ctx.font = "10.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = framed ? CREAM : "#cfcfd4";
    ctx.fillText(H.fitText(ctx, x.stem.replace(/^No_Thing_/, ""), CELL_W - 12), cx + 7, cy + THUMB_H + 8);
    // hits: the cell first, then tick box, magnifier and stars on top (later regions win)
    hit(node, `ed:fin:cell:${i}`, cx, cy, CELL_W, CELL_H, () => {
      if (editMode(node)) {                                                // Browse: one picture is chosen; a quick second click opens it
        const now = performance.now(), again = f.editPick === x.rel && now - (f.editT || 0) < 380;
        f.editPick = x.rel; f.editT = now;
        if (again) openGuarded(node, x);
      } else if (f.sel.has(x.rel)) f.sel.delete(x.rel); else f.sel.add(x.rel);
      f.cur = x.rel; node.setDirtyCanvas(true, true);
    }, "pointer");
    if (editMode(node)) hit(node, `ed:fin:tick:${i}`, cx + 4, cy + 4, 24, 24, () => { if (f.sel.has(x.rel)) f.sel.delete(x.rel); else f.sel.add(x.rel); node.setDirtyCanvas(true, true); }, "pointer");     // Browse: the box ticks it for the batch upscale
    hit(node, `ed:fin:look:${i}`, cx + CELL_W - 28, cy + 6, 22, 22, () => { f.cur = x.rel; f.view = "compare"; f.upDoc = false; f.skipDoc = true; f.skipPick = pickOf(node); node.setDirtyCanvas(true, true); }, "zoom-in");   // the magnifier shows the picture big, right here in Browse (Esc or the Grid button goes back)
    for (let k = 1; k <= 5; k++) {
      const sx = cx + 14 + (k - 1) * 14.5, sy = cy + THUMB_H + 23;
      star(ctx, sx, sy, 5.2, x.r >= k);
      hit(node, `ed:fin:star:${i}:${k}`, sx - 7, sy - 8, 14.5, 16, () => rate(node, x, k), "pointer");
    }
  });
  if (bigH) {                                                      // the big button under the newest pictures
    const by = vy + GAP + nrows * (CELL_H + GAP) - f.scroll, bw = Math.min(vw - 2 * GAP, 420), bx = vx + (vw - bw) / 2;
    rr(ctx, bx, by, bw, bigH, 9); ctx.fillStyle = f.loading ? "#3a2a18" : "#2b2013"; ctx.fill(); ctx.strokeStyle = ORANGE; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.font = "700 14px 'Montserrat Alternates', Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = ORANGE;
    ctx.fillText(f.loading ? "Loading…" : "Load the rest of the pictures", bx + bw / 2, by + bigH / 2);
    hit(node, "ed:fin:more", bx, by, bw, bigH, () => finRefresh(node, true), "pointer");
  }
  ctx.restore();
  if (maxS > 0) {                                                  // a scrollbar you can grab: drag it, or click the track to jump
    const bh = Math.max(32, vh * vh / total), by = vy + (f.scroll / maxS) * (vh - bh), tx = vx + vw - 14;
    const hot = f.dragSB || (node.__lcPointer && node.__lcPointer[0] > tx && node.__lcPointer[0] < vx + vw && node.__lcPointer[1] > vy && node.__lcPointer[1] < vy + vh);
    rr(ctx, vx + vw - (hot ? 10 : 6), by, hot ? 7 : 3, bh, 3.5); ctx.fillStyle = hot ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.2)"; ctx.fill();
    hit(node, "ed:fin:sb", tx, vy, 14, vh, ({ ev, pos }) => {
      const grab = pos[1] >= by && pos[1] <= by + bh ? pos[1] - by : bh / 2;          // grab the handle where it is, else centre it on the click
      const s0 = clamp(((pos[1] - grab - vy) / (vh - bh)) * maxS, 0, maxS);
      f.scroll = s0; f.dragSB = true; node.setDirtyCanvas(true, false);
      drag({ node, ev, cursor: "ns-resize", onMove: (dx, dy) => { f.scroll = clamp(s0 + (dy / (vh - bh)) * maxS, 0, maxS); }, onUp: () => { f.dragSB = false; } });
    }, "ns-resize");
  }
}

// the row under the grid: star filter, tick helpers, refresh
export function drawFinishBar(ctx, node, x, y, w, H) {
  const f = F(node), gap = 5;
  const chips = [[0, "All"], [3, "3★ +"], [4, "4★ +"], [5, "5★"]];
  const bw = 62;
  chips.forEach(([m, t], i) => H.button(ctx, node, "fin:chip:" + m, x + i * (bw + gap), y, bw, 25, t, f.minStar === m, () => { f.minStar = m; f.scroll = 0; node.setDirtyCanvas(true, true); }));
  f.tips["fin:stars"] = [x, y, 4 * bw + 3 * gap, 25];
  let bx = x + 4 * (bw + gap) + 10;
  const SCOPES = [["all", "Show: all"], ["orig", "Show: saved"], ["up", "Show: skin pass done"]];
  H.button(ctx, node, "fin:scope", bx, y, 112, 25, (SCOPES.find((v) => v[0] === (f.scope || "all")) || SCOPES[0])[1], (f.scope || "all") !== "all", () => {
    f.scope = SCOPES[(SCOPES.findIndex((v) => v[0] === (f.scope || "all")) + 1) % SCOPES.length][0]; f.scroll = 0; node.setDirtyCanvas(true, true);
  });
  f.tips["fin:scope"] = [bx, y, 112, 25];
  let rx = x + w;
  rx -= 28; H.button(ctx, node, "fin:refresh", rx, y, 28, 25, "⟳", false, () => finRefresh(node));
}

// the head row in the upper-left corner of the picture area: Grid | Single, and (grid only) thumbnail size S M L.
// e = how present the tab is (0..1), sel = 0 grid .. 1 single (both glide), g = 1 in the grid view .. 0 in single.
export function drawFinishHead(ctx, node, x, y, e, sel, g, H) {
  if (e < 0.02) return;
  const f = F(node), h = 24, bw = 62, dx = -(1 - e) * 26;
  ctx.save(); ctx.globalAlpha = e;
  x += dx;
  rr(ctx, x, y, bw * 2 + 6, h, 6); ctx.fillStyle = "#222226"; ctx.fill();
  rr(ctx, x + 3 + sel * bw, y + 3, bw, h - 6, 4); ctx.fillStyle = "#5a5a5a"; ctx.fill();         // the marker glides between the two
  ctx.font = "11.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  [["Grid", 0], ["Single", 1]].forEach(([t, i]) => {
    ctx.fillStyle = Math.abs(sel - i) < 0.5 ? "#fff" : "#a0a0a8"; ctx.fillText(t, x + 3 + i * bw + bw / 2, y + h / 2 + 0.5);
  });
  if (e > 0.5) {
    hit(node, "ed:fin:vgrid", x, y, bw + 3, h, () => { f.view = "grid"; node.setDirtyCanvas(true, true); }, "pointer");
    hit(node, "ed:fin:vsingle", x + bw + 3, y, bw + 3, h, () => {
      if (!curFile(f)) { const v = finVisible(node)[0]; if (v) f.cur = v.rel; }
      if (curFile(f)) { f.view = "compare"; node.setDirtyCanvas(true, true); }
    }, "pointer");
  }
  if (g > 0.02) {                                                  // size: slides in behind the pill while in the grid view
    ctx.globalAlpha = e * g;
    const sx = x + bw * 2 + 6 + 10 + (1 - g) * -18, sw = 28;
    rr(ctx, sx, y, sw * 3 + 6, h, 6); ctx.fillStyle = "#222226"; ctx.fill();
    SIZES.forEach(([k, t], i) => {
      const on = (f.size || "m") === k, bx = sx + 3 + i * sw;
      if (on) { rr(ctx, bx, y + 3, sw, h - 6, 4); ctx.fillStyle = "#5a5a5a"; ctx.fill(); }
      ctx.fillStyle = on ? "#fff" : "#a0a0a8"; ctx.fillText(t, bx + sw / 2, y + h / 2 + 0.5);
      if (e * g > 0.5) hit(node, "ed:fin:size:" + k, bx, y, sw, h, () => { f.size = k; node.setDirtyCanvas(true, true); }, "pointer");
    });
    f.tips["fin:size"] = [sx, y, sw * 3 + 6, h];
  }
  ctx.restore();
}
export const finView = (node) => (node.__lc && node.__lc.tab === "finish" ? "compare" : (F(node).view || "grid"));       // the Upscale tab is a comparer, never a browser

// the extra rects the tab-tip card watches (node coordinates)
export function finTipRects(node, tab) {
  const f = node.__lcFin, r = {};
  if (!f) return r;
  if (f.tipT) r["fin:temp"] = f.tipT;
  if (tab === "finish") for (const [k, v] of Object.entries(f.tips || {})) r[k] = v;
  return r;
}
export function finFrameStart(node) { if (node.__lcFin) node.__lcFin.tipT = null; }

// number keys 1-5 rate (like the Station) while this tab is open: the picture under the pointer, else the one last clicked. 0 clears.
export function finKey(node, n) {
  const f = F(node), p = node.__lcPointer;
  let target = null;
  if ((f.view || "grid") === "grid" && p && f.cells) { const c = f.cells.find((c) => p[0] >= c.x && p[0] <= c.x + c.w && p[1] >= c.y && p[1] <= c.y + c.h); if (c) target = c.file; }
  if (!target) target = curFile(f);
  if (!target) return false;
  if (n === 0) { target.r = 1; }                                  // rate() toggles a rating off when it equals the old one
  rate(node, target, n === 0 ? 1 : n);
  return true;
}

// ---------------------------------------------------------------- compare view: the saved pictures as a strip along the bottom (click one to look at it)
export const STRIP_H = 104;
const SC_W = 66;

export function drawFinishStrip(ctx, node, x, y, w, h, H) {
  const f = F(node);
  f.cells = [];
  const rows = finVisible(node), step = SC_W + 6, total = rows.length * step + 6, maxS = Math.max(0, total - w);
  if (f.lastStripCur !== f.cur) {                                                      // keep the picture you are looking at in view
    const k = rows.findIndex((v) => v.rel === f.cur);
    if (k >= 0) { const cx = 6 + k * step; if (cx - (f.stripScroll || 0) < 0) f.stripScroll = cx - 6; else if (cx + SC_W - (f.stripScroll || 0) > w) f.stripScroll = cx + SC_W - w + 6; }
    f.lastStripCur = f.cur;
  }
  f.stripScroll = clamp(f.stripScroll || 0, 0, maxS);
  ctx.save();
  rr(ctx, x, y, w, h, 6); ctx.fillStyle = "#101012"; ctx.fill(); ctx.clip();
  wheelZone(node, "fin:swheel", x, y, w, h, (dy) => { f.stripScroll = clamp((f.stripScroll || 0) + dy, 0, maxS); node.setDirtyCanvas(true, false); });
  rows.forEach((v, i) => {
    const cx = x + 6 + i * step - f.stripScroll, cy = y + 5, ch = h - 10;
    if (cx + SC_W < x - 2 || cx > x + w + 2) return;
    const ticked = f.sel.has(v.rel), done = v.ups.length > 0, isUp = !!v.orig, cur = f.cur === v.rel;
    ctx.save();
    if (done) { ctx.shadowColor = "rgba(255,138,42,0.6)"; ctx.shadowBlur = 8; }
    rr(ctx, cx, cy, SC_W, ch, 5); ctx.fillStyle = "#1c1c1f"; ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
    ctx.strokeStyle = done ? ORANGE : ticked ? CREAM : "#2c2c31"; ctx.lineWidth = done || ticked ? 2 : 1; ctx.stroke();
    ctx.restore();
    const t = thumbOf(node, v);
    ctx.save(); rr(ctx, cx + 2.5, cy + 2.5, SC_W - 5, ch - 5, 4); ctx.clip();
    ctx.fillStyle = "#0b0b0c"; ctx.fillRect(cx, cy, SC_W, ch);
    if (t) { const k = Math.min((SC_W - 5) / t.w, (ch - 5) / t.h), tw = t.w * k, th = t.h * k; ctx.globalAlpha = cur ? 1 : 0.78; ctx.drawImage(t.img, cx + (SC_W - tw) / 2, cy + (ch - th) / 2, tw, th); ctx.globalAlpha = 1; }
    ctx.restore();
    if (done || isUp) {
      rr(ctx, cx + SC_W - 21, cy + ch - 15, 18, 11, 5.5); ctx.fillStyle = isUp ? "rgba(0,0,0,0.7)" : ORANGE; ctx.fill();
      if (isUp) { ctx.strokeStyle = ORANGE; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = isUp ? "#ffd2a8" : "#1e1e1e"; ctx.font = "700 8px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("UP", cx + SC_W - 12, cy + ch - 9.3);
    }
    rr(ctx, cx + 5, cy + 5, 12, 12, 3); ctx.fillStyle = ticked ? CREAM : "rgba(0,0,0,0.55)"; ctx.fill(); ctx.strokeStyle = ticked ? CREAM : "#9a9aa2"; ctx.lineWidth = 1; ctx.stroke();
    if (ticked) { ctx.strokeStyle = "#1e1e1e"; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(cx + 7.5, cy + 11); ctx.lineTo(cx + 10, cy + 13.5); ctx.lineTo(cx + 14, cy + 8); ctx.stroke(); }
    if (cur) { ctx.fillStyle = "#ffffff"; ctx.fillRect(cx + 14, cy + ch + 1.5, SC_W - 28, 2.5); }              // the one you are looking at
    f.cells.push({ x: cx, y: cy, w: SC_W, h: ch, file: v });
    hit(node, `ed:fin:strip:${i}`, cx, cy, SC_W, ch, () => { f.cur = v.rel; node.setDirtyCanvas(true, true); }, "pointer");
    hit(node, `ed:fin:stick:${i}`, cx + 2, cy + 2, 18, 18, () => { if (f.sel.has(v.rel)) f.sel.delete(v.rel); else f.sel.add(v.rel); node.setDirtyCanvas(true, true); }, "pointer");
  });
  ctx.restore();
}
