/**
 * Chart primitives drawn by hand on a 2D canvas context (no chart library).
 * Every function is a pure `(ctx, width, height, data) => void`: it only
 * draws into the given context at the given pixel size, so the same code
 * works for an offscreen high-DPI canvas destined for the PDF or (if ever
 * needed) an on-screen preview.
 *
 * `ctx` may be null (jsdom/older browsers have no real canvas 2D context) —
 * every function guards for that and simply does nothing.
 */

import { SLIDE_W } from '../types';

export interface NamedValue {
  label: string;
  value: number;
  color: string;
}

export interface ActivityChartBucket {
  /** label already formatted for the time axis, e.g. "09:00" */
  label: string;
  /** button_id -> press count for this bucket */
  counts: Record<string, number>;
}

export interface ActivityChartSeries {
  id: string;
  label: string;
  color: string;
}

export interface ActivityChartData {
  buckets: ActivityChartBucket[];
  series: ActivityChartSeries[];
}

export interface HeatmapChartData {
  /** row labels, e.g. yyyy-mm-dd */
  days: string[];
  /** matrix[dayIndex][hour 0..23] = count */
  matrix: number[][];
}

export interface TapHeatmapButton {
  label: string;
  /** slide px (see src/types.ts geometry convention: x/w over SLIDE_W, y/h over deckHeight) */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TapHeatmapData {
  /** missGrid[row][col], see ReportStats.missGrid (27 rows x 48 columns, 16:9 cells) */
  grid: number[][];
  /** home-slide button bounds and resolved labels, drawn as outlines over the grid */
  buttons: TapHeatmapButton[];
  /** deck.height, slide px; the grid is mapped onto a deckHeight-tall area so a non-16:9 deck still lines up */
  deckHeight: number;
  /** decoded home-slide thumbnail, drawn underneath the grid when available (best-effort) */
  thumbnail?: CanvasImageSource;
}

export interface SlideTimeChartEntry {
  /** slide number, e.g. 3 (drawn as "Slide 3"; titles aren't in the deck model) */
  slide: number;
  /** timed stays on this slide (ReportStats.SlideTimeStat.visits); used only to choose which
   * slides to keep when there are more than MAX_SLIDE_TIME_ROWS */
  visits: number;
  medianMs: number;
  /** null when every visit through this slide ended by timeout (nothing left to show) */
  medianMsExclTimeout: number | null;
}

export interface SlideTimeChartData {
  entries: SlideTimeChartEntry[];
}

export interface PathTableEntry {
  /** slide numbers in order, e.g. [3, 4, 5]; empty only for the synthetic "Other" row (use `label`) */
  path: number[];
  count: number;
  /** 0..100 */
  pct: number;
  /** true for a path reconstructed from a visit that never reached return_home (see ReportStats.PathStat) */
  ended: boolean;
  /** overrides the path-derived text; used for the "Other" row (empty `path`) */
  label?: string;
}

export interface PathTableData {
  /** already the rows to draw (top paths plus an optional "Other" row); this function does no bucketing */
  entries: PathTableEntry[];
}

const FONT_FAMILY = 'Helvetica, Arial, sans-serif';
const TEXT_COLOR = '#1a1a1a';
const MUTED_COLOR = '#666666';
const GRID_COLOR = '#e0e0e0';
const AXIS_COLOR = '#999999';

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/**
 * White-to-Emota-blackberry (#2A034C, the brand's logo colour) colour ramp shared by every
 * density chart (hour-by-day heatmap, home-slide tap heatmap). `t` is 0..1.
 */
function rampColor(t: number): { r: number; g: number; b: number } {
  const to = { r: 42, g: 3, b: 76 };
  return {
    r: Math.round(255 + (to.r - 255) * t),
    g: Math.round(255 + (to.g - 255) * t),
    b: Math.round(255 + (to.b - 255) * t),
  };
}

function clearBg(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/**
 * Every chart is drawn at a fixed CSS pixel size, then placed into the PDF at whatever
 * millimetre width the page layout picks — which can shrink it a lot. `fontScale` lets the
 * caller (see report/pdf.ts) compensate: it multiplies every font size in the chart so text
 * stays legible (~9pt or more) once printed, no matter how small the placed image ends up.
 * A scale of 1 reproduces the original (on-screen-sized) fonts.
 */
function scaledFont(basePx: number, fontScale: number, bold = false): string {
  const px = Math.round(basePx * fontScale);
  return `${bold ? 'bold ' : ''}${px}px ${FONT_FAMILY}`;
}

/** Donut of values with a legend listing label, count and share %. */
export function drawDonutChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: NamedValue[],
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const total = data.reduce((s, d) => s + d.value, 0);

  const legendW = Math.min(Math.max(width * 0.42, 150 * fontScale), width * 0.56);
  const chartW = width - legendW;
  const cx = chartW / 2;
  const cy = height / 2;
  const outerR = Math.min(chartW, height) * 0.38;
  const innerR = outerR * 0.58;

  if (total <= 0 || data.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No data', cx, cy);
  } else {
    let angle = -Math.PI / 2;
    for (const d of data) {
      if (d.value <= 0) continue;
      const slice = (d.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = d.color;
      ctx.fill();
      angle += slice;
    }
    // punch the hole
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.fillStyle = TEXT_COLOR;
    ctx.font = scaledFont(22, fontScale, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(total), cx, cy - 8 * fontScale);
    ctx.font = scaledFont(12, fontScale);
    ctx.fillStyle = MUTED_COLOR;
    ctx.fillText('total', cx, cy + 12 * fontScale);
  }

  // legend
  const legendX = chartW + 16;
  const swatch = Math.round(12 * fontScale);
  const rowH = Math.max(32, 34 * fontScale);
  let ly = Math.max(rowH / 2, height / 2 - (data.length * rowH) / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const d of data) {
    const pct = total > 0 ? (d.value / total) * 100 : 0;
    ctx.fillStyle = d.color;
    ctx.fillRect(legendX, ly - swatch / 2, swatch, swatch);
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = scaledFont(13, fontScale);
    ctx.fillText(`${d.label}`, legendX + swatch + 6, ly);
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(12, fontScale);
    ctx.fillText(`${d.value} (${fmtPct(pct)})`, legendX + swatch + 6, ly + 14 * fontScale);
    ly += rowH;
    if (ly > height - 8) break; // avoid drawing off-canvas for very long lists
  }
}

/** Horizontal bar chart, one bar per entry, value formatted as a duration. */
export function drawDwellBarChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: NamedValue[],
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  if (data.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const labelW = Math.min(Math.max(width * 0.28, 90 * fontScale), width * 0.4);
  const valueW = Math.max(90, 64 * fontScale);
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const max = Math.max(1, ...data.map((d) => d.value));
  const rowH = height / data.length;
  const barH = Math.min(Math.max(28, 24 * fontScale), rowH * 0.6);

  ctx.font = scaledFont(13, fontScale);
  data.forEach((d, i) => {
    const y = i * rowH + rowH / 2;
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const label = d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label;
    ctx.fillText(label, plotX - 10, y);

    const w = (d.value / max) * plotW;
    ctx.fillStyle = d.color;
    ctx.fillRect(plotX, y - barH / 2, Math.max(1, w), barH);

    ctx.fillStyle = MUTED_COLOR;
    ctx.textAlign = 'left';
    ctx.fillText(fmtMs(d.value), plotX + w + 8, y);
  });
}

/** Stacked bar of presses per interval, one colour per button, with time-axis labels. */
/** Bars never grow wider than this even when a single bucket spans the whole plot. */
const MAX_ACTIVITY_BAR_W = 140;

export function drawActivityChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: ActivityChartData,
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const { buckets, series } = data;

  const marginL = Math.max(40, 30 * fontScale);
  const marginB = Math.max(46, 38 * fontScale);
  const marginT = Math.max(16, 12 * fontScale);
  const marginR = 12;
  const plotW = width - marginL - marginR;
  const plotH = height - marginT - marginB;

  if (buckets.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const totals = buckets.map((b) => series.reduce((s, sr) => s + (b.counts[sr.id] ?? 0), 0));
  const max = Math.max(1, ...totals);

  // gridlines + y axis labels (4 steps)
  ctx.strokeStyle = GRID_COLOR;
  ctx.fillStyle = MUTED_COLOR;
  ctx.font = scaledFont(11, fontScale);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = Math.round((max / steps) * s);
    const y = marginT + plotH - (v / max) * plotH;
    ctx.beginPath();
    ctx.moveTo(marginL, y);
    ctx.lineTo(marginL + plotW, y);
    ctx.stroke();
    ctx.fillText(String(v), marginL - 6, y);
  }

  const slotW = plotW / buckets.length;
  const barW = Math.min(Math.max(1, slotW * 0.7), MAX_ACTIVITY_BAR_W);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 12));

  buckets.forEach((b, i) => {
    const x = marginL + i * slotW + (slotW - barW) / 2;
    let yTop = marginT + plotH;
    for (const sr of series) {
      const v = b.counts[sr.id] ?? 0;
      if (v <= 0) continue;
      const h = (v / max) * plotH;
      yTop -= h;
      ctx.fillStyle = sr.color;
      ctx.fillRect(x, yTop, barW, h);
    }

    if (i % labelEvery === 0) {
      ctx.save();
      ctx.fillStyle = MUTED_COLOR;
      ctx.font = scaledFont(10, fontScale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(b.label, x + barW / 2, marginT + plotH + 8);
      ctx.restore();
    }
  });

  // axis line
  ctx.strokeStyle = AXIS_COLOR;
  ctx.beginPath();
  ctx.moveTo(marginL, marginT + plotH);
  ctx.lineTo(marginL + plotW, marginT + plotH);
  ctx.stroke();
}

