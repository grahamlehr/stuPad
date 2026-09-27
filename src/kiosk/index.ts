/**
 * Kiosk runtime: the Home <-> Destination tap loop, secret admin sequence, idle
 * timeout, wake lock and gesture lockdown. See docs/PLAN.md "Kiosk API" and
 * docs/SPEC.md "Kiosk mode behaviour".
 *
 * Design: DOM/timer glue lives in KioskController; the small pieces that are easy to
 * get subtly wrong (corner detection, the secret-sequence state machine, rect hit
 * testing) are plain, dependency-free functions/classes so they can be unit tested
 * without a DOM or fake timers.
 */
import { SlideStage, preloadDeckFonts } from '../render';
import type { Deck, ButtonDef, NavLinkDef, KioskConfig, GlowConfig, LogEvent, Rect, SecretPattern } from '../types';
import { uuid } from '../util';
import { applyGlowStyle, createGlow, createGlowLayer } from './glow';

// ------------------------------------------------------------------ geometry

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Rounds a slide-position percentage to 0.1, per SPEC's x/y field convention. */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export type Corner = 'TL' | 'TR' | 'BL' | 'BR';

/** Classifies a slide-relative tap (0..100 pct) as being in one of the four corner
 * regions, or null if it isn't near any corner. `frac` is the fraction of the slide's
 * width/height (independently in x and y) that counts as "near an edge". */
export function cornerOf(xPct: number, yPct: number, frac: number): Corner | null {
  const thresholdLow = frac * 100;
  const thresholdHigh = 100 - frac * 100;
  const nearLeft = xPct <= thresholdLow;
  const nearRight = xPct >= thresholdHigh;
  const nearTop = yPct <= thresholdLow;
  const nearBottom = yPct >= thresholdHigh;
  if (nearLeft && nearTop) return 'TL';
  if (nearRight && nearTop) return 'TR';
  if (nearLeft && nearBottom) return 'BL';
  if (nearRight && nearBottom) return 'BR';
  return null;
}

// ------------------------------------------------------------- secret sequence

const SECRET_PATTERNS: Record<SecretPattern, Corner[]> = {
  corners_cw: ['TL', 'TR', 'BR', 'BL'],
  corners_ccw: ['TL', 'BL', 'BR', 'TR'],
  tl3_br2: ['TL', 'TL', 'TL', 'BR', 'BR'],
};

/**
 * Tracks progress through a fixed corner-tap pattern. Taps outside the corner regions
 * (see `cornerOf`) are ignored. `step()` tells the caller whether to consume the tap:
 * only taps that continue or complete an attempt in progress are consumed.
 *
 * Rules: a tap matching the next expected corner advances the attempt. A tap in a
 * *different* corner restarts the attempt — starting fresh at step 1 if that wrong
 * corner happens to be the pattern's first step, otherwise resetting to "waiting for
 * the first step". An attempt started at time t0 expires (silently resets) once a
 * later tap arrives more than `windowMs` after t0.
 */
export class SecretSequenceDetector {
  private readonly pattern: Corner[];
  private readonly windowMs: number;
  private readonly cornerFraction: number;
  private progress = 0;
  private firstTapAt: number | null = null;

  constructor(pattern: SecretPattern, windowMs: number, cornerFraction = 0.12) {
    this.pattern = SECRET_PATTERNS[pattern];
    this.windowMs = windowMs;
    this.cornerFraction = cornerFraction;
  }

  get cornerFrac(): number {
    return this.cornerFraction;
  }

  /** Feed a tap already expressed as slide-relative percentages. Returns true iff this
   * tap completed the sequence (the detector resets itself in that case). A tap that
   * isn't actually within a corner region is ignored (returns false, no state change). */
  feed(xPct: number, yPct: number, t: number): boolean {
    return this.step(xPct, yPct, t) === 'complete';
  }

