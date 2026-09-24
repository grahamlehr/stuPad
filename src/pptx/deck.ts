import type { Deck, Slide, SlideElement, MediaItem, Issue } from '../types';
import { SLIDE_W } from '../types';
import { Pkg } from './zip';
import { children, child, attr, attrNS, attrNum, localTag } from './xml';
import { parseTheme, parseClrMap, defaultTheme, defaultClrMap, type Theme, type ClrMap } from './color';
import { resolveBackground } from './background';
import { parseShapeChildren, type ShapeParseCtx } from './shapes';
import { makeScale, type Scale } from './geometry';
import { uuid } from '../util';

const REL = {
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
};

interface MasterInfo {
  path: string;
  theme: Theme;
  clrMap: ClrMap;
  cSld: Element | null;
  showMasterSp: boolean;
}

interface LayoutInfo {
  path: string;
  master: MasterInfo;
  cSld: Element | null;
  showMasterSp: boolean;
}

async function loadTheme(pkg: Pkg, masterPath: string): Promise<Theme> {
  const rels = await pkg.relsFor(masterPath);
  const themeRel = rels.find((r) => r.type === REL.theme);
  if (!themeRel) return defaultTheme();
  const doc = await pkg.xml(themeRel.target);
  return parseTheme(doc);
}

async function loadMaster(pkg: Pkg, masterPath: string, cache: Map<string, MasterInfo>): Promise<MasterInfo> {
  const cached = cache.get(masterPath);
  if (cached) return cached;
  const doc = await pkg.xml(masterPath);
  const cSld = doc ? child(doc, 'cSld') : null;
  const clrMapOvr = child(doc, 'clrMap'); // <p:sldMaster> holds <p:clrMap> directly
  const theme = await loadTheme(pkg, masterPath);
  const info: MasterInfo = {
    path: masterPath,
    theme,
    clrMap: clrMapOvr ? parseClrMap(doc) : defaultClrMap(),
    cSld,
    showMasterSp: attr(cSld, 'showMasterSp') !== '0',
  };
  cache.set(masterPath, info);
  return info;
}

async function loadLayout(pkg: Pkg, layoutPath: string, masterCache: Map<string, MasterInfo>): Promise<LayoutInfo> {
  const doc = await pkg.xml(layoutPath);
  const cSld = doc ? child(doc, 'cSld') : null;
  const rels = await pkg.relsFor(layoutPath);
  const masterRel = rels.find((r) => r.type === REL.slideMaster);
  const master = masterRel ? await loadMaster(pkg, masterRel.target, masterCache) : await loadMaster(pkg, '__missing__', masterCache);
  return {
    path: layoutPath,
    master,
    cSld,
    showMasterSp: attr(cSld, 'showMasterSp') !== '0',
  };
}

function isPlaceholder(el: Element): boolean {
  const tag = localTag(el);
  const nvPrHost = tag === 'sp' ? child(el, 'nvSpPr') : tag === 'pic' ? child(el, 'nvPicPr') : tag === 'grpSp' ? child(el, 'nvGrpSpPr') : null;
  const nvPr = child(nvPrHost, 'nvPr');
  return !!child(nvPr, 'ph');
}

/** Non-placeholder shapes from a spTree, in document order (used for layout/master pass-through decoration). */
function nonPlaceholderChildren(spTree: Element | null): Element[] {
  if (!spTree) return [];
  return Array.from(spTree.children).filter((el) => {
    const tag = localTag(el);
    if (!['sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp'].includes(tag)) return false;
    return !isPlaceholder(el);
  });
}

export interface LoadedPackage {
  pkg: Pkg;
  slideWidthEmu: number;
  slideHeightEmu: number;
  slidePaths: string[]; // in deck order, 1 entry per slide (index 0 = slide 1)
  slidePathToIndex: Map<string, number>;
  fontsUsed: Set<string>;
  media: Record<string, MediaItem>;
  issues: Issue[];
}

