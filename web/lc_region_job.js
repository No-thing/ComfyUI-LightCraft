import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Eyes / Face detail: the Face tab's two buttons. A run adds a small chain to the prompt on its way to the server (nothing in the saved workflow changes):
//   Edit Page picture -> cut out the eyes / face and enlarge it -> Qwen redraws it (the workflow's own Qwen model, text encoder and VAE) -> paste back softly
// The result arrives as a temp picture and becomes a new History state.
export const SIZES = ["Small 1024", "Medium 1280", "Big 1536", "Huge 2048"];
export const ENGINES = ["Qwen", "Krea 2", "Flux 2 Klein"];
// per engine: its own step count and three strengths (Low / Medium / High denoise). Qwen = what the workflow's own Qwen uses (25); Krea 2 = its 8-step setting
const TABLE = { Qwen: { steps: 25, dn: [0.35, 0.5, 0.65] }, "Krea 2": { steps: 8, dn: [0.3, 0.4, 0.5] }, "Flux 2 Klein": { steps: 4, dn: [0.75, 0.9, 1.0] } };   // Flux: full denoise is what works (the eyes stay where they were because the reference holds the layout)
export const LEVELS = ["Low", "Medium", "High"];
export const RESTORE = ["Restore off", "Restore low", "Restore full"];   // Qwen only: the Restore LoRA keeps a redraw close to the picture, for eyes it is what hides the change
const RESTORE_K = [0, 0.4, 1];
const PROMPTS = {
  // written like the workflow's own requests (the AusBoss ones): one plain instruction, then what must stay unchanged
  eyes: "Refine the eyes: sharp, detailed irises with natural texture, clear catchlights, crisp lashes and eyelids, clean whites. Keep the eye shape, eye color, gaze direction, expression, skin, lighting and the rest of the picture unchanged.",
  face: "Refine the face: sharp, detailed eyes, natural skin texture, defined lips and brows. Keep the identity, expression, face shape, skin tone, lighting and the rest of the picture unchanged.",
};
// Without the reference picture Qwen is not told to copy anything: it redraws the crop from its own knowledge, starting from the crop's colours (like an SDXL adetailer pass).
// That is what makes new eye detail possible. With the reference (edit mode) it mostly copies the crop, which is why little changes.
const DESC = {
  eyes: "Close-up of eyes in a high-end beauty retouch: clear glossy irises with fine radial detail and depth, bright crisp catchlights, smooth wet eye surface, clean white sclera, sharp defined eyeliner and individual lashes, smooth polished eyelids, soft studio light, clean sharp focus.",
  face: "Close-up portrait photograph of a face, ultra detailed: sharp detailed eyes with catchlights, natural skin texture with pores, defined lips and brows, individual eyelashes, realistic lighting, 8k, razor sharp focus.",
};
// eye colour for the Flux engine: button presets (label, what the request says). Auto = read from the irises, a typed prompt overrides all of them
export const EYE_COLORS = [["Auto (read from the picture)", ""], ["Brown", "brown iris"], ["Hazel", "hazel iris"], ["Blue", "blue iris"], ["Ocean blue", "ocean blue iris"], ["Green", "green iris"], ["Hazel + blue ring", "hazel iris with a soft blue outer ring"], ["Hazel + green", "hazel iris with green"]];
const FLUX_EYES = "Refine the eyes using the reference image: {colour}, sharp, detailed irises with natural texture, clear catchlights,";
const FLUX_FACE = "Refine the face using the reference image: sharp, detailed eyes, natural skin texture, defined lips and brows. Keep the identity, expression, face shape, skin tone, lighting and the rest of the picture unchanged.";
let JOBR = null;                       // { node, kind } while a run is being queued
let addHist = null;
export const setRegionHistAdder = (fn) => { addHist = fn; };
export const regionJob = () => JOBR;

