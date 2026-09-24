import type { Color } from '../types';
import { children, child, attr, attrNum, localTag } from './xml';

export interface ThemeFonts {
  major: string;
  minor: string;
}

export interface Theme {
  name: string;
  /** dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink -> hex (no #) */
  scheme: Record<string, string>;
  fonts: ThemeFonts;
}

/** master's <p:clrMap>: placeholder name (bg1,tx1,bg2,tx2,accentN,hlink,folHlink) -> theme scheme slot. */
export type ClrMap = Record<string, string>;

const DEFAULT_THEME: Theme = {
  name: 'default',
  scheme: {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '44546A',
    lt2: 'E7E6E6',
    accent1: '4472C4',
    accent2: 'ED7D31',
    accent3: 'A5A5A5',
    accent4: 'FFC000',
    accent5: '5B9BD5',
    accent6: '70AD47',
    hlink: '0563C1',
    folHlink: '954F72',
  },
  fonts: { major: 'Calibri', minor: 'Calibri' },
};

const DEFAULT_CLR_MAP: ClrMap = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
};

export function defaultTheme(): Theme {
  return DEFAULT_THEME;
}

export function defaultClrMap(): ClrMap {
  return DEFAULT_CLR_MAP;
}

export function parseTheme(doc: Document | null): Theme {
  if (!doc) return DEFAULT_THEME;
  const themeEl = doc.documentElement;
  const name = attr(themeEl, 'name') ?? 'theme';
  const elements = child(doc, 'themeElements');
  const clrScheme = child(elements, 'clrScheme');
  const scheme: Record<string, string> = { ...DEFAULT_THEME.scheme };
  if (clrScheme) {
    for (const el of Array.from(clrScheme.children)) {
      const slot = localTag(el);
      const hex = readColorValue(el.children[0] ?? null);
      if (hex) scheme[slot] = hex;
    }
  }
  const fontScheme = child(elements, 'fontScheme');
  const majorFont = child(fontScheme, 'majorFont');
  const minorFont = child(fontScheme, 'minorFont');
  const major = attr(child(majorFont, 'latin'), 'typeface') || DEFAULT_THEME.fonts.major;
  const minor = attr(child(minorFont, 'latin'), 'typeface') || DEFAULT_THEME.fonts.minor;
  return { name, scheme, fonts: { major, minor } };
}

export function parseClrMap(masterEl: Element | Document | null): ClrMap {
  const clrMapEl = child(masterEl, 'clrMap');
  if (!clrMapEl) return DEFAULT_CLR_MAP;
  const map: ClrMap = {};
  for (const key of Object.keys(DEFAULT_CLR_MAP)) {
    map[key] = attr(clrMapEl, key) ?? DEFAULT_CLR_MAP[key];
  }
  return map;
}

/** Read a plain colour value (srgbClr/sysClr/prstClr) with no modifiers, hex without #. */
function readColorValue(el: Element | null): string | null {
  if (!el) return null;
  const tag = localTag(el);
  if (tag === 'srgbClr') return attr(el, 'val');
  if (tag === 'sysClr') return attr(el, 'lastClr') || attr(el, 'val');
  if (tag === 'prstClr') return PRESET_COLORS[attr(el, 'val') ?? ''] ?? null;
  return null;
}

