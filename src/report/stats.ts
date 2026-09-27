import type { LogEvent, ReturnMethod } from '../types';
import { pollLabelKey } from '../types';

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
  /**
   * Milliseconds of this bucket's own [start, end) span spent inside an attract period (see
   * `computeStats`' attract-period reconstruction below), clipped to the bucket. 0 when the
   * loop never ran, or never overlapped this bucket. Drawn as a shaded band in the Activity
   * chart (`drawActivityChart`); kept as a single number per bucket (not raw periods) so
   * memory stays flat regardless of event count.
   */
  attractMs: number;
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

/**
 * Poll/rating option metadata from the deck, passed via `ComputeStatsOpts.pollOptions` so
 * `computeStats` can order polls/choices in deck order, resolve each poll's overall `kind`
 * (see `PollStat.kind`) and fall back to a default label when the admin hasn't renamed a
 * choice. One entry per `PollOptionDef` (`src/types.ts`); a poll appearing on several slides
 * (or with the same choice defined twice, which is also a validation warning) just repeats.
 */
export interface PollOptionMeta {
  poll: string;
  choice: string;
  kind: 'vote' | 'rate';
  label: string;
}

/** One choice's tally within a `PollStat`. */
export interface PollChoiceStat {
  choice: string;
  label: string;
  count: number;
  /** % of the poll's total votes, 0..100 */
  pct: number;
}

/**
 * Aggregate results for one poll (ROADMAP "Polls and ratings"), counting every vote —
 * home-slide and destination-slide alike (decision 4). `kind` is `'rate'` only when every
 * option `computeStats` has seen for this poll (via `ComputeStatsOpts.pollOptions`) is
 * `'rate'`; a poll mixing `VOTE_`/`RATE_` (see `validateDeck`'s `poll_mixed_kind` warning) is
 * `'vote'` here, and `mean` is always `null` for a `'vote'` poll.
 */
export interface PollStat {
  poll: string;
  /** display label for the poll itself (deck's own pretty-printed poll name) */
  label: string;
  kind: 'vote' | 'rate';
  /** every vote for this poll, in scope */
  total: number;
  /** deck order (then any extra choices seen only in events), see `computeStats` */
  choices: PollChoiceStat[];
  /** mean of numeric choices, weighted by vote count; null for a 'vote' poll or with no numeric votes */
  mean: number | null;
}

/** Optional extra context for `computeStats`: poll metadata and admin-renamed choice labels. */
export interface ComputeStatsOpts {
  /** deck's poll options (any order); used for poll/choice ordering, kind resolution and default labels */
  pollOptions?: PollOptionMeta[];
  /** KioskConfig.pollLabels: admin-renamed choice labels, keyed by `pollLabelKey(poll, choice)` */
  pollLabels?: Record<string, string>;
}

/** Columns (x, 0..47) in the miss-tap grid; see `ReportStats.missGrid`. */
export const MISS_GRID_COLS = 48;
/** Rows (y, 0..26) in the miss-tap grid; see `ReportStats.missGrid`. */
export const MISS_GRID_ROWS = 27;

/**
 * A gap longer than this between two consecutive events inside a running span (see
 * `UptimeStats`) counts as downtime. iOS suspends timers when the app is backgrounded or
 * the screen locks, so a silence this long inside a span is exactly the "someone left the
 * kiosk" / "it crashed" / "it lost power" signal a heartbeat is meant to catch.
 */
export const UPTIME_GAP_MS = 20 * 60_000;

/** One continuous stretch of the kiosk actually running, see `UptimeStats`. */
export interface UptimeSpan {
  from: string;
  to: string;
  /**
   * False when this span contains no `heartbeat` event at all: a log from before 1.5.0 (the
   * release that added the heartbeat), or a new-build span shorter than one heartbeat tick
   * (15 minutes). An unmonitored span's whole duration goes into `UptimeStats.unmonitoredMs`
   * instead of `uptimeMs`/`downtimeMs`/`gaps`, since without any heartbeat there is nothing
   * to measure a gap against; it is still drawn (as a neutral grey) in the PDF's uptime strip
   * so it reads as "no data" rather than "fully down".
   */
  monitored: boolean;
}

/** A silence longer than `UPTIME_GAP_MS` between two consecutive events inside a *monitored* span. */
export interface UptimeGap {
  from: string;
  to: string;
}

