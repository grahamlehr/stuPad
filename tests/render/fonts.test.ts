import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FONT_FACES } from '../../src/render/font-faces';
import { BUNDLED_FONT_FAMILIES, fontFaceCss, embeddedFontCss, preloadDeckFonts } from '../../src/render/fonts';
import { KNOWN_FONTS, isKnownFont } from '../../src/pptx/fonts';

const FONT_DIR = path.resolve(__dirname, '../../public/fonts');

function runWith(fontFamily: string, fontStyle = 'normal'): HTMLElement {
  const root = document.createElement('div');
  const run = document.createElement('span');
  run.className = 'sr-run';
  run.style.fontFamily = `"${fontFamily}", sans-serif`;
  run.style.fontStyle = fontStyle;
  root.appendChild(run);
  return root;
}

afterEach(() => vi.unstubAllGlobals());

describe('bundled fonts', () => {
  it('manifest and public/fonts list exactly the same files', () => {
    const onDisk = fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')).sort();
    expect(FONT_FACES.map((f) => f.file).sort()).toEqual(onDisk);
  });

  it('every bundled family is a known font, so decks using it get no missing_font warning', () => {
    expect(BUNDLED_FONT_FAMILIES.length).toBeGreaterThan(0);
    for (const family of BUNDLED_FONT_FAMILIES) {
      expect(KNOWN_FONTS).toContain(family);
      expect(isKnownFont(family)).toBe(true);
    }
  });

  it('ships an OFL licence file for every bundled family', () => {
    const files = fs.readdirSync(FONT_DIR).map((f) => f.toLowerCase());
    for (const family of BUNDLED_FONT_FAMILIES) {
      expect(files).toContain(`${family.replace(/ /g, '-').toLowerCase()}-ofl.txt`);
    }
  });

  it('every entry has a woff2 file with a valid header', () => {
    for (const f of FONT_FACES) {
      const header = fs.readFileSync(path.join(FONT_DIR, f.file)).subarray(0, 4).toString('ascii');
      expect(header).toBe('wOF2');
    }
  });

  it('fontFaceCss emits one rule per file, pointing under BASE_URL/fonts', () => {
    const css = fontFaceCss();
    expect(css.match(/@font-face/g)).toHaveLength(FONT_FACES.length);
    expect(css).toContain(`url("${import.meta.env.BASE_URL}fonts/inter-normal-100-900-latin.woff2")`);
  });
});

describe('embeddedFontCss (raster fallback)', () => {
  it('inlines only the families and styles the slide uses, as data URLs', async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(['x'], { type: 'font/woff2' })));
    vi.stubGlobal('fetch', fetchMock);
    const css = await embeddedFontCss(runWith('Roboto', 'italic'));
    expect(css).toContain("font-family:'Roboto'");
    expect(css).toContain('font-style:italic');
    expect(css).not.toContain('font-style:normal');
    expect(css).not.toContain("'Inter'");
    expect(css).toContain('data:');
    expect(css).not.toContain('/fonts/');
    expect(fetchMock).toHaveBeenCalledTimes(FONT_FACES.filter((f) => f.family === 'Roboto' && f.style === 'italic').length);
  });

  it('returns nothing for a system font, and skips files that fail to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect(await embeddedFontCss(runWith('Helvetica'))).toBe('');
    expect(await embeddedFontCss(runWith('Lato'))).toBe('');
  });
});

describe('preloadDeckFonts', () => {
  it('is a no-op without the FontFaceSet API, and ignores non-bundled families', async () => {
    await expect(preloadDeckFonts(['Inter'])).resolves.toBeUndefined();
    const load = vi.fn(async () => []);
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
    await preloadDeckFonts(['Helvetica']);
    expect(load).not.toHaveBeenCalled();
    await preloadDeckFonts(['Inter']);
    expect(load).toHaveBeenCalledTimes(3);
    delete (document as unknown as { fonts?: unknown }).fonts;
  });
});
