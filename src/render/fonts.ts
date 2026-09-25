/**
 * Bundled web fonts (public/fonts, listed in the generated font-faces.ts manifest).
 *
 * Live rendering uses ordinary @font-face rules that point at the precached files. The raster
 * fallback draws slides through an SVG image, which cannot load page fonts or network URLs, so
 * it embeds the fonts it needs as data URLs instead (see `embeddedFontCss`).
 */
import { FONT_FACES, type FontFaceEntry } from './font-faces';

export const BUNDLED_FONT_FAMILIES: string[] = Array.from(new Set(FONT_FACES.map((f) => f.family)));

function fontUrl(entry: FontFaceEntry): string {
  return `${import.meta.env.BASE_URL}fonts/${entry.file}`;
}

function rule(entry: FontFaceEntry, src: string): string {
  return (
    `@font-face{font-family:'${entry.family}';font-style:${entry.style};font-weight:${entry.weight};` +
    `font-display:block;src:url("${src}") format("woff2");unicode-range:${entry.unicodeRange}}`
  );
}

/** @font-face rules for every bundled font, pointing at the files under BASE_URL. */
export function fontFaceCss(): string {
  return FONT_FACES.map((f) => rule(f, fontUrl(f))).join('\n');
}

const dataUrlCache = new Map<string, Promise<string | null>>();

function fetchAsDataUrl(entry: FontFaceEntry): Promise<string | null> {
  let p = dataUrlCache.get(entry.file);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(fontUrl(entry));
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    })();
    dataUrlCache.set(entry.file, p);
  }
  return p;
}

/**
 * @font-face rules with the font files inlined as data URLs, limited to the families (and
 * normal/italic styles) actually used by the `.sr-run` text in `root`. Fonts that cannot be
 * fetched are skipped, so the text just falls back like any other unknown font.
 */
export async function embeddedFontCss(root: HTMLElement): Promise<string> {
  const used = new Set<string>();
  for (const run of Array.from(root.querySelectorAll<HTMLElement>('.sr-run'))) {
    const family = BUNDLED_FONT_FAMILIES.find((f) => run.style.fontFamily.includes(f));
    if (family) used.add(`${family}|${run.style.fontStyle === 'italic' ? 'italic' : 'normal'}`);
  }
  const rules = await Promise.all(
    FONT_FACES.filter((f) => used.has(`${f.family}|${f.style}`)).map(async (f) => {
      const data = await fetchAsDataUrl(f);
      return data ? rule(f, data) : '';
    }),
  );
  return rules.filter(Boolean).join('\n');
}

/**
 * Loads the bundled fonts a deck uses (regular, bold and italic) so the first slide paints in
 * the right face instead of waiting on a lazy font fetch. Never throws and never waits more
 * than `timeoutMs`; no-op where the FontFaceSet API is missing (e.g. jsdom).
 */
export async function preloadDeckFonts(families: string[], timeoutMs = 3000): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return;
  const bundled = families.filter((f) => BUNDLED_FONT_FAMILIES.includes(f));
  if (bundled.length === 0) return;
  const loads = bundled.flatMap((family) =>
    ['400', '700', 'italic 400'].map((spec) => fonts.load(`${spec} 16px "${family}"`, 'Aa').catch(() => [])),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.all(loads), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
