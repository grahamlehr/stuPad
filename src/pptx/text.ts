import type { Paragraph, TextBody, TextRun, Color } from '../types';
import { children, child, attr, attrNum, textContent } from './xml';
import { resolveColor, firstColorChild, type ColorCtx, type Theme } from './color';
import { ptToPx } from './geometry';

export interface TextResolveCtx extends ColorCtx {
  slideWidthEmu: number;
  slideWidthPx: number;
  /** run-property fallback chain, outermost (least specific) first: e.g. [master lvl style, layout ph, ...] */
  defaults?: RunDefaults[];
}

export interface RunDefaults {
  size?: number; // pt
  color?: Color;
  bold?: boolean;
  italic?: boolean;
  font?: string;
}

function resolveFont(typeface: string | null, theme: Theme): string | undefined {
  if (!typeface) return undefined;
  if (typeface === '+mj-lt' || typeface === '+mj-ea' || typeface === '+mj-cs') return theme.fonts.major;
  if (typeface === '+mn-lt' || typeface === '+mn-ea' || typeface === '+mn-cs') return theme.fonts.minor;
  return typeface;
}

function mergeDefaults(defaults: RunDefaults[] | undefined): RunDefaults {
  const out: RunDefaults = {};
  for (const d of defaults ?? []) Object.assign(out, d);
  return out;
}

function parseRunProps(rPr: Element | null, ctx: TextResolveCtx): TextRun {
  const merged = mergeDefaults(ctx.defaults);
  const szAttr = attr(rPr, 'sz');
  const sizePt = szAttr ? Number(szAttr) / 100 : merged.size ?? 18;
  const bold = rPr ? (attr(rPr, 'b') === '1' ? true : attr(rPr, 'b') === '0' ? false : merged.bold ?? false) : merged.bold ?? false;
  const italic = rPr ? (attr(rPr, 'i') === '1' ? true : attr(rPr, 'i') === '0' ? false : merged.italic ?? false) : merged.italic ?? false;
  const uAttr = rPr ? attr(rPr, 'u') : null;
  const underline = uAttr != null && uAttr !== 'none';

  const solidFill = child(rPr, 'solidFill');
  const colorEl = firstColorChild(solidFill);
  const color = colorEl ? resolveColor(colorEl, ctx, merged.color ?? '#000000') : merged.color ?? '#000000';

  const latin = child(rPr, 'latin');
  const font = resolveFont(attr(latin, 'typeface'), ctx.theme) ?? merged.font ?? ctx.theme.fonts.minor;

  const size = ptToPx(sizePt, ctx.slideWidthEmu, ctx.slideWidthPx);

  let link: TextRun['link'];
  const hlink = child(rPr, 'hlinkClick');
  if (hlink) {
    const target = resolveHlinkTarget?.(hlink);
    if (target) link = target;
  }

  return { text: '', font, size, color, bold, italic, underline, link };
}

/** Hook the slide-level link resolver sets so run-level hlinkClick (rare) can resolve too. */
let resolveHlinkTarget: ((hlinkEl: Element) => { targetSlide: number } | undefined) | undefined;
export function setRunLinkResolver(fn: typeof resolveHlinkTarget) {
  resolveHlinkTarget = fn;
}

function parseBullet(pPr: Element | null): Paragraph['bullet'] {
  if (!pPr) return undefined;
  const buChar = child(pPr, 'buChar');
  const buAutoNum = child(pPr, 'buAutoNum');
  const buNone = child(pPr, 'buNone');
  if (buNone) return undefined;
  if (buChar) {
    const buClr = child(pPr, 'buClrTx') ? undefined : child(pPr, 'buClr');
    return { type: 'char', char: attr(buChar, 'char') ?? '•', color: buClr ? undefined : undefined };
  }
  if (buAutoNum) {
    return { type: 'autoNum', scheme: attr(buAutoNum, 'type') ?? 'arabicPeriod', startAt: attrNum(buAutoNum, 'startAt', 1) };
  }
  return undefined;
}

function parseAlign(pPr: Element | null): Paragraph['align'] {
  const algn = attr(pPr, 'algn');
  if (algn === 'ctr') return 'center';
  if (algn === 'r') return 'right';
  if (algn === 'just' || algn === 'justLow') return 'justify';
  return 'left';
}