export function regionOpts(node, kind) {
  const p = (node.properties = node.properties || {});
  const eyesK = (kind || "eyes") === "eyes";                                  // the eyes pass is always Flux, 2048 px, full strength: nothing to choose (the Face tab has no buttons for it any more)
  const engine = eyesK ? "Flux 2 Klein" : (ENGINES[p["lc_rg_eng_" + (kind || "eyes")] ?? 0] || "Qwen");     // eyes: Flux 2 Klein (right place, real detail), face: Qwen (steady identity)
  const t = TABLE[engine], lvl = eyesK ? 2 : (p.lc_rg_lvl ?? 1);
  return { engine, size: eyesK ? SIZES[3] : (SIZES[p.lc_rg_size ?? 2] || SIZES[2]), steps: t.steps, denoise: t.dn[lvl] ?? t.dn[1], lvl, rest: p.lc_rg_rest ?? 0, ref: p.lc_rg_ref ?? 0, prompt: p.lc_rg_prompt || "", eyeIdx: p.lc_rg_eye ?? 0, eyeText: p.lc_rg_eyetext || "" };
}
export function regionCycle(node, key, n, dflt) { const p = (node.properties = node.properties || {}); const i = p[key] ?? (dflt ?? (key === "lc_rg_size" ? 2 : 1)); p[key] = (i + 1) % n; node.setDirtyCanvas(true, true); }

