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

/**
 * Time spent on one slide across all visits that were timed leaving it, either by a
 * `slide_nav` (onward navigation) or by `return_home` (the slide the visit ended on).
 * Home (slide 1) never appears here: visitors are never timed on it within a visit.
 *
 * `visits` counts every timed stay, so a slide reached twice in one visit (e.g. via a
 * back link) contributes two stays, not one.
 *
 * **Timeout skew.** The stay on a visit's last slide before a `timeout` return is timed
 * from arrival to the timeout firing, so it can overstate real attention by up to the
 * configured timeout. `medianMs`/`meanMs` include every timed stay; `medianMsExclTimeout`
 * excludes only the last-slide stay of visits that ended by timeout (earlier stays in the
 * same visit, timed by `slide_nav.dwell_ms`, are never skewed and stay in both). Use the
 * median over the mean in charts, since a handful of long timeout-skewed stays can drag
 * the mean far from what most visitors actually experienced.
 */
export interface SlideTimeStat {
  /** slide number, 2 or higher */
  slide: number;
  /** timed stays on this slide, across all visits (see doc comment above) */
  visits: number;
  medianMs: number;
  meanMs: number;
  /** median over stays excluding a timeout-ended visit's last-slide stay; null when none remain */
  medianMsExclTimeout: number | null;
  /** stays counted in medianMsExclTimeout */
  visitsExclTimeout: number;
}

/**
 * One distinct route through a deck: the button's target slide, then each `slide_nav`'s
 * `slide_to`, in order. A path never includes slide 1: `return_home` ends a path rather
 * than extending it.
 *
 * `ended` marks a path reconstructed from a visit that never reached `return_home` (the
 * app was killed mid-visit, or the export scope cuts it off; see `visitPaths` below). A
 * path with `ended: true` is a distinct entry from the same slide sequence completed
 * normally, e.g. "3, 4 (ended)" is counted separately from "3, 4".
 */
export interface PathStat {
  path: number[];
  count: number;
  ended: boolean;
}

/** Columns (x, 0..47) in the miss-tap grid; see `ReportStats.missGrid`. */
export const MISS_GRID_COLS = 48;
/** Rows (y, 0..26) in the miss-tap grid; see `ReportStats.missGrid`. */
export const MISS_GRID_ROWS = 27;

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
  /**
   * Miss-tap density over the home slide, as a 16:9-cell grid: `MISS_GRID_ROWS` (27) rows
   * of `MISS_GRID_COLS` (48) columns, indexed `missGrid[row][col]`. A cell index is
   * `floor(pct / 100 * count)` clamped to `0..count-1`, so `x = 100` (or `y = 100`) lands in
   * the last column (row) and `x = 0` in the first. Only `miss_tap` events with finite `x`
   * and `y` are counted; events with missing or non-finite coordinates are ignored. Raw
   * miss-tap points are intentionally not kept anywhere in `ReportStats`, so memory stays
   * flat regardless of event count.
   */
  missGrid: number[][];
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
  /** median/mean time spent per slide, ascending by slide number; see SlideTimeStat */
  slideTime: SlideTimeStat[];
  /** the 8 most common paths through the deck, most frequent first; see visitPaths */
  topPaths: PathStat[];
  /** visits whose path isn't among topPaths, counted together as "other" */
  otherPaths: number;
  /** total path-tracked visits: sum of topPaths' counts plus otherPaths */
  totalPaths: number;
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

/**
 * Like `parseTs`, but an unparseable `ts` maps to `NaN` instead of `0`. Used only by the
 * visitPaths tracking below: a bad timestamp there must produce an unknown (and therefore
 * skipped, via the existing `Number.isFinite` duration guards) stay rather than a
 * multi-decade one computed against the epoch. `parseTs` itself keeps its `0` fallback for
 * every other stat (bucket placement, sorting, overall dwell), which this doesn't touch.
 */
function parseTsOrNaN(ts: string): number {
  return Date.parse(ts);
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

function emptyMissGrid(): number[][] {
  return Array.from({ length: MISS_GRID_ROWS }, () => new Array(MISS_GRID_COLS).fill(0));
}

/** `pct` (0..100) to a clamped 0-based cell index in a `count`-wide axis. */
function missCellIndex(pct: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor((pct / 100) * count)));
}

