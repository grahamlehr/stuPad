import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePptx, validateDeck } from '../../src/pptx';

const FIXTURES = path.resolve(__dirname, '../fixtures');

async function loadFixture(name: string): Promise<ArrayBuffer> {
  const buf = await fs.readFile(path.join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('validateDeck: matches parsePptx deck-level issues', () => {
  it('reproduces the same issues as parsePptx for good.pptx (no zip/file-size needed)', async () => {
    const data = await loadFixture('good.pptx');
    const result = await parsePptx(data, 'good.pptx');
    const deck = result.deck!;

    // good.pptx triggers no too_large/no_slides/broken_link/unreadable_file issues, so
    // parsePptx's issues are exactly what the deck-level validator alone would produce.
    expect(result.issues).toEqual(validateDeck(deck));
    // Sanity: this fixture is known (see parse.test.ts) to carry an unlinked_slide warning.
    expect(validateDeck(deck).some((i) => i.code === 'unlinked_slide')).toBe(true);
  });

  it('reproduces the same issues as parsePptx for one-button.pptx', async () => {
    const data = await loadFixture('one-button.pptx');
    const result = await parsePptx(data, 'one-button.pptx');
    const deck = result.deck!;

    expect(result.issues).toEqual(validateDeck(deck));
    // Sanity: this fixture is known (see parse.test.ts) to carry a too_few_buttons error.
    const issue = validateDeck(deck).find((i) => i.code === 'too_few_buttons');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('returns no issues for an empty-slide deck (that case needs no_slides, which validateDeck omits)', () => {
    const deck = {
      id: 'd1',
      fileName: 'empty.pptx',
      parsedAt: new Date().toISOString(),
      slideWidthEmu: 12192000,
      slideHeightEmu: 6858000,
      height: 1080,
      slides: [],
      buttons: [],
      homeLinks: [],
      media: {},
      fonts: [],
    };
    expect(validateDeck(deck)).toEqual([]);
  });
});