const isLink = (v) => Array.isArray(v) && v.length === 2;
// Adds the chain to the prompt `out`; `editId` is the Edit Page's id in it. Returns the id of the last node (the paste back).
export function injectRegion(out, editId) {
  const job = JOBR, o = regionOpts(job.node, job.kind);
  if (o.engine === "Krea 2") return injectKrea(out, editId, job, o);
  if (o.engine === "Flux 2 Klein") return injectFlux(out, editId, job, o);
  // the workflow has two Qwen redraws (outpaint, and the upscale tiles). The tiles one is the one that feeds the tile stitcher: that is the one to copy (its model has no outpaint LoRA)
  const up = (l) => (isLink(l) ? out[l[0]] : null);
  const stitch = Object.values(out).find((n) => n.class_type === "AUSBOSS_NODES_TiledUpscaleStitch");
  const dec0 = stitch && up(stitch.inputs.tiles), ks0 = dec0 && up(dec0.inputs.samples);
  let ks = ks0 && ks0.class_type === "KSampler" ? ks0 : null, tq = ks && up(ks.inputs.positive);
  if (!tq || tq.class_type !== "TextEncodeQwenImage21") {
    tq = Object.values(out).find((n) => n.class_type === "TextEncodeQwenImage21");
    ks = Object.values(out).find((n) => n.class_type === "KSampler" && tq && isLink(n.inputs.positive) && out[n.inputs.positive[0]] === tq);
  }
  if (!tq || !ks) throw new Error("Eyes / Face: this workflow has no Qwen redraw (TextEncodeQwenImage21 + KSampler) to use.");
  const imgKey = Object.keys(tq.inputs).find((k) => /image_1$/.test(k)) || "images.image_1";
  const edit = out[editId];
  out.lc_rg_crop = { class_type: "LightCraftRegionCrop", inputs: { image: [editId, 0], face_data: [editId, 14], region: job.kind, size: o.size, margin: job.kind === "eyes" ? 0.35 : 0.15 }, _meta: { title: "Eyes / Face crop" } };
  const encIn = { ...tq.inputs, prompt: o.prompt || (o.ref ? PROMPTS[job.kind] : DESC[job.kind]) };
  if (o.ref === 2) encIn[imgKey] = ["lc_rg_crop", 0];                                       // full reference: Qwen mostly copies it
  else if (o.ref === 1) {                                                                  // soft reference: a small, blurry copy. Qwen still sees the structure and colours, but has to draw the fine detail itself
    out.lc_rg_soft = { class_type: "ImageScaleBy", inputs: { image: ["lc_rg_crop", 0], upscale_method: "area", scale_by: 0.3 }, _meta: { title: "Soft reference (small copy of the crop)" } };
    encIn[imgKey] = ["lc_rg_soft", 0];
  } else delete encIn[imgKey];                                                              // no reference picture = a real redraw
  out.lc_rg_enc = { class_type: "TextEncodeQwenImage21", inputs: encIn, _meta: { title: "Eyes / Face request" } };
  // the model: the workflow's Qwen (cache node), with its Restore LoRA turned down / off for this redraw
  let model = ks.inputs.model;
  const cacheId = isLink(model) ? String(model[0]) : null, cache = cacheId && out[cacheId];
  if (cache && o.rest < 2) {
    const seen = new Set(), st = [cache.inputs.model]; let lo = null, lid = null;
    while (st.length && !lo) {
      const l = st.shift(); if (!isLink(l) || seen.has(String(l[0]))) continue; seen.add(String(l[0]));
      const m = out[l[0]]; if (!m) continue;
      if (m.class_type === "AUSBOSS_NODES_LoraLoader") { lo = m; lid = String(l[0]); break; }
      for (const v of Object.values(m.inputs || {})) if (isLink(v)) st.push(v);
    }
    const key = lo && Object.keys(lo.inputs).find((k) => typeof lo.inputs[k] === "string" && lo.inputs[k].trim().startsWith("["));
    if (key) {
      try {
        const list = JSON.parse(lo.inputs[key]).map((e) => (/restore/i.test(e.name || "") ? { ...e, enabled: o.rest > 0 && e.enabled !== false, strength: (e.strength || 1) * RESTORE_K[o.rest], strength_clip: (e.strength_clip || 1) * RESTORE_K[o.rest] } : e));
        out.lc_rg_lora = { ...lo, inputs: { ...lo.inputs, [key]: JSON.stringify(list) }, _meta: { title: "Eyes / Face LoRAs" } };
        out.lc_rg_cache = { ...cache, inputs: { ...cache.inputs, model: [lid === cacheId ? "lc_rg_lora" : "lc_rg_lora", 0] } };
        model = ["lc_rg_cache", 0];
      } catch (e) { /* keep the workflow's own model */ }
    }
  }
  out.lc_rg_lat = { class_type: "VAEEncode", inputs: { pixels: ["lc_rg_crop", 0], vae: tq.inputs.vae }, _meta: { title: "Eyes / Face start picture" } };   // redraw FROM the crop (low denoise), not from an empty latent
  out.lc_rg_ks = { class_type: "KSampler", inputs: { ...ks.inputs, model, positive: ["lc_rg_enc", 0], negative: ["lc_rg_enc", 1], latent_image: ["lc_rg_lat", 0], seed: Math.floor(Math.random() * 4294967295), steps: o.steps, denoise: o.denoise }, _meta: { title: "Eyes / Face redraw" } };
  const dec = Object.values(out).find((n) => n.class_type === "VAEDecode" && isLink(n.inputs.samples) && out[n.inputs.samples[0]] === ks);
  out.lc_rg_dec = { class_type: "VAEDecode", inputs: { samples: ["lc_rg_ks", 0], vae: dec ? dec.inputs.vae : tq.inputs.vae }, _meta: { title: "Eyes / Face decode" } };
  out.lc_rg_paste = { class_type: "LightCraftRegionPaste", inputs: { image: [editId, 0], redrawn: ["lc_rg_dec", 0], region: ["lc_rg_crop", 1], feather: job.kind === "eyes" ? 0.25 : 0.12, color_match: 0.8 }, _meta: { title: "Eyes / Face paste back" } };
  return "lc_rg_paste";
}