/** Median of a non-empty array of numbers; 0 for an empty array (callers guard length first). */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** In-progress visit tracked for `visitPaths` (see `computeStats`): the slides visited so
 * far (button target, then each slide_nav target), the slide currently shown, and when
 * the visitor arrived there (epoch ms), so the next event can time that stay. */
interface OpenVisitPath {
  path: number[];
  currentSlide: number;
  lastArrivalMs: number;
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
      missGrid: emptyMissGrid(),
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
      slideTime: [],
      topPaths: [],
      otherPaths: 0,
      totalPaths: 0,
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
  const missGrid = emptyMissGrid();
  let dwellSumAll = 0;
  let dwellCountAll = 0;
  let totalNavTaps = 0;
  const slideViewCounts = new Map<number, number>();

  // open visits: visit_id -> { buttonId, ts }
  const openVisits = new Map<string, { buttonId: string; ts: string }>();

  // ---- visitPaths (feature C: time per slide and common paths) ----
  // Open visits tracked purely for path/slide-time purposes; separate from `openVisits`
  // above (which only needs the starting button and its own dwell). Only one visit is
  // ever open on a real kiosk, but this is keyed defensively by visit_id in case a
  // filtered/merged log ever has more than one.
  const openVisitPaths = new Map<string, OpenVisitPath>();
  // slide -> every timed stay's duration, ms (see SlideTimeStat)
  const durationsBySlide = new Map<number, number[]>();
  // slide -> timed stays excluding the last-slide stay of a timeout-ended visit
  const durationsBySlideExclTimeout = new Map<number, number[]>();
  // pathKey(path, ended) -> aggregate; see PathStat
  const pathCounts = new Map<string, { path: number[]; ended: boolean; count: number }>();

  function pathKey(path: number[], ended: boolean): string {
    return `${ended ? '1' : '0'}|${path.join(',')}`;
  }

  function recordPath(path: number[], ended: boolean): void {
    if (path.length === 0) return; // nothing to report if the button press itself had no slide_to
    const key = pathKey(path, ended);
    const existing = pathCounts.get(key);
    if (existing) existing.count += 1;
    else pathCounts.set(key, { path: path.slice(), ended, count: 1 });
  }

  /** A visit that never reached return_home: the kiosk moved on (a new button_press, an
   * app_resume/kiosk_start/kiosk_stop) or the log simply ends while it's still open. Counted
   * in paths as ended; left out of slide-time entirely, per SPEC. */
  function closeVisitOrphaned(visitId: string): void {
    const v = openVisitPaths.get(visitId);
    if (!v) return;
    openVisitPaths.delete(visitId);
    recordPath(v.path, true);
  }

  function pushDuration(map: Map<number, number[]>, slide: number, durationMs: number): void {
    let arr = map.get(slide);
    if (!arr) {
      arr = [];
      map.set(slide, arr);
    }
    arr.push(durationMs);
  }

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