export function parseParagraph(pEl: Element, ctx: TextResolveCtx): Paragraph {
  const pPr = child(pEl, 'pPr');
  const level = attrNum(pPr, 'lvl', 0);
  const marginLeft = ptToPx(attrNum(pPr, 'marL', 0) / 12700, ctx.slideWidthEmu, ctx.slideWidthPx);
  const indent = ptToPx(attrNum(pPr, 'indent', 0) / 12700, ctx.slideWidthEmu, ctx.slideWidthPx);
  const spcBef = child(pPr, 'spcBef');
  const spcAft = child(pPr, 'spcAft');
  const spaceBefore = spcBef ? ptToPx(attrNum(child(spcBef, 'spcPts'), 'val', 0) / 100, ctx.slideWidthEmu, ctx.slideWidthPx) : 0;
  const spaceAfter = spcAft ? ptToPx(attrNum(child(spcAft, 'spcPts'), 'val', 0) / 100, ctx.slideWidthEmu, ctx.slideWidthPx) : 0;
  const lnSpc = child(pPr, 'lnSpc');
  const spcPct = child(lnSpc, 'spcPct');
  const lineSpacing = spcPct ? attrNum(spcPct, 'val', 100000) / 100000 : 1;

  const runs: TextRun[] = [];
  for (const child_ of Array.from(pEl.children)) {
    const tag = child_.nodeName.split(':').pop();
    if (tag === 'r') {
      const rPr = child(child_, 'rPr');
      const run = parseRunProps(rPr, ctx);
      run.text = textContent(child(child_, 't'));
      runs.push(run);
    } else if (tag === 'br') {
      runs.push({ text: '\n', font: ctx.theme.fonts.minor, size: ptToPx(18, ctx.slideWidthEmu, ctx.slideWidthPx), color: '#000000', bold: false, italic: false, underline: false });
    }
  }

  const endParaRPr = child(pEl, 'endParaRPr');
  let emptySize: number | undefined;
  if (runs.length === 0) {
    const szAttr = attr(endParaRPr, 'sz');
    const sizePt = szAttr ? Number(szAttr) / 100 : mergeDefaults(ctx.defaults).size ?? 18;
    emptySize = ptToPx(sizePt, ctx.slideWidthEmu, ctx.slideWidthPx);
  }

  return {
    align: parseAlign(pPr),
    level,
    bullet: parseBullet(pPr),
    lineSpacing,
    spaceBefore,
    spaceAfter,
    marginLeft,
    indent,
    runs,
    emptySize,
  };
}

export function parseTextBody(txBody: Element | null, ctx: TextResolveCtx): TextBody | undefined {
  if (!txBody) return undefined;
  const bodyPr = child(txBody, 'bodyPr');
  const anchorAttr = attr(bodyPr, 'anchor');
  const anchor: TextBody['anchor'] = anchorAttr === 'ctr' ? 'middle' : anchorAttr === 'b' ? 'bottom' : 'top';
  const wrap = attr(bodyPr, 'wrap') !== 'none';
  const inset = {
    l: ptToPx(attrNum(bodyPr, 'lIns', 91440) / 12700, ctx.slideWidthEmu, ctx.slideWidthPx),
    t: ptToPx(attrNum(bodyPr, 'tIns', 45720) / 12700, ctx.slideWidthEmu, ctx.slideWidthPx),
    r: ptToPx(attrNum(bodyPr, 'rIns', 91440) / 12700, ctx.slideWidthEmu, ctx.slideWidthPx),
    b: ptToPx(attrNum(bodyPr, 'bIns', 45720) / 12700, ctx.slideWidthEmu, ctx.slideWidthPx),
  };
  const paragraphs = children(txBody, 'p').map((p) => parseParagraph(p, ctx));
  return { paragraphs, anchor, inset, wrap, vertical: attr(bodyPr, 'vert') != null && attr(bodyPr, 'vert') !== 'horz' };
}

export function plainText(tb: TextBody | undefined): string {
  if (!tb) return '';
  return tb.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(''))
    .join('\n')
    .trim();
}