/**
 * Uptime/downtime reconstructed from the event log, not from the heartbeat alone: any two
 * consecutive events (heartbeats, taps, `app_resume`, ...) close enough together prove the
 * kiosk was up for the time between them. Uptime is only ever measured for a span that has
 * at least one `heartbeat`, i.e. a span logged by 1.5.0 or later (see `UptimeSpan.monitored`
 * and `unmonitoredMs`); an older log's spans are counted as unmonitored, not as downtime.
 *
 * **Spans.** A running span opens at a `kiosk_start`; if no span is already open, any other
 * event opens one too (an `app_resume`, a tap, a `heartbeat`, ...), since events are only
 * ever logged while the kiosk is running, so an event arriving with no span open means the
 * scope simply cut off the `kiosk_start` that would have opened it (a date-range export, or
 * a session whose `kiosk_start` is out of scope). The one exception is `kiosk_stop`: with no
 * span open it closes nothing and opens nothing. A span closes at the matching `kiosk_stop`.
 * If the event log ends, or another `kiosk_start` arrives, while a span is still open, that
 * span closes at its own last event (not at the new `kiosk_start`, which opens the next
 * span). Time outside any span (kiosk stopped, admin in Setup) is neither up nor down: it's
 * simply not counted.
 *
 * **Within a monitored span**, every consecutive pair of events is walked in order. A gap
 * longer than `UPTIME_GAP_MS` (20 minutes) between them is downtime (`gaps`); every other
 * gap is uptime. So `uptimeMs + downtimeMs` always equals the sum of every *monitored*
 * span's own duration; an unmonitored span's duration is in `unmonitoredMs` instead. An
 * `app_resume` that arrives after a long silence *inside* an already-open span (rather than
 * opening a new one) is exactly how a kill/relaunch or a long backgrounding shows up: the
 * gap immediately before it is recorded as down.
 *
 * Events with an unparseable `ts` are skipped entirely (they neither open/close a span nor
 * take part in a gap calculation). Computed over whatever events are passed in, so a
 * filtered scope (a date range, a single session) reports uptime for just that scope.
 */
export interface UptimeStats {
  uptimeMs: number;
  downtimeMs: number;
  /** total duration of every unmonitored span (see `UptimeSpan.monitored`); never up or down */
  unmonitoredMs: number;
  /** silences longer than `UPTIME_GAP_MS` inside a monitored span, in chronological order */
  gaps: UptimeGap[];
  /** every running span found in the scope, monitored and not, in chronological order; drawn as the PDF's uptime strip */
  spans: UptimeSpan[];
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
  /** uptime/downtime reconstructed from the event log; see `UptimeStats` */
  uptime: UptimeStats;
  /** uptimeMs as a % of (uptimeMs + downtimeMs) over monitored spans only, 0..100; null when there are none */
  uptimePct: number | null;
  /** count of `attract_start` events (attract loop runs) in scope */
  attractStarts: number;
  /** count of `attract_end` events (loops ended by a wake tap, as opposed to kiosk_stop/kiosk_start/app_resume) in scope */
  attractEnds: number;
  /** attractEnds / attractStarts * 100, 0..100; null when attractStarts is 0. The "pull-in rate": of
   * every attract loop that ran, the share a visitor actually walked up and tapped to end. */
  attractPullInPct: number | null;
  /** count of `vote` events with no visit_id: an unlinked poll/rating option tapped on Home,
   * which has no destination, dwell or return, so it isn't a visit (decision 4). */
  homeVotes: number;
  /** totalVisits + homeVotes: the headline engagement count (Summary's "Interactions" tile).
   * A linked home vote is already counted once, as its (real) visit. */
  interactions: number;
  /** one entry per poll seen (via `ComputeStatsOpts.pollOptions` and/or `vote` events),
   * ordered per `ComputeStatsOpts.pollOptions` then first-seen in events; see `PollStat`. */
  polls: PollStat[];
}

function emptyUptime(): UptimeStats {
  return { uptimeMs: 0, downtimeMs: 0, unmonitoredMs: 0, gaps: [], spans: [] };
}

