import { describe, expect, it } from "vitest";
import { cropParams, exposureParams } from "./params.js";
import { buildSidecar, mergeSidecar, type HistoryEntry } from "./sidecar.js";

const exposure = (ev: number): HistoryEntry => ({ operation: "exposure", modversion: 7, params: exposureParams(ev) });
const crop: HistoryEntry = { operation: "crop", modversion: 3, params: cropParams({ left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 }) };
const opts = { file: "IMG_0412.CR3.xmp", derivedFrom: "IMG_0412.CR3" };

/** Every start tag is closed, every element is closed in order: enough to catch a merge that mangled the document. */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?[\s\S]*?\?>/g, "").matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else stack.push(name!);
  }
  return stack.length === 0;
}

const entriesOf = (xml: string) => [...xml.matchAll(/<rdf:li darktable:num="(\d+)" darktable:operation="([^"]+)"[^>]*darktable:params="([^"]*)"[^>]*\/>/g)].map((m) => ({ num: Number(m[1]), operation: m[2]!, params: m[3]! }));
const attr = (xml: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(xml)?.[1];

const PARAMS = { rawprepare: "01020304", temperature: "0a0b0c0d", exposure: exposureParams(0.7), colorbalancergb: "ffee" };
/** A sidecar as darktable keeps it for a photo the photographer has already worked on: metadata, tags, hashes, and a step they undid. */
const existing = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:darktable="http://darktable.sf.net/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
   exif:DateTimeOriginal="2026:11:20 10:15:00"
   xmp:Rating="4"
   xmp:Label="Green"
   xmpMM:DerivedFrom="IMG_0412.CR3"
   darktable:xmp_version="5"
   darktable:raw_params="0"
   darktable:auto_presets_applied="1"
   darktable:history_end="3"
   darktable:iop_order_version="4"
   darktable:history_basic_hash="aa11"
   darktable:history_auto_hash="bb22"
   darktable:history_current_hash="cc33">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>wedding</rdf:li>
     <rdf:li>bride</rdf:li>
    </rdf:Bag>
   </dc:subject>
   <darktable:masks_history>
    <rdf:Seq/>
   </darktable:masks_history>
   <darktable:history>
    <rdf:Seq>
     <rdf:li darktable:num="0" darktable:operation="rawprepare" darktable:enabled="1" darktable:modversion="2" darktable:params="${PARAMS.rawprepare}" darktable:multi_name="" darktable:multi_name_hand_edited="0" darktable:multi_priority="0" darktable:blendop_version="14" darktable:blendop_params="gz01"/>
     <rdf:li darktable:num="1" darktable:operation="temperature" darktable:enabled="1" darktable:modversion="4" darktable:params="${PARAMS.temperature}" darktable:multi_name="" darktable:multi_priority="0"/>
     <rdf:li darktable:num="2" darktable:operation="exposure" darktable:enabled="1" darktable:modversion="7" darktable:params="${PARAMS.exposure}" darktable:multi_name="" darktable:multi_priority="0"/>
     <rdf:li darktable:num="3" darktable:operation="colorbalancergb" darktable:enabled="1" darktable:modversion="5" darktable:params="${PARAMS.colorbalancergb}" darktable:multi_name="" darktable:multi_priority="0"/>
    </rdf:Seq>
   </darktable:history>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

describe("a new sidecar", () => {
  it("holds the entries in order, with the settings darktable needs to read them in the right module order", () => {
    const xml = buildSidecar("IMG_0412.CR3", [exposure(1.05), crop]);
    expect(wellFormed(xml)).toBe(true);
    expect(entriesOf(xml)).toEqual([
      { num: 0, operation: "exposure", params: exposureParams(1.05) },
      { num: 1, operation: "crop", params: crop.params },
    ]);
    expect(attr(xml, "darktable:xmp_version")).toBe("5");
    expect(attr(xml, "darktable:iop_order_version")).toBe("4");
    expect(attr(xml, "darktable:history_end")).toBe("2");
    expect(attr(xml, "darktable:auto_presets_applied")).toBe("0");
    expect(attr(xml, "xmpMM:DerivedFrom")).toBe("IMG_0412.CR3");
    expect(xml).toContain('darktable:modversion="7"');
    expect(xml).toContain('darktable:enabled="1"');
    expect(xml).toContain('darktable:multi_priority="0"');
  });

  it("carries no rating, label or tags, so importing it cannot overwrite what darktable already knows about the photo", () => {
    const xml = buildSidecar("IMG.CR3", [exposure(1)]);
    expect(xml).not.toMatch(/xmp:Rating|xmp:Label|dc:subject|Bag/);
  });

  it("escapes a file name that has characters XML cares about", () => {
    const xml = buildSidecar('Bride & "Groom" <1>.CR3', [exposure(1)]);
    expect(wellFormed(xml)).toBe(true);
    expect(attr(xml, "xmpMM:DerivedFrom")).toBe("Bride &amp; &quot;Groom&quot; &lt;1&gt;.CR3");
  });

  it("is a valid empty history when there is nothing to add", () => {
    const xml = buildSidecar("IMG.CR3", []);
    expect(wellFormed(xml)).toBe(true);
    expect(attr(xml, "darktable:history_end")).toBe("0");
    expect(entriesOf(xml)).toEqual([]);
  });
});

describe("merging into the photographer's own sidecar", () => {
  it("adds the entry after the steps that are in force, drops the step that had been undone, and brings the count up to date", () => {
    const merged = mergeSidecar(existing, [exposure(1.05)], opts);
    expect(wellFormed(merged)).toBe(true);
    expect(entriesOf(merged).map((e) => [e.num, e.operation])).toEqual([[0, "rawprepare"], [1, "temperature"], [2, "exposure"], [3, "exposure"]]);
    expect(entriesOf(merged)[3]!.params).toBe(exposureParams(1.05));
    expect(attr(merged, "darktable:history_end")).toBe("4");
    expect(merged).not.toContain("colorbalancergb");
  });

  it("leaves everything else exactly as it was: rating, label, date, tags, masks, the earlier entries with their blend data", () => {
    const merged = mergeSidecar(existing, [exposure(1.05)], opts);
    for (const kept of ['xmp:Rating="4"', 'xmp:Label="Green"', 'exif:DateTimeOriginal="2026:11:20 10:15:00"', "<rdf:li>wedding</rdf:li>", "<rdf:li>bride</rdf:li>", '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>', '<?xpacket end="w"?>', 'darktable:auto_presets_applied="1"', 'darktable:iop_order_version="4"', 'darktable:blendop_params="gz01"', 'darktable:multi_name_hand_edited="0"']) {
      expect(merged, kept).toContain(kept);
    }
    // Byte for byte the same up to the start of the history.
    const upTo = (s: string) => s.slice(s.indexOf("<dc:subject>"), s.indexOf("<darktable:history>"));
    expect(upTo(merged)).toBe(upTo(existing));
    expect(merged.slice(merged.indexOf("</darktable:history>"))).toBe(existing.slice(existing.indexOf("</darktable:history>")));
  });

  it("drops the hashes that described the old history, so darktable works them out again", () => {
    const merged = mergeSidecar(existing, [exposure(1.05)], opts);
    expect(merged).not.toMatch(/history_(basic|auto|current)_hash/);
  });

  it("changes nothing when the same entry is applied again, and adds another when the value differs", () => {
    const once = mergeSidecar(existing, [exposure(1.05)], opts);
    expect(mergeSidecar(once, [exposure(1.05)], opts)).toBe(once);
    const twice = mergeSidecar(once, [exposure(0.4)], opts);
    expect(entriesOf(twice).map((e) => e.operation)).toEqual(["rawprepare", "temperature", "exposure", "exposure", "exposure"]);
    expect(attr(twice, "darktable:history_end")).toBe("5");
    // Going back to an earlier value is a change too, not a repeat of the one before it.
    const back = mergeSidecar(twice, [exposure(1.05)], opts);
    expect(entriesOf(back)).toHaveLength(6);
  });

  it("does not add an entry the photographer's own latest step already matches, whatever the case of its hex", () => {
    const upper = existing.replace(PARAMS.exposure, PARAMS.exposure.toUpperCase());
    const merged = mergeSidecar(upper, [{ operation: "exposure", modversion: 7, params: PARAMS.exposure }], opts);
    expect(entriesOf(merged).map((e) => e.operation)).toEqual(["rawprepare", "temperature", "exposure"]);
    // The undone step after it is still dropped: this was an edit made after stepping back.
    expect(attr(merged, "darktable:history_end")).toBe("3");
  });

  it("treats a second instance of a module as a different thing from the base one", () => {
    const multi = existing.replace('darktable:multi_priority="0"/>\n     <rdf:li darktable:num="3"', 'darktable:multi_priority="1"/>\n     <rdf:li darktable:num="3"');
    expect(multi).not.toBe(existing);
    const merged = mergeSidecar(multi, [{ operation: "exposure", modversion: 7, params: PARAMS.exposure }], opts);
    expect(entriesOf(merged).map((e) => e.operation)).toEqual(["rawprepare", "temperature", "exposure", "exposure"]);
  });

  it("keeps every step when the history end is not recorded, numbers them again from 0, and tolerates an empty or missing history", () => {
    const noEnd = existing.replace(/\s+darktable:history_end="3"/, "").replace(/darktable:num="(\d)"/g, (_m, n) => `darktable:num="${Number(n) * 5}"`);
    const merged = mergeSidecar(noEnd, [crop], opts);
    expect(entriesOf(merged).map((e) => [e.num, e.operation])).toEqual([[0, "rawprepare"], [1, "temperature"], [2, "exposure"], [3, "colorbalancergb"], [4, "crop"]]);
    expect(attr(merged, "darktable:history_end")).toBe("5");

    const empty = existing.replace(/<darktable:history>[\s\S]*<\/darktable:history>/, "<darktable:history><rdf:Seq/></darktable:history>").replace('history_end="3"', 'history_end="0"');
    expect(entriesOf(mergeSidecar(empty, [crop], opts))).toEqual([{ num: 0, operation: "crop", params: crop.params }]);
    expect(wellFormed(mergeSidecar(empty, [crop], opts))).toBe(true);

    const none = existing.replace(/<darktable:history>[\s\S]*<\/darktable:history>\s*/, "");
    const added = mergeSidecar(none, [crop], opts);
    expect(wellFormed(added)).toBe(true);
    expect(entriesOf(added)).toEqual([{ num: 0, operation: "crop", params: crop.params }]);
    expect(attr(added, "darktable:history_end")).toBe("1");

    const selfClosingHistory = existing.replace(/<darktable:history>[\s\S]*<\/darktable:history>/, "<darktable:history/>");
    expect(wellFormed(mergeSidecar(selfClosingHistory, [crop], opts))).toBe(true);
  });

  it("opens up a description that was written as an empty element", () => {
    const bare = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:darktable="http://darktable.sf.net/" darktable:xmp_version="5"/></rdf:RDF></x:xmpmeta>`;
    const merged = mergeSidecar(bare, [crop], opts);
    expect(wellFormed(merged)).toBe(true);
    expect(entriesOf(merged)).toEqual([{ num: 0, operation: "crop", params: crop.params }]);
    expect(attr(merged, "darktable:history_end")).toBe("1");
  });

  it("starts a new file when there is none", () => {
    expect(mergeSidecar(undefined, [exposure(1)], opts)).toBe(buildSidecar("IMG_0412.CR3", [exposure(1)]));
  });
});

describe("a sidecar it will not touch", () => {
  const refused = (xml: string, message: RegExp) => expect(() => mergeSidecar(xml, [exposure(1)], opts)).toThrowError(expect.objectContaining({ code: "ADAPTER_APPLY_FAILED", message: expect.stringMatching(message) }));

  it("is one that is not a darktable sidecar at all, such as a Lightroom file saved under darktable's name", () => {
    refused(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.50"/></rdf:RDF></x:xmpmeta>`, /IMG_0412\.CR3\.xmp is not a darktable sidecar .* was not changed$/);
    refused("not xml at all", /is not a darktable sidecar/);
  });

  it("is one in a format from before the history was ordered, or from a darktable newer than this code knows", () => {
    refused(existing.replace('darktable:xmp_version="5"', 'darktable:xmp_version="2"'), /uses sidecar format 2, which this version of VivahLens does not know/);
    refused(existing.replace('darktable:xmp_version="5"', 'darktable:xmp_version="6"'), /uses sidecar format 6/);
  });

  it("is one whose history is written in a layout it does not handle", () => {
    const nested = existing.replace(/darktable:multi_priority="0"\/>\n     <rdf:li darktable:num="2"/, 'darktable:multi_priority="0"><x/></rdf:li>\n     <rdf:li darktable:num="2"');
    expect(nested).not.toBe(existing);
    refused(nested, /history in a layout this version of VivahLens does not handle/);
    refused(existing.replace("</rdf:Seq>\n   </darktable:history>", "<rdf:li>stray</rdf:li></rdf:Seq>\n   </darktable:history>"), /history in a layout/);
  });
});
