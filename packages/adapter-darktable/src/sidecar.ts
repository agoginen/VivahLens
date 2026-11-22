import { VivahError } from "@vivahlens/core";

/** One module setting to add to a photo's history. VivahLens only ever writes the base instance, switched on. */
export interface HistoryEntry {
  operation: string;
  modversion: number;
  /** Lowercase hex of the module's parameter struct. */
  params: string;
}

/** `num` orders the history from sidecar format 3; 5 is what darktable 5.6 writes. Anything else is left alone, not guessed at. */
const MIN_XMP_VERSION = 3;
const MAX_XMP_VERSION = 5;

const refuse = (file: string, why: string) => new VivahError("ADAPTER_APPLY_FAILED", `${file} ${why}, so it was not changed`);
const escapeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const entryTag = (entry: HistoryEntry, num: number) =>
  `<rdf:li darktable:num="${num}" darktable:operation="${entry.operation}" darktable:enabled="1" darktable:modversion="${entry.modversion}" darktable:params="${entry.params}" darktable:multi_name="" darktable:multi_priority="0"/>`;

const historyBlock = (tags: readonly string[]) => `<darktable:history>\n    <rdf:Seq>\n${tags.map((t) => `     ${t}`).join("\n")}\n    </rdf:Seq>\n   </darktable:history>`;

/**
 * A new sidecar holding these entries and nothing else: no rating, tags or title, so importing it never overwrites what
 * darktable already knows about the photo. `iop_order_version` 4 is the order for raw files; without it darktable falls
 * back to its legacy module order (research §4b).
 */
export function buildSidecar(derivedFrom: string, entries: readonly HistoryEntry[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:darktable="http://darktable.sf.net/"
   xmpMM:DerivedFrom="${escapeAttribute(derivedFrom)}"
   darktable:xmp_version="5"
   darktable:raw_params="0"
   darktable:auto_presets_applied="0"
   darktable:history_end="${entries.length}"
   darktable:iop_order_version="4">
   <darktable:masks_history>
    <rdf:Seq/>
   </darktable:masks_history>
   ${historyBlock(entries.map((e, i) => entryTag(e, i)))}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}

const attributesOf = (tag: string): Map<string, string> => new Map([...tag.matchAll(/([A-Za-z_][\w.-]*:[\w.-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));

/**
 * Adds entries to a photo's history in the sidecar darktable already keeps for it, without disturbing anything else in
 * the file: rating, tags, colour labels and the photographer's own history stay exactly as they are. As darktable does
 * when someone edits after stepping back in the history, steps that were undone are dropped first. An entry identical to
 * the photo's latest one for that module is not added again, so applying the same recipe twice changes nothing.
 * A file that is not a sidecar this code understands is refused rather than rewritten.
 */
export function mergeSidecar(existing: string | undefined, entries: readonly HistoryEntry[], opts: { file: string; derivedFrom: string }): string {
  if (existing === undefined) return buildSidecar(opts.derivedFrom, entries);

  const description = /<rdf:Description\b[^>]*>/.exec(existing);
  const version = description && /darktable:xmp_version="(\d+)"/.exec(description[0])?.[1];
  if (!description || version === undefined) throw refuse(opts.file, "is not a darktable sidecar (it has no darktable:xmp_version)");
  if (Number(version) < MIN_XMP_VERSION || Number(version) > MAX_XMP_VERSION) throw refuse(opts.file, `uses sidecar format ${version}, which this version of VivahLens does not know`);

  const block = /<darktable:history>\s*(?:<rdf:Seq\s*\/>|<rdf:Seq>([\s\S]*?)<\/rdf:Seq>)\s*<\/darktable:history>|<darktable:history\s*\/>/.exec(existing);
  const inner = block?.[1] ?? "";
  const tags = inner.match(/<rdf:li\b[^>]*>/g) ?? [];
  if (tags.some((t) => !t.endsWith("/>")) || /<\/rdf:li>/.test(inner) || inner.replace(/<rdf:li\b[^>]*\/>/g, "").trim() !== "") {
    throw refuse(opts.file, "has a history in a layout this version of VivahLens does not handle");
  }

  const declaredEnd = /darktable:history_end="(\d+)"/.exec(description[0])?.[1];
  const kept = tags.slice(0, declaredEnd === undefined ? tags.length : Math.min(Number(declaredEnd), tags.length));

  const added: HistoryEntry[] = [];
  for (const entry of entries) {
    const latest = [...kept].reverse().map(attributesOf).find((a) => a.get("darktable:operation") === entry.operation && (a.get("darktable:multi_priority") ?? "0") === "0");
    const same = latest?.get("darktable:enabled") === "1" && latest.get("darktable:params")?.toLowerCase() === entry.params;
    if (!same) added.push(entry);
  }

  const renumbered = kept.map((tag, i) => (/darktable:num="\d*"/.test(tag) ? tag.replace(/darktable:num="\d*"/, `darktable:num="${i}"`) : tag.replace("<rdf:li", `<rdf:li darktable:num="${i}"`)));
  const all = [...renumbered, ...added.map((e, i) => entryTag(e, renumbered.length + i))];
  const replacement = historyBlock(all);

  // The hashes describe the history that was there; darktable works them out again when they are missing.
  const selfClosing = /\/\s*>$/.test(description[0]);
  const head = description[0].replace(/\s+darktable:history_(?:basic|auto|current)_hash="[^"]*"/g, "").replace(/\s*\/?>$/, "");
  const withEnd = /darktable:history_end="[^"]*"/.test(head) ? head.replace(/darktable:history_end="[^"]*"/, `darktable:history_end="${all.length}"`) : `${head} darktable:history_end="${all.length}"`;
  const open = `${withEnd}>`;

  if (block) return existing.replace(block[0], () => replacement).replace(description[0], () => open);
  // No history yet: add one, and close the description first if it was written as an empty element.
  if (selfClosing) return existing.replace(description[0], () => `${open}\n   ${replacement}\n  </rdf:Description>`);
  return existing.replace(/<\/rdf:Description>/, () => `   ${replacement}\n  </rdf:Description>`).replace(description[0], () => open);
}
