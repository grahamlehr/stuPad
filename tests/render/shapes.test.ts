import { describe, it, expect, beforeEach } from 'vitest';
import { SlideStage, ooxmlAngleToCss } from '../../src/render';
import { deck, slide, shape, picture, group, table, xfrm, pngBlob } from './helpers';
import { stubObjectUrl } from './setup-url';

beforeEach(() => {
  stubObjectUrl();
});

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540 }),
  });
  document.body.appendChild(el);
  return el;
}

describe('shape rendering', () => {
  it('renders rect fill, roundRect radius and ellipse radius', () => {
    const d = deck({
      slides: [
        slide({
          elements: [
            shape({ id: '1', geom: 'rect', fill: { type: 'solid', color: 'rgb(255, 0, 0)' } }),
            shape({ id: '2', geom: 'roundRect', cornerRadius: 12, xfrm: xfrm(0, 0, 50, 50) }),
            shape({ id: '3', geom: 'ellipse', xfrm: xfrm(0, 0, 50, 50) }),
          ],
        }),
      ],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const shapeEls = container.querySelectorAll('.sr-shape');
    expect(shapeEls.length).toBe(3);
    expect((shapeEls[0] as HTMLElement).style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect((shapeEls[1] as HTMLElement).style.borderRadius).toBe('12px');
    expect((shapeEls[2] as HTMLElement).style.borderRadius).toBe('50%');
    stage.destroy();
  });

  it('applies border from Line', () => {
    const d = deck({
      slides: [
        slide({
          elements: [shape({ line: { color: '#00ff00', width: 3, dash: 'dash' } })],
        }),
      ],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const el = container.querySelector('.sr-shape') as HTMLElement;
    expect(el.style.border).toContain('3px');
    expect(el.style.border).toContain('dashed');
    stage.destroy();
  });

  it('applies rotation and flip as a transform', () => {
    const d = deck({
      slides: [
        slide({
          elements: [shape({ xfrm: xfrm(0, 0, 100, 100, { rot: 45, flipH: true, flipV: false }) })],
        }),
      ],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const el = container.querySelector('.sr-shape') as HTMLElement;
    expect(el.style.transform).toBe('rotate(45deg) scale(-1, 1)');
    stage.destroy();
  });

  it('renders picture crop as a scaled/offset img inside an overflow-hidden wrapper', () => {
    const d = deck({
      media: { 'img/1.png': { blob: pngBlob(), mime: 'image/png' } },
      slides: [
        slide({
          elements: [
            picture({
              mediaKey: 'img/1.png',
              xfrm: xfrm(0, 0, 100, 50),
              crop: { l: 0.25, t: 0, r: 0.25, b: 0 },
            }),
          ],
        }),
      ],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const wrap = container.querySelector('.sr-crop-wrap') as HTMLElement;
    expect(getComputedStyle(wrap).overflow).toBe('hidden');
    const img = wrap.querySelector('img') as HTMLImageElement;
    // fracW = 1 - 0.25 - 0.25 = 0.5 -> imgW = 100 / 0.5 = 200; left = -0.25*200 = -50
    expect(img.style.width).toBe('200px');
    expect(img.style.left).toBe('-50px');
    stage.destroy();
  });

  it('renders group children flat, respecting group rotation via transform-origin', () => {
    const d = deck({
      slides: [
        slide({
          elements: [
            group({
              xfrm: xfrm(100, 100, 200, 200, { rot: 30 }),
              children: [shape({ id: 'c1', xfrm: xfrm(120, 120, 40, 40) })],
            }),
          ],
        }),
      ],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const groupEl = container.querySelector('.sr-group') as HTMLElement;
    expect(groupEl.style.transform).toBe('rotate(30deg)');
    expect(groupEl.style.transformOrigin).toBe('200px 200px');
    const child = groupEl.querySelector('.sr-shape') as HTMLElement;
    expect(child.style.left).toBe('120px');
    stage.destroy();
  });

  it('renders table cells honouring gridSpan/rowSpan and skipping merged cells', () => {
    const d = deck({
      slides: [
        slide({
          elements: [
            table({
              colWidths: [50, 50, 50],
              rowHeights: [20, 20],
              rows: [
                [
                  { fill: { type: 'solid', color: '#111' }, gridSpan: 2 },
                  { fill: { type: 'none' }, merged: true },
                  { fill: { type: 'solid', color: '#222' } },
                ],
                [
                  { fill: { type: 'solid', color: '#333' } },
                  { fill: { type: 'solid', color: '#444' } },
                  { fill: { type: 'solid', color: '#555' } },
                ],
              ],
            }),
          ],
        }),
      ],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const cells = container.querySelectorAll('.sr-table-cell');
    // 6 grid slots minus 1 merged = 5 rendered cells
    expect(cells.length).toBe(5);
    const spanned = cells[0] as HTMLElement;
    expect(spanned.style.width).toBe('100px'); // 50+50 spanned
    stage.destroy();
  });
});

describe('gradient angle mapping', () => {
  it('maps OOXML east (0deg) to CSS "to right" (90deg)', () => {
    expect(ooxmlAngleToCss(0)).toBe(90);
  });
  it('maps OOXML south (90deg) to CSS "to bottom" (180deg)', () => {
    expect(ooxmlAngleToCss(90)).toBe(180);
  });
  it('wraps around at 360', () => {
    expect(ooxmlAngleToCss(300)).toBe(30);
  });

  it('produces a linear-gradient background-image with mapped angle and % stops', () => {
    const d = deck({
      slides: [
        slide({
          elements: [
            shape({
              fill: {
                type: 'gradient',
                kind: 'linear',
                angle: 0,
                stops: [
                  { pos: 0, color: '#000000' },
                  { pos: 1, color: '#ffffff' },
                ],
              },
            }),
          ],
        }),
      ],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const el = container.querySelector('.sr-shape') as HTMLElement;
    expect(el.style.backgroundImage).toContain('linear-gradient(90deg');
    expect(el.style.backgroundImage).toContain('0%');
    expect(el.style.backgroundImage).toContain('100%');
    stage.destroy();
  });
});