export interface UptimeStripSegment {
  /** ISO instant (local-offset, see util.isoLocal) */
  from: string;
  to: string;
}

/** A running span for the strip; see `ReportStats.uptime.spans` / `UptimeSpan.monitored`. */
export interface UptimeStripSpan extends UptimeStripSegment {
  /** false for a span with no heartbeat at all (an older log, or a span shorter than one tick) */
  monitored: boolean;
}

export interface UptimeStripData {
  /**
   * Epoch-ms bounds of the time axis. Must be the same `startMs`/`endMs` the paired
   * `drawActivityChart` call above it derives from its own buckets, so the two images'
   * horizontal axes agree once both are placed at the same width in the PDF.
   */
  startMs: number;
  endMs: number;
  /** running spans (ReportStats.uptime.spans): monitored ones drawn green, unmonitored ones neutral grey */
  spans: UptimeStripSpan[];
  /** downtime gaps inside monitored spans (ReportStats.uptime.gaps), drawn over the green in red */
  gaps: UptimeStripSegment[];
}

const UPTIME_RUNNING_COLOR = '#3F9142'; // muted green
const UPTIME_DOWN_COLOR = '#B24C43'; // muted red
const UPTIME_STOPPED_COLOR = '#EDEDED'; // light grey: outside any running span
const UPTIME_UNMONITORED_COLOR = '#A6A6A6'; // neutral mid grey: a span with no heartbeat data

