import { describe, it, expect } from 'vitest';
import {
  drawDonutChart,
  drawDwellBarChart,
  drawActivityChart,
  drawBarChart,
  drawPercentBarChart,
  drawHeatmapChart,
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
