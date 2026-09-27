import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePptx } from '../../src/pptx';
import { detectPollOptions } from '../../src/pptx/buttons';
import type { SlideElement } from '../../src/types';

const FIXTURES = path.resolve(__dirname, '../fixtures');

async function loadFixture(name: string): Promise<ArrayBuffer> {
  const buf = await fs.readFile(path.join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function shape(over: Partial<SlideElement> & { id: string; name: string }): SlideElement {
  return {
    kind: 'shape',
    xfrm: { x: 0, y: 0, w: 100, h: 100, rot: 0, flipH: false, flipV: false },
    geom: 'rect',
    fill: { type: 'none' },
    ...over,
  } as SlideElement;
}

describe('parsePptx: polls.pptx', () => {
  it('detects every VOTE_/RATE_ option in the deck', async () => {
    const data = await loadFixture('polls.pptx');
    const result = await parsePptx(data, 'polls.pptx');
    const deck = result.deck!;

    // 2 unlinked Mood options (home) + 5 unlinked Stand ratings + 1 linked Topic vote + 1
    // unlinked single-option Single poll = 9.
    expect(deck.pollOptions.length).toBe(9);

    const mood = deck.pollOptions.filter((p) => p.poll === 'Mood');
    expect(mood.map((p) => p.choice).sort()).toEqual(['Happy', 'Sad']);
    expect(mood.every((p) => p.kind === 'vote')).toBe(true);
    expect(mood.every((p) => p.linked === false)).toBe(true);
    expect(mood.every((p) => p.slide === 1)).toBe(true);

    const stand = deck.pollOptions.filter((p) => p.poll === 'Stand');
    expect(stand.map((p) => p.choice).sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(stand.every((p) => p.kind === 'rate')).toBe(true);
    expect(stand.every((p) => p.linked === false)).toBe(true);

    const topic = deck.pollOptions.find((p) => p.poll === 'Topic');
    expect(topic).toMatchObject({ choice: 'Net_Zero', kind: 'vote', linked: true, targetSlide: 4, label: 'Net Zero' });

    const single = deck.pollOptions.filter((p) => p.poll === 'Single');
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ choice: 'OnlyOption', kind: 'vote', linked: false });
  });

  it('does not count an unlinked home-slide poll option toward the button minimum', async () => {
    const data = await loadFixture('polls.pptx');
    const result = await parsePptx(data, 'polls.pptx');
    const deck = result.deck!;
    // Only BTN_A and BTN_B; the unlinked VOTE_Mood_* shapes are not buttons.
    expect(deck.buttons.map((b) => b.shapeName).sort()).toEqual(['BTN_A', 'BTN_B']);
    expect(result.issues.some((i) => i.code === 'too_few_buttons')).toBe(false);
  });

  it('flags every poll with only one option (Single, and Topic, which also has just one choice in this fixture)', async () => {
    const data = await loadFixture('polls.pptx');
    const result = await parsePptx(data, 'polls.pptx');
    const issues = result.issues.filter((i) => i.code === 'poll_single_option');
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    const messages = issues.map((i) => i.message).join(' | ');
    expect(messages).toContain('Single');
    expect(messages).toContain('Topic');
  });

  it('does not warn about duplicate choices, bad ratings or mixed kinds for this fixture', async () => {
    const data = await loadFixture('polls.pptx');
    const result = await parsePptx(data, 'polls.pptx');
    expect(result.issues.some((i) => i.code === 'poll_duplicate_choice')).toBe(false);
    expect(result.issues.some((i) => i.code === 'poll_bad_rating')).toBe(false);
    expect(result.issues.some((i) => i.code === 'poll_mixed_kind')).toBe(false);
  });
});

describe('detectPollOptions: name parsing', () => {
  const slides = (elements: SlideElement[]) => [{ index: 1, elements }];

  it('is case-insensitive on the VOTE_/RATE_ prefix', () => {
    const out = detectPollOptions(slides([shape({ id: '1', name: 'vote_Topic_A' }), shape({ id: '2', name: 'RaTe_Stand_3' })]));
    expect(out.map((o) => o.kind)).toEqual(['vote', 'rate']);
  });

  it('allows underscores in the choice segment but not the poll segment', () => {
    const out = detectPollOptions(slides([shape({ id: '1', name: 'VOTE_Topic_Net_Zero' })]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ poll: 'Topic', choice: 'Net_Zero', label: 'Net Zero' });
  });

  it('ignores a shape name that does not match the VOTE_/RATE_ pattern', () => {
    const out = detectPollOptions(slides([shape({ id: '1', name: 'BTN_Sustainability' }), shape({ id: '2', name: 'VOTES_Bad' })]));
    expect(out).toHaveLength(0);
  });

  it('skips hidden shapes', () => {
    const out = detectPollOptions(slides([shape({ id: '1', name: 'VOTE_Topic_A', hidden: true })]));
    expect(out).toHaveLength(0);
  });

  it('treats a named group as one option using the group bounds, not its children', () => {
    const child = shape({ id: 'c1', name: 'Rectangle 1', xfrm: { x: 5, y: 5, w: 10, h: 10, rot: 0, flipH: false, flipV: false } });
    const group: SlideElement = {
      kind: 'group',
      id: 'g1',
      name: 'VOTE_Topic_Group',
      xfrm: { x: 0, y: 0, w: 200, h: 200, rot: 0, flipH: false, flipV: false },
      children: [child],
    };
    const out = detectPollOptions(slides([group]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'g1', poll: 'Topic', choice: 'Group', bounds: { x: 0, y: 0, w: 200, h: 200 } });
  });
});
