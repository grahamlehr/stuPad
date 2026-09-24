/**
 * Deck model -> DOM renderer.
 *
 * SlideStage builds one absolutely-positioned "slide px" DOM tree per slide (SLIDE_W wide,
 * deck.height tall) up front, then scales/letterboxes that fixed canvas to fit its container
 * with a CSS transform. toSlide() inverts that same transform to turn a client (viewport)
 * coordinate into slide px / percent, returning null when the point falls in the letterbox.
 *
 * Every module here is pure DOM + Fill/TextBody -> CSS. See "Limitations" at the bottom for
 * known gaps (vertical text, exotic bullet schemes, raster fallback on locked-down Safari).
 */
import type {
  Deck,
  Slide,
  SlideElement,
  ShapeElement,
  PictureElement,
  GroupElement,
  TableElement,
  TableCell,
  Fill,
  Line,
  TextBody,
  Paragraph,
  TextRun,
  Xfrm,
} from '../types';
import { SLIDE_W } from '../types';

// ------------------------------------------------------------------ styling

const STYLE_ID = 'stupad-render';

/** CSS shared by the live renderer and the rasterizer's foreignObject snapshot. */
const STYLE_TEXT = `
.sr-stage-scaler { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.sr-slide {
  position: relative;
  overflow: hidden;
  background: #000;
}
/* After .sr-slide so the stage's stacked layers aren't overridden back to position: relative. */
.sr-slide.sr-slide-layer { position: absolute; left: 0; top: 0; }
.sr-el { position: absolute; box-sizing: border-box; }
.sr-el, .sr-el * {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.sr-text-box {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
}
.sr-para { margin: 0; padding: 0; }
.sr-para.sr-bulleted { display: flex; flex-direction: row; }
.sr-bullet { flex-shrink: 0; }
.sr-run { white-space: inherit; }
.sr-crop-wrap { position: relative; overflow: hidden; width: 100%; height: 100%; }
.sr-crop-wrap img { position: absolute; display: block; }
.sr-full-img { width: 100%; height: 100%; display: block; object-fit: fill; }
.sr-group { position: absolute; inset: 0; }
.sr-table-cell { position: absolute; box-sizing: border-box; overflow: hidden; }
.sr-overlay { position: absolute; inset: 0; pointer-events: none; }
`;

function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);
}

// ------------------------------------------------------------------ colour / fill helpers

/** OOXML gradient angle is clockwise from the 3-o'clock (east) direction; CSS linear-gradient
 * angle is clockwise from north (0deg = "to top"). East (OOXML 0) is CSS 90 ("to right"). */
export function ooxmlAngleToCss(angleDeg: number): number {
  return ((angleDeg + 90) % 360 + 360) % 360;
}

function dashToCss(dash: Line['dash']): string {
  if (dash === 'dash') return 'dashed';
  if (dash === 'dot') return 'dotted';
  return 'solid';
}

function borderCss(line?: Line): string {
  if (!line || line.width <= 0) return 'none';
  return `${line.width}px ${dashToCss(line.dash)} ${line.color}`;
}

function gradientStopsCss(stops: { pos: number; color: string }[]): string {
  return stops.map((s) => `${s.color} ${s.pos * 100}%`).join(', ');
}

/** Applies a Fill to an element's background-* properties (not `background` shorthand, so it
 * composes with other style writes). */
function applyFill(el: HTMLElement, fill: Fill, deck: Deck, urls: Map<string, string>): void {
  switch (fill.type) {
    case 'none':
      el.style.backgroundColor = 'transparent';
      return;
    case 'solid':
      el.style.backgroundColor = fill.color;
      return;
    case 'gradient': {
      if (fill.kind === 'linear') {
        const angle = ooxmlAngleToCss(fill.angle);
        el.style.backgroundImage = `linear-gradient(${angle}deg, ${gradientStopsCss(fill.stops)})`;
      } else {
        el.style.backgroundImage = `radial-gradient(circle, ${gradientStopsCss(fill.stops)})`;
      }
      return;
    }
    case 'image': {
      const url = getObjectUrl(deck, fill.mediaKey, urls);
      el.style.backgroundImage = `url(${JSON.stringify(url).slice(1, -1)})`;
      if (fill.mode === 'tile') {
        el.style.backgroundRepeat = 'repeat';
        el.style.backgroundSize = 'auto';
      } else {
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundSize = '100% 100%';
      }
      return;
    }
  }
}