    // A visit still open when the kiosk restarts or resumes can never be completed by a
    // later return_home, so close it now as an orphan (see closeVisitOrphaned).
    if (ev.event === 'app_resume' || ev.event === 'kiosk_start' || ev.event === 'kiosk_stop') {
      for (const id of Array.from(openVisitPaths.keys())) closeVisitOrphaned(id);
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

        // A new visit starting means any previous visit was never returned from (the
        // kiosk moved straight on to a new press), so orphan it before opening this one.
        for (const oldId of Array.from(openVisitPaths.keys())) {
          if (oldId !== ev.visit_id) closeVisitOrphaned(oldId);
        }
        if (ev.slide_to !== undefined) {
          openVisitPaths.set(ev.visit_id, {
            path: [ev.slide_to],
            currentSlide: ev.slide_to,
            // NaN (unparseable ts) propagates forward and is caught by the Number.isFinite
            // guards below, rather than a decades-long stay computed against the epoch.
            lastArrivalMs: parseTsOrNaN(ev.ts),
          });
        }
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

      // visitPaths: a return_home with no matching open visit (its visit_id has no
      // button_press in this event set, e.g. the export scope starts mid-visit) is
      // ignored entirely for paths/slide-time, per SPEC.
      const openPath = ev.visit_id ? openVisitPaths.get(ev.visit_id) : undefined;
      if (openPath) {
        const nowMs = parseTsOrNaN(ev.ts);
        const lastDur = nowMs - openPath.lastArrivalMs;
        if (Number.isFinite(lastDur) && lastDur >= 0) {
          pushDuration(durationsBySlide, openPath.currentSlide, lastDur);
          if (ev.method !== 'timeout') {
            pushDuration(durationsBySlideExclTimeout, openPath.currentSlide, lastDur);
          }
        }
        recordPath(openPath.path, false);
        openVisitPaths.delete(ev.visit_id!);
      }
    } else if (ev.event === 'miss_tap') {
      missTaps += 1;
      if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) {
        const col = missCellIndex(ev.x as number, MISS_GRID_COLS);
        const row = missCellIndex(ev.y as number, MISS_GRID_ROWS);
        missGrid[row][col] += 1;
      }
    } else if (ev.event === 'slide_nav') {
      totalNavTaps += 1;
      if (ev.slide_to !== undefined) {
        slideViewCounts.set(ev.slide_to, (slideViewCounts.get(ev.slide_to) ?? 0) + 1);
      }

      // visitPaths: ignore a slide_nav whose visit_id has no matching button_press
      // (same scope-cutting case as above).
      const openPath = ev.visit_id ? openVisitPaths.get(ev.visit_id) : undefined;
      if (openPath && ev.slide_to !== undefined) {
        const nowMs = parseTsOrNaN(ev.ts);
        // slide_nav.dwell_ms is kept when present, even if this event's own ts is malformed.
        const dwell = ev.dwell_ms ?? nowMs - openPath.lastArrivalMs;
        if (Number.isFinite(dwell) && dwell >= 0) {
          // never the last stay of the visit (the visit continues past this slide), so
          // it's kept in both the all-stays and excl.-timeout duration sets.
          pushDuration(durationsBySlide, openPath.currentSlide, dwell);
          pushDuration(durationsBySlideExclTimeout, openPath.currentSlide, dwell);
        }
        openPath.path.push(ev.slide_to);
        openPath.currentSlide = ev.slide_to;
        openPath.lastArrivalMs = nowMs;
      }
    }
  }

  // Any visit still open at the end of the log never reached return_home (the app was
  // killed, or the log/export scope simply ends mid-visit), so orphan it too.
  for (const id of Array.from(openVisitPaths.keys())) closeVisitOrphaned(id);

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

  const slideTime: SlideTimeStat[] = Array.from(durationsBySlide.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([slide, durations]) => {
      const excl = durationsBySlideExclTimeout.get(slide) ?? [];
      return {
        slide,
        visits: durations.length,
        medianMs: median(durations),
        meanMs: durations.reduce((s, d) => s + d, 0) / durations.length,
        medianMsExclTimeout: excl.length > 0 ? median(excl) : null,
        visitsExclTimeout: excl.length,
      };
    });

  // Array.prototype.sort is a stable sort, so paths with equal counts keep first-seen
  // (Map insertion) order rather than shuffling between calls.
  const allPaths = Array.from(pathCounts.values()).sort((a, b) => b.count - a.count);
  const topPaths: PathStat[] = allPaths.slice(0, 8).map((p) => ({ path: p.path, count: p.count, ended: p.ended }));
  const otherPaths = allPaths.slice(8).reduce((s, p) => s + p.count, 0);
  const totalPaths = allPaths.reduce((s, p) => s + p.count, 0);

  return {
    sessionId,
    firstTs,
    lastTs,
    totalPresses,
    totalVisits,
    avgDwellMs,
    missTaps,
    missGrid,
    buttons,
    returnsByMethod,
    bucketMinutes,
    buckets,
    isMultiDay,
    heatmap: heatmapRows,
    heatmapDays: heatmapDayOrder,
    slideViews,
    totalNavTaps,
    slideTime,
    topPaths,
    otherPaths,
    totalPaths,
  };
}
