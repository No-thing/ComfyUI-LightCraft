import { app } from "../../scripts/app.js";

// Mouse handling shared by all LightCraft nodes.
//
// Why this exists: ComfyUI / LiteGraph handle clicks on widgets themselves, *before* a node's
// onMouseDown runs. For number widgets that means the stock drag (a tenth of a step per pixel)
// won, which is why custom sliders felt slow and never followed the mouse. Here we listen on the
// window in the capture phase, claim the click when it lands on one of our registered regions,
// and stop LiteGraph from ever seeing it.
//
// Drags are tracked by pointer *delta* (client pixels / canvas zoom), so the result does not
// depend on any canvas-offset conversion, and updates are batched to one per animation frame.

const CLASSES = new Set(["LightCraftDevelop", "LightCraftGrade", "LightCraftFX", "LightCraftGrain", "LightCraftLens", "LightCraftCrop", "LightCraftColor", "LightCraftScope", "LightCraftWatermark"]);

export const zoom = () => (app.canvas && app.canvas.ds && app.canvas.ds.scale) || 1;

// ---- regions -------------------------------------------------------------------------------
// Registered while a node draws (node-local coordinates, same space as widget y). Keyed by id,
// so re-registering every frame just updates the rectangle.
export function hit(node, id, x, y, w, h, fn, cursor, hover) {
  const map = node.__lcHits || (node.__lcHits = new Map());
  map.set(id, { id, x, y, w, h, fn, cursor, hover });
}

function graphPoint(ev) {
  const c = app.canvas;
  if (c.convertEventToCanvasOffset) {
    const p = c.convertEventToCanvasOffset(ev);
    return [p[0], p[1]];
  }
  const r = c.canvas.getBoundingClientRect();
  return [(ev.clientX - r.left) / c.ds.scale - c.ds.offset[0], (ev.clientY - r.top) / c.ds.scale - c.ds.offset[1]];
}

function currentNodes() {
  const g = (app.canvas && app.canvas.graph) || app.graph;
  return (g && (g._nodes || g.nodes)) || [];
}

function nodeAt(ev) {
  const nodes = currentNodes();
  const p = graphPoint(ev);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const x = p[0] - n.pos[0], y = p[1] - n.pos[1];
    if (x < 0 || y < 0 || x > n.size[0] || y > n.size[1]) continue;
    // topmost node under the pointer decides; if it is not ours, leave the click alone
    if (!CLASSES.has(n.comfyClass || n.type) || (n.flags && n.flags.collapsed)) return null;
    return { node: n, pos: [x, y] };
  }
  return null;
}

function findHit(node, pos) {
  const map = node.__lcHits;
  if (!map) return null;
  const list = Array.from(map.values());
  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i];
    if (pos[0] >= h.x && pos[0] <= h.x + h.w && pos[1] >= h.y && pos[1] <= h.y + h.h) return h;
  }
  return null;
}

function canInteract(ev, allowLow = false) {
  const c = app.canvas;
  return c && c.canvas && ev.target === c.canvas && (allowLow || !c.low_quality) && !c.read_only && !ev.ctrlKey && !ev.metaKey;
}

// LiteGraph's menus close on a click elsewhere, but we swallow our clicks, so close them ourselves
function closeMenus() {
  try { if (window.LiteGraph && window.LiteGraph.closeAllContextMenus) window.LiteGraph.closeAllContextMenus(); } catch (e) { /* ignore */ }
}

function selectNode(node) {
  const c = app.canvas;
  try {
    if (node.is_selected || node.selected) return;
    if (c.deselectAll) c.deselectAll();
    if (c.select) c.select(node); else if (c.selectNode) c.selectNode(node);
  } catch (e) { /* selection is cosmetic */ }
}

