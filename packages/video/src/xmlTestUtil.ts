export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

/** Minimal strict XML reader for tests: throws on unbalanced tags, unquoted attributes, or raw `<` / bare `&` in values. */
export function parseXml(xml: string): XmlNode {
  const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "");
  const root: XmlNode = { name: "#document", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const tag = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (let m = tag.exec(body); m; m = tag.exec(body)) {
    const between = body.slice(last, m.index);
    if (/[<>]/.test(between)) throw new Error(`Malformed markup near "${between.slice(0, 40)}"`);
    last = m.index + m[0].length;
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`Mismatched </${name}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs!.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      const value = a[2]!;
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(value)) throw new Error(`Bare & in attribute ${a[1]}`);
      attrs[a[1]!] = value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
    const node: XmlNode = { name: name!, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (/[<>]/.test(body.slice(last))) throw new Error("Trailing malformed markup");
  if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1]!.name}>`);
  return root.children[0]!;
}

export const findAll = (node: XmlNode, name: string): XmlNode[] => [
  ...(node.name === name ? [node] : []),
  ...node.children.flatMap((c) => findAll(c, name)),
];