// A modest subset of the ~140 DrawingML preset colour names (CSS-equivalent hex).
const PRESET_COLORS: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
  yellow: 'FFFF00', orange: 'FFA500', purple: '800080', gray: '808080', grey: '808080',
  silver: 'C0C0C0', maroon: '800000', navy: '000080', teal: '008080', olive: '808000',
  lime: '00FF00', aqua: '00FFFF', fuchsia: 'FF00FF', pink: 'FFC0CB', brown: 'A52A2A',
  gold: 'FFD700', indigo: '4B0082', ivory: 'FFFFF0', khaki: 'F0E68C', salmon: 'FA8072',
  tan: 'D2B48C', turquoise: '40E0D0', violet: 'EE82EE', coral: 'FF7F50', crimson: 'DC143C',
  darkBlue: '00008B', darkGray: 'A9A9A9', darkGreen: '006400', darkOrange: 'FF8C00',
  darkRed: '8B0000', lightBlue: 'ADD8E6', lightGray: 'D3D3D3', lightGreen: '90EE90',
  lightYellow: 'FFFFE0', magenta: 'FF00FF', cyan: '00FFFF', transparent: 'FFFFFF',
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').padStart(6, '0');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Apply DrawingML colour transforms (lumMod/lumOff/tint/shade) found as children of a colour element. */
export function applyColorMods(hex: string, modsHost: Element): string {
  let [r, g, b] = hexToRgb(hex);
  let alpha = 1;
  for (const mod of Array.from(modsHost.children)) {
    const tag = localTag(mod);
    const valAttr = attr(mod, 'val');
    const val = valAttr ? Number(valAttr) / 100000 : 0;
    if (tag === 'lumMod' || tag === 'lumOff') {
      const [h, s, l] = rgbToHsl(r, g, b);
      const lumMod = tag === 'lumMod' ? val : 1;
      const lumOff = tag === 'lumOff' ? val : 0;
      // lumMod/lumOff often arrive as a pair; approximate by applying each as it's seen,
      // rescaling L directly (good enough for the tint/shade-style adjustments PowerPoint themes use).
      const newL = tag === 'lumMod' ? l * lumMod : l + lumOff;
      [r, g, b] = hslToRgb(h, s, Math.max(0, Math.min(1, newL)));
    } else if (tag === 'tint') {
      r = r * val + 255 * (1 - val);
      g = g * val + 255 * (1 - val);
      b = b * val + 255 * (1 - val);
    } else if (tag === 'shade') {
      r *= val; g *= val; b *= val;
    } else if (tag === 'alpha') {
      alpha = val;
    }
  }
  const hexOut = rgbToHex(r, g, b);
  return alpha < 1 ? withAlpha(hexOut, alpha) : `#${hexOut}`;
}

function withAlpha(hex: string, alpha: number): Color {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.round(alpha * 1000) / 1000})`;
}

export interface ColorCtx {
  theme: Theme;
  clrMap: ClrMap;
}

/**
 * Resolve a colour element: srgbClr, schemeClr, sysClr, prstClr (with optional
 * lumMod/lumOff/tint/shade/alpha children) to a CSS colour string.
 */
export function resolveColor(el: Element | null, ctx: ColorCtx, fallback: Color = '#000000'): Color {
  if (!el) return fallback;
  const tag = localTag(el);
  let hex: string | null = null;
  if (tag === 'srgbClr') {
    hex = attr(el, 'val');
  } else if (tag === 'sysClr') {
    hex = attr(el, 'lastClr') || attr(el, 'val');
  } else if (tag === 'prstClr') {
    hex = PRESET_COLORS[attr(el, 'val') ?? ''] ?? null;
  } else if (tag === 'schemeClr') {
    const val = attr(el, 'val') ?? '';
    if (val === 'phClr') {
      hex = null; // pattern-fill placeholder colour; not resolvable without a parent fill context
    } else {
      const mapped = ctx.clrMap[val] ?? val; // direct dk1/lt1/accentN/hlink/folHlink also valid
      hex = ctx.theme.scheme[mapped] ?? ctx.theme.scheme[val] ?? null;
    }
  }
  if (!hex) return fallback;
  if (el.children.length > 0) return applyColorMods(hex, el);
  return `#${hex}`;
}

/** Find the first recognised colour-value child (srgbClr/schemeClr/sysClr/prstClr) of a fill/line element. */
export function firstColorChild(host: Element | null): Element | null {
  if (!host) return null;
  for (const el of Array.from(host.children)) {
    const tag = localTag(el);
    if (tag === 'srgbClr' || tag === 'schemeClr' || tag === 'sysClr' || tag === 'prstClr') return el;
  }
  return null;
}

export { children, attrNum };
