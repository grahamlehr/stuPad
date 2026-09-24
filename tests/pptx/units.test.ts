import { describe, it, expect } from 'vitest';
import { emuToPx, makeScale, ptToPx } from '../../src/pptx/geometry';
import { SLIDE_W, EMU_PER_INCH } from '../../src/types';

describe('unit conversion', () => {
  it('emuToPx: a full 16:9 slide width maps to SLIDE_W', () => {
    const slideWidthEmu = 12192000; // 13.333in
    const scale = makeScale(slideWidthEmu, SLIDE_W);
    expect(emuToPx(slideWidthEmu, scale)).toBeCloseTo(SLIDE_W, 5);
  });

  it('emuToPx: one inch converts proportionally', () => {
    const slideWidthEmu = 12192000;
    const scale = makeScale(slideWidthEmu, SLIDE_W);
    const pxPerInch = SLIDE_W / (slideWidthEmu / EMU_PER_INCH);
    expect(emuToPx(EMU_PER_INCH, scale)).toBeCloseTo(pxPerInch, 5);
  });

  it('ptToPx matches the documented formula: pt * SLIDE_W / (slideWidthEmu / 12700)', () => {
    const slideWidthEmu = 12192000;
    const pt = 20;
    const expected = (pt * SLIDE_W) / (slideWidthEmu / 12700);
    expect(ptToPx(pt, slideWidthEmu, SLIDE_W)).toBeCloseTo(expected, 6);
  });

  it('ptToPx: 44pt on a 1920-wide 16:9 deck is ~88px (accessibility minimum)', () => {
    const slideWidthEmu = 12192000;
    expect(ptToPx(44, slideWidthEmu, SLIDE_W)).toBeCloseTo(88, 0);
  });
});