function parseMsOrNaN(ts: string): number {
  return Date.parse(ts);
}

function clampMs(ms: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, ms));
}

/**
 * A thin up/down strip spanning the same time axis as the activity chart above it: green
 * for a monitored running span, a muted red for a downtime gap inside one (drawn over the
 * green), neutral grey for a span with no heartbeat data at all (an older log, see
 * `UptimeStripSpan.monitored`), and light grey everywhere else (the kiosk wasn't running:
 * Setup, or between sessions). See `UptimeStripData` for how its axis is kept in sync with
 * `drawActivityChart`'s.
 */
export function drawUptimeStrip(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: UptimeStripData,
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const { startMs, endMs, spans, gaps } = data;

  // Same formula as drawActivityChart's marginL/marginR: passing the same fontScale keeps
  // the two charts' plot areas (and so their time axes) pixel-aligned once placed.
  const marginL = Math.max(40, 30 * fontScale);
  const marginR = 12;
  const plotW = Math.max(1, width - marginL - marginR);

  const legendH = Math.max(18, 16 * fontScale);
  const stripTop = 4;
  const stripH = Math.max(8, height - legendH - stripTop - 4);

  const durationMs = Math.max(1, endMs - startMs);
  const xOf = (ms: number): number => marginL + ((clampMs(ms, startMs, endMs) - startMs) / durationMs) * plotW;

  ctx.fillStyle = UPTIME_STOPPED_COLOR;
  ctx.fillRect(marginL, stripTop, plotW, stripH);

  let hasUnmonitored = false;
  for (const s of spans) {
    const fromMs = parseMsOrNaN(s.from);
    const toMs = parseMsOrNaN(s.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) continue;
    if (!s.monitored) hasUnmonitored = true;
    ctx.fillStyle = s.monitored ? UPTIME_RUNNING_COLOR : UPTIME_UNMONITORED_COLOR;
    const x1 = xOf(fromMs);
    const x2 = xOf(toMs);
    ctx.fillRect(x1, stripTop, Math.max(1, x2 - x1), stripH);
  }

  ctx.fillStyle = UPTIME_DOWN_COLOR;
  for (const g of gaps) {
    const fromMs = parseMsOrNaN(g.from);
    const toMs = parseMsOrNaN(g.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) continue;
    const x1 = xOf(fromMs);
    const x2 = xOf(toMs);
    ctx.fillRect(x1, stripTop, Math.max(1, x2 - x1), stripH);
  }

  ctx.strokeStyle = AXIS_COLOR;
  ctx.strokeRect(marginL, stripTop, plotW, stripH);

  // legend: swatches with labels, left-aligned under the strip. "No heartbeat data" only
  // appears when the scope actually has an unmonitored span, so a fully modern log's strip
  // isn't cluttered with a legend entry that never applies to it.
  const legendY = stripTop + stripH + legendH / 2;
  const sw = Math.max(9, 10 * fontScale);
  ctx.font = scaledFont(11, fontScale);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lx = marginL;
  const items: Array<[string, string]> = [
    [UPTIME_RUNNING_COLOR, 'Running'],
    [UPTIME_DOWN_COLOR, 'Down'],
    [UPTIME_STOPPED_COLOR, 'Stopped'],
    ...(hasUnmonitored ? ([[UPTIME_UNMONITORED_COLOR, 'No heartbeat data']] as Array<[string, string]>) : []),
  ];
  for (const [color, label] of items) {
    ctx.fillStyle = color;
    ctx.strokeStyle = AXIS_COLOR;
    ctx.fillRect(lx, legendY - sw / 2, sw, sw);
    ctx.strokeRect(lx, legendY - sw / 2, sw, sw);
    ctx.fillStyle = MUTED_COLOR;
    ctx.fillText(label, lx + sw + 6, legendY);
    lx += sw + 6 + ctx.measureText(label).width + 18;
  }
}