// Flux 2 Klein: its own three loaders (files you already have), a small soft copy of the crop as the reference, full denoise from the crop
function injectFlux(out, editId, job, o) {
  const eyes = job.kind === "eyes";
  out.lc_rg_crop = { class_type: "LightCraftRegionCrop", inputs: { image: [editId, 0], face_data: [editId, 14], region: job.kind, size: o.size, margin: eyes ? 0.35 : 0.15 }, _meta: { title: "Eyes / Face crop" } };
  // reuse the Flux loaders the workflow already has (the skin pass ones), so no file name has to exist that you do not own; fall back to the stock names
  const find = (cls, test) => Object.keys(out).find((k) => out[k].class_type === cls && test(out[k].inputs || {}));
  const uId = find("UNETLoader", (i) => /snofs|flux|klein/i.test(String(i.unet_name || ""))), cId = find("CLIPLoader", (i) => String(i.type) === "flux2"), vId = find("VAELoader", (i) => /flux2/i.test(String(i.vae_name || "")));
  out.lc_rg_f_unet = uId ? { ...out[uId] } : { class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-9b-fp8.safetensors", weight_dtype: "default" }, _meta: { title: "Flux 2 Klein 9B" } };
  out.lc_rg_f_clip = cId ? { ...out[cId] } : { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_8b_fp8mixed.safetensors", type: "flux2", device: "default" }, _meta: { title: "Flux text encoder" } };
  out.lc_rg_f_vae = vId ? { ...out[vId] } : { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" }, _meta: { title: "Flux 2 VAE" } };
  const custom = (o.eyeText || "").trim(), preset = EYE_COLORS[o.eyeIdx] || EYE_COLORS[6];
  const colour = custom || preset[1];                                                       // typed text beats the button; empty = read from the irises
  const template = o.prompt || (eyes ? FLUX_EYES : FLUX_FACE);
  let text;
  if (eyes) {
    out.lc_rg_f_text = { class_type: "LightCraftEyePrompt", inputs: { image: [editId, 0], face_data: [editId, 14], template, colour }, _meta: { title: "Eye request (colour)" } };
    text = ["lc_rg_f_text", 0];
  } else text = template;
  out.lc_rg_pos = { class_type: "CLIPTextEncode", inputs: { clip: ["lc_rg_f_clip", 0], text }, _meta: { title: "Eyes / Face request" } };
  out.lc_rg_zero = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["lc_rg_pos", 0] }, _meta: { title: "Empty negative" } };
  out.lc_rg_soft = { class_type: "ImageScaleBy", inputs: { image: ["lc_rg_crop", 0], upscale_method: "area", scale_by: 0.3 }, _meta: { title: "Soft reference (small copy of the crop)" } };
  out.lc_rg_refl = { class_type: "VAEEncode", inputs: { pixels: ["lc_rg_soft", 0], vae: ["lc_rg_f_vae", 0] }, _meta: { title: "Reference" } };
  out.lc_rg_rp = { class_type: "ReferenceLatent", inputs: { conditioning: ["lc_rg_pos", 0], latent: ["lc_rg_refl", 0] }, _meta: { title: "Reference (positive)" } };
  out.lc_rg_rn = { class_type: "ReferenceLatent", inputs: { conditioning: ["lc_rg_zero", 0], latent: ["lc_rg_refl", 0] }, _meta: { title: "Reference (negative)" } };
  out.lc_rg_lat = { class_type: "VAEEncode", inputs: { pixels: ["lc_rg_crop", 0], vae: ["lc_rg_f_vae", 0] }, _meta: { title: "Eyes / Face start picture" } };
  out.lc_rg_ks = { class_type: "KSampler", inputs: { model: ["lc_rg_f_unet", 0], positive: ["lc_rg_rp", 0], negative: ["lc_rg_rn", 0], latent_image: ["lc_rg_lat", 0], seed: Math.floor(Math.random() * 4294967295), steps: o.steps, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: o.denoise }, _meta: { title: "Eyes / Face redraw (Flux 2 Klein)" } };
  out.lc_rg_dec = { class_type: "VAEDecode", inputs: { samples: ["lc_rg_ks", 0], vae: ["lc_rg_f_vae", 0] }, _meta: { title: "Eyes / Face decode" } };
  const named = eyes && (custom || preset[1]);                                              // a colour was asked for: do not pull it back toward the old colour
  out.lc_rg_paste = { class_type: "LightCraftRegionPaste", inputs: { image: [editId, 0], redrawn: ["lc_rg_dec", 0], region: ["lc_rg_crop", 1], feather: eyes ? 0.25 : 0.12, color_match: named ? 0.4 : 0.8 }, _meta: { title: "Eyes / Face paste back" } };
  return "lc_rg_paste";
}

const KREA_DESC = {
  eyes: "Close-up photograph of beautiful eyes with brows: clear glossy irises with fine radial detail and depth, bright crisp catchlights, smooth wet eye surface, clean white sclera, sharp defined eyeliner and individual lashes, smooth polished eyelids, soft studio light, clean sharp focus.",
  face: "Close-up portrait photograph of a face: sharp detailed eyes with catchlights, natural skin texture, defined lips and brows, individual eyelashes, realistic soft lighting, clean sharp focus.",
};
const KREA_NEG = "(worst quality, low quality, bad quality:1.3), embedding:ng_deepnegative_v1_75t, embedding:EasyNegative, embedding:badhandv4";
// Krea 2 redraw: the workflow's own Krea model chain, with ONLY the identity LoRA (the first in the stack) switched on, img2img from the crop
function injectKrea(out, editId, job, o) {
  const up = (l) => (isLink(l) ? out[l[0]] : null);
  const enhId = Object.keys(out).find((k) => /Krea2T/i.test(out[k].class_type || ""));
  const enh = enhId && out[enhId], loraId = enh && isLink(enh.inputs.model) ? String(enh.inputs.model[0]) : null, lora = loraId && out[loraId];
  const msaId = Object.keys(out).find((k) => out[k].class_type === "ModelSamplingAuraFlow" && isLink(out[k].inputs.model) && String(out[k].inputs.model[0]) === enhId), msa = msaId && out[msaId];
  if (!enh || !lora || !msa) throw new Error("Eyes / Face: could not find the Krea 2 model chain (Krea2T Enhancer, LoRA stack, ModelSamplingAuraFlow) in this workflow. Switch the engine to Qwen.");
  const li = { ...lora.inputs };
  for (const k of Object.keys(li)) if (/^lora_\d+$/.test(k) && li[k] && typeof li[k] === "object") li[k] = { ...li[k], on: k === "lora_1" };
  out.lc_rg_k_lora = { ...lora, inputs: li, _meta: { title: "Eyes / Face identity LoRA only" } };
  out.lc_rg_k_enh = { ...enh, inputs: { ...enh.inputs, model: ["lc_rg_k_lora", 0] } };
  out.lc_rg_k_msa = { ...msa, inputs: { ...msa.inputs, model: ["lc_rg_k_enh", 0] } };
  const clown = Object.keys(out).find((k) => /ClownsharKSampler/i.test(out[k].class_type || ""));
  const vdec = clown && Object.values(out).find((n) => n.class_type === "VAEDecode" && isLink(n.inputs.samples) && String(n.inputs.samples[0]) === clown);
  const vl = Object.keys(out).find((k) => out[k].class_type === "VAELoader" && /qwen_image_vae/i.test(String(out[k].inputs.vae_name || "")));
  const vae = vdec ? vdec.inputs.vae : vl ? [vl, 0] : null;
  if (!vae) throw new Error("Eyes / Face: could not find Krea's VAE. Switch the engine to Qwen.");
  const edit = out[editId];
  out.lc_rg_crop = { class_type: "LightCraftRegionCrop", inputs: { image: [editId, 0], face_data: [editId, 14], region: job.kind, size: o.size, margin: job.kind === "eyes" ? 0.35 : 0.15 }, _meta: { title: "Eyes / Face crop" } };
  out.lc_rg_pos = { class_type: "CLIPTextEncode", inputs: { clip: ["lc_rg_k_lora", 1], text: o.prompt || KREA_DESC[job.kind] }, _meta: { title: "Eyes / Face prompt" } };
  out.lc_rg_neg = { class_type: "CLIPTextEncode", inputs: { clip: ["lc_rg_k_lora", 1], text: KREA_NEG }, _meta: { title: "Eyes / Face negative" } };
  out.lc_rg_lat = { class_type: "VAEEncode", inputs: { pixels: ["lc_rg_crop", 0], vae }, _meta: { title: "Eyes / Face start picture" } };
  out.lc_rg_ks = { class_type: "KSampler", inputs: { model: ["lc_rg_k_msa", 0], positive: ["lc_rg_pos", 0], negative: ["lc_rg_neg", 0], latent_image: ["lc_rg_lat", 0], seed: Math.floor(Math.random() * 4294967295), steps: o.steps, cfg: 1, sampler_name: "euler", scheduler: "beta", denoise: o.denoise }, _meta: { title: "Eyes / Face redraw (Krea 2)" } };
  out.lc_rg_dec = { class_type: "VAEDecode", inputs: { samples: ["lc_rg_ks", 0], vae }, _meta: { title: "Eyes / Face decode" } };
  out.lc_rg_paste = { class_type: "LightCraftRegionPaste", inputs: { image: [editId, 0], redrawn: ["lc_rg_dec", 0], region: ["lc_rg_crop", 1], feather: job.kind === "eyes" ? 0.25 : 0.12, color_match: 0.8 }, _meta: { title: "Eyes / Face paste back" } };
  return "lc_rg_paste";
}

export async function regionRun(node, kind) {
  const K = node.__lcFace || (node.__lcFace = {});
  if (K.rgBusy) return;
  K.rgBusy = true; K.error = ""; K.status = kind === "eyes" ? "Redrawing the eyes…" : "Redrawing the face…"; node.setDirtyCanvas(true, true);
  JOBR = { node, kind };
  try { await app.queuePrompt(0, 1); }
  catch (e) { K.error = String(e.message || e); K.rgBusy = false; }
  finally { JOBR = null; }
  node.setDirtyCanvas(true, true);
}

// Before / after of the region, drawn in the Face panel so the change can be SEEN: the picture the pass started from vs what came back
const urlOf = (f, type) => api.apiURL(`/view?filename=${encodeURIComponent(f)}&type=${type || "temp"}&subfolder=&rand=${Math.random()}`);
function loadCmp(n, before, after, box, full) {
  const K = n.__lcFace, mk = (e) => { const i = new Image(); i.onload = () => n.setDirtyCanvas(true, true); i.src = urlOf(e.f, e.type); return i; };
  K.rgCmp = { b: mk(before), a: mk(after), box, full }; K.rgShow = true;
}
export const regionCompareH = (node) => (node.__lcFace && node.__lcFace.rgCmp ? 28 : 0);
export function drawRegionCompare(ctx, node, x, y, iw, hitFn) {
  const K = node.__lcFace; if (!K || !K.rgCmp) return 0;
  ctx.fillStyle = "#3a2a1c"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, iw, 22, 5) : ctx.rect(x, y, iw, 22); ctx.fill();
  ctx.strokeStyle = "#e0893f"; ctx.lineWidth = 1; ctx.stroke();
  ctx.font = "600 11.5px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#ffe7d1";
  ctx.fillText("Show before / after (big)", x + iw / 2, y + 11.5);
  hitFn("fp:rg:reopen", x, y, iw, 22, () => regionReopen(node));
  return 28;
}

