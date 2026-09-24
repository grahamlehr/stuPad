import type { LogEvent, ReturnMethod } from '../types';

// ---------------------------------------------------------------- types

export interface ButtonStats {
  id: string;
  label: string;
  presses: number;
  /** % of totalPresses, 0..100 */
  share: number;
  /** completed returns attributable to this button */
  visits: number;
  /** mean dwell_ms over this button's completed returns with known dwell; null if none */
  avgDwellMs: number | null;
  returnsByMethod: Record<ReturnMethod, number>;
  /** % of this button's returns that ended by timeout, 0..100 */
  timeoutShare: number;
}

export interface SlideViewStat {
  slide: number;
  /** arrivals at this slide, from button_press.slide_to or slide_nav.slide_to */
  views: number;
}

export interface ActivityBucket {
  /** ISO instant, local-offset (see util.isoLocal) */
  start: string;
  end: string;
  /** button_id -> press count within [start, end) */
  counts: Record<string, number>;
  total: number;
}

export interface ReportStats {
  /** session_id of the first event, or null for an empty log */
  sessionId: string | null;
  firstTs: string | null;
  lastTs: string | null;
  totalPresses: number;
  /** completed return_home events (matched to a press or not) */
  totalVisits: number;
  /** mean dwell_ms across all completed returns with known dwell; null if none */
  avgDwellMs: number | null;
  missTaps: number;
  /** ordered: label map's key order, then any extra ids seen only in events, first-seen order */
  buttons: ButtonStats[];
  returnsByMethod: Record<ReturnMethod, number>;
  /** minutes per activity bucket, auto-scaled (see computeStats) */
  bucketMinutes: number;
  buckets: ActivityBucket[];
  /** true when events span more than one local calendar day */
  isMultiDay: boolean;
  /** heatmap[dayIndex][hour] = button_press count; only meaningful (non-empty) when isMultiDay */
  heatmap: number[][];
  /** yyyy-mm-dd label for each row of heatmap, same order */
  heatmapDays: string[];
  /** arrivals per slide (button_press + slide_nav), ascending by slide number */
  slideViews: SlideViewStat[];
  /** total slide_nav events (onward navigation taps on destination slides) */
  totalNavTaps: number;
}

function emptyMethodCounts(): Record<ReturnMethod, number> {
  return { home_button: 0, tap: 0, timeout: 0 };
}

/** Standard bucket widths (minutes) to choose from, finest first. */
const BUCKET_CANDIDATES_MIN = [5, 15, 30, 60, 120, 240, 1440];
const MAX_BUCKETS = 48;

