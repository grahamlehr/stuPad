import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
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
  backLinks: [],
  pollOptions: [],
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

/**
 * jsPDF's `compress: true` (used by buildPdf, see its own comment) Flate-compresses every
 * content stream, so literal text like a footer or a tile label never appears in the raw
 * PDF bytes: it has to be inflated first. This concatenates every stream's inflated text
 * operators so a test can assert a string appears somewhere in the rendered PDF.
 */
async function extractPdfText(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const raw = Buffer.from(buf).toString('latin1');
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    try {
      out += inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      // not every "stream" block is Flate-compressed text (e.g. the embedded PNGs); skip those
    }
  }
  return out;
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

  it('adds a "Home slide taps" page after Button share only when the log has miss taps', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const withoutMissTaps: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A' },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000 },
    ];
    const withMissTaps: LogEvent[] = [
      ...withoutMissTaps,
      { ts: '2026-10-14T09:00:20.000+00:00', session_id: 's1', event: 'miss_tap', x: 12, y: 88 },
    ];

    const noMissBlob = await buildPdf(withoutMissTaps, deck, config);
    expect(await countPdfPages(noMissBlob)).toBe(4);

    const withMissBlob = await buildPdf(withMissTaps, deck, config);
    expect(await countPdfPages(withMissBlob)).toBe(5);
  });

  it('renders the Home slide taps page without throwing when a home thumbnail is provided', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const pngBytes = Uint8Array.from(atob(TINY_PNG.split(',')[1]), (c) => c.charCodeAt(0));
    const thumb = new Blob([pngBytes], { type: 'image/png' });
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', event: 'miss_tap', x: 50, y: 50 },
    ];
    // jsdom has no createImageBitmap, so the thumbnail decode is skipped and the page must
    // still render (button outlines and grid cells alone), never throwing.
    const blob = await buildPdf(events, deck, config, thumb);
    expect(await readHeader(blob)).toBe('%PDF');
    expect(await countPdfPages(blob)).toBe(5);
  });

  it('adds a "Slides and paths" page after Return behaviour only when there are onward nav taps', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const withoutNavTaps: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A', slide_from: 1, slide_to: 2 },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000, slide_from: 2, slide_to: 1 },
    ];
    const withNavTaps: LogEvent[] = [
      ...withoutNavTaps,
      { ts: '2026-10-14T09:01:00.000+00:00', session_id: 's1', visit_id: 'v2', event: 'button_press', button_id: 'b1', button_label: 'A', slide_from: 1, slide_to: 2 },
      { ts: '2026-10-14T09:01:05.000+00:00', session_id: 's1', visit_id: 'v2', event: 'slide_nav', slide_from: 2, slide_to: 3, dwell_ms: 5000 },
      { ts: '2026-10-14T09:01:12.000+00:00', session_id: 's1', visit_id: 'v2', event: 'return_home', method: 'tap', dwell_ms: 12000, slide_from: 3, slide_to: 1 },
    ];

    const withoutBlob = await buildPdf(withoutNavTaps, deck, config);
    expect(await countPdfPages(withoutBlob)).toBe(4);

    const withBlob = await buildPdf(withNavTaps, deck, config);
    expect(await countPdfPages(withBlob)).toBe(5);
  });

  it('renders the Slides and paths page without throwing for a visit orphaned by a kill', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A', slide_from: 1, slide_to: 2 },
      { ts: '2026-10-14T09:00:05.000+00:00', session_id: 's1', visit_id: 'v1', event: 'slide_nav', slide_from: 2, slide_to: 3, dwell_ms: 5000 },
      // no return_home: the app was killed mid-visit
    ];
    const blob = await buildPdf(events, deck, config);
    expect(await readHeader(blob)).toBe('%PDF');
    expect(await countPdfPages(blob)).toBe(5);
  });
});