// The big before / after: over the Face view, the region fills it. Wide strips (eyes) stack, squarish ones (face) sit side by side. Click anywhere to close.
export function drawRegionBig(ctx, node, vx, vy, vw, vh, hitFn) {
  const K = node.__lcFace, c = K && K.rgCmp; if (!c || !c.box || !K.rgShow) return;
  const [x0, y0, x1, y1] = c.box, bw = x1 - x0, bh = y1 - y0, asp = bw / bh, stack = asp > 1.6;
  ctx.save();
  ctx.fillStyle = "rgba(14,14,16,0.94)"; ctx.fillRect(vx, vy, vw, vh);
  const pad = 14, gap = 10, top = 30;
  const aw = vw - 2 * pad, ah = vh - top - pad;
  let cw, ch;
  if (stack) { cw = Math.min(aw, (ah - gap) / 2 * asp); ch = cw / asp; } else { ch = Math.min(ah, (aw - gap) / 2 / asp); cw = ch * asp; }
  const total = stack ? [cw, ch * 2 + gap] : [cw * 2 + gap, ch], ox = vx + (vw - total[0]) / 2, oy = vy + top + (ah - total[1]) / 2;
  ctx.font = "600 12px Inter, 'Segoe UI', sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = "#e0893f";
  ctx.fillText("What the pass changed (click anywhere to close)", vx + pad, vy + 15);
  ctx.imageSmoothingQuality = "high";
  [["Before", c.b], ["After", c.a]].forEach(([label, img], k) => {
    const rx = stack ? ox : ox + k * (cw + gap), ry = stack ? oy + k * (ch + gap) : oy;
    ctx.fillStyle = "#101012"; ctx.fillRect(rx, ry, cw, ch);
    if (img && img.complete && img.naturalWidth) {
      const sx = img.naturalWidth / (c.full ? c.full[0] : img.naturalWidth), sy = img.naturalHeight / (c.full ? c.full[1] : img.naturalHeight);
      ctx.drawImage(img, x0 * sx, y0 * sy, bw * sx, bh * sy, rx, ry, cw, ch);
    }
    ctx.font = "700 13px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 5;
    ctx.fillText(label, rx + 8, ry + 14); ctx.shadowBlur = 0;
  });
  ctx.restore();
  hitFn("fp:rg:big", vx, vy, vw, vh, () => { K.rgShow = false; node.setDirtyCanvas(true, true); });
}
export function regionReopen(node) { const K = node.__lcFace; if (K && K.rgCmp) { K.rgShow = true; node.setDirtyCanvas(true, true); } }