function getObjectUrl(deck: Deck, mediaKey: string, cache: Map<string, string>): string {
  const cached = cache.get(mediaKey);
  if (cached) return cached;
  const item = deck.media[mediaKey];
  if (!item) return '';
  const url = URL.createObjectURL(item.blob);
  cache.set(mediaKey, url);
  return url;
}

// ------------------------------------------------------------------ geometry / transform

function applyBaseBox(el: HTMLElement, xfrm: Xfrm): void {
  el.style.left = `${xfrm.x}px`;
  el.style.top = `${xfrm.y}px`;
  el.style.width = `${xfrm.w}px`;
  el.style.height = `${xfrm.h}px`;
}

/** rotate() is applied last (i.e. written first) so the shape flips in its own local axes
 * before being rotated into the parent's frame, matching PowerPoint's flip-then-rotate order. */
function applyRotateFlip(el: HTMLElement, xfrm: Xfrm): void {
  const parts: string[] = [];
  if (xfrm.rot) parts.push(`rotate(${xfrm.rot}deg)`);
  if (xfrm.flipH || xfrm.flipV) parts.push(`scale(${xfrm.flipH ? -1 : 1}, ${xfrm.flipV ? -1 : 1})`);
  if (parts.length) {
    el.style.transform = parts.join(' ');
    el.style.transformOrigin = 'center';
  }
}

// ------------------------------------------------------------------ text

const ANCHOR_JUSTIFY: Record<TextBody['anchor'], string> = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
};

