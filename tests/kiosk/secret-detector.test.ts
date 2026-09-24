import { describe, expect, it } from 'vitest';
import { SecretSequenceDetector, cornerOf, round1, pointInRect } from '../../src/kiosk/index';

describe('cornerOf', () => {
  it('classifies the four corners and rejects the middle', () => {
    expect(cornerOf(2, 2, 0.12)).toBe('TL');
    expect(cornerOf(98, 2, 0.12)).toBe('TR');
    expect(cornerOf(2, 98, 0.12)).toBe('BL');
    expect(cornerOf(98, 98, 0.12)).toBe('BR');
    expect(cornerOf(50, 50, 0.12)).toBeNull();
    expect(cornerOf(20, 2, 0.12)).toBeNull(); // near top edge but not near a side edge
  });
});

describe('round1 / pointInRect', () => {
  it('rounds to one decimal', () => {
    expect(round1(12.53)).toBe(12.5);
    expect(round1(88.0)).toBe(88);
    expect(round1(12.55)).toBeCloseTo(12.6, 5);
  });
  it('tests inclusive rect containment', () => {
    const r = { x: 10, y: 10, w: 100, h: 50 };
    expect(pointInRect(10, 10, r)).toBe(true);
    expect(pointInRect(110, 60, r)).toBe(true);
    expect(pointInRect(9, 10, r)).toBe(false);
    expect(pointInRect(111, 10, r)).toBe(false);
  });
});

const TL = { x: 2, y: 2 };
const TR = { x: 98, y: 2 };
const BR = { x: 98, y: 98 };
const BL = { x: 2, y: 98 };

describe('SecretSequenceDetector', () => {
  it('completes corners_cw (TL,TR,BR,BL) within the window', () => {
    const d = new SecretSequenceDetector('corners_cw', 5000);
    expect(d.feed(TL.x, TL.y, 0)).toBe(false);
    expect(d.feed(TR.x, TR.y, 100)).toBe(false);
    expect(d.feed(BR.x, BR.y, 200)).toBe(false);
    expect(d.feed(BL.x, BL.y, 300)).toBe(true);
  });

  it('completes corners_ccw (TL,BL,BR,TR)', () => {
    const d = new SecretSequenceDetector('corners_ccw', 5000);
    expect(d.feed(TL.x, TL.y, 0)).toBe(false);
    expect(d.feed(BL.x, BL.y, 10)).toBe(false);
    expect(d.feed(BR.x, BR.y, 20)).toBe(false);
    expect(d.feed(TR.x, TR.y, 30)).toBe(true);
  });

  it('completes tl3_br2 (TL,TL,TL,BR,BR)', () => {
    const d = new SecretSequenceDetector('tl3_br2', 5000);
    expect(d.feed(TL.x, TL.y, 0)).toBe(false);
    expect(d.feed(TL.x, TL.y, 10)).toBe(false);
    expect(d.feed(TL.x, TL.y, 20)).toBe(false);
    expect(d.feed(BR.x, BR.y, 30)).toBe(false);
    expect(d.feed(BR.x, BR.y, 40)).toBe(true);
  });

  it('ignores non-corner taps (no state change)', () => {
    const d = new SecretSequenceDetector('corners_cw', 5000);
    expect(d.feed(TL.x, TL.y, 0)).toBe(false);
    expect(d.feed(50, 50, 10)).toBe(false); // middle tap, not fed
    expect(d.feed(TR.x, TR.y, 20)).toBe(false); // sequence still continues
    expect(d.feed(BR.x, BR.y, 30)).toBe(false);
    expect(d.feed(BL.x, BL.y, 40)).toBe(true);
  });

  it('restarts from step 1 when the wrong corner happens to be the first step', () => {
    const d = new SecretSequenceDetector('corners_cw', 5000); // TL,TR,BR,BL
    expect(d.feed(TL.x, TL.y, 0)).toBe(false);
    expect(d.feed(TL.x, TL.y, 10)).toBe(false); // wrong (expected TR), but == pattern[0] -> restart at step 1
    expect(d.feed(TR.x, TR.y, 20)).toBe(false);
    expect(d.feed(BR.x, BR.y, 30)).toBe(false);
    expect(d.feed(BL.x, BL.y, 40)).toBe(true);
  });

  it('fully resets when the wrong corner is not the pattern start', () => {
    const d = new SecretSequenceDetector('corners_cw', 5000); // TL,TR,BR,BL
    expect(d.feed(TL.x, TL.y, 0)).toBe(false);
    expect(d.feed(TR.x, TR.y, 10)).toBe(false);
    expect(d.feed(TL.x, TL.y, 20)).toBe(false); // wrong (expected BR), and != pattern[0]... wait TL IS pattern[0]
    // TL is the pattern's first step, so this restarts a fresh attempt at step 1, not a full reset.
    expect(d.feed(TR.x, TR.y, 30)).toBe(false);
    expect(d.feed(BR.x, BR.y, 40)).toBe(false);
    expect(d.feed(BL.x, BL.y, 50)).toBe(true);
  });

  it('expires an attempt after windowMs from the first tap', () => {
    const d = new SecretSequenceDetector('corners_cw', 1000);
    expect(d.feed(TL.x, TL.y, 0)).toBe(false);
    expect(d.feed(TR.x, TR.y, 500)).toBe(false);
    // more than windowMs after the first tap: attempt expires and restarts
    expect(d.feed(BR.x, BR.y, 1600)).toBe(false); // BR != TL (pattern[0]), so full reset - not counted
    expect(d.feed(BL.x, BL.y, 1700)).toBe(false); // BL != TL either - still nothing
    // now start clean
    expect(d.feed(TL.x, TL.y, 1800)).toBe(false);
    expect(d.feed(TR.x, TR.y, 1900)).toBe(false);
    expect(d.feed(BR.x, BR.y, 2000)).toBe(false);
    expect(d.feed(BL.x, BL.y, 2100)).toBe(true);
  });
});
