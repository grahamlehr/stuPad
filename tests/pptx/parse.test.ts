import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePptx } from '../../src/pptx';

const FIXTURES = path.resolve(__dirname, '../fixtures');

async function loadFixture(name: string): Promise<ArrayBuffer> {
  const buf = await fs.readFile(path.join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('parsePptx: good.pptx', () => {
  it('parses slides, buttons, home links with no errors', async () => {
    const data = await loadFixture('good.pptx');
    const result = await parsePptx(data, 'good.pptx');
    expect(result.deck).toBeDefined();
    const deck = result.deck!;
    expect(deck.slides.length).toBe(6);
    expect(deck.slideWidthEmu).toBeGreaterThan(0);
    expect(deck.height).toBeCloseTo(1920 * (deck.slideHeightEmu / deck.slideWidthEmu), 1);

    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('detects 4 buttons in reading order with correct labels and targets', async () => {
    const data = await loadFixture('good.pptx');
    const result = await parsePptx(data, 'good.pptx');
    const deck = result.deck!;
    expect(deck.buttons.length).toBe(4);
    // Shapes are named (not PowerPoint defaults like "Rectangle 3"), so per SPEC the
    // shape name is used as the default label, not the shape's own text.
    expect(deck.buttons.map((b) => b.defaultLabel)).toEqual(['Sustainability', 'Innovation', 'People', 'Contact']);
    expect(deck.buttons.map((b) => b.text)).toEqual(['Sustainability', 'Innovation', 'People', 'Contact']);
    expect(deck.buttons.map((b) => b.targetSlide)).toEqual([2, 3, 4, 5]);
    expect(deck.buttons.map((b) => b.shapeName)).toEqual(['BTN_Sustainability', 'BTN_Innovation', 'BTN_People', 'BTN_Contact']);
  });

  it('detects home links on each destination slide', async () => {
    const data = await loadFixture('good.pptx');
    const result = await parsePptx(data, 'good.pptx');
    const deck = result.deck!;
    const homeSlides = deck.homeLinks.map((h) => h.slide).sort();
    expect(homeSlides).toEqual([2, 3, 4, 5]);
  });

  it('flags slide 6 as unlinked (warning, not error)', async () => {
    const data = await loadFixture('good.pptx');
    const result = await parsePptx(data, 'good.pptx');
    const unlinked = result.issues.find((i) => i.code === 'unlinked_slide');
    expect(unlinked).toBeDefined();
    expect(unlinked!.severity).toBe('warning');
    expect(unlinked!.slide).toBe(6);
  });

  it('resolves button fill colours and geometry', async () => {
    const data = await loadFixture('good.pptx');
    const result = await parsePptx(data, 'good.pptx');
    const deck = result.deck!;
    const home = deck.slides[0];
    const btnEl = home.elements.find((e) => e.kind === 'shape' && e.name === 'BTN_Sustainability');
    expect(btnEl).toBeDefined();
    expect(btnEl!.kind).toBe('shape');
    if (btnEl!.kind === 'shape') {
      expect(btnEl!.geom).toBe('roundRect');
      expect(btnEl!.fill).toEqual({ type: 'solid', color: '#2E7D6B' });
      expect(btnEl!.cornerRadius).toBeGreaterThan(0);
    }
  });
});

describe('parsePptx: one-button.pptx', () => {
  it('reports too_few_buttons as an error', async () => {
    const data = await loadFixture('one-button.pptx');
    const result = await parsePptx(data, 'one-button.pptx');
    const deck = result.deck!;
    expect(deck.buttons.length).toBe(1);
    const issue = result.issues.find((i) => i.code === 'too_few_buttons');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });
});

describe('parsePptx: broken-link.pptx', () => {
  it('reports a broken_link error and excludes the broken button', async () => {
    const data = await loadFixture('broken-link.pptx');
    const result = await parsePptx(data, 'broken-link.pptx');
    const issue = result.issues.find((i) => i.code === 'broken_link');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    // Sustainability's link was broken; only 3 valid buttons remain.
    const deck = result.deck!;
    expect(deck.buttons.map((b) => b.shapeName)).not.toContain('BTN_Sustainability');
  });
});

describe('parsePptx: grouped-button.pptx', () => {
  it('detects the group itself as a button via its own hlinkClick', async () => {
    const data = await loadFixture('grouped-button.pptx');
    const result = await parsePptx(data, 'grouped-button.pptx');
    const deck = result.deck!;
    const group = deck.buttons.find((b) => b.shapeName === 'Group Button');
    expect(group).toBeDefined();
    expect(group!.targetSlide).toBe(4);
  });
});

describe('parsePptx: with-image.pptx', () => {
  it('parses an image element with media stored and a gradient/solid background', async () => {
    const data = await loadFixture('with-image.pptx');
    const result = await parsePptx(data, 'with-image.pptx');
    const deck = result.deck!;
    const dest = deck.slides[1];
    const pic = dest.elements.find((e) => e.kind === 'picture');
    expect(pic).toBeDefined();
    if (pic && pic.kind === 'picture') {
      expect(deck.media[pic.mediaKey]).toBeDefined();
      expect(deck.media[pic.mediaKey].mime).toBe('image/png');
    }
    expect(dest.background.type).toBe('solid');
  });
});

describe('parsePptx: unreadable file', () => {
  it('returns unreadable_file for non-zip data', async () => {
    const bad = new TextEncoder().encode('not a zip file').buffer;
    const result = await parsePptx(bad, 'bad.pptx');
    expect(result.deck).toBeUndefined();
    expect(result.issues.some((i) => i.code === 'unreadable_file')).toBe(true);
  });
});

describe('prettyName', () => {
  it('strips a BTN prefix and separators', async () => {
    const { prettyName } = await import('../../src/pptx/buttons');
    expect(prettyName('BTN_Sustainability')).toBe('Sustainability');
    expect(prettyName('btn-our_people')).toBe('our people');
    expect(prettyName('Visit Us')).toBe('Visit Us');
    expect(prettyName('BTN_')).toBe('BTN_');
  });
});

describe('template run links', () => {
  it('has no underlined or run-level links on button captions', async () => {
    const JSZip = (await import('jszip')).default;
    const buf = await fs.readFile(path.resolve(__dirname, '../../public/template.pptx'));
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).not.toMatch(/u="sng"/);
    expect(xml.match(/<a:hlinkClick/g)?.length).toBe(4);
  });
});
