import { describe, it, expect } from 'vitest';
import { computeStats } from '../../src/report/stats';
import type { LogEvent } from '../../src/types';

const SID = 'sess-1';

function press(id: string, ts: string, opts: Partial<LogEvent> = {}): LogEvent {
  return {
    ts,
    session_id: SID,
    event: 'button_press',
    button_id: id,
    button_label: `Label ${id}`,
    slide_from: 1,
    slide_to: 2,
    ...opts,
  };
}

function ret(ts: string, opts: Partial<LogEvent> = {}): LogEvent {
  return {
    ts,
    session_id: SID,
    event: 'return_home',
    slide_from: 2,
    slide_to: 1,
    method: 'timeout',
    ...opts,
  };
}

function miss(ts: string, x: number, y: number): LogEvent {
  return { ts, session_id: SID, event: 'miss_tap', x, y };
}

describe('computeStats: empty log', () => {
  it('returns zeroed stats with no events', () => {
    const stats = computeStats([], {});
    expect(stats.sessionId).toBeNull();
    expect(stats.firstTs).toBeNull();
    expect(stats.lastTs).toBeNull();
    expect(stats.totalPresses).toBe(0);
    expect(stats.totalVisits).toBe(0);
    expect(stats.avgDwellMs).toBeNull();
    expect(stats.missTaps).toBe(0);
    expect(stats.buttons).toEqual([]);
    expect(stats.buckets).toEqual([]);
    expect(stats.isMultiDay).toBe(false);
    expect(stats.heatmap).toEqual([]);
  });

  it('still lists labelled buttons with zero presses', () => {
    const stats = computeStats([], { b1: 'Alpha', b2: 'Beta' });
    expect(stats.buttons).toHaveLength(2);
    expect(stats.buttons[0]).toMatchObject({ id: 'b1', label: 'Alpha', presses: 0, share: 0, avgDwellMs: null });
    expect(stats.buttons[1]).toMatchObject({ id: 'b2', label: 'Beta', presses: 0 });
  });
});

describe('computeStats: presses and visits', () => {
  it('counts a single press/return pair with matching dwell', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v1' }),
      ret('2026-10-14T10:00:18.420+00:00', { visit_id: 'v1', method: 'timeout', dwell_ms: 18420 }),
    ];
    const stats = computeStats(events, { b1: 'Sustainability' });
    expect(stats.totalPresses).toBe(1);
    expect(stats.totalVisits).toBe(1);
    expect(stats.avgDwellMs).toBe(18420);
    expect(stats.missTaps).toBe(0);
    expect(stats.buttons).toHaveLength(1);
    const b = stats.buttons[0];
    expect(b.id).toBe('b1');
    expect(b.label).toBe('Sustainability');
    expect(b.presses).toBe(1);
    expect(b.share).toBe(100);
    expect(b.visits).toBe(1);
    expect(b.avgDwellMs).toBe(18420);
    expect(b.returnsByMethod).toEqual({ home_button: 0, tap: 0, timeout: 1 });
    expect(b.timeoutShare).toBe(100);
  });

  it('falls back to computing dwell from timestamps when dwell_ms is absent', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v1' }),
      ret('2026-10-14T10:00:05.000+00:00', { visit_id: 'v1', method: 'tap' }),
    ];
    const stats = computeStats(events, { b1: 'X' });
    expect(stats.avgDwellMs).toBe(5000);
    expect(stats.buttons[0].avgDwellMs).toBe(5000);
  });

  it('splits presses and shares across multiple buttons', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00'),
      press('b1', '2026-10-14T10:01:00.000+00:00'),
      press('b1', '2026-10-14T10:02:00.000+00:00'),
      press('b2', '2026-10-14T10:03:00.000+00:00'),
    ];
    const stats = computeStats(events, { b1: 'A', b2: 'B' });
    expect(stats.totalPresses).toBe(4);
    const a = stats.buttons.find((b) => b.id === 'b1')!;
    const b = stats.buttons.find((b) => b.id === 'b2')!;
    expect(a.presses).toBe(3);
    expect(a.share).toBeCloseTo(75);
    expect(b.presses).toBe(1);
    expect(b.share).toBeCloseTo(25);
  });

  it('handles two buttons pointing at the same slide as distinct presses', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { slide_to: 3 }),
      press('b2', '2026-10-14T10:00:05.000+00:00', { slide_to: 3 }),
    ];
    const stats = computeStats(events, { b1: 'A', b2: 'B' });
    expect(stats.buttons.map((b) => b.presses)).toEqual([1, 1]);
  });

  it('splits return methods per button and overall', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v1' }),
      ret('2026-10-14T10:00:05.000+00:00', { visit_id: 'v1', method: 'home_button', dwell_ms: 5000 }),
      press('b1', '2026-10-14T10:01:00.000+00:00', { visit_id: 'v2' }),
      ret('2026-10-14T10:01:10.000+00:00', { visit_id: 'v2', method: 'timeout', dwell_ms: 10000 }),
      press('b1', '2026-10-14T10:02:00.000+00:00', { visit_id: 'v3' }),
      ret('2026-10-14T10:02:03.000+00:00', { visit_id: 'v3', method: 'tap', dwell_ms: 3000 }),
    ];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.returnsByMethod).toEqual({ home_button: 1, tap: 1, timeout: 1 });
    const b = stats.buttons[0];
    expect(b.returnsByMethod).toEqual({ home_button: 1, tap: 1, timeout: 1 });
    expect(b.timeoutShare).toBeCloseTo(100 / 3);
    expect(b.avgDwellMs).toBeCloseTo((5000 + 10000 + 3000) / 3);
  });

  it('counts miss taps without affecting press/visit totals', () => {
    const events: LogEvent[] = [miss('2026-10-14T10:00:00.000+00:00', 12.5, 88), miss('2026-10-14T10:00:01.000+00:00', 5, 5)];
    const stats = computeStats(events, {});
    expect(stats.missTaps).toBe(2);
    expect(stats.totalPresses).toBe(0);
    expect(stats.totalVisits).toBe(0);
  });

  it('handles an orphan return_home with no matching press gracefully', () => {
    const events: LogEvent[] = [ret('2026-10-14T10:00:05.000+00:00', { visit_id: 'ghost', method: 'timeout', dwell_ms: 9000 })];
    expect(() => computeStats(events, {})).not.toThrow();
    const stats = computeStats(events, {});
    expect(stats.totalVisits).toBe(1);
    expect(stats.returnsByMethod.timeout).toBe(1);
    expect(stats.avgDwellMs).toBe(9000); // still counted at session level
    expect(stats.buttons).toEqual([]); // but not attributed to any button
  });
});

