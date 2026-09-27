import { describe, it, expect } from 'vitest';
import {
  drawDonutChart,
  drawDwellBarChart,
  drawActivityChart,
  drawBarChart,
  drawPercentBarChart,
  drawHeatmapChart,
  drawTapHeatmap,
  drawSlideTimeChart,
  drawPathTable,
  drawUptimeStrip,
  ATTRACT_BAND_LEGEND_COLOR,
} from '../../src/report/charts';
import { makeMockCtx } from './mockCtx';

describe('chart functions guard a null context', () => {
  it('drawDonutChart does not throw with a null ctx', () => {
    expect(() => drawDonutChart(null, 100, 100, [{ label: 'A', value: 1, color: '#000' }])).not.toThrow();
  });
  it('drawDwellBarChart does not throw with a null ctx', () => {
    expect(() => drawDwellBarChart(null, 100, 100, [{ label: 'A', value: 1, color: '#000' }])).not.toThrow();
  });
  it('drawActivityChart does not throw with a null ctx', () => {
    expect(() => drawActivityChart(null, 100, 100, { buckets: [], series: [] })).not.toThrow();
  });
  it('drawBarChart does not throw with a null ctx', () => {
    expect(() => drawBarChart(null, 100, 100, [])).not.toThrow();
  });
  it('drawPercentBarChart does not throw with a null ctx', () => {
    expect(() => drawPercentBarChart(null, 100, 100, [])).not.toThrow();
  });
  it('drawHeatmapChart does not throw with a null ctx', () => {
    expect(() => drawHeatmapChart(null, 100, 100, { days: [], matrix: [] })).not.toThrow();
  });
  it('drawTapHeatmap does not throw with a null ctx', () => {
    expect(() => drawTapHeatmap(null, 100, 100, { grid: [], buttons: [], deckHeight: 1080 })).not.toThrow();
  });
  it('drawSlideTimeChart does not throw with a null ctx', () => {
    expect(() => drawSlideTimeChart(null, 100, 100, { entries: [] })).not.toThrow();
  });
  it('drawPathTable does not throw with a null ctx', () => {
    expect(() => drawPathTable(null, 100, 100, { entries: [] })).not.toThrow();
  });
  it('drawUptimeStrip does not throw with a null ctx', () => {
    expect(() =>
      drawUptimeStrip(null, 100, 100, { startMs: 0, endMs: 1000, spans: [], gaps: [] }),
    ).not.toThrow();
  });
});

describe('drawDonutChart', () => {
  it('draws one arc slice per nonzero value and a legend swatch per entry', () => {
    const { ctx, callCount } = makeMockCtx();
    const data = [
      { label: 'A', value: 3, color: '#111111' },
      { label: 'B', value: 0, color: '#222222' }, // zero-value slice skipped
      { label: 'C', value: 7, color: '#333333' },
    ];
    drawDonutChart(ctx, 400, 300, data);
    // 2 nonzero slices + 1 inner-hole circle = 3 arcs
    expect(callCount('arc')).toBe(3);
    // legend swatch per entry (all 3, including the zero-value one), plus 1 background fill
    expect(callCount('fillRect')).toBe(4);
  });

  it('renders a "No data" placeholder for an empty series', () => {
    const { ctx, calls } = makeMockCtx();
    drawDonutChart(ctx, 400, 300, []);
    const text = calls.find((c) => c.method === 'fillText');
    expect(text?.args[0]).toBe('No data');
  });
});

describe('drawDwellBarChart', () => {
  it('draws one bar per entry', () => {
    const { ctx, callCount } = makeMockCtx();
    drawDwellBarChart(ctx, 400, 300, [
      { label: 'A', value: 5000, color: '#111' },
      { label: 'B', value: 12000, color: '#222' },
    ]);
    // 2 bars + 1 background fill
    expect(callCount('fillRect')).toBe(3);
  });
});

