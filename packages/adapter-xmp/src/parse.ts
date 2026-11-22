import { HSL_COLORS, type EditRecipe, type HslColor, type RecipeAdjustments } from "@vivahlens/core";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** The text items of a list setting stored as `<crs:Name><rdf:Seq><rdf:li>…</rdf:li>…</rdf:Seq></crs:Name>`, such as the tone curve. */
export function readCrsSequence(xmp: string, name: string): string[] {
  const element = new RegExp(`<crs:${name}\\b[^>]*>([\\s\\S]*?)</crs:${name}>`).exec(xmp);
  if (!element) return [];
  return [...element[1]!.matchAll(/<rdf:li>([^<]*)<\/rdf:li>/g)].map((m) => m[1]!.trim());
}

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
  const percent = (key: string) => {
    const n = num(key);
    return n === undefined ? undefined : clamp(n, 0, 100);
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
  set("clarity", slider("Clarity2012"));
  set("texture", slider("Texture"));
  set("dehaze", slider("Dehaze"));

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

  const vignette = { amount: slider("PostCropVignetteAmount"), midpoint: percent("PostCropVignetteMidpoint"), feather: percent("PostCropVignetteFeather"), roundness: slider("PostCropVignetteRoundness") };
  if (Object.values(vignette).some((v) => v !== undefined)) adj.vignette = Object.fromEntries(Object.entries(vignette).filter(([, v]) => v !== undefined));
  const grain = { amount: percent("GrainAmount"), size: percent("GrainSize"), roughness: percent("GrainFrequency") };
  if (Object.values(grain).some((v) => v !== undefined)) adj.grain = Object.fromEntries(Object.entries(grain).filter(([, v]) => v !== undefined));

  const curve = readCrsSequence(xmp, "ToneCurvePV2012")
    .map((item) => /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(item))
    .flatMap((m) => (m ? [{ input: clamp(Number(m[1]), 0, 255), output: clamp(Number(m[2]), 0, 255) }] : []));
  // A curve that is the straight line from corner to corner is Lightroom's way of saying "no curve".
  if (curve.length >= 2 && curve.some((p) => p.input !== p.output)) adj.toneCurve = curve;

  if (s.HasCrop === "True") {
    const [left, top, right, bottom] = ["CropLeft", "CropTop", "CropRight", "CropBottom"].map((k) => num(k));
    if (left !== undefined && top !== undefined && right !== undefined && bottom !== undefined && right > left && bottom > top) {
      const angle = num("CropAngle");
      const round6 = (n: number) => Number(n.toFixed(6));
      const l = clamp(left, 0, 1);
      const t = clamp(top, 0, 1);
      adj.crop = { x: l, y: t, width: round6(clamp(right, 0, 1) - l), height: round6(clamp(bottom, 0, 1) - t), ...(angle !== undefined && angle !== 0 && { rotationDeg: angle }) };
    }
  }

  return { version: "1.0", assetType: "photo", adjustments: adj };
}