function parseTs(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

function dayKey(ts: string): string {
  // ts is a local-offset ISO string (see util.isoLocal); its date portion is
  // already the local calendar day, so a plain slice avoids timezone math.
  return ts.slice(0, 10);
}

function hourOf(ts: string): number {
  const h = ts.slice(11, 13);
  const n = Number(h);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Compute all report statistics from a flat event log in a single pass
 * (plus a couple of small finishing passes over the much smaller per-button/
 * per-bucket aggregates). Designed to stay fast for ~100k events.
 *
 * Button identity is `button_id`; its label is `labels[id]` if given, else
 * the latest non-empty `button_label` seen on any event for that id, else
 * the id itself. Buttons appear in `labels`' key order first (so callers can
 * pass deck order), then any extra ids seen only in the events, in the
 * order first encountered.
 */
export function computeStats(events: LogEvent[], labels: Record<string, string>): ReportStats {
  if (events.length === 0) {
    return {
      sessionId: null,
      firstTs: null,
      lastTs: null,
      totalPresses: 0,
      totalVisits: 0,
      avgDwellMs: null,
      missTaps: 0,
      buttons: Object.keys(labels).map((id) => ({
        id,
        label: labels[id],
        presses: 0,
        share: 0,
        visits: 0,
        avgDwellMs: null,
        returnsByMethod: emptyMethodCounts(),
        timeoutShare: 0,
      })),
      returnsByMethod: emptyMethodCounts(),
      bucketMinutes: BUCKET_CANDIDATES_MIN[0],
      buckets: [],
      isMultiDay: false,
      heatmap: [],
      heatmapDays: [],
      slideViews: [],
      totalNavTaps: 0,
    };
  }

  // events are expected in chronological (id) order from the store, but sort
  // defensively by ts so callers passing filtered/merged logs stay correct.
  const sorted = events.slice().sort((a, b) => parseTs(a.ts) - parseTs(b.ts) || (a.id ?? 0) - (b.id ?? 0));

  const sessionId = sorted[0].session_id ?? null;
  const firstTs = sorted[0].ts;
  const lastTs = sorted[sorted.length - 1].ts;

  // per-button accumulators, in first-seen / labels order
  const order: string[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys(labels)) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  const latestLabel = new Map<string, string>();
  const presses = new Map<string, number>();
  const visitsByButton = new Map<string, number>();
  const dwellSumByButton = new Map<string, number>();
  const dwellCountByButton = new Map<string, number>();
  const methodByButton = new Map<string, Record<ReturnMethod, number>>();

  function ensure(id: string): void {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }

  const returnsByMethod = emptyMethodCounts();
  let totalPresses = 0;
  let totalVisits = 0;
  let missTaps = 0;
  let dwellSumAll = 0;
  let dwellCountAll = 0;
  let totalNavTaps = 0;
  const slideViewCounts = new Map<number, number>();

  // open visits: visit_id -> { buttonId, ts }
  const openVisits = new Map<string, { buttonId: string; ts: string }>();

  // bucket sizing
  const rangeMs = Math.max(0, parseTs(lastTs) - parseTs(firstTs));
  let bucketMinutes = BUCKET_CANDIDATES_MIN[BUCKET_CANDIDATES_MIN.length - 1];
  for (const cand of BUCKET_CANDIDATES_MIN) {
    const n = Math.max(1, Math.ceil(rangeMs / (cand * 60_000)));
    if (n <= MAX_BUCKETS) {
      bucketMinutes = cand;
      break;
    }
  }
  const bucketMs = bucketMinutes * 60_000;
  const startMs = parseTs(firstTs);
  const numBuckets = Math.max(1, Math.ceil((rangeMs + 1) / bucketMs));
  const bucketCounts: Array<Map<string, number>> = Array.from({ length: numBuckets }, () => new Map());

  // heatmap: day -> hour -> count, built incrementally, day order = first-seen
  const heatmapDayOrder: string[] = [];
  const heatmapDayIndex = new Map<string, number>();
  const heatmapRows: number[][] = [];
  const dayKeysSeen = new Set<string>();

  for (const ev of sorted) {
    dayKeysSeen.add(dayKey(ev.ts));

    if (ev.button_id && ev.button_label) {
      latestLabel.set(ev.button_id, ev.button_label);
    }

    if (ev.event === 'button_press' && ev.button_id) {
      const id = ev.button_id;
      ensure(id);
      totalPresses += 1;
      presses.set(id, (presses.get(id) ?? 0) + 1);
      if (ev.slide_to !== undefined) {
        slideViewCounts.set(ev.slide_to, (slideViewCounts.get(ev.slide_to) ?? 0) + 1);
      }
      if (ev.visit_id) {
        openVisits.set(ev.visit_id, { buttonId: id, ts: ev.ts });
      }

      // activity bucket
      const idx = Math.min(numBuckets - 1, Math.max(0, Math.floor((parseTs(ev.ts) - startMs) / bucketMs)));
      const bucket = bucketCounts[idx];
      bucket.set(id, (bucket.get(id) ?? 0) + 1);

      // heatmap
      const dk = dayKey(ev.ts);
      let dIdx = heatmapDayIndex.get(dk);
      if (dIdx === undefined) {
        dIdx = heatmapDayOrder.length;
        heatmapDayIndex.set(dk, dIdx);
        heatmapDayOrder.push(dk);
        heatmapRows.push(new Array(24).fill(0));
      }
      heatmapRows[dIdx][hourOf(ev.ts)] += 1;
    } else if (ev.event === 'return_home' && ev.method) {
      totalVisits += 1;
      returnsByMethod[ev.method] += 1;

      const open = ev.visit_id ? openVisits.get(ev.visit_id) : undefined;
      const dwell = ev.dwell_ms ?? (open ? parseTs(ev.ts) - parseTs(open.ts) : undefined);

      if (open) {
        ensure(open.buttonId);
        visitsByButton.set(open.buttonId, (visitsByButton.get(open.buttonId) ?? 0) + 1);
        let m = methodByButton.get(open.buttonId);
        if (!m) {
          m = emptyMethodCounts();
          methodByButton.set(open.buttonId, m);
        }
        m[ev.method] += 1;
        if (dwell !== undefined && Number.isFinite(dwell)) {
          dwellSumByButton.set(open.buttonId, (dwellSumByButton.get(open.buttonId) ?? 0) + dwell);
          dwellCountByButton.set(open.buttonId, (dwellCountByButton.get(open.buttonId) ?? 0) + 1);
        }
        if (ev.visit_id) openVisits.delete(ev.visit_id);
      }
      // orphan returns (no matching open press) still count toward session
      // totals and overall dwell, but can't be attributed to a button.
      if (dwell !== undefined && Number.isFinite(dwell)) {
        dwellSumAll += dwell;
        dwellCountAll += 1;
      }
    } else if (ev.event === 'miss_tap') {
      missTaps += 1;
    } else if (ev.event === 'slide_nav') {
      totalNavTaps += 1;
      if (ev.slide_to !== undefined) {
        slideViewCounts.set(ev.slide_to, (slideViewCounts.get(ev.slide_to) ?? 0) + 1);
      }
    }
  }

  // overall average dwell = matched (per-button) dwell + orphan-return dwell
  let matchedDwellSum = 0;
  let matchedDwellCount = 0;
  for (const sum of dwellSumByButton.values()) matchedDwellSum += sum;
  for (const cnt of dwellCountByButton.values()) matchedDwellCount += cnt;
  const totalDwellSum = matchedDwellSum + dwellSumAll;
  const totalDwellCount = matchedDwellCount + dwellCountAll;
  const avgDwellMs = totalDwellCount > 0 ? totalDwellSum / totalDwellCount : null;

  const buttons: ButtonStats[] = order.map((id) => {
    const p = presses.get(id) ?? 0;
    const label = labels[id] ?? latestLabel.get(id) ?? id;
    const methods = methodByButton.get(id) ?? emptyMethodCounts();
    const returns = methods.home_button + methods.tap + methods.timeout;
    const dwellCount = dwellCountByButton.get(id) ?? 0;
    const dwellSum = dwellSumByButton.get(id) ?? 0;
    return {
      id,
      label,
      presses: p,
      share: totalPresses > 0 ? (p / totalPresses) * 100 : 0,
      visits: visitsByButton.get(id) ?? 0,
      avgDwellMs: dwellCount > 0 ? dwellSum / dwellCount : null,
      returnsByMethod: methods,
      timeoutShare: returns > 0 ? (methods.timeout / returns) * 100 : 0,
    };
  });

  const buckets: ActivityBucket[] = bucketCounts.map((counts, i) => {
    const start = new Date(startMs + i * bucketMs).toISOString();
    const end = new Date(startMs + (i + 1) * bucketMs).toISOString();
    const obj: Record<string, number> = {};
    let total = 0;
    for (const [id, c] of counts) {
      obj[id] = c;
      total += c;
    }
    return { start, end, counts: obj, total };
  });

  const isMultiDay = dayKeysSeen.size > 1;

  const slideViews: SlideViewStat[] = Array.from(slideViewCounts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([slide, views]) => ({ slide, views }));

  return {
    sessionId,
    firstTs,
    lastTs,
    totalPresses,
    totalVisits,
    avgDwellMs,
    missTaps,
    buttons,
    returnsByMethod,
    bucketMinutes,
    buckets,
    isMultiDay,
    heatmap: heatmapRows,
    heatmapDays: heatmapDayOrder,
    slideViews,
    totalNavTaps,
  };
}
