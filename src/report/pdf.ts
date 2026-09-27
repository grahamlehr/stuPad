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
  drawTapHeatmap,
  drawSlideTimeChart,
  drawPathTable,
  drawUptimeStrip,
  ATTRACT_BAND_LEGEND_COLOR,
  type NamedValue,
  type ActivityChartData,
  type HeatmapChartData,
  type TapHeatmapData,
  type SlideTimeChartData,
  type PathTableData,
  type PathTableEntry,
  type UptimeStripData,
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

function addFooters(doc: jsPDF, sessionName: string, deviceName: string, generatedAt: string): void {
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(130, 130, 130);
    const parts = ['GGPad', ...(deviceName ? [deviceName] : []), sessionName, `page ${i}/${n}`, `generated ${generatedAt}`];
    doc.text(parts.join(' · '), PAGE_W / 2, PAGE_H - 7, { align: 'center' });
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
 * Decodes the home thumbnail PNG so the synchronous `drawTapHeatmap` can paint it. Returns
 * `undefined` (never throws) when `createImageBitmap` isn't available (as in jsdom's test
 * environment, and on very old browsers) or when decoding fails, e.g. Safari canvas
 * tainting in `rasterizeSlide`. The tap-heatmap page never depends on this succeeding: the
 * grid cells and button outlines alone still make it readable.
 */