function quoteFont(font: string): string {
  const name = font && font.trim() ? font.trim() : 'Helvetica';
  return `"${name}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
}

function toAlpha(n: number): string {
  // 1 -> a, 26 -> z, 27 -> aa (spreadsheet-column style)
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(97 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || 'a';
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let x = Math.max(1, Math.round(n));
  let out = '';
  for (const [v, sym] of table) {
    while (x >= v) {
      out += sym;
      x -= v;
    }
  }
  return out || 'I';
}

function autoNumText(scheme: string, n: number): string {
  switch (scheme) {
    case 'arabicPeriod':
      return `${n}.`;
    case 'arabicParenR':
      return `${n})`;
    case 'alphaLcPeriod':
      return `${toAlpha(n)}.`;
    case 'alphaUcPeriod':
      return `${toAlpha(n).toUpperCase()}.`;
    case 'alphaLcParenR':
      return `${toAlpha(n)})`;
    case 'romanUcPeriod':
      return `${toRoman(n)}.`;
    case 'romanLcPeriod':
      return `${toRoman(n).toLowerCase()}.`;
    default:
      return `${n}.`;
  }
}

function buildRun(run: TextRun): HTMLElement {
  const span = document.createElement('span');
  span.className = 'sr-run';
  span.textContent = run.text;
  span.style.fontFamily = quoteFont(run.font);
  span.style.fontSize = `${run.size}px`;
  span.style.color = run.color;
  span.style.fontWeight = run.bold ? '700' : '400';
  span.style.fontStyle = run.italic ? 'italic' : 'normal';
  span.style.textDecoration = run.underline ? 'underline' : 'none';
  return span;
}

function buildParagraph(p: Paragraph, wrap: boolean, levelCounters: Map<number, { scheme: string; value: number }>): HTMLElement {
  const div = document.createElement('div');
  div.className = 'sr-para';
  div.style.textAlign = p.align;
  div.style.lineHeight = String(p.lineSpacing || 1);
  div.style.marginTop = `${p.spaceBefore}px`;
  div.style.marginBottom = `${p.spaceAfter}px`;
  if (!wrap) div.style.whiteSpace = 'pre';

  if (p.bullet) {
    div.classList.add('sr-bulleted');
    div.style.marginLeft = `${p.marginLeft}px`;
    const bulletWidth = Math.max(Math.abs(p.indent) || 24, 12);
    const bullet = document.createElement('span');
    bullet.className = 'sr-bullet';
    bullet.style.width = `${bulletWidth}px`;
    if (p.bullet.type === 'char') {
      bullet.textContent = p.bullet.char;
      if (p.bullet.color) bullet.style.color = p.bullet.color;
    } else {
      const prev = levelCounters.get(p.level);
      // A scheme change (or a fresh level) restarts numbering at startAt.
      const n = prev && prev.scheme === p.bullet.scheme ? prev.value + 1 : p.bullet.startAt;
      levelCounters.set(p.level, { scheme: p.bullet.scheme, value: n });
      // Restart numbering on any shallower level so a new sub-list starts fresh.
      for (const lvl of Array.from(levelCounters.keys())) {
        if (lvl > p.level) levelCounters.delete(lvl);
      }
      bullet.textContent = autoNumText(p.bullet.scheme, n);
    }
    const content = document.createElement('span');
    content.className = 'sr-text';
    content.style.flex = '1';
    if (!wrap) content.style.whiteSpace = 'pre';
    appendRuns(content, p, wrap);
    div.append(bullet, content);
  } else {
    div.style.marginLeft = `${p.marginLeft}px`;
    div.style.textIndent = `${p.indent}px`;
    appendRuns(div, p, wrap);
  }
  return div;
}

function appendRuns(host: HTMLElement, p: Paragraph, _wrap: boolean): void {
  if (p.runs.length === 0) {
    const span = document.createElement('span');
    span.className = 'sr-run';
    span.style.opacity = '0';
    span.style.fontSize = `${p.emptySize ?? 12}px`;
    span.textContent = ' ';
    host.appendChild(span);
    return;
  }
  for (const run of p.runs) host.appendChild(buildRun(run));
}

function buildTextBody(tb: TextBody): HTMLElement {
  const box = document.createElement('div');
  box.className = 'sr-text-box';
  box.style.justifyContent = ANCHOR_JUSTIFY[tb.anchor];
  box.style.padding = `${tb.inset.t}px ${tb.inset.r}px ${tb.inset.b}px ${tb.inset.l}px`;
  if (tb.vertical) box.style.writingMode = 'vertical-rl';
  if (!tb.wrap) box.style.whiteSpace = 'pre';
  const levelCounters = new Map<number, { scheme: string; value: number }>();
  for (const p of tb.paragraphs) box.appendChild(buildParagraph(p, tb.wrap, levelCounters));
  return box;
}

// ------------------------------------------------------------------ elements

function buildShape(el: ShapeElement, deck: Deck, urls: Map<string, string>): HTMLElement {
  const div = document.createElement('div');
  div.className = 'sr-el sr-shape';
  applyBaseBox(div, el.xfrm);
  applyRotateFlip(div, el.xfrm);

  if (el.geom === 'line') {
    const w = el.xfrm.w;
    const h = el.xfrm.h;
    const width = el.line?.width ?? 1;
    const color = el.line?.color ?? '#000000';
    const dash = el.line?.dash;
    const dashArray = dash === 'dash' ? '8,6' : dash === 'dot' ? '2,4' : '';
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '0');
    line.setAttribute('x2', String(w));
    line.setAttribute('y2', String(h));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(width));
    if (dashArray) line.setAttribute('stroke-dasharray', dashArray);
    svg.appendChild(line);
    div.appendChild(svg);
    return div;
  }

  applyFill(div, el.fill, deck, urls);
  div.style.border = borderCss(el.line);
  if (el.geom === 'ellipse') {
    div.style.borderRadius = '50%';
  } else if (el.geom === 'roundRect') {
    div.style.borderRadius = `${el.cornerRadius ?? 0}px`;
  } else {
    div.style.borderRadius = '0';
  }

  if (el.text) div.appendChild(buildTextBody(el.text));
  return div;
}

function buildPicture(el: PictureElement, deck: Deck, urls: Map<string, string>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sr-el sr-crop-wrap';
  applyBaseBox(wrap, el.xfrm);
  applyRotateFlip(wrap, el.xfrm);
  wrap.style.border = borderCss(el.line);

  const img = document.createElement('img');
  img.src = getObjectUrl(deck, el.mediaKey, urls);
  img.draggable = false;
  img.alt = '';

  if (el.crop) {
    const { l, t, r, b } = el.crop;
    const fracW = Math.max(1 - l - r, 0.01);
    const fracH = Math.max(1 - t - b, 0.01);
    const imgW = el.xfrm.w / fracW;
    const imgH = el.xfrm.h / fracH;
    img.style.width = `${imgW}px`;
    img.style.height = `${imgH}px`;
    img.style.left = `${-l * imgW}px`;
    img.style.top = `${-t * imgH}px`;
  } else {
    img.className = 'sr-full-img';
  }
  wrap.appendChild(img);
  return wrap;
}

function buildGroup(el: GroupElement, deck: Deck, urls: Map<string, string>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sr-group';
  // Children already carry absolute slide-px coordinates, so this wrapper spans the whole
  // slide canvas (not just the group's own bounding box) and rotates around the group's
  // own center via an explicit px transform-origin.
  if (el.xfrm.rot || el.xfrm.flipH || el.xfrm.flipV) {
    const cx = el.xfrm.x + el.xfrm.w / 2;
    const cy = el.xfrm.y + el.xfrm.h / 2;
    const parts: string[] = [];
    if (el.xfrm.rot) parts.push(`rotate(${el.xfrm.rot}deg)`);
    if (el.xfrm.flipH || el.xfrm.flipV) parts.push(`scale(${el.xfrm.flipH ? -1 : 1}, ${el.xfrm.flipV ? -1 : 1})`);
    wrap.style.transform = parts.join(' ');
    wrap.style.transformOrigin = `${cx}px ${cy}px`;
  }
  for (const child of el.children) {
    const childEl = buildElement(child, deck, urls);
    if (childEl) wrap.appendChild(childEl);
  }
  return wrap;
}

function buildTable(el: TableElement, deck: Deck, urls: Map<string, string>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sr-el sr-table';
  applyBaseBox(wrap, el.xfrm);
  applyRotateFlip(wrap, el.xfrm);

  const colX: number[] = [];
  {
    let acc = 0;
    for (const w of el.colWidths) {
      colX.push(acc);
      acc += w;
    }
  }
  const rowY: number[] = [];
  {
    let acc = 0;
    for (const h of el.rowHeights) {
      rowY.push(acc);
      acc += h;
    }
  }

  for (let r = 0; r < el.rows.length; r++) {
    const row = el.rows[r];
    for (let c = 0; c < row.length; c++) {
      const cell: TableCell = row[c];
      if (cell.merged) continue;
      const span = Math.max(cell.gridSpan ?? 1, 1);
      const rowSpan = Math.max(cell.rowSpan ?? 1, 1);
      const width = el.colWidths.slice(c, c + span).reduce((a, b) => a + b, 0);
      const height = el.rowHeights.slice(r, r + rowSpan).reduce((a, b) => a + b, 0);
      const cellDiv = document.createElement('div');
      cellDiv.className = 'sr-table-cell';
      cellDiv.style.left = `${colX[c]}px`;
      cellDiv.style.top = `${rowY[r]}px`;
      cellDiv.style.width = `${width}px`;
      cellDiv.style.height = `${height}px`;
      applyFill(cellDiv, cell.fill, deck, urls);
      if (cell.text) cellDiv.appendChild(buildTextBody(cell.text));
      wrap.appendChild(cellDiv);
    }
  }
  return wrap;
}

function buildElement(el: SlideElement, deck: Deck, urls: Map<string, string>): HTMLElement | null {
  if (el.hidden) return null;
  switch (el.kind) {
    case 'shape':
      return buildShape(el, deck, urls);
    case 'picture':
      return buildPicture(el, deck, urls);
    case 'group':
      return buildGroup(el, deck, urls);
    case 'table':
      return buildTable(el, deck, urls);
    default:
      return null;
  }
}

function buildSlideEl(deck: Deck, slide: Slide, urls: Map<string, string>, useRaster: boolean): HTMLElement {
  const root = document.createElement('div');
  root.className = 'sr-slide';
  root.style.width = `${SLIDE_W}px`;
  root.style.height = `${deck.height}px`;

  if (useRaster && slide.rasterKey && deck.media[slide.rasterKey]) {
    const img = document.createElement('img');
    img.className = 'sr-full-img';
    img.src = getObjectUrl(deck, slide.rasterKey, urls);
    img.draggable = false;
    img.alt = '';
    root.appendChild(img);
    return root;
  }

  applyFill(root, slide.background, deck, urls);
  for (const el of slide.elements) {
    const built = buildElement(el, deck, urls);
    if (built) root.appendChild(built);
  }
  return root;
}

// ------------------------------------------------------------------ SlideStage

export interface StageOpts {
  useRaster?: boolean;
}

export interface SlideTransition {
  type: 'none' | 'fade';
  ms: number;
}

interface ActiveFade {
  /** Outgoing layer, still fully opaque underneath; null on the very first show(). */
  out: HTMLElement | null;
  /** Incoming layer, fading 0 -> 1 on top. */
  in: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
  /** Resolves this fade's show() promise, whether it completes or is interrupted. */
  done: () => void;
}

export class SlideStage {
  readonly overlay: HTMLElement;

  private readonly container: HTMLElement;
  private readonly deck: Deck;
  private readonly scaler: HTMLElement;
  private readonly slideHost: HTMLElement;
  private readonly slideEls: HTMLElement[];
  private readonly urls = new Map<string, string>();
  private readonly ro: ResizeObserver | undefined;

  /** The layer currently fully visible (opacity 1, visibility visible) when no fade is running. */
  private visible: HTMLElement | null = null;
  private _current = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private fade: ActiveFade | undefined;

  constructor(container: HTMLElement, deck: Deck, opts: StageOpts = {}) {
    ensureStyles();
    this.container = container;
    this.deck = deck;

    this.container.style.position = this.container.style.position || 'relative';
    this.container.style.overflow = 'hidden';
    this.container.style.background = '#000';

    this.scaler = document.createElement('div');
    this.scaler.className = 'sr-stage-scaler';
    this.scaler.style.width = `${SLIDE_W}px`;
    this.scaler.style.height = `${deck.height}px`;

    this.slideHost = document.createElement('div');
    this.slideHost.style.position = 'absolute';
    this.slideHost.style.inset = '0';
    this.scaler.appendChild(this.slideHost);

    this.overlay = document.createElement('div');
    this.overlay.className = 'sr-overlay';
    this.scaler.appendChild(this.overlay);

    this.container.appendChild(this.scaler);

    // Every slide layer is mounted once, up front, and never removed/re-appended: on
    // iPadOS Safari re-appending a large subtree forces a re-layout/re-rasterise, and while
    // its tiles are unpainted the document background shows through (a white flash). Layers
    // not currently shown just sit hidden underneath.
    this.slideEls = deck.slides.map((slide) =>
      buildSlideEl(deck, slide, this.urls, !!opts.useRaster)
    );
    this.slideEls.forEach((el) => {
      el.className += ' sr-slide-layer';
      this.hideLayer(el);
      this.slideHost.appendChild(el);
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.fit());
      this.ro.observe(this.container);
    }

    this.fit();
    void this.show(1, { type: 'none', ms: 0 });
  }

  get current(): number {
    return this._current;
  }

  private hideLayer(el: HTMLElement): void {
    el.style.transition = '';
    el.style.visibility = 'hidden';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '0';
    el.style.willChange = '';
    el.style.transform = '';
  }

  private showLayerInstant(el: HTMLElement): void {
    el.style.transition = '';
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    el.style.pointerEvents = '';
    el.style.zIndex = '0';
    el.style.willChange = '';
    el.style.transform = '';
  }

  /** Settles an in-flight fade immediately, leaving exactly its `in` layer visible. Used both
   * when a fade completes naturally and when it's interrupted by another show() call. */
  private settleFade(): void {
    const f = this.fade;
    if (!f) return;
    clearTimeout(f.timer);
    this.fade = undefined;
    this.showLayerInstant(f.in);
    if (f.out && f.out !== f.in) this.hideLayer(f.out);
    this.visible = f.in;
    f.done();
  }

  show(index: number, transition: SlideTransition = { type: 'none', ms: 0 }): Promise<void> {
    const target = this.slideEls[index - 1];
    if (!target) return Promise.resolve();

    // Interrupted fade (e.g. rapid multi-slide navigation): settle it synchronously first,
    // so we never leave a stale half-transparent layer behind.
    this.settleFade();
    this._current = index;

    if (target === this.visible) {
      // Already showing this slide and nothing is fading: no-op.
      return Promise.resolve();
    }

    const prev = this.visible;

    if (transition.type === 'none' || transition.ms <= 0) {
      this.showLayerInstant(target);
      if (prev) this.hideLayer(prev);
      this.visible = target;
      return Promise.resolve();
    }

    // Fade: raise the incoming layer on top and crossfade it 0 -> 1 while the outgoing layer
    // stays fully opaque underneath (never simultaneously semi-transparent), then hide the
    // outgoing layer once the fade settles.
    target.style.willChange = 'opacity';
    target.style.transform = 'translateZ(0)';
    target.style.visibility = 'visible';
    target.style.zIndex = '1';
    target.style.pointerEvents = '';
    target.style.transition = 'none';
    target.style.opacity = '0';
    // Force a reflow so the browser registers opacity:0 before animating to 1.
    void target.offsetWidth;
    target.style.transition = `opacity ${transition.ms}ms linear`;
    requestAnimationFrame(() => {
      target.style.opacity = '1';
    });

    if (prev) {
      prev.style.willChange = 'opacity';
      prev.style.transform = 'translateZ(0)';
      prev.style.zIndex = '0';
      // prev is already visibility:visible / opacity:1 from when it was shown.
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settleFade(), transition.ms);
      this.fade = { out: prev, in: target, timer, done: resolve };
    });
  }

  toSlide(clientX: number, clientY: number): { px: number; py: number; xPct: number; yPct: number } | null {
    const rect = this.container.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const px = (localX - this.offsetX) / this.scale;
    const py = (localY - this.offsetY) / this.scale;
    if (px < 0 || py < 0 || px > SLIDE_W || py > this.deck.height) return null;
    return {
      px,
      py,
      xPct: (px / SLIDE_W) * 100,
      yPct: (py / this.deck.height) * 100,
    };
  }

  fit(): void {
    const rect = this.container.getBoundingClientRect();
    const w = rect.width || this.container.clientWidth || SLIDE_W;
    const h = rect.height || this.container.clientHeight || this.deck.height;
    const scale = Math.min(w / SLIDE_W, h / this.deck.height) || 1;
    const offsetX = (w - SLIDE_W * scale) / 2;
    const offsetY = (h - this.deck.height * scale) / 2;
    this.scale = scale;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.scaler.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  }

  destroy(): void {
    const f = this.fade;
    this.fade = undefined;
    if (f) {
      clearTimeout(f.timer);
      f.done();
    }
    this.ro?.disconnect();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.scaler.remove();
  }
}

// ------------------------------------------------------------------ thumbnails

const thumbUrls = new Map<string, string>();

export function renderThumbnail(deck: Deck, index: number, widthPx: number): HTMLElement {
  ensureStyles();
  const slide = deck.slides[index - 1];
  const container = document.createElement('div');
  const scale = widthPx / SLIDE_W;
  const heightPx = Math.round(deck.height * scale);
  container.style.position = 'relative';
  container.style.width = `${widthPx}px`;
  container.style.height = `${heightPx}px`;
  container.style.overflow = 'hidden';
  container.style.background = '#000';

  if (!slide) return container;

  const cacheForDeck = getThumbCache(deck.id);
  const slideEl = buildSlideEl(deck, slide, cacheForDeck, false);
  slideEl.style.transformOrigin = '0 0';
  slideEl.style.transform = `scale(${scale})`;
  container.appendChild(slideEl);
  return container;
}

const thumbCachesByDeck = new Map<string, Map<string, string>>();
function getThumbCache(deckId: string): Map<string, string> {
  let m = thumbCachesByDeck.get(deckId);
  if (!m) {
    m = new Map();
    thumbCachesByDeck.set(deckId, m);
  }
  return m;
}

/** Revokes every object URL created by renderThumbnail() across all decks. */
export function releaseThumbnails(): void {
  for (const cache of thumbCachesByDeck.values()) {
    for (const url of cache.values()) URL.revokeObjectURL(url);
  }
  thumbCachesByDeck.clear();
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
}

// ------------------------------------------------------------------ rasterizeDeck

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Renders one already-built slide DOM tree to a PNG blob via an SVG <foreignObject> snapshot. */
async function rasterizeSlideEl(
  slideEl: HTMLElement,
  deckHeight: number,
  widthPx: number,
  heightPx: number,
): Promise<Blob | null> {
  const xmlns = 'http://www.w3.org/1999/xhtml';
  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', xmlns);
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE_TEXT;
  wrapper.appendChild(styleEl);
  wrapper.appendChild(slideEl);

  const svgString =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SLIDE_W}" height="${deckHeight}">` +
    `<foreignObject width="100%" height="100%">${wrapper.outerHTML}</foreignObject>` +
    `</svg>`;
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;

  const img = await loadImage(svgUrl);
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(img, 0, 0, widthPx, heightPx);

  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Renders each slide to a PNG via an SVG <foreignObject> snapshot of the same DOM the live
 * renderer builds, and stores the results into a cloned Deck's media map as `raster/N.png`
 * with `slide.rasterKey` set. Per-slide failures (e.g. Safari tainting the canvas on foreign
 * content) are caught individually; that slide is left without a rasterKey rather than failing
 * the whole deck. See "Limitations" below.
 */
