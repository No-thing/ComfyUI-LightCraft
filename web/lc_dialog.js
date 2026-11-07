import { app } from "../../scripts/app.js";
import { DISPLAY, UI, loadBrandFonts } from "./lc_brand.js";

// No_Thing styled confirm box (OK / Cancel / "don't show again"). Slides in and out softly, no hard cuts.
// The "don't show again" choice lives in ComfyUI's own settings (cog menu > LightCraft), so it can always be switched back on.
export const SETTING_UNSAVED = "LightCraft.WarnUnsavedEdits";
const EASE = "cubic-bezier(.16,1,.3,1)";                                             // expo-out: fast start, long soft landing

export function settingOn(id, dflt = true) {
  try { const v = app.ui.settings.getSettingValue(id); return v === undefined ? dflt : !!v; } catch (e) { return dflt; }
}
function setSetting(id, v) { try { app.ui.settings.setSettingValue(id, v); } catch (e) { /* the box still works without it */ } }

let styled = false;
function css() {
  if (styled) return; styled = true;
  const s = document.createElement("style");
  s.textContent = `
.lcdlg-back{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(10,10,12,0);backdrop-filter:blur(0px);transition:background .38s ${EASE},backdrop-filter .38s ${EASE}}
.lcdlg-back.in{background:rgba(10,10,12,.58);backdrop-filter:blur(3px)}
.lcdlg{width:min(460px,90vw);box-sizing:border-box;padding:26px 28px 22px;border-radius:16px;background:linear-gradient(180deg,#1d1d20,#151518);border:1px solid #383838;
 box-shadow:0 24px 70px rgba(0,0,0,.65),0 0 0 1px rgba(224,137,63,.14);color:#eae5dc;font-family:${UI};opacity:0;transform:translateY(26px) scale(.965);transition:opacity .34s ${EASE},transform .46s ${EASE}}
.lcdlg-back.in .lcdlg{opacity:1;transform:none}
.lcdlg h2{margin:0 0 10px;font:400 26px ${DISPLAY};color:#e0893f;text-shadow:0 2px 8px rgba(0,0,0,.6);letter-spacing:.3px}
.lcdlg p{margin:0 0 18px;font:700 14px/1.5 ${UI};color:#eae5dc;text-shadow:0 1px 5px rgba(0,0,0,.7);overflow-wrap:anywhere}
.lcdlg label{display:flex;align-items:center;gap:9px;margin:0 0 20px;font:700 12.5px ${UI};color:#b9b3a8;text-shadow:0 1px 4px rgba(0,0,0,.6);cursor:pointer;user-select:none}
.lcdlg input{accent-color:#e0893f;width:16px;height:16px;margin:0;cursor:pointer}
.lcdlg .row{display:flex;gap:10px;justify-content:flex-end}
.lcdlg button{font:700 13.5px ${UI};padding:9px 20px;border-radius:9px;cursor:pointer;border:1px solid #444;background:#2b2b2b;color:#eae5dc;text-shadow:0 1px 4px rgba(0,0,0,.6);transition:transform .22s ${EASE},background .22s,border-color .22s}
.lcdlg button:hover{background:#383838;transform:translateY(-1px)}
.lcdlg button.ok{background:#e0893f;border-color:#e0893f;color:#1d1d1d;text-shadow:none}
.lcdlg button.ok:hover{background:#eb9a52}`;
  document.head.appendChild(s);
}

// -> Promise<boolean>: true = OK. opts: title, text, ok, cancel, settingId (the box offers "don't show again" and turns that setting off)
export function confirmBox({ title, text, ok = "OK", cancel = "Cancel", settingId = null }) {
  css(); try { loadBrandFonts(); } catch (e) { /* fonts fall back */ }
  return new Promise((resolve) => {
    const back = document.createElement("div"); back.className = "lcdlg-back";
    const box = document.createElement("div"); box.className = "lcdlg"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    const h = document.createElement("h2"); h.textContent = title;
    const p = document.createElement("p"); p.textContent = text;
    box.append(h, p);
    let chk = null;
    if (settingId) {
      const l = document.createElement("label"); chk = document.createElement("input"); chk.type = "checkbox";
      l.append(chk, document.createTextNode("Don't show this again (turn it back on in Settings > LightCraft)")); box.append(l);
    }
    const row = document.createElement("div"); row.className = "row";
    const bc = document.createElement("button"); bc.textContent = cancel;
    const bo = document.createElement("button"); bo.textContent = ok; bo.className = "ok";
    row.append(bc, bo); box.append(row); back.append(box); document.body.appendChild(back);
    let done = false;
    const close = (val) => {
      if (done) return; done = true;
      document.removeEventListener("keydown", key, true);
      if (val && chk && chk.checked) setSetting(settingId, false);
      back.classList.remove("in");
      setTimeout(() => { back.remove(); resolve(val); }, 420);                         // let the slide-out finish before handing control back
    };
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(true); }
    };
    document.addEventListener("keydown", key, true);
    bo.onclick = () => close(true); bc.onclick = () => close(false);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(false); });
    requestAnimationFrame(() => requestAnimationFrame(() => { back.classList.add("in"); bo.focus(); }));
  });
}

app.registerExtension({
  name: "LightCraft.Dialog",
  settings: [{ id: SETTING_UNSAVED, category: ["LightCraft", "Edit Page", "Warn about unsaved edits"], name: "Warn before replacing unsaved edits", type: "boolean", defaultValue: true,
    tooltip: "When you open another picture while the current edit is not saved, ask first." }],
});
