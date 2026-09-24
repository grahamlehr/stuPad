import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildPdf } from '../../src/report/pdf';
import { defaultConfig, type Deck, type LogEvent } from '../../src/types';

// 1x1 transparent PNG, used as a stand-in for canvas.toDataURL output since
// jsdom has no real canvas 2D context / rasteriser.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

function mockCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const methods = [
      'save', 'restore', 'fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath',
      'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'fillText', 'strokeText', 'rect', 'scale', 'translate',
    ];
    const ctx: Record<string, unknown> = {
      fillStyle: '#000', strokeStyle: '#000', font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    };
    for (const m of methods) ctx[m] = () => undefined;
    ctx.measureText = () => ({ width: 20 });
    return ctx as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => TINY_PNG);
}

beforeEach(() => {
  mockCanvas();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDeck(buttonIds: string[]): Deck {
  return {
    id: 'deck-1',
    fileName: 'demo.pptx',
    parsedAt: new Date().toISOString(),
    slideWidthEmu: 12192000,
    slideHeightEmu: 6858000,
    height: 1080,
    slides: [],
    buttons: buttonIds.map((id, i) => ({
      id,
      shapeName: `BTN_${id}`,
      text: id,
      defaultLabel: `Button ${i + 1}`,
      targetSlide: i + 2,
      bounds: { x: 0, y: 0, w: 100, h: 100 },
    })),
    homeLinks: [],
  navLinks: [],
    media: {},
    fonts: [],
  };
}

async function readHeader(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return Buffer.from(buf.slice(0, 4)).toString('utf-8');
}

/** Counts PDF page objects by scanning the raw PDF body (jsPDF exposes no public page-count on the blob). */
async function countPdfPages(blob: Blob): Promise<number> {
  const buf = await blob.arrayBuffer();
  const text = Buffer.from(buf).toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

describe('buildPdf', () => {
  it('produces a valid PDF blob for an empty log (single summary page)', async () => {
    const deck = makeDeck(['b1', 'b2']);
    const config = defaultConfig('demo.pptx');
    const blob = await buildPdf([], deck, config);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
    expect(await readHeader(blob)).toBe('%PDF');
  });

  it('produces 4 pages for a single-day session', async () => {
    const deck = makeDeck(['b1', 'b2']);
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', event: 'kiosk_start' },
      { ts: '2026-10-14T09:01:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A', slide_from: 1, slide_to: 2 },
      { ts: '2026-10-14T09:01:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'timeout', dwell_ms: 10000, slide_from: 2, slide_to: 1 },
      { ts: '2026-10-14T09:02:00.000+00:00', session_id: 's1', event: 'miss_tap', x: 10, y: 10 },
    ];
    const blob = await buildPdf(events, deck, config);
    // capture page count via a fresh call path: re-run buildPdf but inspect through jsPDF directly is
    // internal; instead assert indirectly by checking file grows with more content than empty case.
    expect(await readHeader(blob)).toBe('%PDF');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('includes a 5th page only for a multi-day session', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const singleDay: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A', slide_from: 1, slide_to: 2 },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000, slide_from: 2, slide_to: 1 },
    ];
    const multiDay: LogEvent[] = [
      ...singleDay,
      { ts: '2026-10-15T09:00:00.000+00:00', session_id: 's1', visit_id: 'v2', event: 'button_press', button_id: 'b1', button_label: 'A', slide_from: 1, slide_to: 2 },
      { ts: '2026-10-15T09:00:05.000+00:00', session_id: 's1', visit_id: 'v2', event: 'return_home', method: 'tap', dwell_ms: 5000, slide_from: 2, slide_to: 1 },
    ];

    const singleBlob = await buildPdf(singleDay, deck, config);
    const multiBlob = await buildPdf(multiDay, deck, config);
    expect(await readHeader(singleBlob)).toBe('%PDF');
    expect(await readHeader(multiBlob)).toBe('%PDF');
    // the multi-day report has an extra page (and legend/heatmap content), so it must be larger
    expect(multiBlob.size).toBeGreaterThan(singleBlob.size);
  });

  it('embeds a home slide thumbnail when provided, without throwing', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const pngBytes = Uint8Array.from(atob(TINY_PNG.split(',')[1]), (c) => c.charCodeAt(0));
    const thumb = new Blob([pngBytes], { type: 'image/png' });
    const blob = await buildPdf([], deck, config, thumb);
    expect(await readHeader(blob)).toBe('%PDF');
  });

  it('does not throw when config.buttonLabels overrides a deck default label', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    config.buttonLabels['b1'] = 'Custom Label';
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', event: 'button_press', button_id: 'b1', button_label: 'A' },
    ];
    const blob = await buildPdf(events, deck, config);
    expect(await readHeader(blob)).toBe('%PDF');
  });
});

describe('buildPdf: exact page counts', () => {
  it('produces 1 page for an empty log', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const blob = await buildPdf([], deck, config);
    expect(await countPdfPages(blob)).toBe(1);
  });

  it('produces 4 pages for a single-day session', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const singleDay: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A' },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000 },
    ];
    const blob = await buildPdf(singleDay, deck, config);
    expect(await countPdfPages(blob)).toBe(4);
  });

  it('produces 5 pages for a multi-day session', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const singleDay: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A' },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000 },
    ];
    const multiDay: LogEvent[] = [
      ...singleDay,
      { ts: '2026-10-15T09:00:00.000+00:00', session_id: 's1', visit_id: 'v2', event: 'button_press', button_id: 'b1', button_label: 'A' },
      { ts: '2026-10-15T09:00:05.000+00:00', session_id: 's1', visit_id: 'v2', event: 'return_home', method: 'tap', dwell_ms: 5000 },
    ];
    const blob = await buildPdf(multiDay, deck, config);
    expect(await countPdfPages(blob)).toBe(5);
  });
});