  /**
   * Like `feed`, but also says whether the tap *continued* an attempt already in
   * progress (step 2 onwards). The kiosk consumes 'continued' and 'complete' taps and
   * handles 'none' taps (including a sequence's first step) normally, so buttons and
   * Home links that sit in a corner still work.
   */
  step(xPct: number, yPct: number, t: number): 'none' | 'continued' | 'complete' {
    const corner = cornerOf(xPct, yPct, this.cornerFraction);
    if (!corner) return 'none';

    if (this.firstTapAt !== null && t - this.firstTapAt > this.windowMs) {
      this.reset();
    }

    const expected = this.pattern[this.progress];
    if (corner === expected) {
      const continuing = this.progress > 0;
      if (this.progress === 0) this.firstTapAt = t;
      this.progress += 1;
      if (this.progress >= this.pattern.length) {
        this.reset();
        return 'complete';
      }
      return continuing ? 'continued' : 'none';
    }

    if (corner === this.pattern[0]) {
      this.progress = 1;
      this.firstTapAt = t;
    } else {
      this.progress = 0;
      this.firstTapAt = null;
    }
    return 'none';
  }

  reset(): void {
    this.progress = 0;
    this.firstTapAt = null;
  }
}

// ---------------------------------------------------------------- wake lock

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', cb: () => void): void;
}

async function requestWakeLockSentinel(): Promise<WakeLockSentinelLike | null> {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } })
      .wakeLock;
    if (!wl?.request) return null;
    return await wl.request('screen');
  } catch {
    return null;
  }
}

/** One-shot check of whether the Screen Wake Lock API is available and grantable right
 * now (acquires then immediately releases). Lets the UI warn the admin ("set Auto-Lock
 * to Never") before going live, per SPEC. KioskController manages its own long-lived
 * lock internally and does not use this helper. */
export async function acquireWakeLock(): Promise<boolean> {
  const sentinel = await requestWakeLockSentinel();
  if (!sentinel) return false;
  try {
    await sentinel.release();
  } catch {
    /* ignore */
  }
  return true;
}

// ------------------------------------------------------------------ checklist

export function checklist(): string[] {
  return [
    'Guided Access on (Settings > Accessibility > Guided Access)',
    'Auto-Lock set to Never',
    'iPad on charge',
    'Brightness and volume set',
  ];
}

// -------------------------------------------------------------- controller

export type KioskLogFn = (e: Omit<LogEvent, 'ts' | 'session_id'>) => void;

export interface KioskControllerOpts {
  root: HTMLElement;
  deck: Deck;
  config: KioskConfig;
  sessionId: string;
  log: KioskLogFn;
  onAdminRequested: () => void;
}

type Mode = 'home' | 'destination' | 'attract';

const CORNER_FRACTION = 0.12;
const FALLBACK_HOME_SIZE = 88; // slide px, >= 44pt per SPEC accessibility target
const FALLBACK_HOME_MARGIN = 24;
const PRESS_FEEDBACK_MS = 220;
/** Cap on the per-visit slide history used by "Last Slide Viewed" links, so a visitor
 * looping between two slides with explicit links can't grow it without bound. */
const MAX_VISIT_PATH = 100;
const IDLE_WARNING_MS = 5000;

/**
 * Crossfade length for every attract-cycle step, fixed regardless of `config.transitionMs`
 * (SPEC/ROADMAP "Attract loop"). Exported so tests and callers don't need to hard-code it.
 */
export const ATTRACT_CROSSFADE_MS = 1000;
/** Pulse mode's glow is at least this intense, even if `config.glow.intensity` is lower or
 * the glow is off entirely (see `KioskController.ensureAttractPulseElements`). */
const ATTRACT_PULSE_MIN_INTENSITY = 8;

export class KioskController {
  private readonly root: HTMLElement;
  private readonly deck: Deck;
  private readonly config: KioskConfig;
  private readonly _sessionId: string;
  private readonly log: KioskLogFn;
  private readonly onAdminRequested: () => void;
  private readonly detector: SecretSequenceDetector;

  private stage: SlideStage | null = null;
  private mode: Mode = 'home';
  private destSlide: number | null = null;

  private visitId: string | undefined;
  private visitButtonId: string | undefined;
  private visitButtonLabel: string | undefined;
  private visitStartedAt = 0;
  /** When the *current* destination slide was entered (updated on every nav tap), used
   * for slide_nav's dwell_ms; distinct from visitStartedAt, which anchors the whole
   * visit's dwell (used by return_home). */
  private slideEnteredAt = 0;
  /** Destination slides shown during the current visit, oldest first; the last entry is
   * destSlide. A "Last Slide Viewed" (back) link pops it. Empty while on the home slide. */
  private visitPath: number[] = [];

