import type {
  SlideElement, ShapeElement, PictureElement, GroupElement, TableElement, TableCell,
  Fill, Line, SlideLink, Issue, MediaItem, Rect,
} from '../types';
import { children, child, attr, attrNum, localTag } from './xml';
import { resolveColor, firstColorChild, type ColorCtx } from './color';
import { parseTextBody, type TextResolveCtx } from './text';
import {
  emuToPx, parseXfrm, groupChildSpace, applyGroupTransform, type Scale,
} from './geometry';
import type { Rel } from './zip';
import { Pkg, mimeForPath } from './zip';

export interface ShapeParseCtx extends TextResolveCtx {
  scale: Scale;
  rels: Rel[];
  slidePathToIndex: Map<string, number>;
  media: Record<string, MediaItem>;
  pkg: Pkg;
  issues: Issue[];
  slideIndex: number;
}

const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

export function resolveLink(cNvPr: Element | null, ctx: ShapeParseCtx): SlideLink | undefined {
  const hlink = child(cNvPr, 'hlinkClick');
  if (!hlink) return undefined;
  const action = attr(hlink, 'action') ?? '';
  const rId = attr(hlink, 'id'); // r:id, namespace-stripped by attr()
  if (action.includes('hlinksldjump')) {
    if (!rId) {
      ctx.issues.push({ severity: 'error', code: 'broken_link', message: `Slide ${ctx.slideIndex}: link with no target`, slide: ctx.slideIndex });
      return undefined;
    }
    const rel = ctx.rels.find((r) => r.id === rId);
    if (!rel || rel.type !== SLIDE_REL_TYPE) {
      ctx.issues.push({ severity: 'error', code: 'broken_link', message: `Slide ${ctx.slideIndex}: link target "${rId}" could not be resolved`, slide: ctx.slideIndex });
      return undefined;
    }
    const targetSlide = ctx.slidePathToIndex.get(rel.target);
    if (targetSlide == null) {
      ctx.issues.push({ severity: 'error', code: 'broken_link', message: `Slide ${ctx.slideIndex}: link target "${rel.target}" is not a slide`, slide: ctx.slideIndex });
      return undefined;
    }
    return { targetSlide };
  }
  if (action.includes('hlinkshowjump')) {
    const slideCount = ctx.slidePathToIndex.size;
    if (action.includes('firstslide')) return { targetSlide: 1 };
    // "Last Slide Viewed": checked before 'lastslide', which is a substring of it.
    if (action.includes('lastslideviewed')) return { targetSlide: 0, back: true };
    if (action.includes('lastslide')) return slideCount > 0 ? { targetSlide: slideCount } : undefined;
    if (action.includes('nextslide')) {
      const target = ctx.slideIndex + 1;
      return target <= slideCount ? { targetSlide: target } : undefined; // last slide: no next slide to link to
    }
    if (action.includes('previousslide')) {
      const target = ctx.slideIndex - 1;
      return target >= 1 ? { targetSlide: target } : undefined; // first slide: no previous slide
    }
    return undefined;
  }
  return undefined;
}

function parseFill(spPr: Element | null, ctx: ColorCtx): Fill {
  if (!spPr) return { type: 'none' };
  for (const el of Array.from(spPr.children)) {
    const tag = localTag(el);
    if (tag === 'noFill') return { type: 'none' };
    if (tag === 'solidFill') {
      const c = firstColorChild(el);
      return { type: 'solid', color: resolveColor(c, ctx) };
    }
    if (tag === 'gradFill') return parseGradFill(el, ctx);
    if (tag === 'blipFill') {
      // resolved to a media fill by the caller (needs rels); return a placeholder here,
      // overridden by parseFillWithMedia below when applicable.
      return { type: 'none' };
    }
  }
  return { type: 'none' };
}