/**
 * Reconstructs `UptimeStats` from a chronologically-sorted event list (see the doc comment
 * on `UptimeStats` for the full semantics). Kept as its own small pass, separate from the
 * main `computeStats` loop, since it needs to see events computeStats otherwise ignores
 * (`kiosk_start`/`kiosk_stop`/`app_resume`/`heartbeat`) and its own state (the currently
 * open span) doesn't fit naturally into that loop's per-button/per-visit accumulators.
 *
 * Each span's own up/down/gap numbers are accumulated locally (`spanUptimeMs` etc.) while
 * the span is open, and only folded into the running totals once the span closes and its
 * `monitored` flag (whether a `heartbeat` was ever seen in it) is known: a span that turns
 * out unmonitored contributes its whole duration to `unmonitoredMs` instead, and its gaps
 * (computed the same way, just in case, but meaningless without a heartbeat to trust) are
 * discarded rather than reported as real downtime.
 */
function computeUptime(sorted: LogEvent[]): UptimeStats {
  const gaps: UptimeGap[] = [];
  const spans: UptimeSpan[] = [];
  let uptimeMs = 0;
  let downtimeMs = 0;
  let unmonitoredMs = 0;

  let openFrom: string | null = null;
  let openFromMs = 0;
  let lastTs: string | null = null;
  let lastMs = 0;
  let sawHeartbeat = false;
  let spanUptimeMs = 0;
  let spanDowntimeMs = 0;
  let spanGaps: UptimeGap[] = [];

  function openSpan(ts: string, ms: number): void {
    openFrom = ts;
    openFromMs = ms;
    lastTs = ts;
    lastMs = ms;
    sawHeartbeat = false;
    spanUptimeMs = 0;
    spanDowntimeMs = 0;
    spanGaps = [];
  }

  function closeSpan(): void {
    if (openFrom === null || lastTs === null) return;
    if (sawHeartbeat) {
      spans.push({ from: openFrom, to: lastTs, monitored: true });
      uptimeMs += spanUptimeMs;
      downtimeMs += spanDowntimeMs;
      for (const g of spanGaps) gaps.push(g);
    } else {
      spans.push({ from: openFrom, to: lastTs, monitored: false });
      unmonitoredMs += lastMs - openFromMs;
    }
    openFrom = null;
    lastTs = null;
  }

  for (const ev of sorted) {
    const ms = parseTsOrNaN(ev.ts);
    if (!Number.isFinite(ms)) continue; // unparseable ts: skip entirely, per SPEC

    if (ev.event === 'kiosk_start') {
      // A span already open when a new kiosk_start arrives closes at ITS OWN last event
      // (not at this kiosk_start), then this kiosk_start opens the next span.
      if (openFrom !== null) closeSpan();
      openSpan(ev.ts, ms);
      continue;
    }

    if (openFrom === null) {
      // Events are only ever logged while the kiosk is running, so anything other than
      // kiosk_start arriving with no span open means the scope cut off the kiosk_start
      // that would have opened it: open the span here instead. kiosk_stop is the one
      // exception, since a stop with nothing open closes nothing and starts nothing.
      if (ev.event === 'kiosk_stop') continue;
      openSpan(ev.ts, ms);
      if (ev.event === 'heartbeat') sawHeartbeat = true;
      continue;
    }

    if (ev.event === 'heartbeat') sawHeartbeat = true;

    const gap = ms - lastMs;
    if (gap > UPTIME_GAP_MS) {
      spanGaps.push({ from: lastTs!, to: ev.ts });
      spanDowntimeMs += gap;
    } else if (gap > 0) {
      spanUptimeMs += gap;
    }
    lastTs = ev.ts;
    lastMs = ms;

    if (ev.event === 'kiosk_stop') closeSpan();
  }
  // The log ends while a span is still open: it closes at its own last event.
  closeSpan();

  return { uptimeMs, downtimeMs, unmonitoredMs, gaps, spans };
}

