import { describe, it, expect } from 'vitest';
import { buttonColor } from '../../src/report/colors';

describe('buttonColor', () => {
  it('is deterministic and stable for the same index', () => {
    expect(buttonColor(0)).toBe(buttonColor(0));
    expect(buttonColor(3)).toBe(buttonColor(3));
  });

  it('returns a valid hex colour', () => {
    for (let i = 0; i < 10; i++) {
      expect(buttonColor(i)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('gives distinct colours to the first 10 buttons', () => {
    const colors = Array.from({ length: 10 }, (_, i) => buttonColor(i));
    expect(new Set(colors).size).toBe(10);
  });

  it('wraps around (and stays valid) past the palette size', () => {
    expect(buttonColor(10)).toBe(buttonColor(0));
    expect(buttonColor(11)).toBe(buttonColor(1));
  });
});
