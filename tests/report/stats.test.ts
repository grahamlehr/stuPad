import { describe, it, expect } from 'vitest';
import { computeStats, MISS_GRID_COLS, MISS_GRID_ROWS } from '../../src/report/stats';
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

describe('computeStats: miss-tap grid', () => {
  function countGridCells(grid: number[][]): number {
    return grid.reduce((sum, row) => sum + row.reduce((s, v) => s + v, 0), 0);
  }

  it('is an all-zero MISS_GRID_ROWS x MISS_GRID_COLS grid for an empty log', () => {
    const stats = computeStats([], {});
    expect(stats.missGrid).toHaveLength(MISS_GRID_ROWS);
    for (const row of stats.missGrid) {
      expect(row).toHaveLength(MISS_GRID_COLS);
      expect(row.every((v) => v === 0)).toBe(true);
    }
  });

  it('is an all-zero grid when there are events but no miss taps', () => {
    const events: LogEvent[] = [press('b1', '2026-10-14T10:00:00.000+00:00'), ret('2026-10-14T10:00:10.000+00:00')];
    const stats = computeStats(events, { b1: 'A' });
    expect(countGridCells(stats.missGrid)).toBe(0);
  });

  it('bins x = 0, y = 0 into the first cell', () => {
    const stats = computeStats([miss('2026-10-14T10:00:00.000+00:00', 0, 0)], {});
    expect(stats.missGrid[0][0]).toBe(1);
    expect(countGridCells(stats.missGrid)).toBe(1);
  });

  it('bins x = 100, y = 100 into the last cell (not off the edge)', () => {
    const stats = computeStats([miss('2026-10-14T10:00:00.000+00:00', 100, 100)], {});
    expect(stats.missGrid[MISS_GRID_ROWS - 1][MISS_GRID_COLS - 1]).toBe(1);
    expect(countGridCells(stats.missGrid)).toBe(1);
  });

  it('bins a mid-slide tap into the matching cell', () => {
    // x = 50% of 48 cols = col 24; y = 50% of 27 rows = row 13 (floor(13.5))
    const stats = computeStats([miss('2026-10-14T10:00:00.000+00:00', 50, 50)], {});
    expect(stats.missGrid[13][24]).toBe(1);
  });

  it('accumulates multiple miss taps landing in the same cell', () => {
    const events: LogEvent[] = [
      miss('2026-10-14T10:00:00.000+00:00', 1, 1),
      miss('2026-10-14T10:00:01.000+00:00', 1.5, 1.5),
    ];
    const stats = computeStats(events, {});
    expect(stats.missGrid[0][0]).toBe(2);
  });

  it('ignores miss taps with missing or non-finite coordinates', () => {
    const events: LogEvent[] = [
      { ts: '2026-10-14T10:00:00.000+00:00', session_id: SID, event: 'miss_tap' }, // no x/y
      { ts: '2026-10-14T10:00:01.000+00:00', session_id: SID, event: 'miss_tap', x: NaN, y: 10 },
      { ts: '2026-10-14T10:00:02.000+00:00', session_id: SID, event: 'miss_tap', x: 10, y: Infinity },
    ];
    const stats = computeStats(events, {});
    expect(stats.missTaps).toBe(3); // still counted toward the overall miss-tap total
    expect(countGridCells(stats.missGrid)).toBe(0); // but none land in the grid
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

function nav(ts: string, opts: Partial<LogEvent> = {}): LogEvent {
  return {
    ts,
    session_id: SID,
    event: 'slide_nav',
    slide_from: 2,
    slide_to: 3,
    ...opts,
  };
}

describe('computeStats: slide views and nav taps', () => {
  it('counts a slide arrival from button_press.slide_to', () => {
    const events: LogEvent[] = [press('b1', '2026-10-14T09:00:00.000+00:00', { slide_to: 2 })];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.slideViews).toEqual([{ slide: 2, views: 1 }]);
    expect(stats.totalNavTaps).toBe(0);
  });

  it('counts a slide arrival from slide_nav.slide_to, and tallies totalNavTaps separately from presses', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T09:00:00.000+00:00', { slide_to: 2 }),
      nav('2026-10-14T09:00:05.000+00:00', { slide_from: 2, slide_to: 3, visit_id: 'v1', button_id: 'b1', button_label: 'A', dwell_ms: 5000 }),
      nav('2026-10-14T09:00:10.000+00:00', { slide_from: 3, slide_to: 4, visit_id: 'v1', button_id: 'b1', button_label: 'A', dwell_ms: 5000 }),
    ];
    const stats = computeStats(events, { b1: 'A' });
    expect(stats.totalNavTaps).toBe(2);
    // one arrival each at slides 2, 3 and 4
    expect(stats.slideViews).toEqual([
      { slide: 2, views: 1 },
      { slide: 3, views: 1 },
      { slide: 4, views: 1 },
    ]);
    // slide_nav must never be counted as a button_press
    expect(stats.totalPresses).toBe(1);
    expect(stats.buttons.find((b) => b.id === 'b1')?.presses).toBe(1);
  });

  it('sums repeated arrivals at the same slide across both event kinds', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T09:00:00.000+00:00', { slide_to: 2 }),
      press('b2', '2026-10-14T09:01:00.000+00:00', { slide_to: 2 }),
      nav('2026-10-14T09:02:00.000+00:00', { slide_from: 5, slide_to: 2 }),
    ];
    const stats = computeStats(events, { b1: 'A', b2: 'B' });
    expect(stats.slideViews).toEqual([{ slide: 2, views: 3 }]);
  });

  it('empty log has no slide views and zero nav taps', () => {
    const stats = computeStats([], {});
    expect(stats.slideViews).toEqual([]);
    expect(stats.totalNavTaps).toBe(0);
  });
});