describe('drawActivityChart', () => {
  it('draws a stacked segment per (bucket, series-with-count>0) pair', () => {
    const { ctx, callCount } = makeMockCtx();
    drawActivityChart(ctx, 600, 300, {
      buckets: [
        { label: '09:00', counts: { b1: 2, b2: 1 } },
        { label: '09:15', counts: { b1: 0, b2: 3 } },
      ],
      series: [
        { id: 'b1', label: 'A', color: '#111' },
        { id: 'b2', label: 'B', color: '#222' },
      ],
    });
    // bucket 1: 2 segments (b1, b2), bucket 2: 1 segment (b2 only, b1 is 0), plus 1 background fill
    expect(callCount('fillRect')).toBe(4);
  });

  /** fillStyle is a plain settable property on the mock ctx (not a per-call arg), so capture
   * it at the moment each fillRect call is made. */
  function trackFillStyles(ctx: CanvasRenderingContext2D): { style: string }[] {
    const record: { style: string }[] = [];
    const orig = ctx.fillRect.bind(ctx);
    ctx.fillRect = ((...args: Parameters<typeof ctx.fillRect>) => {
      record.push({ style: String(ctx.fillStyle) });
      return orig(...args);
    }) as typeof ctx.fillRect;
    return record;
  }

  it('draws no attract band when no bucket has attractMs', () => {
    const { ctx } = makeMockCtx();
    const fills = trackFillStyles(ctx);
    drawActivityChart(ctx, 600, 300, {
      buckets: [{ label: '09:00', counts: { b1: 1 } }],
      series: [{ id: 'b1', label: 'A', color: '#111' }],
      bucketMs: 300_000,
    });
    expect(fills.some((f) => f.style.startsWith('rgba(42, 3, 76'))).toBe(false);
  });

  it('draws a shaded band for a bucket with attractMs, scaled by attractMs / bucketMs', () => {
    const { ctx } = makeMockCtx();
    const fills = trackFillStyles(ctx);
    drawActivityChart(ctx, 600, 300, {
      buckets: [
        { label: '09:00', counts: { b1: 1 }, attractMs: 150_000 }, // half the bucket
        { label: '09:05', counts: { b1: 0 } }, // no band
      ],
      series: [{ id: 'b1', label: 'A', color: '#111' }],
      bucketMs: 300_000,
    });
    const band = fills.find((f) => f.style.startsWith('rgba(42, 3, 76'));
    expect(band).toBeDefined();
    // 150_000 / 300_000 = 0.5 of the band's max opacity.
    const alpha = Number(band!.style.match(/,\s*([\d.]+)\)$/)?.[1]);
    expect(alpha).toBeCloseTo(0.11, 2);
  });
});

describe('drawBarChart', () => {
  it('draws one bar per entry with a label per bar', () => {
    const { ctx, callCount } = makeMockCtx();
    drawBarChart(ctx, 400, 200, [
      { label: 'Home button', value: 4, color: '#0072B2' },
      { label: 'Tap', value: 2, color: '#009E73' },
      { label: 'Timeout', value: 6, color: '#D55E00' },
    ]);
    // 3 bars + 1 background fill
    expect(callCount('fillRect')).toBe(4);
  });
});

describe('drawHeatmapChart', () => {
  it('draws 24 cells per day row', () => {
    const { ctx, callCount } = makeMockCtx();
    const matrix = [new Array(24).fill(0), new Array(24).fill(0)];
    matrix[0][9] = 5;
    matrix[1][14] = 2;
    drawHeatmapChart(ctx, 600, 200, { days: ['2026-10-14', '2026-10-15'], matrix });
    // 48 cells + 1 background fill
    expect(callCount('fillRect')).toBe(49);
  });
});

