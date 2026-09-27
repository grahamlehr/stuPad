import { describe, expect, it } from 'vitest';
import { createGlowLayer, glowRadius, glowStyle, glowTargets } from '../../src/kiosk/glow';
import { defaultGlow } from '../../src/types';
import { deck, group, picture, shape, slide, xfrm } from '../render/helpers';

const B = { x: 100, y: 100, w: 200, h: 80 };

describe('glowRadius', () => {
  it('follows the linked shape outline', () => {
    expect(glowRadius([shape({ id: '5', xfrm: xfrm(100, 100, 200, 80), geom: 'ellipse' })], '5', B)).toBe('50%');
    expect(glowRadius([shape({ id: '5', xfrm: xfrm(100, 100, 200, 80), geom: 'roundRect', cornerRadius: 24 })], '5', B)).toBe('24px');
    expect(glowRadius([shape({ id: '5', xfrm: xfrm(100, 100, 200, 80), geom: 'rect' })], '5', B)).toBe('0');
  });

  it('uses a soft rounded rectangle for pictures, groups and unknown shapes', () => {
    expect(glowRadius([picture({ id: '5', xfrm: xfrm(100, 100, 200, 80) })], '5', B)).toBe('16px');
    expect(glowRadius([group({ id: '5', xfrm: xfrm(100, 100, 200, 80) })], '5', B)).toBe('16px');
    expect(glowRadius([], '5', B)).toBe('16px');
  });

  it('matches bounds as well as id, since ids repeat across slide, layout and master', () => {
    const layoutShape = shape({ id: '5', xfrm: xfrm(0, 0, 50, 50), geom: 'rect' });
    const button = shape({ id: '5', xfrm: xfrm(100, 100, 200, 80), geom: 'ellipse' });
    expect(glowRadius([layoutShape, button], '5', B)).toBe('50%');
  });
});

describe('glowTargets', () => {
  const d = deck({
    slides: [
      slide({ index: 1, elements: [shape({ id: 'b1', xfrm: xfrm(100, 100, 200, 80), geom: 'ellipse' })] }),
      slide({ index: 2 }),
      slide({ index: 3 }),
    ],
    buttons: [{ id: 'b1', shapeName: 'BTN', text: '', defaultLabel: 'A', targetSlide: 2, bounds: B }],
    homeLinks: [{ slide: 2, id: 'h', bounds: { x: 10, y: 10, w: 50, h: 50 } }],
    backLinks: [{ slide: 2, id: 'bk', shapeName: '', label: 'Back', bounds: { x: 70, y: 10, w: 50, h: 50 } }],
    navLinks: [
      { slide: 2, id: 'n', shapeName: '', label: 'Next', targetSlide: 3, bounds: { x: 130, y: 10, w: 50, h: 50 } },
      { slide: 3, id: 'n3', shapeName: '', label: 'Next', targetSlide: 2, bounds: { x: 0, y: 0, w: 5, h: 5 } },
    ],
  });

  it('returns the buttons on slide 1', () => {
    expect(glowTargets(d, 1)).toEqual([{ bounds: B, radius: '50%' }]);
  });

  it('returns Home, Back and Next links on a destination slide, and only that slide', () => {
    expect(glowTargets(d, 2).map((t) => t.bounds.x)).toEqual([10, 70, 130]);
  });
});

describe('glowTargets: poll options', () => {
  it('includes an unlinked poll option alongside buttons on Home', () => {
    const d = deck({
      slides: [slide({ index: 1 })],
      buttons: [{ id: 'b1', shapeName: 'BTN', text: '', defaultLabel: 'A', targetSlide: 2, bounds: B }],
      pollOptions: [
        {
          slide: 1,
          id: 'v1',
          shapeName: 'VOTE_Mood_Happy',
          poll: 'Mood',
          choice: 'Happy',
          kind: 'vote',
          label: 'Happy',
          bounds: { x: 300, y: 300, w: 50, h: 50 },
          linked: false,
        },
      ],
    });
    expect(glowTargets(d, 1).map((t) => t.bounds.x)).toEqual([B.x, 300]);
  });

  it('dedupes a poll option that is also a button, by shape id, instead of glowing it twice', () => {
    const d = deck({
      slides: [slide({ index: 1 })],
      buttons: [{ id: 'b1', shapeName: 'BTN', text: '', defaultLabel: 'A', targetSlide: 2, bounds: B }],
      pollOptions: [
        {
          slide: 1,
          id: 'b1',
          shapeName: 'VOTE_Topic_Zero',
          poll: 'Topic',
          choice: 'Zero',
          kind: 'vote',
          label: 'Zero',
          bounds: B,
          linked: true,
          targetSlide: 2,
        },
      ],
    });
    expect(glowTargets(d, 1)).toHaveLength(1);
  });

  it('includes a poll option on a destination slide alongside its other links', () => {
    const d = deck({
      slides: [slide({ index: 1 }), slide({ index: 2 })],
      homeLinks: [{ slide: 2, id: 'h', bounds: { x: 10, y: 10, w: 50, h: 50 } }],
      pollOptions: [
        {
          slide: 2,
          id: 'r1',
          shapeName: 'RATE_Stand_3',
          poll: 'Stand',
          choice: '3',
          kind: 'rate',
          label: '3',
          bounds: { x: 500, y: 500, w: 50, h: 50 },
          linked: false,
        },
      ],
    });
    expect(glowTargets(d, 2).map((t) => t.bounds.x)).toEqual([10, 500]);
  });
});

describe('glowStyle', () => {
  it('scales size and brightness with intensity, and splits the period into two half-pulses', () => {
    const soft = glowStyle({ enabled: true, color: '#ff0000', intensity: 1, periodMs: 3000 });
    const strong = glowStyle({ enabled: true, color: '#ff0000', intensity: 10, periodMs: 3000 });
    expect(soft.blurPx).toBeLessThan(strong.blurPx);
    expect(soft.spreadPx).toBeLessThan(strong.spreadPx);
    expect(soft.shadowColor).toBe('rgba(255,0,0,0.46)');
    expect(strong.shadowColor).toBe('rgba(255,0,0,1)');
    expect(soft.halfPeriodMs).toBe(1500);
  });
});

describe('createGlowLayer', () => {
  it('builds one pointer-transparent glow per target', () => {
    const d = deck({ buttons: [{ id: 'b1', shapeName: '', text: '', defaultLabel: 'A', targetSlide: 2, bounds: B }] });
    const layer = createGlowLayer(d, 1, { ...defaultGlow(), enabled: true });
    const glows = layer.querySelectorAll<HTMLElement>('.kiosk-glow');
    expect(glows).toHaveLength(1);
    expect(glows[0].style.width).toBe('200px');
    expect(layer.style.getPropertyValue('--glow-blur')).toBe('28px');
  });
});