/** Bar chart for a small set of named values (used for return-method split). */
export function drawBarChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: NamedValue[],
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  if (data.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }
  const total = data.reduce((s, d) => s + d.value, 0);
  const marginB = Math.max(40, 32 * fontScale);
  const marginT = Math.max(16, 22 * fontScale);
  const plotH = height - marginT - marginB;
  const max = Math.max(1, ...data.map((d) => d.value));
  const slotW = width / data.length;
  const barW = Math.min(90, slotW * 0.5);

  data.forEach((d, i) => {
    const cx = i * slotW + slotW / 2;
    const h = (d.value / max) * plotH;
    const y = marginT + plotH - h;
    ctx.fillStyle = d.color;
    ctx.fillRect(cx - barW / 2, y, barW, h);

    ctx.fillStyle = TEXT_COLOR;
    ctx.font = scaledFont(13, fontScale, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const pct = total > 0 ? (d.value / total) * 100 : 0;
    ctx.fillText(`${d.value} (${fmtPct(pct)})`, cx, y - 4);

    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(12, fontScale);
    ctx.textBaseline = 'top';
    ctx.fillText(d.label, cx, marginT + plotH + 6);
  });
}

/** Horizontal bar chart with values formatted as percentages (e.g. timeout share per button). */
export function drawPercentBarChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: NamedValue[],
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  if (data.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }
  const labelW = Math.min(Math.max(width * 0.28, 90 * fontScale), width * 0.4);
  const valueW = Math.max(60, 46 * fontScale);
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const max = Math.max(1, ...data.map((d) => d.value));
  const rowH = height / data.length;
  const barH = Math.min(Math.max(28, 24 * fontScale), rowH * 0.6);

  ctx.font = scaledFont(13, fontScale);
  data.forEach((d, i) => {
    const y = i * rowH + rowH / 2;
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const label = d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label;
    ctx.fillText(label, plotX - 10, y);

    const w = (d.value / max) * plotW;
    ctx.fillStyle = d.color;
    ctx.fillRect(plotX, y - barH / 2, Math.max(1, w), barH);

    ctx.fillStyle = MUTED_COLOR;
    ctx.textAlign = 'left';
    ctx.fillText(`${d.value.toFixed(1)}%`, plotX + w + 8, y);
  });
}

