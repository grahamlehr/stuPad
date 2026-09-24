/**
 * Minimal XML helpers on top of DOMParser. Works identically in the browser and in
 * jsdom (vitest environment), so the parser needs no separate node/browser branches.
 *
 * PPTX XML uses namespace prefixes (a:, p:, r:, ...) but we don't bother with real
 * namespace-aware lookups: `localName` (the part after the colon) is unique enough
 * within OOXML for our purposes, so children/attrs are matched on local name.
 */

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`XML parse error: ${err.textContent?.slice(0, 200)}`);
  return doc;
}

function localName(el: Element): string {
  const n = el.nodeName;
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
}

/** Direct children whose local name matches (namespace prefix ignored). */
export function children(el: Element | Document | null | undefined, name: string): Element[] {
  if (!el) return [];
  const root = 'documentElement' in el ? el.documentElement : el;
  if (!root) return [];
  const out: Element[] = [];
  for (const child of Array.from(root.children)) {
    if (localName(child) === name) out.push(child);
  }
  return out;
}

/** First direct child matching, or null. */
export function child(el: Element | Document | null | undefined, name: string): Element | null {
  return children(el, name)[0] ?? null;
}

/** First descendant matching (any depth), or null. */
export function find(el: Element | Document | null | undefined, name: string): Element | null {
  if (!el) return null;
  const root = 'documentElement' in el ? el.documentElement : el;
  if (!root) return null;
  if (localName(root) === name) return root;
  const all = root.getElementsByTagName('*');
  for (const e of Array.from(all)) {
    if (localName(e) === name) return e;
  }
  return null;
}

/** All descendants matching (any depth). */
export function findAll(el: Element | Document | null | undefined, name: string): Element[] {
  if (!el) return [];
  const root = 'documentElement' in el ? el.documentElement : el;
  if (!root) return [];
  const out: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (const e of Array.from(all)) {
    if (localName(e) === name) out.push(e);
  }
  return out;
}

/** Attribute value, ignoring namespace prefix on the attribute name (e.g. "r:id" -> "id"). */
export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  if (el.hasAttribute(name)) return el.getAttribute(name);
  for (const a of Array.from(el.attributes)) {
    const i = a.name.indexOf(':');
    const local = i >= 0 ? a.name.slice(i + 1) : a.name;
    if (local === name) return a.value;
  }
  return null;
}

/**
 * Attribute value matched by local name but only among *namespace-prefixed* attributes
 * (e.g. "r:id"). Use this instead of `attr()` when a plain, unprefixed attribute of the
 * same local name might also be present on the element (e.g. `<p:sldId id="256" r:id="rId2"/>`,
 * where `id` is the slide's own id and `r:id` is the relationship reference).
 */
export function attrNS(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) {
    const i = a.name.indexOf(':');
    if (i < 0) continue;
    if (a.name.slice(i + 1) === name) return a.value;
  }
  return null;
}

export function attrNum(el: Element | null | undefined, name: string, fallback = 0): number {
  const v = attr(el, name);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function localTag(el: Element): string {
  return localName(el);
}

export function textContent(el: Element | null | undefined): string {
  return el?.textContent ?? '';
}
