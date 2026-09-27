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
