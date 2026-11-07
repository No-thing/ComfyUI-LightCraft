import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Roll lock: while you reshape a face (or anything else) the picture must not change underneath you.
// Opening the Face tab freezes the dice of the No_Thing roulette nodes on the exact seeds that made the picture you are
// looking at, so the next run is identical upstream and ComfyUI reuses its cache (no new outfit, no new face, no Krea render).
// Going back to the Compare tab (or clicking the lock chip) gives the dice back, set up for a fresh roll.
//
//   lock:    seed := the seed that made the shown picture (the roulettes report it), seed control := "fixed"
//   unlock:  the old seed control is restored; "increment" starts one past the locked seed, "randomize" gets a fresh seed
//
// The old settings are kept in each roulette's properties (nt_prev), so a saved workflow stays locked and can still be unlocked.

const ROULETTES = new Set(["NoThingOutfitRoulette", "NoThingUnderwearRoulette", "NoThingMakeupRoulette", "NoThingBodyRoulette", "NoThingHeadRoulette", "NoThingFaceRoulette", "NoThingHairRoulette", "NoThingRouletteBar"]);
const lastSeed = new Map();                                                 // node id -> the seed it used in its last run

api.addEventListener("executed", (ev) => {
  const d = ev && ev.detail, s = d && d.output && d.output.nt_seed;
  if (s && s.length) lastSeed.set(String(d.node), Number(s[0]));
});

const roulettes = () => ((app.graph && (app.graph._nodes || app.graph.nodes)) || []).filter((n) => ROULETTES.has(n.comfyClass || n.type));

function seedWidgets(n) {
  const ws = n.widgets || [];
  const sw = ws.find((w) => w.name === "seed");
  const cw = ws.find((w) => w.name === "control_after_generate") || (sw && ((sw.linkedWidgets && sw.linkedWidgets[0]) || sw.controlWidget)) || null;
  return { sw, cw };
}

export const rollLocked = () => roulettes().some((n) => n.properties && n.properties.nt_prev);

export function lockRoll() {
  let count = 0;
  for (const n of roulettes()) {
    const { sw, cw } = seedWidgets(n);
    if (!sw || !cw || (n.properties && n.properties.nt_prev)) continue;
    const mode = String(cw.value);
    let seed = Number(sw.value) || 0;
    const ran = lastSeed.get(String(n.id));
    if (ran !== undefined) seed = ran;                                      // the seed that made the picture on screen
    else if (mode === "increment") seed = Math.max(0, seed - 1);            // not run this session: "increment" has already stepped past it
    else if (mode === "decrement") seed += 1;
    n.properties = n.properties || {};
    n.properties.nt_prev = { control: mode, seed: Number(sw.value) || 0 };
    sw.value = seed; cw.value = "fixed";
    n.setDirtyCanvas(true, true);
    count++;
  }
  if (count && app.graph && app.graph.change) app.graph.change();
  return count;
}

export function rollAll() {                                                 // new seeds for every roulette: unlock first, then every node gets a fresh seed
  unlockRoll();
  let count = 0;
  for (const n of roulettes()) {
    const { sw } = seedWidgets(n);
    if (!sw) continue;
    sw.value = Math.floor(Math.random() * 4294967296);
    if (sw.callback) { try { sw.callback(sw.value); } catch (e) { /* ignore */ } }
    n.setDirtyCanvas(true, true);
    count++;
  }
  if (count && app.graph && app.graph.change) app.graph.change();
  return count;
}

export function unlockRoll() {
  let count = 0;
  for (const n of roulettes()) {
    const prev = n.properties && n.properties.nt_prev;
    if (!prev) continue;
    const { sw, cw } = seedWidgets(n);
    if (sw && cw) {
      const locked = Number(sw.value) || 0;
      cw.value = prev.control;
      if (prev.control === "increment") sw.value = locked + 1;
      else if (prev.control === "decrement") sw.value = Math.max(0, locked - 1);
      else if (prev.control === "randomize") sw.value = Math.floor(Math.random() * 4294967296);
      else sw.value = prev.seed;                                            // "fixed" before: back to the seed it had
    }
    delete n.properties.nt_prev;
    n.setDirtyCanvas(true, true);
    count++;
  }
  if (count && app.graph && app.graph.change) app.graph.change();
  return count;
}