function resume(ts: string): LogEvent {
  return { ts, session_id: SID, event: 'app_resume' };
}

function kioskEvent(event: 'kiosk_start' | 'kiosk_stop', ts: string): LogEvent {
  return { ts, session_id: SID, event };
}

describe('computeStats: visitPaths (slide time and common paths)', () => {
  it('empty log has empty slideTime and topPaths', () => {
    const stats = computeStats([], {});
    expect(stats.slideTime).toEqual([]);
    expect(stats.topPaths).toEqual([]);
    expect(stats.otherPaths).toBe(0);
    expect(stats.totalPaths).toBe(0);
  });

  it('records the path and per-slide time for a multi-slide visit', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v1', slide_to: 2 }),
      nav('2026-10-14T10:00:05.000+00:00', { visit_id: 'v1', slide_from: 2, slide_to: 3, dwell_ms: 5000 }),
      nav('2026-10-14T10:00:08.000+00:00', { visit_id: 'v1', slide_from: 3, slide_to: 4, dwell_ms: 3000 }),
      ret('2026-10-14T10:00:14.000+00:00', { visit_id: 'v1', method: 'tap', slide_from: 4 }),
    ];
    const stats = computeStats(events, { b1: 'A' });

    expect(stats.topPaths).toEqual([{ path: [2, 3, 4], count: 1, ended: false }]);
    expect(stats.otherPaths).toBe(0);
    expect(stats.totalPaths).toBe(1);

    const bySlide = new Map(stats.slideTime.map((s) => [s.slide, s]));
    expect(bySlide.get(2)).toMatchObject({ visits: 1, medianMs: 5000, meanMs: 5000 });
    expect(bySlide.get(3)).toMatchObject({ visits: 1, medianMs: 3000, meanMs: 3000 });
    // last slide's time is return_home.ts minus the last arrival (10:00:08 -> 10:00:14 = 6000ms),
    // not return_home.dwell_ms (which would be the whole-visit dwell, not just this slide's)
    expect(bySlide.get(4)).toMatchObject({ visits: 1, medianMs: 6000, meanMs: 6000 });
  });

  it('counts a back-link revisit to the same slide as two separate timed stays', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v2', slide_to: 2 }),
      nav('2026-10-14T10:00:04.000+00:00', { visit_id: 'v2', slide_from: 2, slide_to: 3, dwell_ms: 4000 }),
      nav('2026-10-14T10:00:07.000+00:00', { visit_id: 'v2', slide_from: 3, slide_to: 2, dwell_ms: 3000 }),
      ret('2026-10-14T10:00:12.000+00:00', { visit_id: 'v2', method: 'home_button', slide_from: 2 }),
    ];
    const stats = computeStats(events, { b1: 'A' });

    expect(stats.topPaths).toEqual([{ path: [2, 3, 2], count: 1, ended: false }]);

    const slide2 = stats.slideTime.find((s) => s.slide === 2)!;
    // one stay of 4000ms (before leaving to slide 3) and one of 5000ms (10:00:07 -> 10:00:12,
    // the second visit to slide 2, ended by the return)
    expect(slide2.visits).toBe(2);
    expect(slide2.medianMs).toBe(4500); // median of [4000, 5000]
  });

  it('leaves a visit orphaned by app_resume out of slide time, and counts its path as ended', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v3', slide_to: 2 }),
      nav('2026-10-14T10:00:05.000+00:00', { visit_id: 'v3', slide_from: 2, slide_to: 3, dwell_ms: 5000 }),
      resume('2026-10-14T11:00:00.000+00:00'), // app was killed and relaunched mid-visit; no return_home ever came
    ];
    const stats = computeStats(events, { b1: 'A' });

    expect(stats.topPaths).toEqual([{ path: [2, 3], count: 1, ended: true }]);
    // slide 2's stay (timed by the slide_nav that left it) is real and kept...
    expect(stats.slideTime.find((s) => s.slide === 2)).toMatchObject({ visits: 1, medianMs: 5000 });
    // ...but slide 3 was never left via slide_nav or return_home, so it has no timed stay
    expect(stats.slideTime.find((s) => s.slide === 3)).toBeUndefined();
  });

  it('leaves a visit orphaned by kiosk_start out of slide time, and counts its path as ended', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v3a', slide_to: 2 }),
      nav('2026-10-14T10:00:05.000+00:00', { visit_id: 'v3a', slide_from: 2, slide_to: 3, dwell_ms: 5000 }),
      kioskEvent('kiosk_start', '2026-10-14T11:00:00.000+00:00'), // admin resumed/restarted the kiosk mid-visit
    ];
    const stats = computeStats(events, { b1: 'A' });

    expect(stats.topPaths).toEqual([{ path: [2, 3], count: 1, ended: true }]);
    expect(stats.slideTime.find((s) => s.slide === 2)).toMatchObject({ visits: 1, medianMs: 5000 });
    expect(stats.slideTime.find((s) => s.slide === 3)).toBeUndefined();
  });

  it('leaves a visit orphaned by kiosk_stop out of slide time, and counts its path as ended', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v3b', slide_to: 2 }),
      nav('2026-10-14T10:00:05.000+00:00', { visit_id: 'v3b', slide_from: 2, slide_to: 3, dwell_ms: 5000 }),
      kioskEvent('kiosk_stop', '2026-10-14T11:00:00.000+00:00'), // admin exited to Setup mid-visit
    ];
    const stats = computeStats(events, { b1: 'A' });

    expect(stats.topPaths).toEqual([{ path: [2, 3], count: 1, ended: true }]);
    expect(stats.slideTime.find((s) => s.slide === 2)).toMatchObject({ visits: 1, medianMs: 5000 });
    expect(stats.slideTime.find((s) => s.slide === 3)).toBeUndefined();
  });

  it('treats an unparseable button_press timestamp as unknown: no slide time, but the path still counts', () => {
    const events: LogEvent[] = [
      press('b1', 'not-a-date', { visit_id: 'v-bad', slide_to: 2 }),
      ret('2026-10-14T10:00:10.000+00:00', { visit_id: 'v-bad', method: 'tap', slide_from: 2 }),
    ];
    const stats = computeStats(events, { b1: 'A' });

    // the visit's arrival time on slide 2 is unknown, so return_home.ts minus it is NaN and
    // gets skipped, per the Number.isFinite duration guard
    expect(stats.slideTime.find((s) => s.slide === 2)).toBeUndefined();
    // but the path itself doesn't depend on timing, so it's still recorded
    expect(stats.topPaths).toEqual([{ path: [2], count: 1, ended: false }]);
  });

  it('leaves a visit orphaned by the log simply ending out of slide time, counted as ended in paths', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v4', slide_to: 2 }),
      nav('2026-10-14T10:00:05.000+00:00', { visit_id: 'v4', slide_from: 2, slide_to: 3, dwell_ms: 5000 }),
      // log ends here: no return_home, no app_resume/kiosk_stop
    ];
    const stats = computeStats(events, { b1: 'A' });

    expect(stats.topPaths).toEqual([{ path: [2, 3], count: 1, ended: true }]);
    expect(stats.slideTime.find((s) => s.slide === 3)).toBeUndefined();
  });

  it('orphans a still-open visit when a new button_press starts before it returned', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v5', slide_to: 2 }),
      // v5 never returns; the visitor apparently walked off and someone else pressed a button
      press('b1', '2026-10-14T10:05:00.000+00:00', { visit_id: 'v6', slide_to: 2 }),
      ret('2026-10-14T10:05:10.000+00:00', { visit_id: 'v6', method: 'tap', slide_from: 2 }),
    ];
    const stats = computeStats(events, { b1: 'A' });

    const paths = stats.topPaths.slice().sort((a, b) => a.count - b.count || Number(a.ended) - Number(b.ended));
    expect(paths).toContainEqual({ path: [2], count: 1, ended: true }); // v5
    expect(paths).toContainEqual({ path: [2], count: 1, ended: false }); // v6
  });

  it('excludes a timeout-ended visit\'s last-slide stay from medianMsExclTimeout but keeps it in medianMs', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v7', slide_to: 2 }),
      ret('2026-10-14T10:00:20.000+00:00', { visit_id: 'v7', method: 'timeout', slide_from: 2 }), // 20s, timeout-skewed
      press('b1', '2026-10-14T11:00:00.000+00:00', { visit_id: 'v8', slide_to: 2 }),
      ret('2026-10-14T11:00:06.000+00:00', { visit_id: 'v8', method: 'tap', slide_from: 2 }), // 6s, a real stay
    ];
    const stats = computeStats(events, { b1: 'A' });

    const slide2 = stats.slideTime.find((s) => s.slide === 2)!;
    expect(slide2.visits).toBe(2);
    expect(slide2.medianMs).toBe(13000); // median of [20000, 6000] includes both
    expect(slide2.visitsExclTimeout).toBe(1);
    expect(slide2.medianMsExclTimeout).toBe(6000); // only the tap-ended stay
  });

  it('reports null medianMsExclTimeout when every visit through a slide ended by timeout', () => {
    const events: LogEvent[] = [
      press('b1', '2026-10-14T10:00:00.000+00:00', { visit_id: 'v9', slide_to: 2 }),
      ret('2026-10-14T10:00:20.000+00:00', { visit_id: 'v9', method: 'timeout', slide_from: 2 }),
    ];
    const stats = computeStats(events, { b1: 'A' });
    const slide2 = stats.slideTime.find((s) => s.slide === 2)!;
    expect(slide2.visitsExclTimeout).toBe(0);
    expect(slide2.medianMsExclTimeout).toBeNull();
  });

  it('ignores slide_nav and return_home events whose visit_id has no button_press (scope cut mid-visit)', () => {
    const events: LogEvent[] = [
      nav('2026-10-14T10:00:00.000+00:00', { visit_id: 'orphan', slide_from: 2, slide_to: 3, dwell_ms: 5000 }),
      ret('2026-10-14T10:00:05.000+00:00', { visit_id: 'orphan', method: 'tap', slide_from: 3 }),
    ];
    const stats = computeStats(events, {});
    expect(stats.slideTime).toEqual([]);
    expect(stats.topPaths).toEqual([]);
    expect(stats.totalPaths).toBe(0);
    // the events still count toward totalNavTaps/totalVisits, which are independent of visitPaths
    expect(stats.totalNavTaps).toBe(1);
  });

  it('buckets paths beyond the top 8 into otherPaths, sorted by count descending', () => {
    const events: LogEvent[] = [];
    // 9 distinct single-slide paths (slides 2..10), with counts 10 down to 2, one press+return each repeated
    const counts = [10, 9, 8, 7, 6, 5, 4, 3, 2];
    let t = 0;
    counts.forEach((n, i) => {
      const slide = i + 2;
      for (let k = 0; k < n; k++) {
        const startTs = new Date(2026, 9, 14, 9, 0, t).toISOString();
        t += 1;
        const endTs = new Date(2026, 9, 14, 9, 0, t).toISOString();
        t += 1;
        events.push(press('b1', startTs, { visit_id: `v-${slide}-${k}`, slide_to: slide }));
        events.push(ret(endTs, { visit_id: `v-${slide}-${k}`, method: 'tap', slide_from: slide }));
      }
    });
    const stats = computeStats(events, { b1: 'A' });

    expect(stats.topPaths).toHaveLength(8);
    expect(stats.topPaths.map((p) => p.count)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
    expect(stats.otherPaths).toBe(2);
    expect(stats.totalPaths).toBe(counts.reduce((s, n) => s + n, 0));
  });
});
