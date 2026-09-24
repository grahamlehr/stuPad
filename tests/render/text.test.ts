import { describe, it, expect, beforeEach } from 'vitest';
import { SlideStage } from '../../src/render';
import { deck, slide, shape, textBody } from './helpers';
import { stubObjectUrl } from './setup-url';
import type { Paragraph } from '../../src/types';

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

function para(overrides: Partial<Paragraph> = {}): Paragraph {
  return {
    align: 'left',
    level: 0,
    lineSpacing: 1,
    spaceBefore: 0,
    spaceAfter: 0,
    marginLeft: 0,
    indent: 0,
    runs: [],
    ...overrides,
  };
}

function run(text: string) {
  return { text, font: 'Arial', size: 24, color: '#000000', bold: false, italic: false, underline: false };
}

function renderOneShape(shapeOverrides: Parameters<typeof shape>[0]) {
  const d = deck({ slides: [slide({ elements: [shape(shapeOverrides)] })] });
  const container = makeContainer();
  const stage = new SlideStage(container, d);
  const el = container.querySelector('.sr-shape') as HTMLElement;
  return { stage, el };
}

describe('text anchor and alignment', () => {
  it('maps anchor to flex justify-content', () => {
    for (const [anchor, expected] of [
      ['top', 'flex-start'],
      ['middle', 'center'],
      ['bottom', 'flex-end'],
    ] as const) {
      const { stage, el } = renderOneShape({
        text: textBody({ anchor, paragraphs: [para({ runs: [run('hi')] })] }),
      });
      const box = el.querySelector('.sr-text-box') as HTMLElement;
      expect(box.style.justifyContent).toBe(expected);
      stage.destroy();
    }
  });

  it('applies paragraph align and insets as padding', () => {
    const { stage, el } = renderOneShape({
      text: textBody({
        inset: { l: 10, t: 5, r: 10, b: 5 },
        paragraphs: [para({ align: 'center', runs: [run('hi')] })],
      }),
    });
    const box = el.querySelector('.sr-text-box') as HTMLElement;
    expect(box.style.padding).toBe('5px 10px');
    const p = el.querySelector('.sr-para') as HTMLElement;
    expect(p.style.textAlign).toBe('center');
    stage.destroy();
  });

  it('sets white-space: pre when wrap is false', () => {
    const { stage, el } = renderOneShape({
      text: textBody({ wrap: false, paragraphs: [para({ runs: [run('no wrap here')] })] }),
    });
    const box = el.querySelector('.sr-text-box') as HTMLElement;
    expect(box.style.whiteSpace).toBe('pre');
    stage.destroy();
  });

  it('keeps height for an empty paragraph via emptySize', () => {
    const { stage, el } = renderOneShape({
      text: textBody({ paragraphs: [para({ runs: [], emptySize: 32 })] }),
    });
    const run0 = el.querySelector('.sr-run') as HTMLElement;
    expect(run0.style.fontSize).toBe('32px');
    expect(run0.textContent).toBe(' ');
    stage.destroy();
  });
});

describe('bullets', () => {
  it('renders a char bullet verbatim', () => {
    const { stage, el } = renderOneShape({
      text: textBody({
        paragraphs: [para({ bullet: { type: 'char', char: '•' }, runs: [run('Item')] })],
      }),
    });
    const bullet = el.querySelector('.sr-bullet') as HTMLElement;
    expect(bullet.textContent).toBe('•');
    stage.destroy();
  });

  it('numbers arabicPeriod autoNum bullets sequentially from startAt', () => {
    const { stage, el } = renderOneShape({
      text: textBody({
        paragraphs: [
          para({ bullet: { type: 'autoNum', scheme: 'arabicPeriod', startAt: 1 }, runs: [run('a')] }),
          para({ bullet: { type: 'autoNum', scheme: 'arabicPeriod', startAt: 1 }, runs: [run('b')] }),
          para({ bullet: { type: 'autoNum', scheme: 'arabicPeriod', startAt: 1 }, runs: [run('c')] }),
        ],
      }),
    });
    const bullets = Array.from(el.querySelectorAll('.sr-bullet')).map((b) => b.textContent);
    expect(bullets).toEqual(['1.', '2.', '3.']);
    stage.destroy();
  });

  it('renders alphaLcPeriod and romanUcPeriod schemes', () => {
    const { stage, el } = renderOneShape({
      text: textBody({
        paragraphs: [
          para({ bullet: { type: 'autoNum', scheme: 'alphaLcPeriod', startAt: 1 }, level: 0, runs: [run('a')] }),
          para({ bullet: { type: 'autoNum', scheme: 'alphaLcPeriod', startAt: 1 }, level: 0, runs: [run('b')] }),
          para({ bullet: { type: 'autoNum', scheme: 'romanUcPeriod', startAt: 1 }, level: 1, runs: [run('c')] }),
          para({ bullet: { type: 'autoNum', scheme: 'romanUcPeriod', startAt: 1 }, level: 1, runs: [run('d')] }),
          para({ bullet: { type: 'autoNum', scheme: 'romanUcPeriod', startAt: 1 }, level: 1, runs: [run('e')] }),
        ],
      }),
    });
    const bullets = Array.from(el.querySelectorAll('.sr-bullet')).map((b) => b.textContent);
    expect(bullets).toEqual(['a.', 'b.', 'I.', 'II.', 'III.']);
    stage.destroy();
  });
});

describe('runs', () => {
  it('applies font family with quoting/fallback, size, colour, and style flags', () => {
    const { stage, el } = renderOneShape({
      text: textBody({
        paragraphs: [
          para({
            runs: [
              {
                text: 'Bold Italic',
                font: 'Calibri',
                size: 28,
                color: '#123456',
                bold: true,
                italic: true,
                underline: true,
              },
            ],
          }),
        ],
      }),
    });
    const span = el.querySelector('.sr-run') as HTMLElement;
    expect(span.style.fontFamily.startsWith('"Calibri"')).toBe(true);
    expect(span.style.fontSize).toBe('28px');
    expect(span.style.color).toBe('rgb(18, 52, 86)');
    expect(span.style.fontWeight).toBe('700');
    expect(span.style.fontStyle).toBe('italic');
    expect(span.style.textDecoration).toContain('underline');
    stage.destroy();
  });
});