function parseGradFill(el: Element, ctx: ColorCtx): Fill {
  const gsLst = child(el, 'gsLst');
  const stops = children(gsLst, 'gs').map((gs) => {
    const pos = attrNum(gs, 'pos', 0) / 100000;
    const c = firstColorChild(gs);
    return { pos, color: resolveColor(c, ctx) };
  });
  const lin = child(el, 'lin');
  const angle = lin ? attrNum(lin, 'ang', 0) / 60000 : 90;
  return { type: 'gradient', kind: lin ? 'linear' : 'radial', angle, stops };
}

async function parseFillWithMedia(spPr: Element | null, ctx: ShapeParseCtx): Promise<Fill> {
  const blipFill = child(spPr, 'blipFill');
  if (blipFill) {
    const blip = child(blipFill, 'blip');
    const embedId = attr(blip, 'embed');
    const rel = embedId ? ctx.rels.find((r) => r.id === embedId) : undefined;
    if (rel) {
      await ensureMedia(rel.target, ctx);
      const tile = child(blipFill, 'tile');
      return { type: 'image', mediaKey: rel.target, mode: tile ? 'tile' : 'stretch' };
    }
  }
  return parseFill(spPr, ctx);
}

function parseLine(spPr: Element | null, ctx: ColorCtx, scale: Scale): Line | undefined {
  const ln = child(spPr, 'ln');
  if (!ln) return undefined;
  const solidFill = child(ln, 'solidFill');
  if (!solidFill) return undefined; // noFill / no line
  const c = firstColorChild(solidFill);
  const color = resolveColor(c, ctx);
  const widthEmu = attrNum(ln, 'w', 12700);
  const width = emuToPx(widthEmu, scale);
  const prstDash = attr(child(ln, 'prstDash'), 'val');
  let dash: Line['dash'] = 'solid';
  if (prstDash) {
    if (prstDash.toLowerCase().includes('dot')) dash = 'dot';
    else if (prstDash !== 'solid') dash = 'dash';
  }
  return { color, width, dash };
}

const GEOM_MAP: Record<string, ShapeElement['geom']> = {
  rect: 'rect',
  roundRect: 'roundRect',
  round2SameRect: 'roundRect',
  round2DiagRect: 'roundRect',
  ellipse: 'ellipse',
  line: 'line',
  straightConnector1: 'line',
  bentConnector2: 'line',
  bentConnector3: 'line',
};

function cornerRadiusFromAvLst(prstGeom: Element | null, w: number, h: number): number | undefined {
  const avLst = child(prstGeom, 'avLst');
  const gd = children(avLst, 'gd').find((g) => attr(g, 'name') === 'adj');
  if (!gd) return undefined;
  const fmla = attr(gd, 'fmla') ?? '';
  const m = fmla.match(/val\s+(-?\d+)/);
  if (!m) return undefined;
  const frac = Number(m[1]) / 100000;
  return frac * Math.min(w, h);
}

async function ensureMedia(mediaKey: string, ctx: ShapeParseCtx) {
  if (ctx.media[mediaKey]) return;
  const blob = await ctx.pkg.blob(mediaKey, mimeForPath(mediaKey));
  if (blob) ctx.media[mediaKey] = { blob, mime: mimeForPath(mediaKey) };
}

async function parseSp(el: Element, ctx: ShapeParseCtx): Promise<ShapeElement> {
  const cNvPr = child(child(el, 'nvSpPr'), 'cNvPr');
  const spPr = child(el, 'spPr');
  const xfrm = parseXfrm(spPr, ctx.scale) ?? { x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false };
  const prstGeom = child(spPr, 'prstGeom');
  const custGeom = child(spPr, 'custGeom');
  const prst = attr(prstGeom, 'prst') ?? '';
  let geom: ShapeElement['geom'] = GEOM_MAP[prst] ?? 'other';
  if (custGeom || (!prstGeom && !custGeom)) geom = prstGeom ? geom : 'rect';
  if (!GEOM_MAP[prst] && prstGeom) {
    ctx.issues.push({ severity: 'warning', code: 'unsupported_element', message: `Slide ${ctx.slideIndex}: unsupported shape preset "${prst}"`, slide: ctx.slideIndex });
    geom = 'other';
  }
  if (custGeom) {
    ctx.issues.push({ severity: 'warning', code: 'unsupported_element', message: `Slide ${ctx.slideIndex}: custom geometry shape not fully supported`, slide: ctx.slideIndex });
    geom = 'other';
  }
  const cornerRadius = geom === 'roundRect' ? cornerRadiusFromAvLst(prstGeom, xfrm.w, xfrm.h) : undefined;

  const fill = await parseFillWithMedia(spPr, ctx);
  const line = parseLine(spPr, ctx, ctx.scale);
  const txBody = child(el, 'txBody');
  const text = parseTextBody(txBody, ctx);

  return {
    kind: 'shape',
    id: attr(cNvPr, 'id') ?? '',
    name: attr(cNvPr, 'name') ?? '',
    xfrm,
    link: resolveLink(cNvPr, ctx),
    hidden: attr(cNvPr, 'hidden') === '1',
    geom,
    cornerRadius,
    fill,
    line,
    text,
  };
}

