import type { Xfrm } from '../types';
import { children, attr, attrNum, child } from './xml';

/** Points -> EMU (1pt = 12700 EMU). */
export const PT_PER_EMU = 1 / 12700;

export interface Scale {
  /** slide px per EMU */
  pxPerEmu: number;
}

export function makeScale(slideWidthEmu: number, slideWidthPx: number): Scale {
  return { pxPerEmu: slideWidthPx / slideWidthEmu };
}

export function emuToPx(emu: number, scale: Scale): number {
  return emu * scale.pxPerEmu;
}

/** pt * SLIDE_W / (slideWidthEmu / 12700) — matches the convention documented in types.ts. */
export function ptToPx(pt: number, slideWidthEmu: number, slideWidthPx: number): number {
  return (pt * slideWidthPx) / (slideWidthEmu / 12700);
}

const IDENTITY: Xfrm = { x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false };

/** Parse an <a:xfrm> element (child of spPr/grpSpPr/graphicFrame) into slide-px Xfrm. */
export function parseXfrm(spPr: Element | null, scale: Scale): Xfrm | undefined {
  const xfrm = child(spPr, 'xfrm');
  if (!xfrm) return undefined;
  const off = child(xfrm, 'off');
  const ext = child(xfrm, 'ext');
  const x = emuToPx(attrNum(off, 'x', 0), scale);
  const y = emuToPx(attrNum(off, 'y', 0), scale);
  const w = emuToPx(attrNum(ext, 'cx', 0), scale);
  const h = emuToPx(attrNum(ext, 'cy', 0), scale);
  const rotAttr = attr(xfrm, 'rot');
  const rot = rotAttr ? Number(rotAttr) / 60000 : 0;
  const flipH = attr(xfrm, 'flipH') === '1';
  const flipV = attr(xfrm, 'flipV') === '1';
  return { x, y, w, h, rot, flipH, flipV };
}

export function emptyXfrm(): Xfrm {
  return { ...IDENTITY };
}

/** chOff/chExt of a group's own <a:xfrm>, in slide px (for mapping children into slide space). */
export function groupChildSpace(spPr: Element | null, scale: Scale) {
  const xfrm = child(spPr, 'xfrm');
  const chOffEl = child(xfrm, 'chOff');
  const chExtEl = child(xfrm, 'chExt');
  const off = child(xfrm, 'off');
  const ext = child(xfrm, 'ext');
  const chOff = {
    x: emuToPx(attrNum(chOffEl, 'x', attrNum(off, 'x', 0)), scale),
    y: emuToPx(attrNum(chOffEl, 'y', attrNum(off, 'y', 0)), scale),
  };
  const chExt = {
    w: emuToPx(attrNum(chExtEl, 'cx', attrNum(ext, 'cx', 0)), scale),
    h: emuToPx(attrNum(chExtEl, 'cy', attrNum(ext, 'cy', 0)), scale),
  };
  const groupOff = { x: emuToPx(attrNum(off, 'x', 0), scale), y: emuToPx(attrNum(off, 'y', 0), scale) };
  const groupExt = { w: emuToPx(attrNum(ext, 'cx', 0), scale), h: emuToPx(attrNum(ext, 'cy', 0), scale) };
  return { chOff, chExt, groupOff, groupExt };
}

/**
 * Map a child xfrm (already in slide px, expressed in the group's child coordinate
 * space) into the parent/slide coordinate space, given the group's own off/ext and
 * chOff/chExt (OOXML group transform).
 */
export function applyGroupTransform(childXfrm: Xfrm, group: ReturnType<typeof groupChildSpace>): Xfrm {
  const { chOff, chExt, groupOff, groupExt } = group;
  const sx = chExt.w !== 0 ? groupExt.w / chExt.w : 1;
  const sy = chExt.h !== 0 ? groupExt.h / chExt.h : 1;
  return {
    ...childXfrm,
    x: groupOff.x + (childXfrm.x - chOff.x) * sx,
    y: groupOff.y + (childXfrm.y - chOff.y) * sy,
    w: childXfrm.w * sx,
    h: childXfrm.h * sy,
  };
}

export function unrotatedBoundsFromXfrm(x: Xfrm) {
  return { x: x.x, y: x.y, w: x.w, h: x.h };
}

export { children };
