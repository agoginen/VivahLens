import { HSL_COLORS, type EditRecipe, type HslColor, type RecipeAdjustments } from "@vivahlens/core";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Camera Raw settings from an XMP packet: attribute form (`crs:Key="v"`) and simple element form (`<crs:Key>v</crs:Key>`). */
export function readCrsSettings(xmp: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xmp.matchAll(/\bcrs:([A-Za-z0-9]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  for (const m of xmp.matchAll(/<crs:([A-Za-z0-9]+)>([^<]*)<\/crs:\1>/g)) out[m[1]!] ??= m[2]!.trim();
  return out;
}

/**
 * Reverse of `compileToCrsSettings`: turns a finished Lightroom/Camera Raw edit into an EditRecipe, so a style
 * can be learned from the photographer's own numbers instead of an LLM's guess. Values are clamped to the recipe
 * ranges. As-shot white balance is skipped because it describes the scene, not the photographer's style.
 */
export function parseCrsToRecipe(xmp: string): EditRecipe | undefined {
  const s = readCrsSettings(xmp);
  if (s.HasSettings === undefined && !Object.keys(s).some((k) => k.endsWith("2012"))) return undefined;

  const num = (key: string): number | undefined => {
    const raw = s[key];
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const adj: RecipeAdjustments = {};
  const set = <K extends keyof RecipeAdjustments>(k: K, v: RecipeAdjustments[K] | undefined) => {
    if (v !== undefined) adj[k] = v;
  };
  const slider = (key: string) => {
    const n = num(key);
    return n === undefined ? undefined : clamp(n, -100, 100);
  };

  const exposure = num("Exposure2012");
  set("exposure", exposure === undefined ? undefined : clamp(exposure, -5, 5));
  set("contrast", slider("Contrast2012"));
  set("highlights", slider("Highlights2012"));
  set("shadows", slider("Shadows2012"));
  set("whites", slider("Whites2012"));
  set("blacks", slider("Blacks2012"));
  set("vibrance", slider("Vibrance"));
  set("saturation", slider("Saturation"));

  if (s.WhiteBalance === "Custom") {
    const temp = num("Temperature");
    const tint = num("Tint");
    const wb: NonNullable<RecipeAdjustments["whiteBalance"]> = {};
    if (temp !== undefined) wb.tempK = clamp(temp, 2000, 50000);
    if (tint !== undefined) wb.tint = clamp(tint, -150, 150);
    if (Object.keys(wb).length) adj.whiteBalance = wb;
  }

  const hsl: Partial<Record<HslColor, { hue?: number; saturation?: number; luminance?: number }>> = {};
  for (const color of HSL_COLORS) {
    const name = color[0]!.toUpperCase() + color.slice(1);
    const hue = slider(`HueAdjustment${name}`);
    const sat = slider(`SaturationAdjustment${name}`);
    const lum = slider(`LuminanceAdjustment${name}`);
    if (hue !== undefined || sat !== undefined || lum !== undefined) {
      hsl[color] = { ...(hue !== undefined && { hue }), ...(sat !== undefined && { saturation: sat }), ...(lum !== undefined && { luminance: lum }) };
    }
  }
  if (Object.keys(hsl).length) adj.hsl = hsl;

  const st: NonNullable<RecipeAdjustments["splitToning"]> = {};
  const hh = num("SplitToningHighlightHue");
  const hs = num("SplitToningHighlightSaturation");
  const sh = num("SplitToningShadowHue");
  const ss = num("SplitToningShadowSaturation");
  const bal = num("SplitToningBalance");
  if (hh !== undefined) st.highlightHue = clamp(hh, 0, 360);
  if (hs !== undefined) st.highlightSaturation = clamp(hs, 0, 100);
  if (sh !== undefined) st.shadowHue = clamp(sh, 0, 360);
  if (ss !== undefined) st.shadowSaturation = clamp(ss, 0, 100);
  if (bal !== undefined) st.balance = clamp(bal, -100, 100);
  if (Object.keys(st).length) adj.splitToning = st;

  const nrL = num("LuminanceSmoothing");
  const nrC = num("ColorNoiseReduction");
  if (nrL !== undefined || nrC !== undefined) {
    adj.noiseReduction = { ...(nrL !== undefined && { luminance: clamp(nrL, 0, 100) }), ...(nrC !== undefined && { color: clamp(nrC, 0, 100) }) };
  }
  const amount = num("Sharpness");
  const radius = num("SharpenRadius");
  if (amount !== undefined || radius !== undefined) {
    adj.sharpening = { ...(amount !== undefined && { amount: clamp(amount, 0, 150) }), ...(radius !== undefined && { radius: clamp(radius, 0.5, 3) }) };
  }

  return { version: "1.0", assetType: "photo", adjustments: adj };
}
