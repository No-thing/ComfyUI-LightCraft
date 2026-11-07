import { app } from "../../scripts/app.js";

// No_Thing brand lettering: Audiowide for the big name, Montserrat Alternates for everything you read and click.
// The two font files ship in ./fonts (both SIL Open Font License, see the OFL files there); without them the stacks fall back to system fonts.
export const DISPLAY = `Audiowide, "Roboto Slab", Georgia, serif`;
export const UI = `"Montserrat Alternates", Inter, "Segoe UI", sans-serif`;

let asked = false;
export function loadBrandFonts() {
  if (asked || typeof document === "undefined" || typeof FontFace === "undefined") return;
  asked = true;
  [["Audiowide", "./fonts/Audiowide-Regular.ttf", "400"], ["Montserrat Alternates", "./fonts/MontserratAlternates-Light.ttf", "300 700"], ["Montserrat Alternates Bold", "./fonts/MontserratAlternates-Light.ttf", "700"]].forEach(([family, rel, weight]) => {   // "Montserrat Alternates Bold" = the bold weight under its own name, so a plain label (which cannot pick a weight) can ask for it
    try {
      const f = new FontFace(family, `url(${new URL(rel, import.meta.url).href})`, { weight });
      f.load().then(() => { document.fonts.add(f); if (app.graph) app.graph.setDirtyCanvas(true, true); }).catch(() => { /* fonts are cosmetic */ });
    } catch (e) { /* fonts are cosmetic */ }
  });
}
