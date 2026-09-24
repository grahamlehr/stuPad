import type { Fill } from '../types';
import { child, localTag, attr, attrNum } from './xml';
import { resolveColor, firstColorChild, type ColorCtx } from './color';
import type { Rel } from './zip';
import { Pkg, mimeForPath } from './zip';
import type { MediaItem } from '../types';

interface BgFillCtx extends ColorCtx {
  rels: Rel[];
  pkg: Pkg;
  media: Record<string, MediaItem>;
}

function parseGradFill(el: Element, ctx: ColorCtx): Fill {
  const gsLst = child(el, 'gsLst');
  const stops = Array.from(gsLst?.children ?? [])
    .filter((e) => localTag(e) === 'gs')
    .map((gs) => {
      const pos = attrNum(gs, 'pos', 0) / 100000;
      const c = firstColorChild(gs);
      return { pos, color: resolveColor(c, ctx) };
    });
  const lin = child(el, 'lin');
  const angle = lin ? attrNum(lin, 'ang', 0) / 60000 : 90;
  return { type: 'gradient', kind: lin ? 'linear' : 'radial', angle, stops };
}

async function fillFromBgPr(bgPr: Element, ctx: BgFillCtx): Promise<Fill> {
  for (const el of Array.from(bgPr.children)) {
    const tag = localTag(el);
    if (tag === 'noFill') return { type: 'none' };
    if (tag === 'solidFill') {
      const c = firstColorChild(el);
      return { type: 'solid', color: resolveColor(c, ctx) };
    }
    if (tag === 'gradFill') return parseGradFill(el, ctx);
    if (tag === 'blipFill') {
      const blip = child(el, 'blip');
      const embedId = attr(blip, 'embed');
      const rel = embedId ? ctx.rels.find((r) => r.id === embedId) : undefined;
      if (rel) {
        if (!ctx.media[rel.target]) {
          const blob = await ctx.pkg.blob(rel.target, mimeForPath(rel.target));
          if (blob) ctx.media[rel.target] = { blob, mime: mimeForPath(rel.target) };
        }
        const tile = child(el, 'tile');
        return { type: 'image', mediaKey: rel.target, mode: tile ? 'tile' : 'stretch' };
      }
    }
  }
  return { type: 'none' };
}

/**
 * Resolve a slide's background: own <p:bg>, else layout's, else master's.
 * `bgRef` (scheme-colour-indexed background, referencing the theme's fill style list)
 * is approximated as a solid fill using the referenced scheme colour.
 */
export async function resolveBackground(
  slideCSld: Element | null,
  layoutCSld: Element | null,
  masterCSld: Element | null,
  ctx: BgFillCtx
): Promise<Fill> {
  for (const cSld of [slideCSld, layoutCSld, masterCSld]) {
    if (!cSld) continue;
    const bg = child(cSld, 'bg');
    if (!bg) continue;
    const bgPr = child(bg, 'bgPr');
    if (bgPr) return fillFromBgPr(bgPr, ctx);
    const bgRef = child(bg, 'bgRef');
    if (bgRef) {
      const c = firstColorChild(bgRef);
      if (c) return { type: 'solid', color: resolveColor(c, ctx) };
    }
  }
  return { type: 'solid', color: '#FFFFFF' };
}
