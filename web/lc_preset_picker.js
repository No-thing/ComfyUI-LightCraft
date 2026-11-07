// A searchable, categorised preset picker (replaces the flat LiteGraph context menu on the Color node and the Edit Page).
// Type to filter, arrow keys + Enter to pick, Esc or a click outside to close. Categories are worked out from the preset
// names here, so presets.json stays a plain list.

const ORANGE = "#ff8a2a";

const CATS = {
  LightCraftGrade: [
    ["Classic Hollywood", /Technicolor|Silver Screen|Casablanca|Golden Age|Western Sunset|Epic 70mm|Hitchcock|Film Noir|Noir High/],
    ["Film stocks", /Portra|Velvia|Gold 200|Tungsten 800|Green Film|Kodachrome|Vision3|Eterna|Ektachrome|Print 2383|Cinestill|Agfa|Polaroid|Cross Process|Bleach/],
    ["Black & white", /B&W|Mono|Sepia|Selenium/],
    ["Cinematic", /Teal|Blockbuster|Day for Night|Night City|Hazy Replicant|Moonlight|Moody|Matrix|Amber Whiskey|Emerald/],
    ["Retro & neon", /Vintage|VHS|Lo-Fi|Cyberpunk|Vaporwave|Synthwave/],
    ["Portrait & clean", /Skin|Fashion|Clean|Rose Gold|HDR|Muted Earth|Faded Matte/],
    ["Seasons & places", /Golden Hour|Warm Sunset|Autumn|Winter|Summer|Tropical|Desert|Forest|Ocean|Pastel|Storybook/],
  ],
  LightCraftFX: [
    ["Lens & flare", /Anamorphic|Bokeh/],
    ["Comic & glitch", /Halftone|Screentone|Spider|Pop Art|Pixel/],
    ["Film damage", /Dust|Leak|Expired|Projector/],
    ["Glow & halation", /Glow|Halation|Bloom|Dreamy|Diffusion|Soft Portrait|Clean Soft/],
    ["Old TV & VHS", /TV|CRT|VHS|Camcorder|Analog|Antenna|Phosphor|Terminal|Arcade|Security|Tape|Glitch/],
    ["Classic film", /Technicolor|Widescreen|Old Hollywood|Silver Screen|Golden Age|Print|Cinestill|Magic Hour|Disposable|Lomo|Instant/],
    ["Colour & mood", /Pop|Fade|Mono|Rosy|Hazy|Chrome|Cross|Moody|Blue Hour|Sharp|Fisheye/],
  ],
  LightCraftGrain: [
    ["Fine", /^(Ultra )?Fine|Soft Silver/],
    ["Film stocks", /Kodak|Vision3|Kodachrome|Print Grain|Classic Film|16mm|Super 8|Golden Age|Double-X|Tri-X|Disposable/],
    ["Heavy & gritty", /Heavy|Gritty/],
    ["Digital", /Digital/],
  ],
  LightCraftLens: [
    ["Standard & prime", /^(55|50|35|85|135)mm/],
    ["Wide", /^(28|24|16|12)mm|Phone|Action|GoPro Wide|Webcam/],
    ["Fisheye & odd", /Fisheye|Circular|Peephole|Mirror/],
    ["Vintage & cheap", /Vintage|Cheap|Disposable|Pincushion/],
  ],
};