export async function rasterizeDeck(deck: Deck, widthPx = 1600): Promise<Deck> {
  ensureStyles();
  const heightPx = Math.round((widthPx * deck.height) / SLIDE_W);

  // Pre-resolve every media blob to a data URL so the serialized SVG has no external refs.
  const dataUrlCache = new Map<string, string>();
  await Promise.all(
    Object.keys(deck.media).map(async (key) => {
      try {
        dataUrlCache.set(key, await blobToDataUrl(deck.media[key].blob));
      } catch {
        // leave unresolved; images referencing this key will just fail to load
      }
    })
  );

  const newMedia = { ...deck.media };
  const newSlides = deck.slides.map((s) => ({ ...s }));

  for (let i = 0; i < newSlides.length; i++) {
    const slide = newSlides[i];
    try {
      const slideEl = buildSlideEl(deck, slide, dataUrlCache, false);
      const blob = await rasterizeSlideEl(slideEl, deck.height, widthPx, heightPx);
      if (!blob) throw new Error('toBlob failed');

      const key = `raster/${slide.index}.png`;
      newMedia[key] = { blob, mime: 'image/png' };
      slide.rasterKey = key;
    } catch {
      // Leave this slide without a rasterKey; caller falls back to live DOM rendering for it.
    }
  }

  return { ...deck, media: newMedia, slides: newSlides };
}