describe('buildPdf: Video section (feature H)', () => {
  it('adds no extra page when there are no video_end events', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A' },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000 },
    ];
    expect(await countPdfPages(await buildPdf(events, deck, config))).toBe(4);
  });

  it('adds a "Video" page (with no nav taps) titled "Video", not "Slides and paths"', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A' },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000 },
      { ts: '2026-10-14T09:00:05.000+00:00', session_id: 's1', event: 'video_end', slide_from: 2, watched_ms: 12345, completed: true },
    ];
    const blob = await buildPdf(events, deck, config);
    expect(await countPdfPages(blob)).toBe(5);
    const text = await extractPdfText(blob);
    expect(text).toContain('(Video)');
    expect(text).not.toContain('(Slides and paths)');
    expect(text).toContain('(Slide 2)');
  });

  it('shows the Video section on the "Slides and paths" page when nav taps are also present', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A', slide_from: 1, slide_to: 2 },
      { ts: '2026-10-14T09:00:05.000+00:00', session_id: 's1', visit_id: 'v1', event: 'slide_nav', slide_from: 2, slide_to: 3, dwell_ms: 5000 },
      { ts: '2026-10-14T09:00:12.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 12000, slide_from: 3, slide_to: 1 },
      { ts: '2026-10-14T09:00:03.000+00:00', session_id: 's1', event: 'video_end', slide_from: 2, watched_ms: 4000, completed: false },
    ];
    const blob = await buildPdf(events, deck, config);
    // Same single combined page as the plain nav-taps case (no extra page for Video on top).
    expect(await countPdfPages(blob)).toBe(5);
    const text = await extractPdfText(blob);
    expect(text).toContain('(Slides and paths)');
    expect(text).toContain('(Video)');
  });
});

describe('buildPdf: uptime tile and device name', () => {
  it('shows a rounded uptime % tile on Summary for a clean running span', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', event: 'kiosk_start' },
      { ts: '2026-10-14T09:15:00.000+00:00', session_id: 's1', event: 'heartbeat' },
      { ts: '2026-10-14T09:30:00.000+00:00', session_id: 's1', event: 'heartbeat' },
      { ts: '2026-10-14T09:45:00.000+00:00', session_id: 's1', event: 'kiosk_stop' },
    ];
    const blob = await buildPdf(events, deck, config);
    const text = await extractPdfText(blob);
    expect(text).toContain('Uptime');
    expect(text).toContain('100%');
  });

  it('shows "n/a" for uptime when the log has events but no running span', async () => {
    const deck = makeDeck(['b1']);
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', event: 'miss_tap', x: 10, y: 10 },
    ];
    const blob = await buildPdf(events, deck, config);
    const text = await extractPdfText(blob);
    expect(text).toContain('Uptime');
    expect(text).toContain('n/a');
  });

  it('prints the device name next to the session name and in every page footer when set', async () => {
    const deck = makeDeck(['b1']);
    const config = { ...defaultConfig('demo.pptx'), sessionName: 'Launch day', deviceName: 'Stand A' };
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A' },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000 },
    ];
    const blob = await buildPdf(events, deck, config);
    const text = await extractPdfText(blob);
    // Summary header: "Launch day · Stand A"
    expect(text).toContain('Launch day');
    expect(text).toContain('Stand A');
    // footer: "GGPad · Stand A · Launch day · page n/N · generated ..."
    expect(text).toContain('GGPad');
    expect(text).toMatch(/GGPad [^\n]*Stand A[^\n]*Launch day[^\n]*page/);
  });

  it('leaves Summary and the footer unchanged when device name is empty', async () => {
    const deck = makeDeck(['b1']);
    const config = { ...defaultConfig('demo.pptx'), sessionName: 'Launch day' };
    expect(config.deviceName).toBe('');
    const blob = await buildPdf([], deck, config);
    const text = await extractPdfText(blob);
    expect(text).toMatch(/GGPad [^\n]*Launch day[^\n]*page/);
    // no stray double-separator from an empty device-name segment
    expect(text).not.toMatch(/·\s*·/);
  });

  it('trims whitespace-only device names to empty (treated the same as unset)', async () => {
    const deck = makeDeck(['b1']);
    const config = { ...defaultConfig('demo.pptx'), sessionName: 'Launch day', deviceName: '   ' };
    const blob = await buildPdf([], deck, config);
    const text = await extractPdfText(blob);
    expect(text).not.toMatch(/·\s*·/);
  });
});