/** Parse presentation.xml + rels + every slide (with its layout/master/theme) into Deck slides. */
export async function loadDeck(pkg: Pkg, fileName: string): Promise<{ deck: Deck; issues: Issue[] }> {
  const issues: Issue[] = [];
  const presDoc = await pkg.xml('ppt/presentation.xml');
  if (!presDoc) {
    issues.push({ severity: 'error', code: 'unreadable_file', message: 'ppt/presentation.xml is missing' });
    return { deck: emptyDeck(fileName), issues };
  }
  const presRels = await pkg.relsFor('ppt/presentation.xml');
  const sldSz = child(presDoc, 'sldSz');
  const slideWidthEmu = attrNum(sldSz, 'cx', 12192000);
  const slideHeightEmu = attrNum(sldSz, 'cy', 6858000);

  const sldIdLst = child(presDoc, 'sldIdLst');
  const slideRIds = children(sldIdLst, 'sldId').map((el) => attrNS(el, 'id'));
  const slidePaths: string[] = [];
  for (const rid of slideRIds) {
    const rel = presRels.find((r) => r.id === rid);
    if (rel) slidePaths.push(rel.target);
  }

  if (slidePaths.length === 0) {
    issues.push({ severity: 'error', code: 'no_slides', message: 'The presentation has no slides' });
    return { deck: emptyDeck(fileName, slideWidthEmu, slideHeightEmu), issues };
  }

  const slidePathToIndex = new Map<string, number>();
  slidePaths.forEach((p, i) => slidePathToIndex.set(p, i + 1));

  const scale = makeScale(slideWidthEmu, SLIDE_W);
  const heightPx = SLIDE_W * (slideHeightEmu / slideWidthEmu);

  const masterCache = new Map<string, MasterInfo>();
  const layoutCache = new Map<string, LayoutInfo>();
  const media: Record<string, MediaItem> = {};
  const fontsUsed = new Set<string>();

  const slides: Slide[] = [];

  for (let i = 0; i < slidePaths.length; i++) {
    const slideIndex = i + 1;
    const slidePath = slidePaths[i];
    const doc = await pkg.xml(slidePath);
    if (!doc) {
      issues.push({ severity: 'warning', code: 'unsupported_element', message: `Slide ${slideIndex}: could not be read`, slide: slideIndex });
      slides.push({ index: slideIndex, background: { type: 'solid', color: '#FFFFFF' }, elements: [] });
      continue;
    }
    const slideRels = await pkg.relsFor(slidePath);
    const layoutRel = slideRels.find((r) => r.type === REL.slideLayout);
    let layout: LayoutInfo;
    if (layoutRel) {
      layout = layoutCache.get(layoutRel.target) ?? (await loadLayout(pkg, layoutRel.target, masterCache));
      layoutCache.set(layoutRel.target, layout);
    } else {
      const fallbackMaster: MasterInfo = { path: '', theme: defaultTheme(), clrMap: defaultClrMap(), cSld: null, showMasterSp: true };
      layout = { path: '', master: fallbackMaster, cSld: null, showMasterSp: true };
    }

    const cSld = child(doc, 'cSld');
    const slideShowMasterSp = attr(cSld, 'showMasterSp') !== '0';
    const spTree = child(cSld, 'spTree');

    const ctx: ShapeParseCtx = {
      theme: layout.master.theme,
      clrMap: layout.master.clrMap,
      slideWidthEmu,
      slideWidthPx: SLIDE_W,
      scale,
      rels: slideRels,
      slidePathToIndex,
      media,
      pkg,
      issues,
      slideIndex,
    };

    const slideElements = await parseShapeChildren(spTree!, ctx);

    let passthrough: SlideElement[] = [];
    if (layout.showMasterSp && slideShowMasterSp) {
      const masterSpTree = child(layout.master.cSld, 'spTree');
      const masterEls = await parseShapeChildren(wrapHost(nonPlaceholderChildren(masterSpTree)), ctx);
      const layoutSpTree = child(layout.cSld, 'spTree');
      const layoutEls = await parseShapeChildren(wrapHost(nonPlaceholderChildren(layoutSpTree)), ctx);
      passthrough = [...masterEls, ...layoutEls];
    }

    collectFonts(slideElements, fontsUsed);
    collectFonts(passthrough, fontsUsed);

    const background = await resolveBackground(cSld, layout.cSld, layout.master.cSld, {
      theme: layout.master.theme,
      clrMap: layout.master.clrMap,
      rels: slideRels,
      pkg,
      media,
    });

    slides.push({ index: slideIndex, background, elements: [...passthrough, ...slideElements] });
  }

  const deck: Deck = {
    id: uuid(),
    fileName,
    parsedAt: new Date().toISOString(),
    slideWidthEmu,
    slideHeightEmu,
    height: heightPx,
    slides,
    buttons: [],
    homeLinks: [],
    navLinks: [],
    backLinks: [],
    media,
    fonts: Array.from(fontsUsed).sort(),
  };

  return { deck, issues };
}

/** Wrap a plain element array in a synthetic host element so parseShapeChildren can iterate it. */
function wrapHost(elements: Element[]): Element {
  const doc = elements[0]?.ownerDocument ?? document.implementation.createDocument(null, 'host');
  const host = doc.createElement('host');
  for (const el of elements) host.appendChild(el.cloneNode(true));
  return host;
}

function collectFonts(elements: SlideElement[], out: Set<string>) {
  for (const el of elements) {
    if (el.kind === 'shape' && el.text) {
      for (const p of el.text.paragraphs) for (const r of p.runs) if (r.font) out.add(r.font);
    }
    if (el.kind === 'table') {
      for (const row of el.rows) for (const cell of row) {
        if (cell.text) for (const p of cell.text.paragraphs) for (const r of p.runs) if (r.font) out.add(r.font);
      }
    }
    if (el.kind === 'group') collectFonts(el.children, out);
  }
}

function emptyDeck(fileName: string, slideWidthEmu = 12192000, slideHeightEmu = 6858000): Deck {
  return {
    id: uuid(),
    fileName,
    parsedAt: new Date().toISOString(),
    slideWidthEmu,
    slideHeightEmu,
    height: SLIDE_W * (slideHeightEmu / slideWidthEmu),
    slides: [],
    buttons: [],
    homeLinks: [],
    navLinks: [],
    backLinks: [],
    media: {},
    fonts: [],
  };
}

export type { Scale };