/**
 * Renders a single slide (1-based `index`) to a PNG blob, e.g. for a cheap report thumbnail
 * without rasterizing the whole deck. Returns `null` (never throws) on any failure — the same
 * `<foreignObject>` snapshot technique as `rasterizeDeck` can fail on some WebKit versions.
 */
export async function rasterizeSlide(deck: Deck, index: number, widthPx = 800): Promise<Blob | null> {
  const slide = deck.slides[index - 1];
  if (!slide) return null;
  try {
    ensureStyles();
    const heightPx = Math.round((widthPx * deck.height) / SLIDE_W);

    const dataUrlCache = new Map<string, string>();
    for (const key of collectSlideMediaKeys(slide)) {
      const item = deck.media[key];
      if (!item) continue;
      try {
        dataUrlCache.set(key, await blobToDataUrl(item.blob));
      } catch {
        // leave unresolved; that image will just fail to load in the snapshot
      }
    }

    const slideEl = buildSlideEl(deck, slide, dataUrlCache, false);
    return await rasterizeSlideEl(slideEl, deck.height, widthPx, heightPx);
  } catch {
    return null;
  }
}

function collectSlideMediaKeys(slide: Slide): Set<string> {
  const keys = new Set<string>();
  const addFill = (fill: Fill | undefined) => {
    if (fill?.type === 'image') keys.add(fill.mediaKey);
  };
  const walk = (el: SlideElement): void => {
    switch (el.kind) {
      case 'picture':
        keys.add(el.mediaKey);
        break;
      case 'shape':
        addFill(el.fill);
        break;
      case 'group':
        el.children.forEach(walk);
        break;
      case 'table':
        for (const row of el.rows) for (const cell of row) addFill(cell.fill);
        break;
    }
  };
  addFill(slide.background);
  slide.elements.forEach(walk);
  return keys;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

// ------------------------------------------------------------------ Limitations
//
// - Vertical text (`TextBody.vertical`) uses `writing-mode: vertical-rl` and is not
//   pixel-tested against PowerPoint's own vertical layout.
// - Only a handful of autoNum bullet schemes are mapped (arabicPeriod/ParenR,
//   alphaLc/UcPeriod, alphaLcParenR, romanUc/LcPeriod); anything else falls back to
//   arabic-period numbering.
// - Gradient stop `pos` is assumed to be a 0..1 fraction (matches the rest of the geometry
//   convention, which is unitless/normalized elsewhere) and is converted to a CSS percentage.
// - rasterizeDeck relies on SVG <foreignObject> + canvas; some WebKit versions taint the
//   canvas for foreignObject content even with data-URL images, which makes `toBlob` throw.
//   That is caught per-slide (see try/catch above) so one bad slide doesn't fail the deck;
//   affected slides simply keep no `rasterKey` and the caller's live DOM renderer is used.
// - Table cell borders/lines are not modelled in TableCell (per types.ts); only fill + text
//   are rendered, per SPEC's "Tables: Basic — cell text and fills only".
