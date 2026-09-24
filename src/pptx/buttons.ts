import type { ButtonDef, HomeLinkDef, SlideElement, SlideLink, Rect } from '../types';

const DEFAULT_NAME_RE = /^(rectangle|oval|textbox|text box|group|rounded rectangle|picture|straight connector|elbow connector|freeform|shape|line|isoceles triangle|arrow|chevron|speech bubble|title|subtitle)\s*\d*$/i;
const GOOGLE_SHAPE_RE = /^google shape;/i;

function looksLikeDefaultName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  return DEFAULT_NAME_RE.test(trimmed) || GOOGLE_SHAPE_RE.test(trimmed);
}

function elementText(el: SlideElement): string {
  if (el.kind === 'shape' && el.text) {
    return el.text.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').trim();
  }
  if (el.kind === 'group') {
    return el.children.map(elementText).filter(Boolean).join(' ').trim();
  }
  if (el.kind === 'table') {
    return el.rows
      .flat()
      .map((c) => c.text?.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ') ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return '';
}

/** First link found on the element itself or (recursively) on any descendant. */
function findLink(el: SlideElement): SlideLink | undefined {
  if (el.link) return el.link;
  if (el.kind === 'group') {
    for (const c of el.children) {
      const l = findLink(c);
      if (l) return l;
    }
  }
  return undefined;
}

function boundsOf(el: SlideElement): Rect {
  return { x: el.xfrm.x, y: el.xfrm.y, w: el.xfrm.w, h: el.xfrm.h };
}

function readingOrder(a: { bounds: Rect }, b: { bounds: Rect }): number {
  // top-to-bottom, then left-to-right; group rows that are roughly on the same line
  // (within a small vertical tolerance) so a horizontal row of buttons sorts left-to-right.
  const rowTolerance = 12;
  if (Math.abs(a.bounds.y - b.bounds.y) > rowTolerance) return a.bounds.y - b.bounds.y;
  return a.bounds.x - b.bounds.x;
}

/** Detect home-slide buttons per SPEC "PowerPoint template rules". */
export function detectButtons(homeElements: SlideElement[]): ButtonDef[] {
  const candidates: ButtonDef[] = [];
  let n = 0;
  const raw: { el: SlideElement; link: SlideLink }[] = [];
  for (const el of homeElements) {
    if (el.hidden) continue;
    const link = findLink(el);
    if (link && link.targetSlide > 1) raw.push({ el, link });
  }
  raw.sort((a, b) => readingOrder({ bounds: boundsOf(a.el) }, { bounds: boundsOf(b.el) }));

  for (const { el, link } of raw) {
    n++;
    const name = el.name ?? '';
    const text = elementText(el);
    const defaultLabel = !looksLikeDefaultName(name) && name.trim() ? name.trim() : text ? text : `Button ${n}`;
    candidates.push({
      id: el.id,
      shapeName: name,
      text,
      defaultLabel,
      targetSlide: link.targetSlide,
      bounds: boundsOf(el),
    });
  }
  return candidates;
}

/** Detect shapes on a non-home slide that link back to slide 1 ("Home" shapes). */
export function detectHomeLinks(slideIndex: number, elements: SlideElement[]): HomeLinkDef[] {
  const out: HomeLinkDef[] = [];
  for (const el of elements) {
    if (el.hidden) continue;
    const link = findLink(el);
    if (link && link.targetSlide === 1) {
      out.push({ slide: slideIndex, id: el.id, bounds: boundsOf(el) });
    }
  }
  return out;
}