// ---- drags ---------------------------------------------------------------------------------
// onMove(dx, dy, ev): dx/dy are in node units (client pixels / zoom) since the press.
export function drag({ node, ev, cursor, onMove, onUp }) {
  const el = app.canvas.canvas;
  const sx = ev.clientX, sy = ev.clientY;
  let last = null, scheduled = false, finished = false;
  node.__lcDragging = true;
  if (cursor) el.style.cursor = cursor;
  try { if (ev.pointerId !== undefined && el.setPointerCapture) el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }

  const flush = () => {
    scheduled = false;
    if (!last) return;
    const e = last; last = null;
    const z = zoom();
    onMove((e.clientX - sx) / z, (e.clientY - sy) / z, e);
    if (cursor) el.style.cursor = cursor;
    node.setDirtyCanvas(true, true);
  };
  const move = (e) => {
    if (e.preventDefault) e.preventDefault();
    last = e;
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  const up = (e) => {
    if (finished) return;
    finished = true;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    try { if (ev.pointerId !== undefined && el.releasePointerCapture) el.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
    if (last) flush();
    node.__lcDragging = false;
    if (onUp) onUp(e);
    if (app.graph && app.graph.change) app.graph.change();
    node.setDirtyCanvas(true, true);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}

// ---- window-level listeners ------------------------------------------------------------------
function onDown(ev) {
  window.dispatchEvent(new Event("lc-close-menus"));          // an open preset menu closes on ANY click, even one this canvas layer swallows below
  if (ev.button !== undefined && ev.button !== 0) return;
  if (!canInteract(ev, true)) return;
  const at = nodeAt(ev);
  if (!at) return;
  const { node, pos } = at;
  if (pos[0] > node.size[0] - 14 && pos[1] > node.size[1] - 14) return;       // resize corner stays native
  const h = findHit(node, pos);
  if (!h) { closeMenus(); return; }
  // zoomed far out LiteGraph draws a simplified node: only the tab buttons stay live, the rest is a plain node you can drag
  if (app.canvas.low_quality && !String(h.id).startsWith("ed:tab:")) return;
  closeMenus();
  // claim the click before LiteGraph sees it
  ev.preventDefault();
  ev.stopImmediatePropagation();
  ev.stopPropagation();
  selectNode(node);
  h.fn({ ev, pos, node });
}

let hoverNode = null;
function onHover(ev) {
  if (ev.buttons) return;
  if (!canInteract(ev)) return;
  const at = nodeAt(ev);
  let cursor = null;
  if (at) {
    const h = findHit(at.node, at.pos);
    if (h) cursor = (h.hover ? h.hover(at.pos, at.node) : null) || h.cursor || null;
    at.node.__lcPointer = at.pos;
    const T = at.node.__lcTip;                                              // tab tips need a redraw when the pointer moves on / off a tab
    if (T && (T.p > 0.001 || T.hov || (h && (String(h.id).startsWith("ed:tab:") || h.id === "ed:full")))) at.node.setDirtyCanvas(true, false);
  }
  if (hoverNode && (!at || at.node !== hoverNode) && hoverNode.__lcHoverOut) hoverNode.__lcHoverOut();
  hoverNode = at ? at.node : null;
  if (cursor) {
    const el = app.canvas.canvas;
    requestAnimationFrame(() => { el.style.cursor = cursor; });   // after LiteGraph's own cursor update
  }
}

// ---- mouse wheel over a scrollable area (the canvas would zoom instead)
export function wheelZone(node, id, x, y, w, h, fn) {
  const map = node.__lcWheel || (node.__lcWheel = new Map());
  map.set(id, { x, y, w, h, fn });
}

function onWheel(ev) {
  if (!canInteract(ev)) return;
  const at = nodeAt(ev);
  if (!at || !at.node.__lcWheel) return;
  for (const z of Array.from(at.node.__lcWheel.values()).reverse()) {
    if (at.pos[0] >= z.x && at.pos[0] <= z.x + z.w && at.pos[1] >= z.y && at.pos[1] <= z.y + z.h) {
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      z.fn(ev.deltaY, at.pos);
      return;
    }
  }
}

// ---- file drops ----------------------------------------------------------------------------
// Zones registered while a node draws, like hit regions. ComfyUI would otherwise turn a dropped
// picture into a new Load Image node; over one of our zones we take it first.
export function dropZone(node, id, x, y, w, h, fn) {
  const map = node.__lcDrops || (node.__lcDrops = new Map());
  map.set(id, { x, y, w, h, fn });
}

function dropAt(ev) {
  const at = nodeAt(ev);
  if (!at || !at.node.__lcDrops) return null;
  const list = Array.from(at.node.__lcDrops.entries());
  for (let i = list.length - 1; i >= 0; i--) {
    const [id, z] = list[i];
    if (at.pos[0] >= z.x && at.pos[0] <= z.x + z.w && at.pos[1] >= z.y && at.pos[1] <= z.y + z.h) return { node: at.node, id, zone: z };
  }
  return null;
}

const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");

function clearHot(except) {
  for (const n of currentNodes()) if (n.__lcDropHot && n !== except) { n.__lcDropHot = null; n.setDirtyCanvas(true, false); }
}

function onDragOver(ev) {
  if (!hasFiles(ev) || !canInteract(ev)) return;
  const d = dropAt(ev);
  if (!d) { clearHot(null); return; }
  ev.preventDefault();
  ev.stopImmediatePropagation();
  try { ev.dataTransfer.dropEffect = "copy"; } catch (e) { /* ignore */ }
  if (d.node.__lcDropHot !== d.id) { d.node.__lcDropHot = d.id; d.node.setDirtyCanvas(true, false); }
  clearHot(d.node);
}

function onDrop(ev) {
  if (!hasFiles(ev) || !canInteract(ev)) return;
  const d = dropAt(ev);
  clearHot(null);
  if (!d) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  ev.stopPropagation();
  d.zone.fn(Array.from(ev.dataTransfer.files || []), ev);
}

let installed = false;
export function install() {
  if (installed) return;
  installed = true;
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onHover, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("dragleave", () => clearHot(null), true);
}
install();