/** Hour (0-23, x axis) by day (y axis) heatmap of press counts. */
export function drawHeatmapChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: HeatmapChartData,
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const { days, matrix } = data;
  if (days.length === 0 || matrix.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const labelW = Math.max(90, 72 * fontScale);
  const marginT = Math.max(20, 14 * fontScale);
  const marginB = Math.max(24, 20 * fontScale);
  const plotW = width - labelW - 12;
  const plotH = height - marginT - marginB;
  const cellW = plotW / 24;
  const cellH = plotH / days.length;

  let max = 0;
  for (const row of matrix) for (const v of row) max = Math.max(max, v);
  max = Math.max(1, max);

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = scaledFont(11, fontScale);

  days.forEach((day, r) => {
    ctx.fillStyle = MUTED_COLOR;
    ctx.fillText(day, labelW - 8, marginT + r * cellH + cellH / 2);
    for (let h = 0; h < 24; h++) {
      const v = matrix[r]?.[h] ?? 0;
      const { r: rr, g: gg, b: bb } = rampColor(v / max);
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      ctx.fillRect(labelW + h * cellW, marginT + r * cellH, Math.ceil(cellW) - 1, Math.ceil(cellH) - 1);
    }
  });

  // hour labels every 3 hours
  ctx.fillStyle = MUTED_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let h = 0; h < 24; h += 3) {
    ctx.fillText(String(h).padStart(2, '0'), labelW + h * cellW + cellW / 2, marginT + plotH + 4);
  }
}

/**
 * Miss-tap density over the home slide: `data.grid` cells coloured with the same
 * white-to-blackberry ramp as `drawHeatmapChart` (at partial opacity, so an optional
 * thumbnail underneath stays visible), then every button's bounds drawn as an outline
 * with its label. The plot area is letterboxed to the deck's own aspect ratio
 * (`SLIDE_W` wide by `deckHeight` tall) so grid cells, the thumbnail and the button
 * outlines all line up, even for a non-16:9 deck.
 *
 * The thumbnail is optional and best-effort: when absent (not generated, or failed to
 * decode) the cells and outlines alone still make the chart readable.
 */
