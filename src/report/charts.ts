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

function clearBg(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** Donut of values with a legend listing label, count and share %. */
export function drawDonutChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: NamedValue[],
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const total = data.reduce((s, d) => s + d.value, 0);

  const legendW = Math.min(width * 0.42, 340);
  const chartW = width - legendW;
  const cx = chartW / 2;
  const cy = height / 2;
  const outerR = Math.min(chartW, height) * 0.38;
  const innerR = outerR * 0.58;

  if (total <= 0 || data.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = `16px ${FONT_FAMILY}`;
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
    ctx.font = `bold 22px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(total), cx, cy - 8);
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.fillStyle = MUTED_COLOR;
    ctx.fillText('total', cx, cy + 12);
  }

  // legend
  const legendX = chartW + 16;
  let ly = Math.max(16, height / 2 - (data.length * 22) / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const d of data) {
    const pct = total > 0 ? (d.value / total) * 100 : 0;
    ctx.fillStyle = d.color;
    ctx.fillRect(legendX, ly - 6, 12, 12);
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = `13px ${FONT_FAMILY}`;
    ctx.fillText(`${d.label}`, legendX + 18, ly);
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.fillText(`${d.value} (${fmtPct(pct)})`, legendX + 18, ly + 14);
    ly += 32;
    if (ly > height - 8) break; // avoid drawing off-canvas for very long lists
  }
}

/** Horizontal bar chart, one bar per entry, value formatted as a duration. */
export function drawDwellBarChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: NamedValue[],
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  if (data.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const labelW = Math.min(width * 0.28, 220);
  const valueW = 90;
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const max = Math.max(1, ...data.map((d) => d.value));
  const rowH = height / data.length;
  const barH = Math.min(28, rowH * 0.6);

  ctx.font = `13px ${FONT_FAMILY}`;
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
export function drawActivityChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: ActivityChartData,
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const { buckets, series } = data;

  const marginL = 40;
  const marginB = 46;
  const marginT = 16;
  const marginR = 12;
  const plotW = width - marginL - marginR;
  const plotH = height - marginT - marginB;

  if (buckets.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const totals = buckets.map((b) => series.reduce((s, sr) => s + (b.counts[sr.id] ?? 0), 0));
  const max = Math.max(1, ...totals);

  // gridlines + y axis labels (4 steps)
  ctx.strokeStyle = GRID_COLOR;
  ctx.fillStyle = MUTED_COLOR;
  ctx.font = `11px ${FONT_FAMILY}`;
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
  const barW = Math.max(1, slotW * 0.7);
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
      ctx.font = `10px ${FONT_FAMILY}`;
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

/** Bar chart for a small set of named values (used for return-method split). */
export function drawBarChart(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  data: NamedValue[],
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  if (data.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }
  const total = data.reduce((s, d) => s + d.value, 0);
  const marginB = 40;
  const marginT = 16;
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
    ctx.font = `bold 13px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const pct = total > 0 ? (d.value / total) * 100 : 0;
    ctx.fillText(`${d.value} (${fmtPct(pct)})`, cx, y - 4);

    ctx.fillStyle = MUTED_COLOR;
    ctx.font = `12px ${FONT_FAMILY}`;
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
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  if (data.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }
  const labelW = Math.min(width * 0.28, 220);
  const valueW = 60;
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const max = Math.max(1, ...data.map((d) => d.value));
  const rowH = height / data.length;
  const barH = Math.min(28, rowH * 0.6);

  ctx.font = `13px ${FONT_FAMILY}`;
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
): void {
  if (!ctx) return;
  clearBg(ctx, width, height);
  const { days, matrix } = data;
  if (days.length === 0 || matrix.length === 0) {
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const labelW = 90;
  const marginT = 20;
  const marginB = 24;
  const plotW = width - labelW - 12;
  const plotH = height - marginT - marginB;
  const cellW = plotW / 24;
  const cellH = plotH / days.length;

  let max = 0;
  for (const row of matrix) for (const v of row) max = Math.max(max, v);
  max = Math.max(1, max);

  // base colour ramp from light to the first palette colour (blue-safe: use a fixed blue ramp)
  const rampTo = { r: 0, g: 114, b: 178 }; // Okabe-Ito blue

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = `11px ${FONT_FAMILY}`;

  days.forEach((day, r) => {
    ctx.fillStyle = MUTED_COLOR;
    ctx.fillText(day, labelW - 8, marginT + r * cellH + cellH / 2);
    for (let h = 0; h < 24; h++) {
      const v = matrix[r]?.[h] ?? 0;
      const t = v / max;
      const rr = Math.round(255 + (rampTo.r - 255) * t);
      const gg = Math.round(255 + (rampTo.g - 255) * t);
      const bb = Math.round(255 + (rampTo.b - 255) * t);
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