async function decodeThumbnail(png: Blob): Promise<ImageBitmap | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  try {
    return await createImageBitmap(png);
  } catch {
    return undefined;
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

  const sessionName = config.sessionName || 'GGPad session';
  const deviceName = (config.deviceName ?? '').trim();
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
  // Device name (when set) tells reports from different stands apart; shown right next to
  // the session name here, and in every page's footer (see addFooters).
  doc.text(deviceName ? `${sessionName} · ${deviceName}` : sessionName, MARGIN, MARGIN + 14);

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
      [stats.uptimePct !== null ? `${Math.round(stats.uptimePct)}%` : 'n/a', 'Uptime'],
    ];
    if (stats.totalNavTaps > 0) tiles.push([String(stats.totalNavTaps), 'Onward nav taps']);
    // Taps that ended an attract loop, over attract starts: the pull-in rate. Only shown once
    // the loop has actually run at least once in scope.
    if (stats.attractStarts > 0) {
      const pct = stats.attractPullInPct !== null ? Math.round(stats.attractPullInPct) : 0;
      tiles.push([`${stats.attractEnds} / ${stats.attractStarts} (${pct}%)`, 'Attract pull-in']);
    }
    const afterTilesY = drawStatTiles(doc, MARGIN, contentTop + 10, statsW, tiles, 3);

    if (hasThumb) {
      await drawHomeThumbnail(doc, homeThumbPng, MARGIN + statsW + gap, contentTop, thumbW);
    }

    // "Slide views" — arrivals per slide from either a home-slide button press or an
    // onward nav tap. Only shown when the deck actually has nav links in play (otherwise
    // it would just duplicate the button-share numbers already on page 2).
    if (stats.totalNavTaps > 0 && stats.slideViews.length > 0 && afterTilesY < PAGE_H - MARGIN - 20) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(60, 60, 60);
      doc.text('Slide views', MARGIN, afterTilesY + 8);

      const slideViewTiles: Array<[string, string]> = stats.slideViews.map((sv) => [
        String(sv.views),
        `Slide ${sv.slide}`,
      ]);
      const cols = Math.min(6, Math.max(3, slideViewTiles.length));
      drawStatTiles(doc, MARGIN, afterTilesY + 14, CONTENT_W, slideViewTiles, cols);
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

    // ---------------------------------------------------------------- page 3: Home slide taps (only when there are miss taps)
    if (stats.missTaps > 0) {
      doc.addPage();
      drawPageTitle(doc, 'Home slide taps');

      const allHomeSlideTaps = stats.totalPresses + stats.missTaps;
      const missShare = allHomeSlideTaps > 0 ? (stats.missTaps / allHomeSlideTaps) * 100 : 0;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(120, 120, 120);
      doc.text(
        `${stats.missTaps} miss taps, ${missShare.toFixed(1)}% of ${allHomeSlideTaps} home-slide taps`,
        MARGIN,
        MARGIN + 12,
      );

      let thumbnail: ImageBitmap | undefined;
      try {
        thumbnail = homeThumbPng ? await decodeThumbnail(homeThumbPng) : undefined;
        const heatmapData: TapHeatmapData = {
          grid: stats.missGrid,
          buttons: deck.buttons.map((b) => ({
            label: labels[b.id] ?? b.defaultLabel,
            x: b.bounds.x,
            y: b.bounds.y,
            w: b.bounds.w,
            h: b.bounds.h,
          })),
          deckHeight: deck.height,
          thumbnail,
        };
        const heatUrl = renderChartImage(drawTapHeatmap, heatmapData, 1600, 700, fontScaleFor(1600, CONTENT_W, 11));
        placeImage(doc, heatUrl, 1600, 700, MARGIN, MARGIN + 18, CONTENT_W);
      } finally {
        thumbnail?.close();
      }
    }

    // ---------------------------------------------------------------- page: Activity over time (4th when Home slide taps is shown)
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
        attractMs: bkt.attractMs,
      })),
      series: stats.buttons.map((b) => ({ id: b.id, label: b.label, color: colorForId(b.id) })),
      bucketMs: stats.bucketMinutes * 60_000,
    };
    // Same fontScale for the chart and the strip below it: drawUptimeStrip derives its
    // margins from the same formula drawActivityChart uses, so passing this value to both
    // (at the same 1600px css width and the same CONTENT_W placed width) keeps their time
    // axes pixel-aligned.
    const activityFontScale = fontScaleFor(1600, CONTENT_W, 10);
    const activityUrl = renderChartImage(drawActivityChart, activityData, 1600, 700, activityFontScale);
    const activityH = placeImage(doc, activityUrl, 1600, 700, MARGIN, MARGIN + 18, CONTENT_W);

    // Uptime strip: same time axis as the activity chart above it (first bucket's start to
    // last bucket's end), so a downtime gap lines up with the quiet period it explains.
    const uptimeStripData: UptimeStripData = {
      startMs: Date.parse(stats.buckets[0].start),
      endMs: Date.parse(stats.buckets[stats.buckets.length - 1].end),
      spans: stats.uptime.spans,
      gaps: stats.uptime.gaps,
    };
    const uptimeUrl = renderChartImage(drawUptimeStrip, uptimeStripData, 1600, 110, activityFontScale);
    placeImage(doc, uptimeUrl, 1600, 110, MARGIN, MARGIN + 18 + activityH + 6, CONTENT_W);

    const legendItems = stats.buttons.map((b) => ({ label: b.label, color: colorForId(b.id) }));
    // Only shown when some bucket actually has attract time, so a report with the loop off
    // (or one that never triggered) isn't cluttered with an entry that never applies.
    if (stats.buckets.some((b) => b.attractMs > 0)) {
      legendItems.push({ label: 'Attract loop', color: ATTRACT_BAND_LEGEND_COLOR });
    }
    drawLegend(doc, legendItems, MARGIN, PAGE_H - MARGIN - 6);

    // ---------------------------------------------------------------- page: Return behaviour (5th when Home slide taps is shown)
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

    // ---------------------------------------------------------------- page: Slides and paths (only with onward nav taps)
    if (stats.totalNavTaps > 0) {
      doc.addPage();
      drawPageTitle(doc, 'Slides and paths');

      const leftW = CONTENT_W * 0.52;
      const rightX = MARGIN + leftW + 10;
      const rightW = CONTENT_W - leftW - 10;

      const slideTimeData: SlideTimeChartData = {
        entries: stats.slideTime.map((s) => ({
          slide: s.slide,
          visits: s.visits,
          medianMs: s.medianMs,
          medianMsExclTimeout: s.medianMsExclTimeout,
        })),
      };
      const slideTimeUrl = renderChartImage(drawSlideTimeChart, slideTimeData, 800, 520, fontScaleFor(800, leftW, 13));
      placeImage(doc, slideTimeUrl, 800, 520, MARGIN, MARGIN + 14, leftW);

      const pathEntries: PathTableEntry[] = stats.topPaths.map((p) => ({
        path: p.path,
        count: p.count,
        pct: stats.totalPaths > 0 ? (p.count / stats.totalPaths) * 100 : 0,
        ended: p.ended,
      }));
      if (stats.otherPaths > 0) {
        pathEntries.push({
          path: [],
          label: 'Other',
          count: stats.otherPaths,
          pct: stats.totalPaths > 0 ? (stats.otherPaths / stats.totalPaths) * 100 : 0,
          ended: false,
        });
      }
      const pathTableData: PathTableData = { entries: pathEntries };
      const pathUrl = renderChartImage(drawPathTable, pathTableData, 720, 520, fontScaleFor(720, rightW, 12));
      placeImage(doc, pathUrl, 720, 520, rightX, MARGIN + 14, rightW);
    }

    // ---------------------------------------------------------------- page: Hour-by-day (multi-day only; last page)
    if (stats.isMultiDay) {
      doc.addPage();
      drawPageTitle(doc, 'Hour by day');
      const heatData: HeatmapChartData = { days: stats.heatmapDays, matrix: stats.heatmap };
      const heatUrl = renderChartImage(drawHeatmapChart, heatData, 1600, 700, fontScaleFor(1600, CONTENT_W, 11));
      placeImage(doc, heatUrl, 1600, 700, MARGIN, MARGIN + 14, CONTENT_W);
    }
  }

  addFooters(doc, sessionName, deviceName, generatedAt);

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