function categorise(cls, names) {
  const rules = CATS[cls] || [];
  const groups = new Map();
  for (const n of names) {
    const hit = rules.find(([, re]) => re.test(n));
    const cat = hit ? hit[0] : "Other";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(n);
  }
  const order = [...rules.map((r) => r[0]), "Other"];
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

const EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";                 // ease-out-expo: the same curve as the brand motion
let open = null;
const EVENTS = ["pointerdown", "mousedown", "wheel", "contextmenu"];
function close(fast) {
  const el = open;
  if (!el) return;
  open = null;
  EVENTS.forEach((n) => window.removeEventListener(n, onDoc, true));
  window.removeEventListener("blur", onBlur); window.removeEventListener("resize", onBlur);
  document.removeEventListener("keydown", onKey, true);
  el.style.transition = "opacity 140ms ease-out, transform 140ms ease-out";
  el.style.opacity = "0"; el.style.transform = "translateY(-4px) scale(.98)";
  setTimeout(() => el.remove(), fast ? 0 : 150);
}
// pointerdown, not just mousedown: the canvas cancels the compatibility mouse events, which is why the old menu only closed when you picked something
function onDoc(e) { if (open && !open.contains(e.target)) close(); }
function onBlur() { close(true); }
window.addEventListener("lc-close-menus", () => close());
function onKey(e) { if (e.key === "Escape") close(); }

export function pickPreset({ event, cls, none, names, current, onPick }) {
  close();
  const el = document.createElement("div");
  Object.assign(el.style, {
    opacity: "0", transform: "translateY(-10px) scale(.94)", transformOrigin: "top left", willChange: "transform, opacity",
    position: "fixed", zIndex: 100000, width: "260px", maxHeight: "min(70vh, 520px)", display: "flex", flexDirection: "column",
    background: "#232323", border: "1px solid #3a3a3a", borderRadius: "8px", boxShadow: "0 10px 30px rgba(0,0,0,.55)",
    font: "12px 'Montserrat Alternates', system-ui, sans-serif", color: "#d8d8d8", overflow: "hidden",
  });
  const input = document.createElement("input");
  input.placeholder = "Search…  (" + names.length + " presets)";
  Object.assign(input.style, { margin: "8px", padding: "7px 9px", background: "#161616", border: "1px solid #3a3a3a", borderRadius: "6px", color: "#eee", font: "inherit", outline: "none" });
  const list = document.createElement("div");
  Object.assign(list.style, { overflowY: "auto", padding: "0 6px 8px" });
  el.append(input, list);

  let flat = [], sel = 0;
  const choose = (v) => { close(); onPick(v); };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    list.textContent = ""; flat = [];
    const add = (label, v, dim) => {
      const row = document.createElement("div");
      row.textContent = label;
      Object.assign(row.style, { padding: "5px 8px", borderRadius: "5px", cursor: "pointer", color: dim ? "#8a8a8a" : (v === current ? ORANGE : "#e6e6e6") });
      const i = flat.length; flat.push({ v, row });
      row.onmouseenter = () => { sel = i; paint(); };
      row.onclick = () => choose(v);
      list.append(row);
    };
    if (!q) add("None", none, true);
    for (const [cat, items] of categorise(cls, names)) {
      const shown = items.filter((n) => !q || n.toLowerCase().includes(q) || cat.toLowerCase().includes(q));
      if (!shown.length) continue;
      const h = document.createElement("div");
      h.textContent = cat.toUpperCase();
      Object.assign(h.style, { padding: "9px 8px 3px", fontSize: "10px", letterSpacing: ".08em", color: ORANGE, opacity: ".85" });
      list.append(h);
      shown.forEach((n) => add(n, n));
    }
    if (!flat.length) { const e = document.createElement("div"); e.textContent = "No preset matches"; e.style.cssText = "padding:10px 8px;color:#777"; list.append(e); }
    sel = Math.max(0, flat.findIndex((f) => f.v === current && !q)); if (q) sel = 0;
    paint(true);
  };
  const paint = (scroll) => {
    flat.forEach((f, i) => { f.row.style.background = i === sel ? "#3a3a3a" : "transparent"; });
    if (scroll && flat[sel]) flat[sel].row.scrollIntoView({ block: "center" });
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(flat.length - 1, sel + 1); paint(); flat[sel] && flat[sel].row.scrollIntoView({ block: "nearest" }); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); paint(); flat[sel] && flat[sel].row.scrollIntoView({ block: "nearest" }); e.preventDefault(); }
    else if (e.key === "Enter") { if (flat[sel]) choose(flat[sel].v); }
    e.stopPropagation();
  });

  document.body.append(el);
  const ev = event || {}, vw = window.innerWidth, vh = window.innerHeight;
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min((ev.clientX ?? 100) - 20, vw - r.width - 8)) + "px";
  el.style.top = Math.max(8, Math.min((ev.clientY ?? 100) - 10, vh - r.height - 8)) + "px";
  open = el;
  EVENTS.forEach((n) => window.addEventListener(n, onDoc, true));
  window.addEventListener("blur", onBlur); window.addEventListener("resize", onBlur);
  document.addEventListener("keydown", onKey, true);
  render();
  input.focus();
  requestAnimationFrame(() => {                                    // open with an expo ease-out; rows follow one after another
    el.style.transition = "opacity 260ms " + EXPO + ", transform 520ms " + EXPO;
    el.style.opacity = "1"; el.style.transform = "none";
    flat.slice(0, 16).forEach((f, i) => {
      f.row.style.opacity = "0"; f.row.style.transform = "translateY(8px)";
      f.row.style.transition = "opacity 300ms " + EXPO + " " + (i * 14) + "ms, transform 560ms " + EXPO + " " + (i * 14) + "ms";
      requestAnimationFrame(() => { f.row.style.opacity = "1"; f.row.style.transform = "none"; });
    });
  });
}
