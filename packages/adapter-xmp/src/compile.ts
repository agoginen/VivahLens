import { HSL_COLORS, type EditRecipe } from "@vivahlens/core";

const NS = "http://ns.adobe.com/camera-raw-settings/1.0/";

/** Recipe fields this adapter translates to Camera Raw settings. */
export const SUPPORTED_FIELDS = [
  "exposure",
  "contrast",
  "whiteBalance",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "vibrance",
  "saturation",
  "hsl",
  "splitToning",
  "noiseReduction",
  "sharpening",
] as const;

const signed = (n: number, digits = 0): string => {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
};
const int = (n: number) => String(Math.round(n));
const sint = (n: number) => signed(Math.round(n));

/** Maps an EditRecipe to Camera Raw (crs:) develop settings, as read by Lightroom, ACR and Bridge. */
export function compileToCrsSettings(recipe: EditRecipe): Record<string, string> {
  const a = recipe.adjustments;
  const out: Record<string, string> = { Version: "15.0", ProcessVersion: "11.0", HasSettings: "True" };

  if (a.exposure !== undefined) out.Exposure2012 = signed(a.exposure, 2);
  if (a.contrast !== undefined) out.Contrast2012 = sint(a.contrast);
  if (a.highlights !== undefined) out.Highlights2012 = sint(a.highlights);
  if (a.shadows !== undefined) out.Shadows2012 = sint(a.shadows);
  if (a.whites !== undefined) out.Whites2012 = sint(a.whites);
  if (a.blacks !== undefined) out.Blacks2012 = sint(a.blacks);
  if (a.vibrance !== undefined) out.Vibrance = sint(a.vibrance);
  if (a.saturation !== undefined) out.Saturation = sint(a.saturation);

  const wb = a.whiteBalance;
  if (wb && (wb.tempK !== undefined || wb.tint !== undefined)) out.WhiteBalance = "Custom";
  if (wb?.tempK !== undefined) out.Temperature = int(wb.tempK);
  if (wb?.tint !== undefined) out.Tint = sint(wb.tint);

  for (const color of HSL_COLORS) {
    const band = a.hsl?.[color];
    if (!band) continue;
    const name = color[0]!.toUpperCase() + color.slice(1);
    if (band.hue !== undefined) out[`HueAdjustment${name}`] = sint(band.hue);
    if (band.saturation !== undefined) out[`SaturationAdjustment${name}`] = sint(band.saturation);
    if (band.luminance !== undefined) out[`LuminanceAdjustment${name}`] = sint(band.luminance);
  }

  const st = a.splitToning;
  if (st?.highlightHue !== undefined) out.SplitToningHighlightHue = int(st.highlightHue);
  if (st?.highlightSaturation !== undefined) out.SplitToningHighlightSaturation = int(st.highlightSaturation);
  if (st?.shadowHue !== undefined) out.SplitToningShadowHue = int(st.shadowHue);
  if (st?.shadowSaturation !== undefined) out.SplitToningShadowSaturation = int(st.shadowSaturation);
  if (st?.balance !== undefined) out.SplitToningBalance = sint(st.balance);

  if (a.noiseReduction?.luminance !== undefined) out.LuminanceSmoothing = int(a.noiseReduction.luminance);
  if (a.noiseReduction?.color !== undefined) out.ColorNoiseReduction = int(a.noiseReduction.color);
  if (a.sharpening?.amount !== undefined) out.Sharpness = int(a.sharpening.amount);
  if (a.sharpening?.radius !== undefined) out.SharpenRadius = signed(a.sharpening.radius, 1);

  return out;
}

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const attrs = (settings: Record<string, string>) =>
  Object.entries(settings).map(([k, v]) => `crs:${k}="${escapeAttr(v)}"`);

export function buildXmp(settings: Record<string, string>): string {
  const body = attrs(settings)
    .map((a) => `   ${a}`)
    .join("\n");
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="${NS}"
${body}/>
 </rdf:RDF>
</x:xmpmeta>
`;
}

/** Overwrites or inserts crs: attributes in an existing sidecar, leaving other metadata (ratings, keywords) intact. */
export function mergeXmp(existing: string, settings: Record<string, string>): string {
  const open = /<rdf:Description\b[^>]*?(\/?)>/.exec(existing);
  if (!open) throw new Error("Existing XMP has no rdf:Description element");
  let tag = open[0];
  if (!/xmlns:crs=/.test(tag)) tag = tag.replace(/(\/?)>$/, ` xmlns:crs="${NS}"$1>`);
  for (const [key, value] of Object.entries(settings)) {
    const attr = `crs:${key}="${escapeAttr(value)}"`;
    const re = new RegExp(`crs:${key}="[^"]*"`);
    tag = re.test(tag) ? tag.replace(re, () => attr) : tag.replace(/(\/?)>$/, ` ${attr}$1>`);
  }
  return existing.replace(open[0], () => tag);
}