describe('buildPdf: polls and ratings', () => {
  function pollsDeck(): Deck {
    return {
      ...makeDeck(['b1']),
      pollOptions: [
        { slide: 1, id: 'v1', shapeName: 'VOTE_Mood_Happy', poll: 'Mood', choice: 'Happy', kind: 'vote', label: 'Happy', bounds: { x: 0, y: 0, w: 10, h: 10 }, linked: false },
        { slide: 1, id: 'v2', shapeName: 'VOTE_Mood_Sad', poll: 'Mood', choice: 'Sad', kind: 'vote', label: 'Sad', bounds: { x: 0, y: 0, w: 10, h: 10 }, linked: false },
        { slide: 2, id: 'r1', shapeName: 'RATE_Stand_4', poll: 'Stand', choice: '4', kind: 'rate', label: '4', bounds: { x: 0, y: 0, w: 10, h: 10 }, linked: false },
      ],
    };
  }

  it('shows the Interactions tile only when the log has vote events', async () => {
    const deck = pollsDeck();
    const config = defaultConfig('demo.pptx');
    const withoutVotes: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', visit_id: 'v1', event: 'button_press', button_id: 'b1', button_label: 'A' },
      { ts: '2026-10-14T09:00:10.000+00:00', session_id: 's1', visit_id: 'v1', event: 'return_home', method: 'tap', dwell_ms: 10000 },
    ];
    const withVotes: LogEvent[] = [
      ...withoutVotes,
      { ts: '2026-10-14T09:00:20.000+00:00', session_id: 's1', event: 'vote', poll: 'Mood', choice: 'Happy', slide_from: 1 },
    ];

    const noVotesBlob = await buildPdf(withoutVotes, deck, config);
    expect(await extractPdfText(noVotesBlob)).not.toContain('Interactions');

    const withVotesBlob = await buildPdf(withVotes, deck, config);
    expect(await extractPdfText(withVotesBlob)).toContain('Interactions');
  });

  it('adds a Poll results page per poll with at least one vote, and none for a poll with zero votes', async () => {
    const deck = pollsDeck();
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', event: 'vote', poll: 'Mood', choice: 'Happy', slide_from: 1 },
      { ts: '2026-10-14T09:00:05.000+00:00', session_id: 's1', event: 'vote', poll: 'Mood', choice: 'Sad', slide_from: 1 },
    ];
    // No onward nav taps and no miss taps: Summary, Button share, Activity over time, Return
    // behaviour (4 pages), plus one Poll results page for Mood (Stand has zero votes: no page).
    const blob = await buildPdf(events, deck, config);
    expect(await countPdfPages(blob)).toBe(5);
    const text = await extractPdfText(blob);
    expect(text).toContain('Poll results: Mood');
    expect(text).not.toContain('Poll results: Stand');
  });

  it('shows the mean score for a rate poll, over numeric choices only', async () => {
    const deck = pollsDeck();
    const config = defaultConfig('demo.pptx');
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', event: 'vote', poll: 'Stand', choice: '4', slide_from: 2 },
      { ts: '2026-10-14T09:00:05.000+00:00', session_id: 's1', event: 'vote', poll: 'Stand', choice: '4', slide_from: 2 },
    ];
    const blob = await buildPdf(events, deck, config);
    const text = await extractPdfText(blob);
    expect(text).toContain('Poll results: Stand');
    expect(text).toContain('Mean score 4.0');
  });

  it('honours an admin-renamed poll choice label (KioskConfig.pollLabels)', async () => {
    const deck = pollsDeck();
    const config = { ...defaultConfig('demo.pptx'), pollLabels: { 'Mood\u0000Happy': 'Delighted' } };
    const events: LogEvent[] = [
      { ts: '2026-10-14T09:00:00.000+00:00', session_id: 's1', event: 'vote', poll: 'Mood', choice: 'Happy', slide_from: 1 },
    ];
    const blob = await buildPdf(events, deck, config);
    const text = await extractPdfText(blob);
    // The renamed label is drawn on canvas (mocked to a no-op here), not with doc.text, so this
    // only exercises the call path without throwing; computeStats itself is covered in
    // tests/report/stats.test.ts.
    expect(text).toContain('Poll results: Mood');
  });
});