describe('drawUptimeStrip', () => {
  const startMs = Date.parse('2026-10-14T09:00:00.000+00:00');
  const endMs = Date.parse('2026-10-14T10:00:00.000+00:00');

  it('draws the stopped background, one rect per span and per gap, plus 3 legend swatches', () => {
    const { ctx, callCount } = makeMockCtx();
    drawUptimeStrip(ctx, 600, 100, {
      startMs,
      endMs,
      spans: [{ from: '2026-10-14T09:00:00.000+00:00', to: '2026-10-14T09:50:00.000+00:00', monitored: true }],
      gaps: [{ from: '2026-10-14T09:20:00.000+00:00', to: '2026-10-14T09:45:00.000+00:00' }],
    });
    // background fill (clearBg) + stopped rect + 1 span rect + 1 gap rect + 3 legend swatches
    expect(callCount('fillRect')).toBe(1 + 1 + 1 + 1 + 3);
    // one label per legend entry: Running, Down, Stopped (no "No heartbeat data": no unmonitored span)
    const labels = ctx.fillText as unknown as { mock: { calls: unknown[][] } };
    const texts = labels.mock.calls.map((c) => c[0]);
    expect(texts).toEqual(['Running', 'Down', 'Stopped']);
  });

  it('draws an unmonitored span in neutral grey and adds a "No heartbeat data" legend entry', () => {
    const { ctx, callCount } = makeMockCtx();
    drawUptimeStrip(ctx, 600, 100, {
      startMs,
      endMs,
      spans: [{ from: '2026-10-14T09:00:00.000+00:00', to: '2026-10-14T09:50:00.000+00:00', monitored: false }],
      gaps: [],
    });
    // background fill + stopped rect + 1 span rect + 4 legend swatches (the extra one for "No heartbeat data")
    expect(callCount('fillRect')).toBe(1 + 1 + 1 + 4);
    const labels = ctx.fillText as unknown as { mock: { calls: unknown[][] } };
    const texts = labels.mock.calls.map((c) => c[0]);
    expect(texts).toEqual(['Running', 'Down', 'Stopped', 'No heartbeat data']);
  });

  it('mixes monitored and unmonitored spans without the legend entry leaking into a fully-monitored strip', () => {
    const { ctx, callCount } = makeMockCtx();
    drawUptimeStrip(ctx, 600, 100, {
      startMs,
      endMs,
      spans: [
        { from: '2026-10-14T09:00:00.000+00:00', to: '2026-10-14T09:20:00.000+00:00', monitored: false },
        { from: '2026-10-14T09:20:00.000+00:00', to: '2026-10-14T09:50:00.000+00:00', monitored: true },
      ],
      gaps: [],
    });
    // background + stopped rect + 2 span rects + 4 legend swatches
    expect(callCount('fillRect')).toBe(1 + 1 + 2 + 4);
  });

  it('draws just the stopped background (plus legend) when there are no spans', () => {
    const { ctx, callCount } = makeMockCtx();
    drawUptimeStrip(ctx, 600, 100, { startMs, endMs, spans: [], gaps: [] });
    // background fill + stopped rect + 3 legend swatches, no span/gap rects
    expect(callCount('fillRect')).toBe(1 + 1 + 3);
  });

  it('skips a span or gap with an unparseable from/to instead of drawing a garbage rect', () => {
    const { ctx, callCount } = makeMockCtx();
    expect(() =>
      drawUptimeStrip(ctx, 600, 100, {
        startMs,
        endMs,
        spans: [{ from: 'nonsense', to: '2026-10-14T09:50:00.000+00:00', monitored: true }],
        gaps: [{ from: 'also nonsense', to: 'still nonsense' }],
      }),
    ).not.toThrow();
    // background fill + stopped rect + 3 legend swatches; neither the bad span nor the bad gap draws
    expect(callCount('fillRect')).toBe(1 + 1 + 3);
  });

  it('does not throw when startMs === endMs (zero-width axis)', () => {
    const { ctx } = makeMockCtx();
    expect(() =>
      drawUptimeStrip(ctx, 600, 100, {
        startMs,
        endMs: startMs,
        spans: [{ from: '2026-10-14T09:00:00.000+00:00', to: '2026-10-14T09:00:00.000+00:00', monitored: true }],
        gaps: [],
      }),
    ).not.toThrow();
  });
});

describe('drawTapHeatmap', () => {
  const buttons = [
    { label: 'Sustainability', x: 100, y: 100, w: 300, h: 200 },
    { label: 'Community', x: 500, y: 100, w: 300, h: 200 },
  ];

  it('renders a "No data" placeholder when there is no grid and no buttons', () => {
    const { ctx, calls } = makeMockCtx();
    drawTapHeatmap(ctx, 400, 300, { grid: [], buttons: [], deckHeight: 1080 });
    const text = calls.find((c) => c.method === 'fillText');
    expect(text?.args[0]).toBe('No data');
  });

  it('draws one filled cell per nonzero grid entry, plus a stroked outline and label per button', () => {
    const { ctx, callCount, calls } = makeMockCtx();
    const grid = [
      [0, 0, 3],
      [0, 5, 0],
    ];
    drawTapHeatmap(ctx, 800, 450, { grid, buttons, deckHeight: 1080 });
    // 2 nonzero cells + 1 background fill (no thumbnail, so no wash fill)
    expect(callCount('fillRect')).toBe(3);
    // one outline per button, plus the plot-area border drawn in place of a missing thumbnail
    expect(callCount('strokeRect')).toBe(buttons.length + 1);
    // one label per button
    const labelCalls = calls.filter((c) => c.method === 'fillText');
    expect(labelCalls).toHaveLength(buttons.length);
  });

  it('draws the thumbnail underneath the grid, then a light wash, when one is provided', () => {
    const { ctx, callCount } = makeMockCtx();
    const fakeBitmap = {} as unknown as CanvasImageSource;
    const grid = [[1]];
    drawTapHeatmap(ctx, 800, 450, { grid, buttons: [], deckHeight: 1080, thumbnail: fakeBitmap });
    expect(callCount('drawImage')).toBe(1);
    // background fill + wash fill + 1 grid cell
    expect(callCount('fillRect')).toBe(3);
  });

  it('does not throw when the thumbnail fails to draw', () => {
    const { ctx } = makeMockCtx();
    (ctx.drawImage as unknown as { mockImplementation: (fn: () => void) => void }).mockImplementation(() => {
      throw new Error('tainted canvas');
    });
    const fakeBitmap = {} as unknown as CanvasImageSource;
    expect(() =>
      drawTapHeatmap(ctx, 800, 450, { grid: [[1]], buttons, deckHeight: 1080, thumbnail: fakeBitmap }),
    ).not.toThrow();
  });
});

