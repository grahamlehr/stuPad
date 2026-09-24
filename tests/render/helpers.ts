import type {
  Deck,
  Slide,
  ShapeElement,
  PictureElement,
  GroupElement,
  TableElement,
  Xfrm,
  TextBody,
  Fill,
} from '../../src/types';
import { SLIDE_W } from '../../src/types';

export function xfrm(x: number, y: number, w: number, h: number, extra: Partial<Xfrm> = {}): Xfrm {
  return { x, y, w, h, rot: 0, flipH: false, flipV: false, ...extra };
}

export function textBody(overrides: Partial<TextBody> = {}): TextBody {
  return {
    paragraphs: [],
    anchor: 'top',
    inset: { l: 0, t: 0, r: 0, b: 0 },
    wrap: true,
    ...overrides,
  };
}

export function shape(overrides: Partial<ShapeElement> = {}): ShapeElement {
  return {
    kind: 'shape',
    id: overrides.id ?? '1',
    name: overrides.name ?? 'Rect 1',
    xfrm: overrides.xfrm ?? xfrm(0, 0, 100, 100),
    geom: 'rect',
    fill: { type: 'solid', color: '#ff0000' },
    ...overrides,
  };
}

export function picture(overrides: Partial<PictureElement> = {}): PictureElement {
  return {
    kind: 'picture',
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Picture 1',
    xfrm: overrides.xfrm ?? xfrm(0, 0, 100, 100),
    mediaKey: overrides.mediaKey ?? 'ppt/media/image1.png',
    ...overrides,
  };
}

export function group(overrides: Partial<GroupElement> = {}): GroupElement {
  return {
    kind: 'group',
    id: overrides.id ?? 'g1',
    name: overrides.name ?? 'Group 1',
    xfrm: overrides.xfrm ?? xfrm(0, 0, 200, 200),
    children: overrides.children ?? [],
    ...overrides,
  };
}

export function table(overrides: Partial<TableElement> = {}): TableElement {
  return {
    kind: 'table',
    id: overrides.id ?? 't1',
    name: overrides.name ?? 'Table 1',
    xfrm: overrides.xfrm ?? xfrm(0, 0, 200, 100),
    colWidths: overrides.colWidths ?? [100, 100],
    rowHeights: overrides.rowHeights ?? [50, 50],
    rows: overrides.rows ?? [
      [{ fill: { type: 'none' } as Fill }, { fill: { type: 'none' } as Fill }],
      [{ fill: { type: 'none' } as Fill }, { fill: { type: 'none' } as Fill }],
    ],
    ...overrides,
  };
}

export function slide(overrides: Partial<Slide> = {}): Slide {
  return {
    index: overrides.index ?? 1,
    background: overrides.background ?? { type: 'none' },
    elements: overrides.elements ?? [],
    ...overrides,
  };
}

export function deck(overrides: Partial<Deck> = {}): Deck {
  const slides = overrides.slides ?? [slide({ index: 1 })];
  return {
    id: overrides.id ?? 'deck-1',
    fileName: overrides.fileName ?? 'test.pptx',
    parsedAt: overrides.parsedAt ?? new Date().toISOString(),
    slideWidthEmu: overrides.slideWidthEmu ?? 12192000,
    slideHeightEmu: overrides.slideHeightEmu ?? 6858000,
    height: overrides.height ?? Math.round((SLIDE_W * 6858000) / 12192000),
    slides,
    buttons: overrides.buttons ?? [],
    homeLinks: overrides.homeLinks ?? [],
    navLinks: overrides.navLinks ?? [],
    media: overrides.media ?? {},
    fonts: overrides.fonts ?? [],
    ...overrides,
  };
}

export function pngBlob(): Blob {
  return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
}