export function drawTapHeatmap(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: TapHeatmapData,
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const { grid, buttons, thumbnail } = data;
  const deckHeight = data.deckHeight > 0 ? data.deckHeight : (SLIDE_W * 9) / 16;
  const rows = grid.length;
  const cols = rows > 0 ? grid[0].length : 0;

  if (rows === 0 && buttons.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  // letterbox the deck's own aspect ratio inside the available width x height, same
  // idea as SlideStage on screen, so the grid, thumbnail and button outlines agree.
  const deckAspect = SLIDE_W / deckHeight;
  let plotW = width;
  let plotH = width / deckAspect;
  if (plotH > height) {
    plotH = height;
    plotW = height * deckAspect;
  }
  const plotX = (width - plotW) / 2;
  const plotY = (height - plotH) / 2;

  if (thumbnail) {
    try {
      ctx.drawImage(thumbnail, plotX, plotY, plotW, plotH);
      // light wash so the heatmap cells and outlines stay legible over the thumbnail
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.fillRect(plotX, plotY, plotW, plotH);
    } catch {
      // best-effort: draw without the thumbnail
    }
  } else {
    ctx.strokeStyle = GRID_COLOR;
    ctx.strokeRect(plotX, plotY, plotW, plotH);
  }

  if (rows > 0 && cols > 0) {
    let max = 0;
    for (const row of grid) for (const v of row) max = Math.max(max, v);
    if (max > 0) {
      const cellW = plotW / cols;
      const cellH = plotH / rows;
      ctx.save();
      ctx.globalAlpha = 0.75;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = grid[r][c];
          if (v <= 0) continue;
          const { r: rr, g: gg, b: bb } = rampColor(v / max);
          ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
          ctx.fillRect(plotX + c * cellW, plotY + r * cellH, Math.ceil(cellW) - 0.5, Math.ceil(cellH) - 0.5);
        }
      }
      ctx.restore();
    }
  }

  // button bounds (slide px, x/w over SLIDE_W, y/h over deckHeight) as outlines + labels
  ctx.strokeStyle = '#2A034C';
  ctx.lineWidth = Math.max(1, 1.5 * fontScale);
  ctx.font = scaledFont(11, fontScale, true);
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of buttons) {
    const bx = plotX + (b.x / SLIDE_W) * plotW;
    const by = plotY + (b.y / deckHeight) * plotH;
    const bw = (b.w / SLIDE_W) * plotW;
    const bh = (b.h / deckHeight) * plotH;
    ctx.strokeRect(bx, by, bw, bh);
    const label = b.label.length > 18 ? `${b.label.slice(0, 17)}…` : b.label;
    ctx.fillText(label, bx + bw / 2, by + bh / 2);
  }
}

const SLIDE_TIME_COLOR = '#2A034C';
/** Lighter tint of the brand blackberry, for the "excl. timeout returns" bar. */
const SLIDE_TIME_EXCL_COLOR = '#B9A6D6';

/**
 * Maximum slides `drawSlideTimeChart` draws a row for. Beyond this, row labels start
 * overlapping at typical PDF placement sizes (a chart drawn wide but placed narrow, with
 * fontScale compensating text size upward; see report/pdf.ts `fontScaleFor`). When there
 * are more slides than this, the busiest ones (most timed stays) are kept, shown in
 * ascending slide order, and a note below the chart says how many more aren't shown.
 */
const MAX_SLIDE_TIME_ROWS = 16;

/**
 * Paired horizontal bars of median time spent per slide: one bar per slide for every
 * timed stay, and a second, lighter bar excluding the last-slide stay of visits that
 * ended by timeout (see `ReportStats.SlideTimeStat` for why that stay can be skewed).
 * A slide with no excl.-timeout data (every visit through it ended by timeout) draws
 * only the first bar. See `MAX_SLIDE_TIME_ROWS` for the row cap on decks with many
 * destination slides.
 */
