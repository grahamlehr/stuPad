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

  it('treats a slide reached only through a chain of nav links as linked (no unlinked_slide), but still warns no_home_link if it lacks one', () => {
    const deck = {
      id: 'd2',
      fileName: 'chain.pptx',
      parsedAt: new Date().toISOString(),
      slideWidthEmu: 12192000,
      slideHeightEmu: 6858000,
      height: 1080,
      slides: [{ index: 1, background: { type: 'none' }, elements: [] }, { index: 2, background: { type: 'none' }, elements: [] }, { index: 3, background: { type: 'none' }, elements: [] }],
      buttons: [
        { id: 'b1', shapeName: 'BTN_A', text: 'A', defaultLabel: 'A', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
        { id: 'b2', shapeName: 'BTN_B', text: 'B', defaultLabel: 'B', targetSlide: 2, bounds: { x: 200, y: 0, w: 200, h: 200 } },
      ],
      homeLinks: [{ slide: 2, id: 'h1', bounds: { x: 0, y: 0, w: 100, h: 100 } }],
      // Slide 2 has a Next link to slide 3, but slide 3 has no home link back.
      navLinks: [{ slide: 2, id: 'n1', shapeName: 'BTN_Next', label: 'Next', targetSlide: 3, bounds: { x: 100, y: 100, w: 100, h: 100 } }],
      backLinks: [],
      media: {},
      fonts: [],
    };
    const issues = validateDeck(deck as never);
    expect(issues.some((i) => i.code === 'unlinked_slide' && i.slide === 3)).toBe(false);
    expect(issues.some((i) => i.code === 'no_home_link' && i.slide === 3)).toBe(true);
    // Slide 2 does have a home link, so it should not be flagged.
    expect(issues.some((i) => i.code === 'no_home_link' && i.slide === 2)).toBe(false);
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
      navLinks: [],
      backLinks: [],
      pollOptions: [],
      media: {},
      fonts: [],
    };
    expect(validateDeck(deck)).toEqual([]);
  });
});

describe('validateDeck: poll/rating warnings', () => {
  function baseDeck(pollOptions: unknown[]) {
    return {
      id: 'd-poll',
      fileName: 'poll.pptx',
      parsedAt: new Date().toISOString(),
      slideWidthEmu: 12192000,
      slideHeightEmu: 6858000,
      height: 1080,
      slides: [{ index: 1, background: { type: 'none' }, elements: [] }],
      buttons: [
        { id: 'b1', shapeName: 'BTN_A', text: 'A', defaultLabel: 'A', targetSlide: 2, bounds: { x: 0, y: 0, w: 50, h: 50 } },
        { id: 'b2', shapeName: 'BTN_B', text: 'B', defaultLabel: 'B', targetSlide: 2, bounds: { x: 50, y: 0, w: 50, h: 50 } },
      ],
      homeLinks: [],
      navLinks: [],
      backLinks: [],
      pollOptions,
      media: {},
      fonts: [],
    };
  }

  function opt(over: Record<string, unknown>) {
    return {
      slide: 1,
      id: `id-${Math.random()}`,
      shapeName: 'shape',
      poll: 'Poll',
      choice: 'A',
      kind: 'vote',
      label: 'A',
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      linked: false,
      ...over,
    };
  }

  it('warns when a poll has only one option', () => {
    const deck = baseDeck([opt({ poll: 'Solo', choice: 'Only' })]);
    const issues = validateDeck(deck as never);
    expect(issues.some((i) => i.code === 'poll_single_option')).toBe(true);
  });

  it('does not warn a two-option poll', () => {
    const deck = baseDeck([opt({ poll: 'Pair', choice: 'A' }), opt({ poll: 'Pair', choice: 'B' })]);
    const issues = validateDeck(deck as never);
    expect(issues.some((i) => i.code === 'poll_single_option')).toBe(false);
  });

  it('warns when the same choice is used twice in one poll', () => {
    const deck = baseDeck([
      opt({ poll: 'Dup', choice: 'Same' }),
      opt({ poll: 'Dup', choice: 'Same' }),
      opt({ poll: 'Dup', choice: 'Different' }),
    ]);
    const issues = validateDeck(deck as never);
    expect(issues.some((i) => i.code === 'poll_duplicate_choice')).toBe(true);
  });

  it('warns on a non-numeric RATE_ choice, and not on a numeric one', () => {
    const deck = baseDeck([
      opt({ poll: 'Stand', choice: 'high', kind: 'rate' }),
      opt({ poll: 'Stand', choice: '3', kind: 'rate' }),
    ]);
    const issues = validateDeck(deck as never);
    const badRating = issues.filter((i) => i.code === 'poll_bad_rating');
    expect(badRating).toHaveLength(1);
    expect(badRating[0].message).toContain('high');
  });

  it('warns when a poll mixes VOTE_ and RATE_ options', () => {
    const deck = baseDeck([
      opt({ poll: 'Mixed', choice: 'A', kind: 'vote' }),
      opt({ poll: 'Mixed', choice: '4', kind: 'rate' }),
    ]);
    const issues = validateDeck(deck as never);
    expect(issues.some((i) => i.code === 'poll_mixed_kind')).toBe(true);
  });

  it('does not warn for a clean two-option vote poll', () => {
    const deck = baseDeck([opt({ poll: 'Clean', choice: 'A' }), opt({ poll: 'Clean', choice: 'B' })]);
    const issues = validateDeck(deck as never);
    expect(issues.filter((i) => i.code.startsWith('poll_'))).toEqual([]);
  });
});