function uptimePctOf(uptime: UptimeStats): number | null {
  const total = uptime.uptimeMs + uptime.downtimeMs;
  return total > 0 ? (uptime.uptimeMs / total) * 100 : null;
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

/** Pretty-prints a raw poll name the same way choice names are prettified (underscores and
 * hyphens to spaces). Poll names can't contain underscores (see `PollOptionDef`), so this
 * only ever has hyphens to fold, but kept consistent with choice-label formatting. */
function prettyPoll(poll: string): string {
  const stripped = poll.replace(/[_-]+/g, ' ').trim();
  return stripped || poll;
}

/**
 * Builds `ReportStats.polls` from the per-poll/choice vote tallies collected while walking
 * the event log, plus the optional deck metadata in `opts` (poll/choice order, each poll's
 * overall `kind`, and default choice labels). Kept as its own function so both the empty-log
 * early return and the main pass can share it.
 */
function buildPollStats(pollCounts: Map<string, Map<string, number>>, opts: ComputeStatsOpts): PollStat[] {
  const metasByPoll = new Map<string, PollOptionMeta[]>();
  const pollOrder: string[] = [];
  const pollSeen = new Set<string>();
  for (const meta of opts.pollOptions ?? []) {
    const list = metasByPoll.get(meta.poll);
    if (list) list.push(meta);
    else metasByPoll.set(meta.poll, [meta]);
    if (!pollSeen.has(meta.poll)) {
      pollSeen.add(meta.poll);
      pollOrder.push(meta.poll);
    }
  }
  for (const poll of pollCounts.keys()) {
    if (!pollSeen.has(poll)) {
      pollSeen.add(poll);
      pollOrder.push(poll);
    }
  }

  return pollOrder.map((poll) => {
    const metas = metasByPoll.get(poll) ?? [];
    // 'rate' only if every option computeStats knows about for this poll is 'rate'
    // (a poll mixing VOTE_/RATE_ is 'vote' everywhere it's aggregated; see PollStat).
    const kind: 'vote' | 'rate' = metas.length > 0 && metas.every((m) => m.kind === 'rate') ? 'rate' : 'vote';
    const counts = pollCounts.get(poll) ?? new Map<string, number>();
    const total = Array.from(counts.values()).reduce((s, c) => s + c, 0);

    const choiceOrder: string[] = [];
    const choiceSeen = new Set<string>();
    for (const m of metas) {
      if (!choiceSeen.has(m.choice)) {
        choiceSeen.add(m.choice);
        choiceOrder.push(m.choice);
      }
    }
    for (const choice of counts.keys()) {
      if (!choiceSeen.has(choice)) {
        choiceSeen.add(choice);
        choiceOrder.push(choice);
      }
    }

    const metaByChoice = new Map(metas.map((m) => [m.choice, m] as const));
    const choices: PollChoiceStat[] = choiceOrder.map((choice) => {
      const count = counts.get(choice) ?? 0;
      const overrideLabel = opts.pollLabels?.[pollLabelKey(poll, choice)];
      const label = overrideLabel ?? metaByChoice.get(choice)?.label ?? choice;
      return { choice, label, count, pct: total > 0 ? (count / total) * 100 : 0 };
    });

    let mean: number | null = null;
    if (kind === 'rate') {
      let sum = 0;
      let n = 0;
      for (const choice of choiceOrder) {
        const num = Number(choice);
        if (Number.isFinite(num)) {
          const c = counts.get(choice) ?? 0;
          sum += num * c;
          n += c;
        }
      }
      mean = n > 0 ? sum / n : null;
    }

    return { poll, label: prettyPoll(poll), kind, total, choices, mean };
  });
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
export function computeStats(
  events: LogEvent[],
  labels: Record<string, string>,
  opts: ComputeStatsOpts = {},
): ReportStats {
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
      uptime: emptyUptime(),
      uptimePct: null,
      attractStarts: 0,
      attractEnds: 0,
      attractPullInPct: null,
      homeVotes: 0,
      interactions: 0,
      polls: buildPollStats(new Map(), opts),
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

  // ---- attract loop (feature F) ----
  let attractStarts = 0;
  let attractEnds = 0;
  let openAttractFromMs: number | null = null;
  // Closed periods only (not raw events), so memory stays flat regardless of event count;
  // clipped into per-bucket attractMs below once bucketMs/startMs/numBuckets are known.
  const attractPeriods: { fromMs: number; toMs: number }[] = [];

  // ---- polls and ratings (feature G) ----
  // count of `vote` events with no visit_id: an unlinked Home vote (decision 4).
  let homeVotes = 0;
  // poll -> choice -> vote count, across both home and visit votes.
  const pollCounts = new Map<string, Map<string, number>>();

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
    // heartbeat is excluded here on purpose: it must extend firstTs/lastTs (and so the
    // Activity chart's time axis and bucket width, see below) without ever being able to
    // flip a single-evening session that merely stays running past midnight into a
    // multi-day report. Every other event type still counts, as before.
    if (ev.event !== 'heartbeat') dayKeysSeen.add(dayKey(ev.ts));

    if (ev.button_id && ev.button_label) {
      latestLabel.set(ev.button_id, ev.button_label);
    }

    // A visit still open when the kiosk restarts or resumes can never be completed by a
    // later return_home, so close it now as an orphan (see closeVisitOrphaned).
    if (ev.event === 'app_resume' || ev.event === 'kiosk_start' || ev.event === 'kiosk_stop') {
      for (const id of Array.from(openVisitPaths.keys())) closeVisitOrphaned(id);
    }

    // attract loop (feature F): a period runs from attract_start to the next attract_end,
    // or to kiosk_stop/kiosk_start/app_resume, or (handled after the loop) the end of the
    // log, whichever comes first (see ReportStats.attractStarts doc comment / SPEC).
    if (ev.event === 'attract_start') {
      attractStarts += 1;
      const ms = parseTs(ev.ts);
      // Defensive: a second attract_start with no closing event in between (shouldn't happen
      // on a real kiosk) closes the previous period here first, so periods never overlap.
      if (openAttractFromMs !== null) attractPeriods.push({ fromMs: openAttractFromMs, toMs: ms });
      openAttractFromMs = ms;
    } else if (ev.event === 'attract_end') {
      attractEnds += 1;
      if (openAttractFromMs !== null) {
        attractPeriods.push({ fromMs: openAttractFromMs, toMs: parseTs(ev.ts) });
        openAttractFromMs = null;
      }
    } else if (
      (ev.event === 'kiosk_start' || ev.event === 'kiosk_stop' || ev.event === 'app_resume') &&
      openAttractFromMs !== null
    ) {
      attractPeriods.push({ fromMs: openAttractFromMs, toMs: parseTs(ev.ts) });
      openAttractFromMs = null;
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
    } else if (ev.event === 'vote' && ev.poll !== undefined && ev.choice !== undefined) {
      // Every vote counts toward Poll results (home and destination alike, decision 4); only
      // a vote with no visit_id is a home-slide vote, since a destination-slide vote and a
      // linked home vote both carry the visit's visit_id.
      if (!ev.visit_id) homeVotes += 1;
      let choices = pollCounts.get(ev.poll);
      if (!choices) {
        choices = new Map();
        pollCounts.set(ev.poll, choices);
      }
      choices.set(ev.choice, (choices.get(ev.choice) ?? 0) + 1);
    }
  }

  // Any visit still open at the end of the log never reached return_home (the app was
  // killed, or the log/export scope simply ends mid-visit), so orphan it too.
  for (const id of Array.from(openVisitPaths.keys())) closeVisitOrphaned(id);

  // An attract period still open at the end of the log (no attract_end, kiosk_stop,
  // kiosk_start or app_resume came after it in scope) closes at the log's own last event.
  if (openAttractFromMs !== null) {
    attractPeriods.push({ fromMs: openAttractFromMs, toMs: parseTs(lastTs) });
  }

  // Clip each attract period into the buckets it overlaps, so ActivityBucket.attractMs stays
  // a single number per bucket rather than growing with the number of attract periods.
  const bucketAttractMs = new Array<number>(numBuckets).fill(0);
  const scopeEndMs = startMs + numBuckets * bucketMs;
  for (const period of attractPeriods) {
    const from = Math.max(period.fromMs, startMs);
    const to = Math.min(period.toMs, scopeEndMs);
    if (!(to > from)) continue;
    const firstIdx = Math.min(numBuckets - 1, Math.max(0, Math.floor((from - startMs) / bucketMs)));
    const lastIdx = Math.min(numBuckets - 1, Math.max(0, Math.floor((to - startMs - 1) / bucketMs)));
    for (let i = firstIdx; i <= lastIdx; i++) {
      const bucketStart = startMs + i * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      const overlap = Math.min(to, bucketEnd) - Math.max(from, bucketStart);
      if (overlap > 0) bucketAttractMs[i] += overlap;
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
    return { start, end, counts: obj, total, attractMs: bucketAttractMs[i] };
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

  const uptime = computeUptime(sorted);
  const uptimePct = uptimePctOf(uptime);
  const attractPullInPct = attractStarts > 0 ? (attractEnds / attractStarts) * 100 : null;
  const interactions = totalVisits + homeVotes;
  const polls = buildPollStats(pollCounts, opts);

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
    uptime,
    uptimePct,
    attractStarts,
    attractEnds,
    attractPullInPct,
    homeVotes,
    interactions,
    polls,
  };
}