describe('computeStats: labels', () => {
  it('prefers the labels map over button_label seen on events', () => {
    const events: LogEvent[] = [press('b1', '2026-10-14T10:00:00.000+00:00', { button_label: 'Event label' })];
    const stats = computeStats(events, { b1: 'Override label' });
    expect(stats.buttons[0].label).toBe('Override label');
  });

  it('falls back to the latest button_label seen when not in the labels map', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { button_label: 'Old name' }),
      press('b1', '2026-10-14T10:05:00.000+00:00', { button_label: 'New name' }),
    ];
    const stats = computeStats(events, {});
    expect(stats.buttons[0].label).toBe('New name');
  });

  it('falls back to the id when neither a label map entry nor a button_label exists', () => {
    const events: LogEvent[] = [press('b1', '2026-10-14T10:00:00.000+00:00', { button_label: undefined })];
    const stats = computeStats(events, {});
    expect(stats.buttons[0].label).toBe('b1');
  });

  it('orders buttons by the labels map first, then by first appearance in events', () => {
    const events: LogEvent[] = [
      press('b2', '2026-10-14T10:00:00.000+00:00'),
      press('b3', '2026-10-14T10:01:00.000+00:00'),
      press('b1', '2026-10-14T10:02:00.000+00:00'),
    ];
    const stats = computeStats(events, { b1: 'One', b2: 'Two' });
    expect(stats.buttons.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
  });
});

describe('computeStats: activity buckets', () => {
  it('picks 5-minute buckets for a 2-hour range', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T09:00:00.000+00:00'),
      press('b1', '2026-10-14T11:00:00.000+00:00'),
    ];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.bucketMinutes).toBe(5);
    expect(stats.buckets.length).toBeLessThanOrEqual(48);
  });

  it('escalates to 15-minute buckets once 5-minute buckets would exceed the cap', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T00:00:00.000+00:00'),
      press('b1', '2026-10-14T10:00:00.000+00:00'), // 10h range
    ];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.bucketMinutes).toBe(15);
    expect(stats.buckets.length).toBeLessThanOrEqual(48);
  });

  it('escalates further for a multi-day range', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T00:00:00.000+00:00'),
      press('b1', '2026-10-15T06:00:00.000+00:00'), // 30h range
    ];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.bucketMinutes).toBe(60);
    expect(stats.buckets.length).toBeLessThanOrEqual(48);
  });

  it('assigns presses to the correct bucket and per-button counts', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T09:00:00.000+00:00'),
      press('b1', '2026-10-14T09:01:00.000+00:00'),
      press('b2', '2026-10-14T09:20:00.000+00:00'),
    ];
    const stats = computeStats(events, { b1: 'A', b2: 'B' });
    const total = stats.buckets.reduce((s, b) => s + b.total, 0);
    expect(total).toBe(3);
    const firstBucket = stats.buckets[0];
    expect(firstBucket.counts['b1']).toBe(2);
  });

  it('produces a single bucket when all events share one timestamp', () => {
    const events: LogEvent[] = [press('b1', '2026-10-14T09:00:00.000+00:00'), press('b1', '2026-10-14T09:00:00.000+00:00')];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.buckets).toHaveLength(1);
    expect(stats.buckets[0].total).toBe(2);
  });
});

describe('computeStats: multi-day / heatmap', () => {
  it('detects a single-day session as not multi-day', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T09:00:00.000+00:00'),
      press('b1', '2026-10-14T18:00:00.000+00:00'),
    ];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.isMultiDay).toBe(false);
  });

  it('detects events crossing a calendar day boundary as multi-day', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T23:00:00.000+00:00'),
      press('b1', '2026-10-15T01:00:00.000+00:00'),
    ];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.isMultiDay).toBe(true);
    expect(stats.heatmapDays).toEqual(['2026-10-14', '2026-10-15']);
    expect(stats.heatmap).toHaveLength(2);
    expect(stats.heatmap[0][23]).toBe(1);
    expect(stats.heatmap[1][1]).toBe(1);
  });
});