async function parsePic(el: Element, ctx: ShapeParseCtx): Promise<PictureElement> {
  const cNvPr = child(child(el, 'nvPicPr'), 'cNvPr');
  const spPr = child(el, 'spPr');
  const xfrm = parseXfrm(spPr, ctx.scale) ?? { x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false };
  const blipFill = child(el, 'blipFill');
  const blip = child(blipFill, 'blip');
  const embedId = attr(blip, 'embed');
  const rel = embedId ? ctx.rels.find((r) => r.id === embedId && r.type === IMAGE_REL_TYPE) : undefined;
  let mediaKey = '';
  if (rel) {
    mediaKey = rel.target;
    await ensureMedia(mediaKey, ctx);
  } else {
    ctx.issues.push({ severity: 'warning', code: 'unsupported_element', message: `Slide ${ctx.slideIndex}: image could not be resolved`, slide: ctx.slideIndex });
  }
  const srcRect = child(blipFill, 'srcRect');
  const crop = srcRect
    ? {
        l: attrNum(srcRect, 'l', 0) / 100000,
        t: attrNum(srcRect, 't', 0) / 100000,
        r: attrNum(srcRect, 'r', 0) / 100000,
        b: attrNum(srcRect, 'b', 0) / 100000,
      }
    : undefined;
  const line = parseLine(spPr, ctx, ctx.scale);

  return {
    kind: 'picture',
    id: attr(cNvPr, 'id') ?? '',
    name: attr(cNvPr, 'name') ?? '',
    xfrm,
    link: resolveLink(cNvPr, ctx),
    hidden: attr(cNvPr, 'hidden') === '1',
    mediaKey,
    crop,
    line,
  };
}

async function parseGrpSp(el: Element, ctx: ShapeParseCtx): Promise<GroupElement> {
  const cNvPr = child(child(el, 'nvGrpSpPr'), 'cNvPr');
  const grpSpPr = child(el, 'grpSpPr');
  const xfrm = parseXfrm(grpSpPr, ctx.scale) ?? { x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false };
  const space = groupChildSpace(grpSpPr, ctx.scale);
  const rawChildren = await parseShapeChildren(el, ctx);
  const children_ = rawChildren.map((c) => remapChild(c, space));

  return {
    kind: 'group',
    id: attr(cNvPr, 'id') ?? '',
    name: attr(cNvPr, 'name') ?? '',
    xfrm,
    link: resolveLink(cNvPr, ctx),
    hidden: attr(cNvPr, 'hidden') === '1',
    children: children_,
  };
}

function remapChild(el: SlideElement, space: ReturnType<typeof groupChildSpace>): SlideElement {
  const xfrm = applyGroupTransform(el.xfrm, space);
  if (el.kind === 'group') {
    return { ...el, xfrm, children: el.children };
  }
  return { ...el, xfrm } as SlideElement;
}

