import { HSL_COLORS, type EditRecipe } from "@vivahlens/core";

const NS = "http://ns.adobe.com/camera-raw-settings/1.0/";

/**
 * Fields whose Camera Raw names Adobe documents or Lightroom has long written. Safe for every consumer, including the
 * Lightroom plugin.
 */
export const BASIC_FIELDS = [
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

/**
 * Fields whose names come from ExifTool's reverse-engineered table, not from Adobe, and whose ranges are unverified
 * (docs/research/photo-editor-formats-verification-2.md). They are written to sidecars, which Lightroom reads like any other
 * attribute, but are not yet sent through the plugin.
 */
export const EXTENDED_FIELDS = ["clarity", "texture", "dehaze", "toneCurve", "crop", "vignette", "grain"] as const;

/** Recipe fields this adapter translates to Camera Raw settings. */
export const SUPPORTED_FIELDS = [...BASIC_FIELDS, ...EXTENDED_FIELDS] as const;

const signed = (n: number, digits = 0): string => {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
};
const int = (n: number) => String(Math.round(n));
const sint = (n: number) => signed(Math.round(n));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface CrsOutput {
  /** `crs:` attributes, by name without the prefix. */
  attributes: Record<string, string>;
  /** Settings that are lists, written as child elements (`<crs:Name><rdf:Seq><rdf:li>…`): the tone curve. */
  sequences: Record<string, string[]>;
  /** What in the recipe could not be written, and why, for the photographer to see. */
  warnings: string[];
}

/** The tone curve as Camera Raw stores it: integer "x, y" points on 0–255, from the first to the last, ending at the corners. */
function toneCurvePoints(curve: readonly { input: number; output: number }[]): string[] | undefined {
  const byInput = new Map<number, number>();
  for (const p of curve) byInput.set(clamp(Math.round(p.input), 0, 255), clamp(Math.round(p.output), 0, 255));
  const points = [...byInput].sort(([a], [b]) => a - b);
  if (points.length < 2 && !(points.length === 1 && points[0]![0] !== 0 && points[0]![0] !== 255)) return undefined;
  if (points[0]![0] !== 0) points.unshift([0, 0]);
  if (points.at(-1)![0] !== 255) points.push([255, 255]);
  if (points.every(([x, y]) => x === y)) return undefined; // a straight line changes nothing
  return points.map(([x, y]) => `${x}, ${y}`);
}

const fraction = (n: number) => String(Number(n.toFixed(6)));

/**
 * Maps an EditRecipe to Camera Raw (crs:) develop settings, as read by Lightroom, ACR and Bridge. Only fields listed in
 * `fields` are translated (the default is everything this adapter supports).
 */
export function compileToCrs(recipe: EditRecipe, fields: readonly string[] = SUPPORTED_FIELDS): CrsOutput {
  const a = recipe.adjustments;
  const use = (name: string) => fields.includes(name);
  const out: CrsOutput = { attributes: { Version: "15.0", ProcessVersion: "11.0", HasSettings: "True" }, sequences: {}, warnings: [] };
  const attrs = out.attributes;

  if (a.exposure !== undefined && use("exposure")) attrs.Exposure2012 = signed(a.exposure, 2);
  if (a.contrast !== undefined && use("contrast")) attrs.Contrast2012 = sint(a.contrast);
  if (a.highlights !== undefined && use("highlights")) attrs.Highlights2012 = sint(a.highlights);
  if (a.shadows !== undefined && use("shadows")) attrs.Shadows2012 = sint(a.shadows);
  if (a.whites !== undefined && use("whites")) attrs.Whites2012 = sint(a.whites);
  if (a.blacks !== undefined && use("blacks")) attrs.Blacks2012 = sint(a.blacks);
  if (a.vibrance !== undefined && use("vibrance")) attrs.Vibrance = sint(a.vibrance);
  if (a.saturation !== undefined && use("saturation")) attrs.Saturation = sint(a.saturation);
  if (a.clarity !== undefined && use("clarity")) attrs.Clarity2012 = sint(a.clarity);
  if (a.texture !== undefined && use("texture")) attrs.Texture = sint(a.texture);
  if (a.dehaze !== undefined && use("dehaze")) attrs.Dehaze = sint(a.dehaze);

  const wb = a.whiteBalance;
  if (use("whiteBalance")) {
    if (wb && (wb.tempK !== undefined || wb.tint !== undefined)) attrs.WhiteBalance = "Custom";
    if (wb?.tempK !== undefined) attrs.Temperature = int(wb.tempK);
    if (wb?.tint !== undefined) attrs.Tint = sint(wb.tint);
  }

  if (use("hsl")) {
    for (const color of HSL_COLORS) {
      const band = a.hsl?.[color];
      if (!band) continue;
      const name = color[0]!.toUpperCase() + color.slice(1);
      if (band.hue !== undefined) attrs[`HueAdjustment${name}`] = sint(band.hue);
      if (band.saturation !== undefined) attrs[`SaturationAdjustment${name}`] = sint(band.saturation);
      if (band.luminance !== undefined) attrs[`LuminanceAdjustment${name}`] = sint(band.luminance);
    }
  }

  const st = a.splitToning;
  if (st && use("splitToning")) {
    if (st.highlightHue !== undefined) attrs.SplitToningHighlightHue = int(st.highlightHue);
    if (st.highlightSaturation !== undefined) attrs.SplitToningHighlightSaturation = int(st.highlightSaturation);
    if (st.shadowHue !== undefined) attrs.SplitToningShadowHue = int(st.shadowHue);
    if (st.shadowSaturation !== undefined) attrs.SplitToningShadowSaturation = int(st.shadowSaturation);
    if (st.balance !== undefined) attrs.SplitToningBalance = sint(st.balance);
  }

  if (use("noiseReduction")) {
    if (a.noiseReduction?.luminance !== undefined) attrs.LuminanceSmoothing = int(a.noiseReduction.luminance);
    if (a.noiseReduction?.color !== undefined) attrs.ColorNoiseReduction = int(a.noiseReduction.color);
  }
  if (use("sharpening")) {
    if (a.sharpening?.amount !== undefined) attrs.Sharpness = int(a.sharpening.amount);
    if (a.sharpening?.radius !== undefined) attrs.SharpenRadius = signed(a.sharpening.radius, 1);
  }

  const v = a.vignette;
  if (v && use("vignette")) {
    if (v.amount !== undefined) attrs.PostCropVignetteAmount = sint(v.amount);
    if (v.midpoint !== undefined) attrs.PostCropVignetteMidpoint = int(v.midpoint);
    if (v.feather !== undefined) attrs.PostCropVignetteFeather = int(v.feather);
    if (v.roundness !== undefined) attrs.PostCropVignetteRoundness = sint(v.roundness);
    if (Object.values(v).some((x) => x !== undefined)) attrs.PostCropVignetteStyle = "1"; // highlight priority
  }

  const g = a.grain;
  if (g && use("grain")) {
    if (g.amount !== undefined) attrs.GrainAmount = int(g.amount);
    if (g.size !== undefined) attrs.GrainSize = int(g.size);
    if (g.roughness !== undefined) attrs.GrainFrequency = int(g.roughness);
  }

  if (a.toneCurve && use("toneCurve")) {
    const points = toneCurvePoints(a.toneCurve);
    if (points) {
      out.sequences.ToneCurvePV2012 = points;
      attrs.ToneCurveName2012 = "Custom";
    } else if (a.toneCurve.length > 0) {
      out.warnings.push("The tone curve has fewer than two distinct points or changes nothing, so it was not written.");
    }
  }

  const c = a.crop;
  if (c && use("crop")) {
    const hasRectangle = c.x !== undefined && c.y !== undefined && c.width !== undefined && c.height !== undefined;
    if (!hasRectangle) {
      // The sidecar has no aspect-ratio setting: the rectangle itself is the crop, and it depends on the photo's size.
      out.warnings.push("A crop needs a rectangle (x, y, width, height as fractions of the photo); an aspect ratio or angle alone was not applied.");
    } else {
      const left = clamp(c.x!, 0, 1);
      const top = clamp(c.y!, 0, 1);
      const right = clamp(c.x! + c.width!, 0, 1);
      const bottom = clamp(c.y! + c.height!, 0, 1);
      if (right - left <= 0 || bottom - top <= 0) {
        out.warnings.push("The crop rectangle is empty or outside the photo, so it was not applied.");
      } else {
        attrs.HasCrop = "True";
        attrs.CropLeft = fraction(left);
        attrs.CropTop = fraction(top);
        attrs.CropRight = fraction(right);
        attrs.CropBottom = fraction(bottom);
        attrs.CropAngle = fraction(c.rotationDeg ?? 0);
        attrs.CropConstrainToWarp = "0";
        if (c.rotationDeg) out.warnings.push("The direction of the crop angle has not been verified in Lightroom; check straightened photos.");
      }
    }
  }

  return out;
}

/** Just the attributes: the settings that fit on the `rdf:Description` element. */
export function compileToCrsSettings(recipe: EditRecipe, fields?: readonly string[]): Record<string, string> {
  return compileToCrs(recipe, fields).attributes;
}

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const attrs = (settings: Record<string, string>) => Object.entries(settings).map(([k, v]) => `crs:${k}="${escapeAttr(v)}"`);
const escapeText = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const sequenceXml = (name: string, items: readonly string[], indent: string) =>
  `${indent}<crs:${name}>\n${indent} <rdf:Seq>\n${items.map((i) => `${indent}  <rdf:li>${escapeText(i)}</rdf:li>`).join("\n")}\n${indent} </rdf:Seq>\n${indent}</crs:${name}>`;

/** Marks a sidecar as written by VivahLens, so tools that learn from or score "the photographer's own edits" can skip it. */
export const VIVAH_NS = "urn:vivahlens:xmp:1.0";
const GENERATED_ATTR = `vivah:Generated="True"`;

export function isGeneratedByVivah(xmp: string): boolean {
  return /\bvivah:Generated="True"/.test(xmp);
}

export function buildXmp(settings: Record<string, string>, sequences: Record<string, readonly string[]> = {}): string {
  const body = attrs(settings)
    .map((a) => `   ${a}`)
    .join("\n");
  const children = Object.entries(sequences).map(([name, items]) => sequenceXml(name, items, "  "));
  const description = children.length ? `${body}>\n${children.join("\n")}\n  </rdf:Description>` : `${body}/>`;
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="${NS}"
   xmlns:vivah="${VIVAH_NS}"
   ${GENERATED_ATTR}
${description}
 </rdf:RDF>
</x:xmpmeta>
`;
}

/**
 * Overwrites or inserts crs: attributes (and list settings such as the tone curve) in an existing sidecar, leaving other
 * metadata (ratings, keywords) intact.
 */
export function mergeXmp(existing: string, settings: Record<string, string>, sequences: Record<string, readonly string[]> = {}): string {
  // A list setting being replaced is removed wherever it is (with the line break before it); the new one goes in below.
  let doc = existing;
  for (const name of Object.keys(sequences)) {
    doc = doc.replace(new RegExp(`\\n?[ \\t]*<crs:${name}\\b[^>]*?(?:/>|>[\\s\\S]*?</crs:${name}>)`, "g"), "");
  }
  const open = /<rdf:Description\b[^>]*?(\/?)>/.exec(doc);
  if (!open) throw new Error("Existing XMP has no rdf:Description element");
  let tag = open[0];
  if (!/xmlns:crs=/.test(tag)) tag = tag.replace(/(\/?)>$/, ` xmlns:crs="${NS}"$1>`);
  if (!/xmlns:vivah=/.test(tag)) tag = tag.replace(/(\/?)>$/, ` xmlns:vivah="${VIVAH_NS}"$1>`);
  if (!/vivah:Generated=/.test(tag)) tag = tag.replace(/(\/?)>$/, ` ${GENERATED_ATTR}$1>`);
  for (const [key, value] of Object.entries(settings)) {
    const attr = `crs:${key}="${escapeAttr(value)}"`;
    const re = new RegExp(`crs:${key}="[^"]*"`);
    tag = re.test(tag) ? tag.replace(re, () => attr) : tag.replace(/(\/?)>$/, ` ${attr}$1>`);
  }

  const children = Object.entries(sequences).map(([name, items]) => sequenceXml(name, items, "   "));
  if (children.length) {
    tag = tag.endsWith("/>")
      ? `${tag.slice(0, -2).trimEnd()}>\n${children.join("\n")}\n  </rdf:Description>`
      : `${tag}\n${children.join("\n")}`;
  }
  return doc.replace(open[0], () => tag);
}
