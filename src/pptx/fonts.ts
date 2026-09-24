/**
 * Fonts considered safe: iPad system fonts plus the small set of web fonts stuPad
 * bundles itself. A font used in a deck that isn't embedded and isn't in this list
 * produces a `missing_font` warning at validation time (SPEC "Fonts").
 */
export const KNOWN_FONTS: string[] = [
  // iPadOS / Apple system fonts
  'San Francisco',
  '-apple-system',
  'SF Pro',
  'SF Pro Display',
  'SF Pro Text',
  'Helvetica',
  'Helvetica Neue',
  'Arial',
  'Arial Black',
  'Avenir',
  'Avenir Next',
  'Georgia',
  'Times New Roman',
  'Times',
  'Verdana',
  'Trebuchet MS',
  'Courier New',
  'Courier',
  'Palatino',
  'Futura',
  'Gill Sans',
  'Optima',
  'American Typewriter',
  'Baskerville',
  'Didot',
  'Hoefler Text',
  'Menlo',
  'Marker Felt',
  'Chalkboard SE',
  // bundled web fonts (see public/fonts)
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  // generic CSS fallback families
  'sans-serif',
  'serif',
  'monospace',
];

const KNOWN_FONTS_LC = new Set(KNOWN_FONTS.map((f) => f.toLowerCase()));

export function isKnownFont(family: string): boolean {
  return KNOWN_FONTS_LC.has(family.trim().toLowerCase());
}