describe('drawSlideTimeChart', () => {
  it('draws a "No data" placeholder for an empty entry list', () => {
    const { ctx, calls } = makeMockCtx();
    drawSlideTimeChart(ctx, 400, 300, { entries: [] });
    const text = calls.find((c) => c.method === 'fillText');
    expect(text?.args[0]).toBe('No data');
  });

  it('draws both bars for a slide with excl.-timeout data, and only one otherwise', () => {
    const { ctx, callCount } = makeMockCtx();
    drawSlideTimeChart(ctx, 600, 300, {
      entries: [
        { slide: 2, visits: 3, medianMs: 5000, medianMsExclTimeout: 4000 },
        { slide: 3, visits: 2, medianMs: 8000, medianMsExclTimeout: null },
      ],
    });
    // background fill + legend swatches (2) + slide-2's two bars + slide-3's one bar
    expect(callCount('fillRect')).toBe(1 + 2 + 2 + 1);
  });

  it('labels rows "Slide N"', () => {
    const { ctx, calls } = makeMockCtx();
    drawSlideTimeChart(ctx, 600, 300, { entries: [{ slide: 7, visits: 1, medianMs: 1000, medianMsExclTimeout: null }] });
    const labels = calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(labels).toContain('Slide 7');
  });

  it('caps at 16 rows, keeping the busiest slides by visits and a "+N more" note', () => {
    const { ctx, calls } = makeMockCtx();
    // 30 slides, slide N has N visits (2..31), so the 16 busiest are slides 16..31
    const entries = Array.from({ length: 30 }, (_, i) => ({
      slide: i + 2,
      visits: i + 2,
      medianMs: 1000,
      medianMsExclTimeout: null,
    }));
    drawSlideTimeChart(ctx, 600, 300, { entries });

    const texts = calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    const slideLabels = texts.filter((t) => typeof t === 'string' && t.startsWith('Slide '));
    expect(slideLabels).toHaveLength(16);
    // busiest 16 slides are 16..31, shown in ascending order
    expect(slideLabels).toEqual(Array.from({ length: 16 }, (_, i) => `Slide ${i + 16}`));
    expect(texts).toContain('+14 more slides not shown');
  });

  it('does not show a "more" note when entries fit within the row cap', () => {
    const { ctx, calls } = makeMockCtx();
    const entries = Array.from({ length: 16 }, (_, i) => ({
      slide: i + 2,
      visits: 1,
      medianMs: 1000,
      medianMsExclTimeout: null,
    }));
    drawSlideTimeChart(ctx, 600, 300, { entries });
    const texts = calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(texts.some((t) => typeof t === 'string' && t.includes('more slides not shown'))).toBe(false);
  });
});

describe('drawPathTable', () => {
  it('draws a "No data" placeholder for an empty entry list', () => {
    const { ctx, calls } = makeMockCtx();
    drawPathTable(ctx, 400, 300, { entries: [] });
    const text = calls.find((c) => c.method === 'fillText');
    expect(text?.args[0]).toBe('No data');
  });

  it('draws the arrow-joined path, count and pct for each row, and marks an ended path', () => {
    const { ctx, calls } = makeMockCtx();
    drawPathTable(ctx, 500, 200, {
      entries: [
        { path: [3, 4, 5], count: 12, pct: 60, ended: false },
        { path: [3, 4], count: 3, pct: 15, ended: true },
      ],
    });
    const texts = calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(texts).toContain('3 → 4 → 5');
    expect(texts).toContain('3 → 4 (ended)');
    expect(texts).toContain('12');
    expect(texts).toContain('60.0%');
  });

  it('uses the label override for a synthetic "Other" row with an empty path', () => {
    const { ctx, calls } = makeMockCtx();
    drawPathTable(ctx, 500, 200, { entries: [{ path: [], label: 'Other', count: 5, pct: 25, ended: false }] });
    const texts = calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(texts).toContain('Other');
  });
});

describe('ATTRACT_BAND_LEGEND_COLOR', () => {
  it('is a solid hex colour usable as a jsPDF legend swatch fill', () => {
    expect(ATTRACT_BAND_LEGEND_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });
});
