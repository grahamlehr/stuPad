// Type-only import: jsPDF (~400 kB) is loaded on demand in buildPdf so kiosk startup never parses it.
import type { jsPDF } from 'jspdf';
import type { Deck, KioskConfig, LogEvent } from '../types';
import { computeStats, type ReportStats } from './stats';
import { buttonColor, returnMethodColor } from './colors';
import {
  drawDonutChart,
  drawDwellBarChart,
  drawActivityChart,
  drawBarChart,
  drawPercentBarChart,
  drawHeatmapChart,
  type NamedValue,
  type ActivityChartData,
  type HeatmapChartData,
} from './charts';

const PAGE_W = 297; // A4 landscape, mm
const PAGE_H = 210;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatTs(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${base64}`;
}

/** Draws a chart at 2x for crisp print output (~200 dpi at the placed sizes), returns a PNG data URL. */
function renderChartImage<T>(
  draw: (ctx: CanvasRenderingContext2D | null, w: number, h: number, data: T, fontScale?: number) => void,
  data: T,
  cssW: number,
  cssH: number,
  fontScale = 1,
  dpr = 2,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (ctx) ctx.scale(dpr, dpr);
  draw(ctx, cssW, cssH, data, fontScale);
  return canvas.toDataURL('image/png');
}

const PT_TO_MM = 0.352778;
/** Minimum on-paper text size for chart text, in print points. */
const MIN_CHART_PT = 9;

/**
 * A chart is drawn at `cssW` CSS px but placed into the PDF at `wMm` millimetres — often a
 * big reduction. This works out the font-size multiplier (fed to the chart's `fontScale`
 * param) so that `baseFontPx` (the chart's smallest text, at scale 1) still prints at
 * `MIN_CHART_PT` or larger once placed at that width. Never shrinks below the original design.
 */
function fontScaleFor(cssW: number, wMm: number, baseFontPx: number, targetPt = MIN_CHART_PT): number {
  const pxPerMm = cssW / wMm;
  const minPx = pxPerMm * targetPt * PT_TO_MM;
  return Math.max(1, minPx / baseFontPx);
}

function placeImage(
  doc: jsPDF,
  dataUrl: string,
  cssW: number,
  cssH: number,
  x: number,
  y: number,
  wMm: number,
): number {
  const hMm = wMm * (cssH / cssW);
  doc.addImage(dataUrl, 'PNG', x, y, wMm, hMm, undefined, 'FAST');
  return hMm;
}

function drawPageTitle(doc: jsPDF, title: string): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(20, 20, 20);
  doc.text(title, MARGIN, MARGIN + 4);
}

function addFooters(doc: jsPDF, sessionName: string, generatedAt: string): void {
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(130, 130, 130);
    const text = `stuPad · ${sessionName} · page ${i}/${n} · generated ${generatedAt}`;
    doc.text(text, PAGE_W / 2, PAGE_H - 7, { align: 'center' });
  }
}

/** Lays out `[value, label]` pairs as large stat tiles in a `cols`-wide grid, row-major. */
function drawStatTiles(
  doc: jsPDF,
  x: number,
  y: number,
  totalW: number,
  tiles: Array<[string, string]>,
  cols: number,
): number {
  const gap = 6;
  const tileW = (totalW - gap * (cols - 1)) / cols;
  const tileH = 26;
  const rowGap = 8;

  tiles.forEach(([value, label], i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const tx = x + col * (tileW + gap);
    const ty = y + row * (tileH + rowGap);

    doc.setDrawColor(224, 224, 224);
    doc.setFillColor(248, 248, 248);
    doc.roundedRect(tx, ty, tileW, tileH, 2, 2, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19);
    doc.setTextColor(20, 20, 20);
    doc.text(value, tx + tileW / 2, ty + tileH * 0.52, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(110, 110, 110);
    doc.text(label, tx + tileW / 2, ty + tileH - 5, { align: 'center' });
  });

  const rows = Math.ceil(tiles.length / cols);
  return y + rows * (tileH + rowGap);
}

/** Draws the home-slide thumbnail box; best-effort, silently omitted if `png` is missing or fails to load. */
async function drawHomeThumbnail(doc: jsPDF, png: Blob | undefined, x: number, y: number, boxW: number): Promise<void> {
  if (!png) return;
  try {
    const dataUrl = await blobToDataUrl(png);
    const boxH = boxW * (9 / 16);
    doc.setDrawColor(210, 210, 210);
    doc.rect(x - 1, y - 1, boxW + 2, boxH + 2);
    doc.addImage(dataUrl, 'PNG', x, y, boxW, boxH, undefined, 'FAST');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(130, 130, 130);
    doc.text('Home slide', x, y + boxH + 6);
  } catch {
    // thumbnail is best-effort; the report is still valid without it
  }
}

/**
 * Build the full PDF report. Only `deck.buttons` is used (for button order,
 * default labels and colour assignment); rendering/thumbnail generation is
 * the caller's job — pass an already-rendered PNG via `homeThumbPng`.
 */
export async function buildPdf(
  events: LogEvent[],
  deck: Deck,
  config: KioskConfig,
  homeThumbPng?: Blob,
): Promise<Blob> {
  const labels: Record<string, string> = {};
  for (const b of deck.buttons) {
    labels[b.id] = config.buttonLabels[b.id] ?? b.defaultLabel;
  }
  const stats = computeStats(events, labels);

  const colorOf = new Map<string, string>();
  deck.buttons.forEach((b, i) => colorOf.set(b.id, buttonColor(i)));
  const colorForId = (id: string): string => colorOf.get(id) ?? buttonColor(stats.buttons.findIndex((b) => b.id === id));

  const sessionName = config.sessionName || 'stuPad session';
  const now = new Date();
  const generatedAt = formatTs(now.toISOString());

  const { jsPDF } = await import('jspdf');
  // compress + 'FAST' image compression: without them jsPDF stores chart PNGs raw (tens of MB).
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const isEmpty = events.length === 0;

  // ---------------------------------------------------------------- page 1: Summary
  drawPageTitle(doc, 'Summary');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.setTextColor(60, 60, 60);
  doc.text(sessionName, MARGIN, MARGIN + 14);

  if (isEmpty) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(14);
    doc.setTextColor(100, 100, 100);
    doc.text('No interactions recorded.', MARGIN, MARGIN + 34);
    await drawHomeThumbnail(doc, homeThumbPng, PAGE_W / 2 - 55, MARGIN + 46, 110);
  } else {
    const contentTop = MARGIN + 28;
    const rangeStr = `${formatTs(stats.firstTs)} – ${formatTs(stats.lastTs)}`;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(90, 90, 90);
    doc.text(`Date / time range: ${rangeStr}`, MARGIN, contentTop);

    const thumbW = 96;
    const gap = 10;
    const hasThumb = !!homeThumbPng;
    const statsW = hasThumb ? CONTENT_W - thumbW - gap : CONTENT_W;

    const tiles: Array<[string, string]> = [
      [String(stats.totalPresses), 'Total presses'],
      [String(stats.totalVisits), 'Total visits'],
      [fmtDuration(stats.avgDwellMs), 'Average dwell'],
      [String(stats.missTaps), 'Miss taps'],
      [String(stats.buttons.length), 'Buttons'],
    ];
    drawStatTiles(doc, MARGIN, contentTop + 10, statsW, tiles, 3);

    if (hasThumb) {
      await drawHomeThumbnail(doc, homeThumbPng, MARGIN + statsW + gap, contentTop, thumbW);
    }
  }

  if (!isEmpty) {
    // ---------------------------------------------------------------- page 2: Button share
    doc.addPage();
    drawPageTitle(doc, 'Button share');

    const donutData: NamedValue[] = stats.buttons.map((b) => ({
      label: b.label,
      value: b.presses,
      color: colorForId(b.id),
    }));
    const donutW = CONTENT_W * 0.56;
    const donutUrl = renderChartImage(drawDonutChart, donutData, 820, 440, fontScaleFor(820, donutW, 12));
    const donutH = placeImage(doc, donutUrl, 820, 440, MARGIN, MARGIN + 12, donutW);

    const dwellData: NamedValue[] = stats.buttons.map((b) => ({
      label: b.label,
      value: b.avgDwellMs ?? 0,
      color: colorForId(b.id),
    }));
    const dwellX = MARGIN + CONTENT_W * 0.56 + 6;
    const dwellW = CONTENT_W - CONTENT_W * 0.56 - 6;
    const dwellUrl = renderChartImage(drawDwellBarChart, dwellData, 640, 440, fontScaleFor(640, dwellW, 13));
    placeImage(doc, dwellUrl, 640, 440, dwellX, MARGIN + 12, dwellW);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120, 120, 120);
    doc.text('Average dwell per button', dwellX, MARGIN + 12 + Math.min(donutH, dwellW * (440 / 640)) + 8);

    // ---------------------------------------------------------------- page 3: Activity over time
    doc.addPage();
    drawPageTitle(doc, 'Activity over time');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120, 120, 120);
    doc.text(`${stats.bucketMinutes}-minute buckets`, MARGIN, MARGIN + 12);

    const activityData: ActivityChartData = {
      buckets: stats.buckets.map((bkt) => ({
        label: formatBucketLabel(bkt.start, stats.isMultiDay),
        counts: bkt.counts,
      })),
      series: stats.buttons.map((b) => ({ id: b.id, label: b.label, color: colorForId(b.id) })),
    };
    const activityUrl = renderChartImage(drawActivityChart, activityData, 1600, 700, fontScaleFor(1600, CONTENT_W, 10));
    placeImage(doc, activityUrl, 1600, 700, MARGIN, MARGIN + 18, CONTENT_W);
    drawLegend(doc, stats.buttons.map((b) => ({ label: b.label, color: colorForId(b.id) })), MARGIN, PAGE_H - MARGIN - 6);

    // ---------------------------------------------------------------- page 4: Return behaviour
    doc.addPage();
    drawPageTitle(doc, 'Return behaviour');

    const methodLabels: Record<string, string> = { home_button: 'Home button', tap: 'Tap', timeout: 'Timeout' };
    const methodData: NamedValue[] = (['home_button', 'tap', 'timeout'] as const).map((m) => ({
      label: methodLabels[m],
      value: stats.returnsByMethod[m],
      color: returnMethodColor(m),
    }));
    const methodW = CONTENT_W * 0.42;
    const methodUrl = renderChartImage(drawBarChart, methodData, 520, 440, fontScaleFor(520, methodW, 12));
    placeImage(doc, methodUrl, 520, 440, MARGIN, MARGIN + 12, methodW);

    const timeoutData: NamedValue[] = stats.buttons.map((b) => ({
      label: b.label,
      value: b.timeoutShare,
      color: colorForId(b.id),
    }));
    const timeoutX = MARGIN + CONTENT_W * 0.42 + 8;
    const timeoutW = CONTENT_W - CONTENT_W * 0.42 - 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120, 120, 120);
    doc.text('Timeout share by button (%)', timeoutX, MARGIN + 10);
    const timeoutUrl = renderChartImage(drawPercentBarChart, timeoutData, 640, 440, fontScaleFor(640, timeoutW, 13));
    placeImage(doc, timeoutUrl, 640, 440, timeoutX, MARGIN + 14, timeoutW);

    // ---------------------------------------------------------------- page 5: Hour-by-day (multi-day only)
    if (stats.isMultiDay) {
      doc.addPage();
      drawPageTitle(doc, 'Hour by day');
      const heatData: HeatmapChartData = { days: stats.heatmapDays, matrix: stats.heatmap };
      const heatUrl = renderChartImage(drawHeatmapChart, heatData, 1600, 700, fontScaleFor(1600, CONTENT_W, 11));
      placeImage(doc, heatUrl, 1600, 700, MARGIN, MARGIN + 14, CONTENT_W);
    }
  }

  addFooters(doc, sessionName, generatedAt);

  return doc.output('blob');
}

function formatBucketLabel(startIso: string, includeDate: boolean): string {
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (!includeDate) return time;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

function drawLegend(doc: jsPDF, items: Array<{ label: string; color: string }>, x: number, y: number): void {
  doc.setFontSize(9);
  let cx = x;
  const cy = y;
  for (const item of items) {
    const rgb = hexToRgb(item.color);
    doc.setFillColor(rgb.r, rgb.g, rgb.b);
    doc.rect(cx, cy - 3, 3.5, 3.5, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(80, 80, 80);
    const w = doc.getTextWidth(item.label);
    doc.text(item.label, cx + 5, cy);
    cx += 5 + w + 8;
    if (cx > PAGE_W - MARGIN - 30) {
      cx = x;
    }
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

export type { ReportStats };