async function parseTable(el: Element, ctx: ShapeParseCtx): Promise<TableElement | undefined> {
  const cNvPr = child(child(el, 'nvGraphicFramePr'), 'cNvPr');
  const xfrmEl = child(el, 'xfrm');
  const off = child(xfrmEl, 'off');
  const ext = child(xfrmEl, 'ext');
  const xfrm = {
    x: emuToPx(attrNum(off, 'x', 0), ctx.scale),
    y: emuToPx(attrNum(off, 'y', 0), ctx.scale),
    w: emuToPx(attrNum(ext, 'cx', 0), ctx.scale),
    h: emuToPx(attrNum(ext, 'cy', 0), ctx.scale),
    rot: 0,
    flipH: false,
    flipV: false,
  };
  const graphic = child(el, 'graphic');
  const graphicData = child(graphic, 'graphicData');
  const uri = attr(graphicData, 'uri') ?? '';
  const tbl = child(graphicData, 'tbl');
  if (!tbl) {
    if (uri.includes('chart')) {
      ctx.issues.push({ severity: 'warning', code: 'unsupported_element', message: `Slide ${ctx.slideIndex}: chart not supported`, slide: ctx.slideIndex });
    } else if (uri.includes('diagram')) {
      ctx.issues.push({ severity: 'warning', code: 'unsupported_element', message: `Slide ${ctx.slideIndex}: SmartArt not supported`, slide: ctx.slideIndex });
    } else {
      ctx.issues.push({ severity: 'warning', code: 'unsupported_element', message: `Slide ${ctx.slideIndex}: unsupported graphic frame`, slide: ctx.slideIndex });
    }
    return undefined;
  }
  const tblGrid = child(tbl, 'tblGrid');
  const colWidths = children(tblGrid, 'gridCol').map((c) => emuToPx(attrNum(c, 'w', 0), ctx.scale));
  const trs = children(tbl, 'tr');
  const rowHeights = trs.map((tr) => emuToPx(attrNum(tr, 'h', 0), ctx.scale));
  const rows: TableCell[][] = [];
  for (const tr of trs) {
    const row: TableCell[] = [];
    for (const tc of children(tr, 'tc')) {
      const merged = attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1';
      const txBody = child(tc, 'txBody');
      const text = parseTextBody(txBody, ctx);
      const tcPr = child(tc, 'tcPr');
      const solidFill = child(tcPr, 'solidFill');
      const fill: Fill = solidFill ? { type: 'solid', color: resolveColor(firstColorChild(solidFill), ctx) } : { type: 'none' };
      row.push({
        text,
        fill,
        gridSpan: attr(tc, 'gridSpan') ? attrNum(tc, 'gridSpan', 1) : undefined,
        rowSpan: attr(tc, 'rowSpan') ? attrNum(tc, 'rowSpan', 1) : undefined,
        merged: merged || undefined,
      });
    }
    rows.push(row);
  }

  return {
    kind: 'table',
    id: attr(cNvPr, 'id') ?? '',
    name: attr(cNvPr, 'name') ?? '',
    xfrm,
    link: resolveLink(cNvPr, ctx),
    colWidths,
    rowHeights,
    rows,
  };
}

/** Parse the direct sp/pic/grpSp/graphicFrame/cxnSp children of a spTree or grpSp. */
export async function parseShapeChildren(host: Element, ctx: ShapeParseCtx): Promise<SlideElement[]> {
  const out: SlideElement[] = [];
  for (const el of Array.from(host.children)) {
    const tag = localTag(el);
    if (tag === 'sp' || tag === 'cxnSp') {
      out.push(await parseSp(el, ctx));
    } else if (tag === 'pic') {
      out.push(await parsePic(el, ctx));
    } else if (tag === 'grpSp') {
      out.push(await parseGrpSp(el, ctx));
    } else if (tag === 'graphicFrame') {
      const table = await parseTable(el, ctx);
      if (table) out.push(table);
    }
    // nvGrpSpPr / grpSpPr are structural, not elements; everything else is ignored.
  }
  return out;
}

export function boundsOf(el: SlideElement): Rect {
  return { x: el.xfrm.x, y: el.xfrm.y, w: el.xfrm.w, h: el.xfrm.h };
}