  private lastAcceptedTapAt = -Infinity;

  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private idleWarningTimer: ReturnType<typeof setTimeout> | undefined;
  private idleCountdownInterval: ReturnType<typeof setInterval> | undefined;
  private pressFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  /** Armed whenever the kiosk is on Home and idle (see `armAttractIdleTimer`); fires `startAttract`. */
  private attractIdleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The single setTimeout chain driving cycle mode; never more than one pending at a time. */
  private attractCycleTimer: ReturnType<typeof setTimeout> | undefined;
  /** `now()` when the current attract period began, for attract_end's dwell_ms. */
  private attractStartedAt = 0;
  /** Cycle mode's slide list for the current attract period (see `computeAttractCycleSlides`). */
  private attractCycleSlides: number[] = [];
  /** Index into `attractCycleSlides` of the slide currently shown. */
  private attractCycleIndex = 0;
  /** Pulse mode's "Tap to start" overlay + strong glow layer, built once lazily and afterwards
   * only shown/hidden via the `kiosk-attract-pulse` class on `root`; goes with the stage's
   * overlay on `destroy()`. */
  private attractPulseEl: HTMLElement | null = null;

  private fallbackHomeBounds: Rect | null = null;
  private fallbackHomeEl: HTMLElement | null = null;
  private idleCountdownEl: HTMLElement | null = null;
  /** One glow layer per slide, built the first time the slide is shown and then only
   * shown/hidden, so slide changes never rebuild it. Empty when the glow is off. */
  private readonly glowLayers = new Map<number, HTMLElement>();

