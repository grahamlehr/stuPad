/**
 * Pulsing glow around every tappable area (SPEC "Configurable settings": Button glow).
 *
 * Each glow is an empty, pointer-transparent div laid over a tappable area in the stage
 * overlay (slide px). Its outer box-shadow is the glow, and only its `opacity` is
 * animated, so the pulse runs on the compositor and costs nothing on the tap path or over
 * a 12-hour run. Colour, size and speed come from CSS custom properties set by
 * `applyGlowStyle`, so changing a setting never rebuilds the elements. The keyframes live
 * in styles.css (`.kiosk-glow-layer`, `.kiosk-glow`).
 */
import type { Deck, GlowConfig, Rect, SlideElement } from '../types';

export interface GlowTarget {
  bounds: Rect;
  /** CSS border-radius matching the shape's outline */
  radius: string;
}

/** Corner radius for anything that isn't a plain rectangle, rounded rectangle or ellipse. */
const SOFT_RADIUS = '16px';

function sameBounds(el: SlideElement, r: Rect): boolean {
  return el.xfrm.x === r.x && el.xfrm.y === r.y && el.xfrm.w === r.w && el.xfrm.h === r.h;
}

/**
 * Border-radius that follows the linked shape: ellipses glow as ellipses, rounded
 * rectangles keep their corner radius, plain rectangles stay square, and anything else
 * (pictures, groups, other presets) gets a softly rounded rectangle. Links are always
 * top-level elements; ids are only unique per part (slide, layout, master), so the
 * bounds must match too.
 */
export function glowRadius(elements: SlideElement[], id: string, bounds: Rect): string {
  const el = elements.find((e) => e.id === id && sameBounds(e, bounds));
  if (el?.kind !== 'shape') return SOFT_RADIUS;
  if (el.geom === 'ellipse') return '50%';
  if (el.geom === 'roundRect') return `${el.cornerRadius ?? 0}px`;
  if (el.geom === 'rect') return '0';
  return SOFT_RADIUS;
}

/** Every tappable area the deck defines on `slide`: buttons on slide 1; Home, Back and
 * onward nav links elsewhere; poll/rating options anywhere (deduped against the above by
 * shape id, so a poll option that's also a button/link isn't glowed twice). The kiosk's
 * fallback Home button is added separately. */
export function glowTargets(deck: Deck, slide: number): GlowTarget[] {
  const elements = deck.slides.find((s) => s.index === slide)?.elements ?? [];
  const areas: { id: string; bounds: Rect }[] =
    slide === 1
      ? deck.buttons
      : [
          ...deck.homeLinks.filter((l) => l.slide === slide),
          ...(deck.backLinks ?? []).filter((l) => l.slide === slide),
          ...(deck.navLinks ?? []).filter((l) => l.slide === slide),
        ];
  const seenIds = new Set(areas.map((a) => a.id));
  for (const p of (deck.pollOptions ?? []).filter((p) => p.slide === slide)) {
    if (seenIds.has(p.id)) continue;
    seenIds.add(p.id);
    areas.push({ id: p.id, bounds: p.bounds });
  }
  return areas.map((a) => ({ bounds: a.bounds, radius: glowRadius(elements, a.id, a.bounds) }));
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Maps the admin's settings to the glow's CSS values (sizes in slide px). */
export function glowStyle(cfg: GlowConfig): { shadowColor: string; blurPx: number; spreadPx: number; halfPeriodMs: number } {
  const i = Math.min(10, Math.max(1, cfg.intensity));
  const [r, g, b] = hexToRgb(cfg.color);
  const alpha = Math.round((0.4 + i * 0.06) * 100) / 100; // 0.46 .. 1
  return {
    shadowColor: `rgba(${r},${g},${b},${alpha})`,
    blurPx: 8 + i * 4, // 12 .. 48
    spreadPx: Math.round(i * 1.5), // 2 .. 15
    halfPeriodMs: Math.round(cfg.periodMs / 2),
  };
}

/** Sets the glow's custom properties on `el`; every `.kiosk-glow` inside it picks them up. */
export function applyGlowStyle(el: HTMLElement, cfg: GlowConfig): void {
  const s = glowStyle(cfg);
  el.style.setProperty('--glow-color', s.shadowColor);
  el.style.setProperty('--glow-blur', `${s.blurPx}px`);
  el.style.setProperty('--glow-spread', `${s.spreadPx}px`);
  el.style.setProperty('--glow-half-period', `${s.halfPeriodMs}ms`);
}

export function createGlow(target: GlowTarget): HTMLElement {
  const el = document.createElement('div');
  el.className = 'kiosk-glow';
  el.style.left = `${target.bounds.x}px`;
  el.style.top = `${target.bounds.y}px`;
  el.style.width = `${target.bounds.w}px`;
  el.style.height = `${target.bounds.h}px`;
  el.style.borderRadius = target.radius;
  return el;
}

/** A layer holding one glow per tappable area on `slide`, styled from `cfg`. */
export function createGlowLayer(deck: Deck, slide: number, cfg: GlowConfig): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'kiosk-glow-layer';
  applyGlowStyle(layer, cfg);
  for (const t of glowTargets(deck, slide)) layer.appendChild(createGlow(t));
  return layer;
}