function gotResult(im) {
  let hit = false;
  for (const n of (app.graph && app.graph._nodes) || []) {
    const K = n.__lcFace;
    if (!K || !K.rgBusy) continue;
    hit = true; K.rgBusy = false; K.status = "Done: added to History."; K.error = "";
    const hl = (n.properties && n.properties.lc_history) || [], cur = hl.find((e) => e.f === (n.properties && n.properties.lc_hist_cur)) || hl[hl.length - 1];
    if (cur && im.box) loadCmp(n, cur, { f: im.filename, type: im.type }, im.box, im.full);
    if (addHist) addHist(n, { f: im.filename, type: im.type || "temp", w: im.w, h: im.h, t: Date.now(), label: "Edit", note: "Eyes / Face" });
    n.setDirtyCanvas(true, true);
  }
  return hit;
}
api.addEventListener("executed", (ev) => {
  const d = ev && ev.detail, o = d && d.output;
  const im = o && ((o.lc_region && o.lc_region[0]) || (o.images && o.images.find((x) => /^lc_hist_/.test(x.filename || ""))));
  if (im) gotResult(im);
});
// safety net: if the run finished but the picture never arrived by event, read it from ComfyUI's history (the paste node's thumbnail)
api.addEventListener("execution_success", () => {
  setTimeout(async () => {
    if (!((app.graph && app.graph._nodes) || []).some((n) => n.__lcFace && n.__lcFace.rgBusy)) return;
    try {
      const r = await api.fetchApi("/history?max_items=1"), h = await r.json(), last = Object.values(h)[0];
      const o = last && last.outputs && last.outputs.lc_rg_paste, im = o && o.images && o.images[0];
      if (im && gotResult({ filename: im.filename, type: im.type, w: 0, h: 0 })) return;
    } catch (e) { /* fall through */ }
    for (const n of (app.graph && app.graph._nodes) || []) if (n.__lcFace && n.__lcFace.rgBusy) { n.__lcFace.rgBusy = false; n.__lcFace.error = "The run finished but no picture came back. Check the ComfyUI console for [LightCraft] lines."; n.setDirtyCanvas(true, true); }
  }, 1500);
});
api.addEventListener("execution_error", () => {
  for (const n of (app.graph && app.graph._nodes) || []) if (n.__lcFace && n.__lcFace.rgBusy) { n.__lcFace.rgBusy = false; n.__lcFace.error = "The redraw failed. See the ComfyUI console."; n.setDirtyCanvas(true, true); }
});