  private wakeLock: WakeLockSentinelLike | null = null;
  private _wakeLockAvailable = false;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    this.handleTap(ev.clientX, ev.clientY, this.now());
  };
  private readonly onTouchStart = (ev: Event): void => ev.preventDefault();
  private readonly onGestureStart = (ev: Event): void => ev.preventDefault();
  private readonly onDblClick = (ev: Event): void => ev.preventDefault();
  private readonly onContextMenu = (ev: Event): void => ev.preventDefault();
  private readonly onSelectStart = (ev: Event): void => ev.preventDefault();
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void this.reacquireWakeLock();
  };

  constructor(opts: KioskControllerOpts) {
    this.root = opts.root;
    this.deck = opts.deck;
    this.config = opts.config;
    this._sessionId = opts.sessionId;
    this.log = opts.log;
    this.onAdminRequested = opts.onAdminRequested;
    this.detector = new SecretSequenceDetector(opts.config.secretPattern, opts.config.secretWindowMs, CORNER_FRACTION);
  }

  get wakeLockAvailable(): boolean {
    return this._wakeLockAvailable;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  async start(): Promise<void> {
    this.mode = 'home';
    this.destSlide = null;
    this.visitPath = [];
    this.attractCycleSlides = [];
    this.attractCycleIndex = 0;
    this.attractPulseEl = null;
    this.stage = new SlideStage(this.root, this.deck, { useRaster: this.config.useRaster });
    await preloadDeckFonts(this.deck.fonts);
    await this.stage.show(1, { type: 'none', ms: 0 });
    this.showGlow(1, 0);
    this.bindInput();
    await this.reacquireWakeLock();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.armAttractIdleTimer();
  }

  stop(): void {
    this.unbindInput();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.clearDestinationTimers();
    this.clearAttractIdleTimer();
    this.clearAttractCycleTimer();
    this.stopAttractPulse();
    if (this.pressFeedbackTimer !== undefined) {
      clearTimeout(this.pressFeedbackTimer);
      this.pressFeedbackTimer = undefined;
    }
    if (this.wakeLock) {
      const wl = this.wakeLock;
      this.wakeLock = null;
      void wl.release().catch(() => {});
    }
    this.glowLayers.clear(); // their elements go with the stage's overlay
    this.attractPulseEl = null; // same: goes with the stage's overlay
    this.stage?.destroy();
    this.stage = null;
  }

  // --------------------------------------------------------------- input

  private bindInput(): void {
    this.root.style.touchAction = 'none';
    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.root.addEventListener('gesturestart', this.onGestureStart as EventListener);
    this.root.addEventListener('dblclick', this.onDblClick);
    this.root.addEventListener('contextmenu', this.onContextMenu);
    this.root.addEventListener('selectstart', this.onSelectStart);
  }

  private unbindInput(): void {
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('touchstart', this.onTouchStart);
    this.root.removeEventListener('gesturestart', this.onGestureStart as EventListener);
    this.root.removeEventListener('dblclick', this.onDblClick);
    this.root.removeEventListener('contextmenu', this.onContextMenu);
    this.root.removeEventListener('selectstart', this.onSelectStart);
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  // ---------------------------------------------------------------- taps

  private handleTap(clientX: number, clientY: number, now: number): void {
    if (!this.stage) return;
    const at = this.stage.toSlide(clientX, clientY);
    if (!at) return; // letterbox / outside the slide entirely: not logged

    // The secret sequence is checked first. Taps that continue or complete an attempt in
    // progress are consumed (they never press a button or return home). A sequence's
    // first corner tap is handled normally, so buttons and Home links placed in a
    // corner still work; the cost is that starting the exit sequence on a slide with a
    // top-left button also presses that button once.
    const secret = this.detector.step(at.xPct, at.yPct, now);
    if (secret === 'complete') {
      this.onAdminRequested();
      return;
    }
    if (secret === 'continued') {
      if (this.mode === 'destination') this.resetDestinationTimer();
      // A corner tap that continues the sequence on Home is still activity: it must re-arm
      // the idle timer so an admin mid-sequence doesn't trigger the attract loop underneath
      // them (SPEC "Kiosk mode behaviour").
      else if (this.mode === 'home') this.armAttractIdleTimer();
      return;
    }

    // Debounce: repeat taps within the window are ignored entirely (not logged, no
    // state change), per SPEC. This is also what makes the attract-wake tap behave like any
    // other accepted tap: a quick second tap is debounced, and the next tap past the window
    // is a normal Home tap (the mode has already flipped back to 'home' by then).
    if (now - this.lastAcceptedTapAt < this.config.debounceMs) return;
    this.lastAcceptedTapAt = now;

    if (this.mode === 'home') {
      this.handleHomeTap(at.px, at.py, at.xPct, at.yPct);
    } else if (this.mode === 'destination') {
      this.handleDestinationTap(at.px, at.py, now);
    } else {
      // Attract mode: the tap only wakes the kiosk, never a button press, even when the
      // loop happens to be showing Home right now (decided, see ROADMAP "Attract loop").
      this.wakeFromAttract(now);
    }
  }

  private hitTestButton(px: number, py: number): ButtonDef | undefined {
    return this.deck.buttons.find((b) => pointInRect(px, py, b.bounds));
  }

  private handleHomeTap(px: number, py: number, xPct: number, yPct: number): void {
    const button = this.hitTestButton(px, py);
    if (!button) {
      this.log({ event: 'miss_tap', slide_from: 1, x: round1(xPct), y: round1(yPct) });
      // A miss tap is still activity: re-arm the idle timer so the visitor gets a fresh
      // idleSec before the attract loop kicks in.
      this.armAttractIdleTimer();
      return;
    }

    // A button press leaves Home, so no attract idle timer should be left ticking underneath
    // the destination visit.
    this.clearAttractIdleTimer();
    this.showPressFeedback(button.bounds);

    const label = this.config.buttonLabels[button.id] ?? button.defaultLabel;
    const visitId = uuid();
    this.visitId = visitId;
    this.visitButtonId = button.id;
    this.visitButtonLabel = label;
    this.visitStartedAt = this.now();
    this.slideEnteredAt = this.visitStartedAt;

    this.log({
      event: 'button_press',
      button_id: button.id,
      button_label: label,
      slide_from: 1,
      slide_to: button.targetSlide,
      visit_id: visitId,
    });

    this.mode = 'destination';
    this.destSlide = button.targetSlide;
    this.visitPath = [button.targetSlide];
    void this.stage?.show(button.targetSlide, { type: this.config.transition, ms: this.config.transitionMs });
    this.showGlow(button.targetSlide);
    this.setupFallbackHomeButton();
    this.startDestinationTimer();
  }

  private handleDestinationTap(px: number, py: number, now: number): void {
    const slide = this.destSlide;
    if (slide === null) return;

    const homeLink = this.deck.homeLinks.find((h) => h.slide === slide && pointInRect(px, py, h.bounds));
    if (homeLink) {
      this.returnHome('home_button', now);
      return;
    }
    if (this.fallbackHomeBounds && pointInRect(px, py, this.fallbackHomeBounds)) {
      this.returnHome('home_button', now);
      return;
    }
    const backLink = (this.deck.backLinks ?? []).find((b) => b.slide === slide && pointInRect(px, py, b.bounds));
    if (backLink) {
      this.goBack(now);
      return;
    }
    const navLink = (this.deck.navLinks ?? []).find((n) => n.slide === slide && pointInRect(px, py, n.bounds));
    if (navLink) {
      this.navigateTo(navLink, now);
      return;
    }
    if (this.config.returnMethods.tapAnywhere) {
      this.returnHome('tap', now);
      return;
    }
    // Any tap resets the timeout, even one that doesn't return home.
    this.resetDestinationTimer();
  }

  /** A tap on a destination-slide shape that links onward to a further slide (not slide 1,
   * not its own slide - see detectNavLinks). Logs `slide_nav`, updates destSlide and the
   * fallback Home button/timeout for the new slide. If a nav link ever targeted slide 1
   * (it shouldn't - the parser treats that as a HomeLinkDef) this falls back to a normal
   * return_home instead of a half-navigated state. */
  private navigateTo(navLink: NavLinkDef, now: number): void {
    if (navLink.targetSlide === 1) {
      this.returnHome('home_button', now);
      return;
    }
    if (this.destSlide === null) return;
    this.visitPath.push(navLink.targetSlide);
    if (this.visitPath.length > MAX_VISIT_PATH) this.visitPath.shift();
    this.moveToDestination(navLink.targetSlide, now);
  }

  /** A tap on a "Last Slide Viewed" shape: back to the previous slide of this visit, or
   * Home if the visitor came straight from slide 1. Logged as `slide_nav` like any other
   * move between destination slides, so reports still see the visit's path. */
  private goBack(now: number): void {
    if (this.destSlide === null) return;
    if (this.visitPath.length < 2) {
      this.returnHome('home_button', now);
      return;
    }
    this.visitPath.pop();
    this.moveToDestination(this.visitPath[this.visitPath.length - 1], now);
  }

  /** Shared by navigateTo and goBack: log `slide_nav`, show `target` and reset the
   * fallback Home button and timeout for it. */
  private moveToDestination(target: number, now: number): void {
    const fromSlide = this.destSlide;
    if (fromSlide === null) return;
    const dwellMs = Math.max(0, Math.round(now - this.slideEnteredAt));

    this.log({
      event: 'slide_nav',
      visit_id: this.visitId,
      button_id: this.visitButtonId,
      button_label: this.visitButtonLabel,
      slide_from: fromSlide,
      slide_to: target,
      dwell_ms: dwellMs,
    });

    this.destSlide = target;
    this.slideEnteredAt = now;
    void this.stage?.show(target, { type: this.config.transition, ms: this.config.transitionMs });
    this.showGlow(target);
    this.setupFallbackHomeButton();
    this.startDestinationTimer();
  }

  private returnHome(method: 'home_button' | 'tap' | 'timeout', now: number): void {
    const slide = this.destSlide;
    this.clearDestinationTimers();
    const dwellMs = Math.max(0, Math.round(now - this.visitStartedAt));

    this.log({
      event: 'return_home',
      visit_id: this.visitId,
      button_id: this.visitButtonId,
      button_label: this.visitButtonLabel,
      slide_from: slide ?? undefined,
      slide_to: 1,
      method,
      dwell_ms: dwellMs,
    });

    this.mode = 'home';
    this.destSlide = null;
    this.visitPath = [];
    this.visitId = undefined;
    this.visitButtonId = undefined;
    this.visitButtonLabel = undefined;
    this.fallbackHomeBounds = null;
    if (this.fallbackHomeEl) {
      this.fallbackHomeEl.remove();
      this.fallbackHomeEl = null;
    }
    this.clearIdleCountdown();
    void this.stage?.show(1, { type: this.config.transition, ms: this.config.transitionMs });
    this.showGlow(1);
    // Back on Home and idle: a fresh idleSec starts counting toward the attract loop.
    this.armAttractIdleTimer();
  }

  // ------------------------------------------------------------ timeout

  private startDestinationTimer(): void {
    this.clearDestinationTimers();
    if (!this.config.returnMethods.timeout || this.config.timeoutSec === null) return;
    const timeoutMs = this.config.timeoutSec * 1000;

    this.timeoutTimer = setTimeout(() => {
      this.returnHome('timeout', this.now());
    }, timeoutMs);

    if (this.config.idleWarning) {
      const warnAt = Math.max(0, timeoutMs - IDLE_WARNING_MS);
      this.idleWarningTimer = setTimeout(() => this.showIdleCountdown(), warnAt);
    }
  }

  private resetDestinationTimer(): void {
    if (this.mode !== 'destination') return;
    this.startDestinationTimer();
  }

  private clearDestinationTimers(): void {
    if (this.timeoutTimer !== undefined) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    if (this.idleWarningTimer !== undefined) {
      clearTimeout(this.idleWarningTimer);
      this.idleWarningTimer = undefined;
    }
    this.clearIdleCountdown();
  }

  private clearIdleCountdown(): void {
    if (this.idleCountdownInterval !== undefined) {
      clearInterval(this.idleCountdownInterval);
      this.idleCountdownInterval = undefined;
    }
    if (this.idleCountdownEl) {
      this.idleCountdownEl.remove();
      this.idleCountdownEl = null;
    }
  }

  // -------------------------------------------------------- attract loop

  /**
   * Arms (or re-arms) the timer that starts the attract loop after `config.attract.idleSec`
   * of no accepted taps on Home. A no-op when the loop is off or the kiosk isn't on Home, so
   * every call site can call this unconditionally rather than checking first (SPEC "Kiosk
   * mode behaviour": armed after `start()`, after every accepted Home tap that doesn't leave
   * Home, after every return to Home, and after waking from attract).
   */
  private armAttractIdleTimer(): void {
    this.clearAttractIdleTimer();
    if (!this.config.attract.enabled || this.mode !== 'home') return;
    this.attractIdleTimer = setTimeout(() => this.startAttract(), this.config.attract.idleSec * 1000);
  }

  private clearAttractIdleTimer(): void {
    if (this.attractIdleTimer !== undefined) {
      clearTimeout(this.attractIdleTimer);
      this.attractIdleTimer = undefined;
    }
  }

  /** Cycle mode's slide list: Home (always first), then `config.attract.slides` filtered to
   * slide numbers that actually exist in the deck and are not Home itself, deduplicated and
   * in ascending slide order. */
  private computeAttractCycleSlides(): number[] {
    const deckSlideNumbers = new Set(this.deck.slides.map((s) => s.index));
    const extra = Array.from(new Set(this.config.attract.slides))
      .filter((n) => n > 1 && deckSlideNumbers.has(n))
      .sort((a, b) => a - b);
    return [1, ...extra];
  }

  private startAttract(): void {
    if (!this.config.attract.enabled || this.mode !== 'home') return;
    this.clearAttractIdleTimer();
    this.mode = 'attract';
    this.attractStartedAt = this.now();
    this.log({ event: 'attract_start' });

    const cycleSlides = this.computeAttractCycleSlides();
    // Cycling only one slide (Home, because config.attract.slides has nothing valid to add)
    // has nothing to crossfade to, so it behaves like pulse mode instead (documented in SPEC).
    if (this.config.attract.mode === 'pulse' || cycleSlides.length <= 1) {
      this.startAttractPulse();
    } else {
      this.startAttractCycle(cycleSlides);
    }
  }

  private startAttractCycle(slides: number[]): void {
    this.attractCycleSlides = slides;
    this.attractCycleIndex = 0; // slides[0] is Home, already showing
    this.scheduleAttractCycleStep();
  }

  private scheduleAttractCycleStep(): void {
    this.clearAttractCycleTimer();
    this.attractCycleTimer = setTimeout(() => this.advanceAttractCycle(), this.config.attract.slideSec * 1000);
  }

  /** One step of the cycle: crossfade to the next slide (wrapping back to Home), then
   * schedule the next step. A single setTimeout chain, per the 12-hour-safety rule: only one
   * pending timer at a time, and it's re-created (not left running) on every step. */
  private advanceAttractCycle(): void {
    const slides = this.attractCycleSlides;
    if (slides.length === 0) return;
    this.attractCycleIndex = (this.attractCycleIndex + 1) % slides.length;
    const target = slides[this.attractCycleIndex];
    void this.stage?.show(target, { type: 'fade', ms: ATTRACT_CROSSFADE_MS });
    this.updateAttractCycleGlow(target);
    this.scheduleAttractCycleStep();
  }

  /** Nothing on a non-Home slide is tappable in attract mode, so its glow (if any) stays
   * hidden; Home's own glow (if the setting is on) plays normally when the cycle lands there. */
  private updateAttractCycleGlow(target: number): void {
    if (target === 1) {
      this.showGlow(1, ATTRACT_CROSSFADE_MS);
    } else {
      for (const layer of this.glowLayers.values()) layer.style.display = 'none';
    }
  }

  private clearAttractCycleTimer(): void {
    if (this.attractCycleTimer !== undefined) {
      clearTimeout(this.attractCycleTimer);
      this.attractCycleTimer = undefined;
    }
  }

  private startAttractPulse(): void {
    this.ensureAttractPulseElements();
    this.root.classList.add('kiosk-attract-pulse');
  }

  private stopAttractPulse(): void {
    this.root.classList.remove('kiosk-attract-pulse');
  }

  /** Builds pulse mode's "Tap to start" overlay and stronger glow layer once, lazily; every
   * later start/stop of pulse mode only toggles the `kiosk-attract-pulse` class on `root`
   * (see `startAttractPulse`/`stopAttractPulse`), so a tap in pulse mode never rebuilds DOM. */
  private ensureAttractPulseElements(): void {
    if (this.attractPulseEl) return;
    const overlay = this.stage?.overlay;
    if (!overlay) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'kiosk-attract-pulse-layer';

    // Reuses glow.ts with a stronger, always-visible GlowConfig, independent of whether the
    // admin's own button glow is on (SPEC/ROADMAP "Attract loop").
    const strongGlow: GlowConfig = {
      enabled: true,
      color: this.config.glow.color,
      intensity: Math.max(this.config.glow.intensity, ATTRACT_PULSE_MIN_INTENSITY),
      periodMs: this.config.glow.periodMs,
    };
    wrapper.appendChild(createGlowLayer(this.deck, 1, strongGlow));

    const tap = document.createElement('div');
    tap.className = 'kiosk-attract-tap';
    tap.textContent = 'Tap to start';
    wrapper.appendChild(tap);

    overlay.appendChild(wrapper);
    this.attractPulseEl = wrapper;
  }

  /** The first tap in attract mode: wakes the kiosk. Never presses a button, even when the
   * loop happens to be showing Home right now (decided). Stops whichever sub-mode (cycle or
   * pulse) was running, shows Home with the configured transition, logs `attract_end` with
   * `dwell_ms`, and re-arms the idle timer for the next idle period. */
  private wakeFromAttract(now: number): void {
    this.clearAttractCycleTimer();
    this.stopAttractPulse();
    const dwellMs = Math.max(0, Math.round(now - this.attractStartedAt));

    this.log({ event: 'attract_end', dwell_ms: dwellMs });

    this.mode = 'home';
    // Home may already be visible (pulse mode, or the cycle happened to be showing it); show()
    // is a no-op in that case. If a cycle crossfade is mid-flight, SlideStage.show() settles it
    // synchronously before starting this one, so there's never a stale half-transparent layer.
    void this.stage?.show(1, { type: this.config.transition, ms: this.config.transitionMs });
    this.showGlow(1);
    this.armAttractIdleTimer();
  }

  // ------------------------------------------------------------- overlay

  /** Shows the glow layer for `slide` (building it on first use) and hides the others.
   * Showing a hidden layer replays its fade-in, timed to the slide transition. */
  private showGlow(slide: number, fadeInMs = this.config.transition === 'fade' ? this.config.transitionMs : 0): void {
    const overlay = this.stage?.overlay;
    if (!overlay || !this.config.glow.enabled) return;
    for (const [s, layer] of this.glowLayers) if (s !== slide) layer.style.display = 'none';
    let layer = this.glowLayers.get(slide);
    if (!layer) {
      layer = createGlowLayer(this.deck, slide, this.config.glow);
      this.glowLayers.set(slide, layer);
      // Below press feedback and the fallback Home button, which are appended later.
      overlay.prepend(layer);
    }
    layer.style.setProperty('--glow-fade-in', `${fadeInMs}ms`);
    layer.style.display = '';
  }

  private showPressFeedback(bounds: Rect): void {
    const overlay = this.stage?.overlay;
    if (!overlay || this.config.pressFeedback === 'none') return;

    const el = document.createElement('div');
    el.className = `kiosk-press-feedback kiosk-press-feedback--${this.config.pressFeedback}`;
    el.style.position = 'absolute';
    el.style.left = `${bounds.x}px`;
    el.style.top = `${bounds.y}px`;
    el.style.width = `${bounds.w}px`;
    el.style.height = `${bounds.h}px`;
    el.style.pointerEvents = 'none';
    el.style.boxSizing = 'border-box';
    if (this.config.pressFeedback === 'highlight') {
      el.style.background = 'rgba(255,255,255,0.35)';
      el.style.border = '2px solid rgba(255,255,255,0.8)';
    } else if (this.config.pressFeedback === 'scale') {
      el.style.transform = 'scale(1.04)';
      el.style.transformOrigin = 'center';
      el.style.border = '2px solid rgba(255,255,255,0.8)';
    }
    overlay.appendChild(el);

    if (this.pressFeedbackTimer !== undefined) clearTimeout(this.pressFeedbackTimer);
    this.pressFeedbackTimer = setTimeout(() => {
      el.remove();
      this.pressFeedbackTimer = undefined;
    }, PRESS_FEEDBACK_MS);
  }

  private setupFallbackHomeButton(): void {
    this.fallbackHomeBounds = null;
    if (this.fallbackHomeEl) {
      this.fallbackHomeEl.remove();
      this.fallbackHomeEl = null;
    }
    const overlay = this.stage?.overlay;
    const slide = this.destSlide;
    if (!overlay || slide === null) return;

    // A back link always leads somewhere (previous slide or Home), so it isn't a dead end either.
    const hasHomeLink = this.deck.homeLinks.some((h) => h.slide === slide)
      || (this.deck.backLinks ?? []).some((b) => b.slide === slide);
    if (hasHomeLink || !this.config.returnMethods.homeButton) return;

    // Bottom-center placement: never within a corner region regardless of
    // `CORNER_FRACTION`, so it can't be mistaken for (or interfere with) the secret
    // sequence.
    const bounds: Rect = {
      x: 1920 / 2 - FALLBACK_HOME_SIZE / 2,
      y: this.deck.height - FALLBACK_HOME_SIZE - FALLBACK_HOME_MARGIN,
      w: FALLBACK_HOME_SIZE,
      h: FALLBACK_HOME_SIZE,
    };
    this.fallbackHomeBounds = bounds;

    const el = document.createElement('div');
    el.className = 'kiosk-fallback-home';
    el.style.position = 'absolute';
    el.style.left = `${bounds.x}px`;
    el.style.top = `${bounds.y}px`;
    el.style.width = `${bounds.w}px`;
    el.style.height = `${bounds.h}px`;
    el.style.borderRadius = '50%';
    el.style.background = 'rgba(0,0,0,0.35)';
    el.style.border = '2px solid rgba(255,255,255,0.6)';
    el.style.pointerEvents = 'none';
    el.textContent = 'Home';
    el.style.color = '#fff';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.fontSize = '20px';
    if (this.config.glow.enabled) {
      applyGlowStyle(el, this.config.glow);
      el.appendChild(createGlow({ bounds: { x: 0, y: 0, w: bounds.w, h: bounds.h }, radius: '50%' }));
    }
    overlay.appendChild(el);
    this.fallbackHomeEl = el;
  }

  private showIdleCountdown(): void {
    const overlay = this.stage?.overlay;
    if (!overlay) return;
    this.clearIdleCountdown();

    const el = document.createElement('div');
    el.className = 'kiosk-idle-countdown';
    el.style.position = 'absolute';
    el.style.right = '24px';
    el.style.top = '24px';
    el.style.padding = '6px 12px';
    el.style.borderRadius = '8px';
    el.style.background = 'rgba(0,0,0,0.5)';
    el.style.color = '#fff';
    el.style.fontSize = '20px';
    el.style.pointerEvents = 'none';
    overlay.appendChild(el);
    this.idleCountdownEl = el;

    const deadline = this.now() + IDLE_WARNING_MS;
    const tick = (): void => {
      const remainingMs = deadline - this.now();
      const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
      el.textContent = String(seconds);
    };
    tick();
    this.idleCountdownInterval = setInterval(tick, 250);
  }

  // ------------------------------------------------------------ wake lock

  private async reacquireWakeLock(): Promise<void> {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
      } catch {
        /* ignore */
      }
      this.wakeLock = null;
    }
    this.wakeLock = await requestWakeLockSentinel();
    this._wakeLockAvailable = this.wakeLock !== null;
  }
}