export function drawSlideTimeChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: SlideTimeChartData,
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const { entries } = data;
  if (entries.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const hiddenCount = Math.max(0, entries.length - MAX_SLIDE_TIME_ROWS);
  const shown =
    hiddenCount === 0
      ? entries
      : entries
          .slice()
          .sort((a, b) => b.visits - a.visits)
          .slice(0, MAX_SLIDE_TIME_ROWS)
          .sort((a, b) => a.slide - b.slide);

  // legend
  const legendH = Math.max(22, 20 * fontScale);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = scaledFont(12, fontScale);
  const sw = Math.max(9, 10 * fontScale);
  let lx = 4;
  const ly = legendH / 2;
  ctx.fillStyle = SLIDE_TIME_COLOR;
  ctx.fillRect(lx, ly - sw / 2, sw, sw);
  ctx.fillStyle = TEXT_COLOR;
  const mainLabel = 'Median time on slide';
  ctx.fillText(mainLabel, lx + sw + 6, ly);
  lx += sw + 6 + ctx.measureText(mainLabel).width + 18;
  ctx.fillStyle = SLIDE_TIME_EXCL_COLOR;
  ctx.fillRect(lx, ly - sw / 2, sw, sw);
  ctx.fillStyle = TEXT_COLOR;
  ctx.fillText('excl. timeout returns', lx + sw + 6, ly);

  const noteH = hiddenCount > 0 ? Math.max(16, 14 * fontScale) : 0;
  const labelW = Math.min(Math.max(width * 0.2, 64 * fontScale), width * 0.32);
  const valueW = Math.max(90, 64 * fontScale);
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const plotTop = legendH;
  const plotH = Math.max(1, height - legendH - noteH);
  const max = Math.max(1, ...shown.map((e) => Math.max(e.medianMs, e.medianMsExclTimeout ?? 0)));
  const rowH = plotH / shown.length;
  const barH = Math.min(Math.max(9, 8 * fontScale), rowH * 0.34);
  const barGap = Math.max(2, 2 * fontScale);

  // Row text (slide label + values) never exceeds a fraction of the row's own height,
  // however large fontScale asks for, so rows stay legible instead of overlapping.
  const rowFontScale = Math.min(fontScale, Math.max(0.1, (rowH * 0.6) / 13));
  ctx.font = scaledFont(13, rowFontScale);
  shown.forEach((e, i) => {
    const rowMid = plotTop + i * rowH + rowH / 2;
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Slide ${e.slide}`, plotX - 10, rowMid);

    const y1 = rowMid - barH - barGap / 2;
    const w1 = (e.medianMs / max) * plotW;
    ctx.fillStyle = SLIDE_TIME_COLOR;
    ctx.fillRect(plotX, y1, Math.max(1, w1), barH);
    ctx.fillStyle = MUTED_COLOR;
    ctx.textAlign = 'left';
    ctx.fillText(fmtMs(e.medianMs), plotX + w1 + 8, y1 + barH / 2);

    if (e.medianMsExclTimeout !== null) {
      const y2 = rowMid + barGap / 2;
      const w2 = (e.medianMsExclTimeout / max) * plotW;
      ctx.fillStyle = SLIDE_TIME_EXCL_COLOR;
      ctx.fillRect(plotX, y2, Math.max(1, w2), barH);
      ctx.fillStyle = MUTED_COLOR;
      ctx.textAlign = 'left';
      ctx.fillText(fmtMs(e.medianMsExclTimeout), plotX + w2 + 8, y2 + barH / 2);
    }
  });

  if (hiddenCount > 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(11, fontScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`+${hiddenCount} more slides not shown`, width / 2, height - 2);
  }
}

/**
 * A simple table of the most common paths through the deck: "3 → 4 → 5" style labels
 * (drawn on canvas, not `doc.text`, so the arrow glyph, which is outside jsPDF's built-in
 * Helvetica/WinAnsi range, still renders), with a count and % column. An ended path
 * (see `ReportStats.PathStat`) is suffixed " (ended)"; the caller supplies rows already
 * bucketed (top paths plus an optional "Other" row using `label`).
 */
export function drawPathTable(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: PathTableData,
  fontScale = 1,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const { entries } = data;
  if (entries.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = scaledFont(16, fontScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const headerH = Math.max(24, 22 * fontScale);
  const pctColW = Math.max(56, 44 * fontScale);
  const pathColX = 6;
  const countColRight = width - pctColW - 8;
  const pctColRight = width - 8;
  const rowH = Math.max(18, (height - headerH) / entries.length);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = scaledFont(12, fontScale, true);
  ctx.fillStyle = TEXT_COLOR;
  ctx.fillText('Path', pathColX, headerH / 2);
  ctx.textAlign = 'right';
  ctx.fillText('Count', countColRight, headerH / 2);
  ctx.fillText('%', pctColRight, headerH / 2);

  ctx.strokeStyle = GRID_COLOR;
  ctx.beginPath();
  ctx.moveTo(0, headerH);
  ctx.lineTo(width, headerH);
  ctx.stroke();

  ctx.font = scaledFont(12, fontScale);
  entries.forEach((e, i) => {
    const y = headerH + i * rowH + rowH / 2;
    if (y > height) return;
    const base = e.label ?? e.path.join(' → ');
    const text = e.ended ? `${base} (ended)` : base;
    const truncated = text.length > 42 ? `${text.slice(0, 41)}…` : text;

    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncated, pathColX, y);

    ctx.fillStyle = MUTED_COLOR;
    ctx.textAlign = 'right';
    ctx.fillText(String(e.count), countColRight, y);
    ctx.fillText(fmtPct(e.pct), pctColRight, y);
  });
}
