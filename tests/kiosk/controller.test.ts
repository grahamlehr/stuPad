import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Deck, KioskConfig, LogEvent, Slide, VideoElement, MediaItem } from '../../src/types';
import { defaultConfig, SLIDE_W } from '../../src/types';
import type { StageVideo } from '../../src/render';
import { stubObjectUrl } from '../render/setup-url';

// -------------------------------------------------------------- mock render

/** A real jsdom <video> with play/pause/load stubbed, matching src/kiosk/video.ts's own test
 * doubles: jsdom's own HTMLMediaElement methods just log "not implemented" and no-op/return
 * undefined, which VideoPlayer already treats as "no Promise to await": good enough for
 * tests that dispatch events by hand instead of relying on real playback. */
function stubVideoEl(): HTMLVideoElement {
  const el = document.createElement('video');
  el.play = vi.fn(() => Promise.resolve());
  el.pause = vi.fn();
  el.load = vi.fn();
  return el;
}

class MockSlideStage {
  current = 1;
  overlay: HTMLElement;
  showCalls: { index: number; transition?: unknown }[] = [];
  destroyed = false;
  /** When true, `show()` doesn't resolve on its own: the test resolves each call in turn via
   * `resolveNextShow()`, so a tap that lands while the "arrival" `.then()` is still pending can
   * be exercised deterministically (see the video "arrival race" tests). */
  manualShow = false;
  private readonly pendingShowResolvers: (() => void)[] = [];
  /** One stub <video> per VideoElement found at the top level of each slide (deep enough for
   * every test in this file; none of them nest a video inside a group). */
  private readonly videosBySlide: StageVideo[][];

  constructor(
    public container: HTMLElement,
    public deck: Deck,
  ) {
    this.overlay = document.createElement('div');
    container.appendChild(this.overlay);
    this.videosBySlide = deck.slides.map((slide) =>
      slide.elements
        .filter((el): el is VideoElement => el.kind === 'video')
        .map((def) => ({ el: stubVideoEl(), def })),
    );
  }

  show(index: number, transition?: unknown): Promise<void> {
    this.current = index;
    this.showCalls.push({ index, transition });
    if (this.manualShow) {
      return new Promise((resolve) => this.pendingShowResolvers.push(resolve));
    }
    return Promise.resolve();
  }

  resolveNextShow(): void {
    this.pendingShowResolvers.shift()?.();
  }

  toSlide(clientX: number, clientY: number): { px: number; py: number; xPct: number; yPct: number } | null {
    if (clientX < 0 || clientY < 0 || clientX > SLIDE_W || clientY > this.deck.height) return null;
    return { px: clientX, py: clientY, xPct: (clientX / SLIDE_W) * 100, yPct: (clientY / this.deck.height) * 100 };
  }

  videosOn(index: number): StageVideo[] {
    return this.videosBySlide[index - 1] ?? [];
  }

  fit(): void {}

  destroy(): void {
    this.destroyed = true;
  }
}

let lastStage: MockSlideStage | undefined;

vi.mock('../../src/render', () => {
  return {
    SlideStage: class {
      constructor(container: HTMLElement, deck: Deck) {
        const s = new MockSlideStage(container, deck);
        lastStage = s;
        return s as unknown as MockSlideStage;
      }
    },
    preloadDeckFonts: async () => {},
  };
});

// Imported after the mock so KioskController picks up the mocked SlideStage.
const { KioskController, ATTRACT_CROSSFADE_MS } = await import('../../src/kiosk/index');

// ------------------------------------------------------------------- fixtures

function fakeDeck(): Deck {
  return {
    id: 'deck-1',
    fileName: 'demo.pptx',
    parsedAt: '2026-09-24T00:00:00.000Z',
    slideWidthEmu: 12192000,
    slideHeightEmu: 6858000,
    height: 1080,
    slides: [],
    buttons: [
      {
        id: 'b1',
        shapeName: 'BTN_1',
        text: 'Button 1',
        defaultLabel: 'Button 1',
        targetSlide: 2,
        bounds: { x: 100, y: 100, w: 200, h: 100 },
      },
    ],
    homeLinks: [{ slide: 2, id: 'h1', bounds: { x: 300, y: 300, w: 100, h: 60 } }],
    navLinks: [],
    backLinks: [],
    pollOptions: [],
    media: {},
    fonts: [],
  };
}

function fakeConfig(over: Partial<KioskConfig> = {}): KioskConfig {
  return { ...defaultConfig('demo.pptx'), debounceMs: 100, timeoutSec: 5, ...over };
}

function tap(root: HTMLElement, x: number, y: number): void {
  root.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
}

// TL/TR/BR/BL points well inside the default 12% corner fraction for a 1920x1080 slide.
const TL = { x: 20, y: 20 };
const TR = { x: 1900, y: 20 };
const BR = { x: 1900, y: 1060 };
const BL = { x: 20, y: 1060 };
const CENTER_BUTTON = { x: 150, y: 130 }; // inside b1 bounds
const MISS = { x: 900, y: 900 }; // not on any button, not a corner
const HOME_LINK_POINT = { x: 340, y: 320 }; // inside h1 bounds, outside any corner region

describe('KioskController', () => {
  let root: HTMLElement;
  let logs: Omit<LogEvent, 'ts' | 'session_id'>[];
  let onAdminRequested: Mock<() => void>;
  let controller: InstanceType<typeof KioskController>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    root = document.createElement('div');
    document.body.appendChild(root);
    logs = [];
    onAdminRequested = vi.fn<() => void>();
  });

  afterEach(() => {
    controller?.stop();
    root.remove();
    vi.useRealTimers();
  });

  async function makeController(cfgOver: Partial<KioskConfig> = {}) {
    controller = new KioskController({
      root,
      deck: fakeDeck(),
      config: fakeConfig(cfgOver),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    return controller;
  }

  it('button press: tap on a home-slide button logs button_press and navigates to the target', async () => {
    await makeController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'button_press',
      button_id: 'b1',
      button_label: 'Button 1',
      slide_from: 1,
      slide_to: 2,
    });
    expect(logs[0].visit_id).toBeTruthy();
    expect(lastStage!.showCalls.at(-1)?.index).toBe(2);
  });

  it('miss tap: tap outside any button on home logs miss_tap with rounded x/y', async () => {
    await makeController();
    tap(root, MISS.x, MISS.y);

    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe('miss_tap');
    expect(logs[0].slide_from).toBe(1);
    expect(logs[0].x).toBeCloseTo((MISS.x / SLIDE_W) * 100, 1);
    expect(logs[0].y).toBeCloseTo((MISS.y / 1080) * 100, 1);
  });

  it('debounce: a repeat tap within debounceMs is ignored and not logged', async () => {
    await makeController({ debounceMs: 500 });
    tap(root, MISS.x, MISS.y);
    vi.advanceTimersByTime(100);
    tap(root, MISS.x, MISS.y); // within 500ms window: ignored
    expect(logs).toHaveLength(1);

    vi.advanceTimersByTime(500);
    tap(root, MISS.x, MISS.y); // now past the window: accepted
    expect(logs).toHaveLength(2);
  });

  it('a corner tap that continues a secret sequence never triggers a button under it', async () => {
    const deck = fakeDeck();
    // Put a button under the TR corner: step 2 of corners_cw.
    deck.buttons.push({
      id: 'corner-btn',
      shapeName: 'BTN_Corner',
      text: 'Corner',
      defaultLabel: 'Corner',
      targetSlide: 3,
      bounds: { x: 1800, y: 0, w: 120, h: 120 },
    });
    controller = new KioskController({
      root,
      deck,
      config: fakeConfig({ secretPattern: 'corners_cw' }),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    logs.length = 0;

    tap(root, TL.x, TL.y); // step 1: handled normally (a miss here)
    vi.advanceTimersByTime(150);
    tap(root, TR.x, TR.y); // step 2: consumed by the detector

    expect(logs.map((l) => l.event)).toEqual(['miss_tap']);
    expect(onAdminRequested).not.toHaveBeenCalled();
  });

  it('a corner tap that does not continue a sequence is handled normally (e.g. a Home link in a corner)', async () => {
    const deck = fakeDeck();
    deck.homeLinks.push({ slide: 2, id: 'corner-home', bounds: { x: 0, y: 960, w: 200, h: 120 } });
    controller = new KioskController({
      root,
      deck,
      config: fakeConfig({ secretPattern: 'corners_cw' }),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    logs.length = 0;

    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> destination slide 2
    vi.advanceTimersByTime(150);
    tap(root, BL.x, BL.y); // BL is not the first step of corners_cw

    expect(logs.map((l) => l.event)).toEqual(['button_press', 'return_home']);
    expect(logs[1]).toMatchObject({ method: 'home_button' });
  });

  it('secret sequence: completing the corner pattern calls onAdminRequested with no other handling', async () => {
    await makeController({ secretPattern: 'corners_cw', secretWindowMs: 5000 });
    tap(root, TL.x, TL.y);
    tap(root, TR.x, TR.y);
    tap(root, BR.x, BR.y);
    tap(root, BL.x, BL.y);

    expect(onAdminRequested).toHaveBeenCalledTimes(1);
    // every corner tap along the way is consumed; only miss_taps (or nothing) are logged,
    // never a button_press, and the completing tap logs nothing at all.
    expect(logs.every((l) => l.event === 'miss_tap')).toBe(true);
    expect(logs.length).toBeLessThan(4);
  });

  it('home return: tapping the home-link area on a destination slide returns home', async () => {
    await makeController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // press button -> destination slide 2
    logs.length = 0;

    vi.advanceTimersByTime(150); // clear debounce window (100ms)
    tap(root, HOME_LINK_POINT.x, HOME_LINK_POINT.y);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'return_home', method: 'home_button', slide_from: 2, slide_to: 1 });
    expect(typeof logs[0].dwell_ms).toBe('number');
    expect(lastStage!.showCalls.at(-1)?.index).toBe(1);
  });

  it('tap anywhere: when enabled, any non-corner destination tap (not on home link) returns home', async () => {
    await makeController({ returnMethods: { homeButton: true, tapAnywhere: true, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    logs.length = 0;

    vi.advanceTimersByTime(150);
    tap(root, MISS.x, MISS.y); // not on the home link, but tapAnywhere is on

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'return_home', method: 'tap' });
  });

  it('timeout: destination auto-returns home after timeoutSec, and any tap resets it', async () => {
    await makeController({ timeoutSec: 5, returnMethods: { homeButton: true, tapAnywhere: false, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    logs.length = 0;

    vi.advanceTimersByTime(3000);
    // A tap that doesn't return home (not on home link, tapAnywhere off) still resets the timer.
    tap(root, MISS.x, MISS.y);
    expect(logs).toHaveLength(0);

    vi.advanceTimersByTime(3000); // 3s since reset, still < 5s
    expect(logs).toHaveLength(0);

    vi.advanceTimersByTime(2001); // now past 5s since the reset
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'return_home', method: 'timeout' });
  });

  it('stop() removes listeners and timers so nothing fires afterward', async () => {
    await makeController({ timeoutSec: 5 });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    logs.length = 0;

    controller.stop();
    expect(lastStage!.destroyed).toBe(true);

    vi.advanceTimersByTime(10_000); // would have fired the timeout return_home
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // would have fired button_press

    expect(logs).toHaveLength(0);
    expect(onAdminRequested).not.toHaveBeenCalled();
  });

  describe('button glow', () => {
    const GLOW_ON = { glow: { enabled: true, color: '#ffc400', intensity: 5, periodMs: 2000 } };
    const visibleLayers = () =>
      Array.from(lastStage!.overlay.querySelectorAll<HTMLElement>('.kiosk-glow-layer')).filter((l) => l.style.display !== 'none');

    it('draws nothing when the glow is off (the default)', async () => {
      await makeController();
      expect(lastStage!.overlay.querySelector('.kiosk-glow')).toBeNull();
    });

    it('glows every home-slide button on start, styled from the config', async () => {
      await makeController(GLOW_ON);
      const layers = visibleLayers();
      expect(layers).toHaveLength(1);
      expect(layers[0].querySelectorAll('.kiosk-glow')).toHaveLength(1);
      expect(layers[0].style.getPropertyValue('--glow-color')).toMatch(/^rgba\(255,196,0,/);
      expect(layers[0].style.getPropertyValue('--glow-half-period')).toBe('1000ms');
    });

    it('switches to the destination slide glow and back, reusing each slide layer', async () => {
      await makeController(GLOW_ON);
      const homeLayer = visibleLayers()[0];

      tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
      const destLayers = visibleLayers();
      expect(destLayers).toHaveLength(1);
      expect(destLayers[0]).not.toBe(homeLayer);
      const g = destLayers[0].querySelector<HTMLElement>('.kiosk-glow')!;
      expect(g.style.left).toBe('300px'); // the slide-2 home link
      expect(homeLayer.style.display).toBe('none');

      vi.advanceTimersByTime(150);
      tap(root, HOME_LINK_POINT.x, HOME_LINK_POINT.y); // -> home
      expect(visibleLayers()).toEqual([homeLayer]);
      expect(lastStage!.overlay.querySelectorAll('.kiosk-glow-layer')).toHaveLength(2);
    });

    it('stop() drops the cached layers', async () => {
      await makeController(GLOW_ON);
      controller.stop();
      await controller.start();
      expect(lastStage!.overlay.querySelectorAll('.kiosk-glow-layer')).toHaveLength(1);
    });
  });
});

describe('KioskController: nav links (multi-slide chains)', () => {
  let root: HTMLElement;
  let logs: Omit<LogEvent, 'ts' | 'session_id'>[];
  let onAdminRequested: Mock<() => void>;
  let controller: InstanceType<typeof KioskController>;

  // Slide 2 (button b1's target) has a Home link plus a "Next" nav link to slide 3.
  // Slide 3 has a "Back" nav link to slide 2, but deliberately no home link, so the
  // fallback Home overlay should appear there.
  const NAV_TO_3 = { x: 550, y: 520 }; // inside n1 bounds (slide 2) and n2 bounds (slide 3), non-corner
  const FALLBACK_HOME_POINT = { x: 950, y: 1000 }; // bottom-center fallback button on a 1920x1080 slide

  function fakeChainDeck(): Deck {
    const deck = fakeDeck();
    deck.navLinks = [
      { slide: 2, id: 'n1', shapeName: 'BTN_Next', label: 'Next', targetSlide: 3, bounds: { x: 500, y: 500, w: 200, h: 100 } },
      { slide: 3, id: 'n2', shapeName: 'BTN_Back', label: 'Back', targetSlide: 2, bounds: { x: 500, y: 500, w: 200, h: 100 } },
    ];
    return deck;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    root = document.createElement('div');
    document.body.appendChild(root);
    logs = [];
    onAdminRequested = vi.fn<() => void>();
  });

  afterEach(() => {
    controller?.stop();
    root.remove();
    vi.useRealTimers();
  });

  async function makeChainController(cfgOver: Partial<KioskConfig> = {}) {
    controller = new KioskController({
      root,
      deck: fakeChainDeck(),
      config: fakeConfig(cfgOver),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    return controller;
  }

  it('nav tap: tapping a nav-link shape on a destination slide logs slide_nav and moves to the target slide', async () => {
    await makeChainController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // button_press -> slide 2
    const visitId = logs[0].visit_id;
    logs.length = 0;

    vi.advanceTimersByTime(150);
    tap(root, NAV_TO_3.x, NAV_TO_3.y);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'slide_nav',
      visit_id: visitId,
      button_id: 'b1',
      button_label: 'Button 1',
      slide_from: 2,
      slide_to: 3,
    });
    expect(typeof logs[0].dwell_ms).toBe('number');
    expect(lastStage!.showCalls.at(-1)?.index).toBe(3);
  });

  it('a nav tap resets the destination timeout, and the eventual timeout return_home reports the slide actually left', async () => {
    await makeChainController({ timeoutSec: 5, returnMethods: { homeButton: true, tapAnywhere: false, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
    logs.length = 0;

    vi.advanceTimersByTime(3000);
    tap(root, NAV_TO_3.x, NAV_TO_3.y); // -> slide 3, resets the timer
    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe('slide_nav');

    vi.advanceTimersByTime(3000); // 6s since dest entry, but only 3s since the nav reset
    expect(logs).toHaveLength(1);

    vi.advanceTimersByTime(2001); // now past 5s since the nav reset
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ event: 'return_home', method: 'timeout', slide_from: 3, slide_to: 1 });
  });

  it('return_home from a chained slide reports dwell_ms for the whole visit, not just the last slide', async () => {
    await makeChainController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // t=0, -> slide 2
    logs.length = 0;

    vi.advanceTimersByTime(2000);
    tap(root, NAV_TO_3.x, NAV_TO_3.y); // t=2000, -> slide 3
    expect(logs[0].dwell_ms).toBeCloseTo(2000, -2);

    vi.advanceTimersByTime(3000); // t=5000
    tap(root, FALLBACK_HOME_POINT.x, FALLBACK_HOME_POINT.y); // fallback Home on slide 3 (no home link there)

    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ event: 'return_home', method: 'home_button', slide_from: 3, slide_to: 1 });
    expect(logs[1].dwell_ms).toBeCloseTo(5000, -2); // whole visit, not just time on slide 3
    expect(lastStage!.showCalls.at(-1)?.index).toBe(1);
  });

  it('the fallback Home overlay is (re)drawn for the new slide after a nav tap, with no stale element left behind', async () => {
    await makeChainController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2 (has a real home link: no fallback drawn)
    expect(lastStage!.overlay.querySelectorAll('.kiosk-fallback-home').length).toBe(0);

    vi.advanceTimersByTime(150);
    tap(root, NAV_TO_3.x, NAV_TO_3.y); // -> slide 3 (no home link: fallback should appear)
    expect(lastStage!.overlay.querySelectorAll('.kiosk-fallback-home').length).toBe(1);

    // Tapping the fallback returns home; nothing left behind in the overlay afterwards.
    vi.advanceTimersByTime(150);
    tap(root, FALLBACK_HOME_POINT.x, FALLBACK_HOME_POINT.y);
    expect(lastStage!.overlay.querySelectorAll('.kiosk-fallback-home').length).toBe(0);
  });

  it('the fallback Home button glows too when the glow is on', async () => {
    await makeChainController({ glow: { enabled: true, color: '#ffffff', intensity: 3, periodMs: 1500 } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    vi.advanceTimersByTime(150);
    tap(root, NAV_TO_3.x, NAV_TO_3.y); // slide 3 has no home link: fallback drawn
    const fallback = lastStage!.overlay.querySelector<HTMLElement>('.kiosk-fallback-home')!;
    expect(fallback.querySelector('.kiosk-glow')).not.toBeNull();
    expect(fallback.style.getPropertyValue('--glow-half-period')).toBe('750ms');
  });
});

describe('KioskController: "Last Slide Viewed" back links', () => {
  let root: HTMLElement;
  let logs: Omit<LogEvent, 'ts' | 'session_id'>[];
  let controller: InstanceType<typeof KioskController>;

  // b1 -> slide 2, b2 -> slide 4 (Terms) directly. Slide 2: "Next" -> 3 and "Terms" -> 4.
  // Slide 3: "Terms" -> 4. Slide 4 (Terms) has only a back link, no home link.
  const BUTTON_2 = { x: 650, y: 130 };
  const NEXT = { x: 550, y: 520 };
  const TERMS = { x: 850, y: 520 };
  const BACK = { x: 550, y: 720 };

  function fakeTermsDeck(): Deck {
    const deck = fakeDeck();
    deck.buttons.push({
      id: 'b2', shapeName: 'BTN_Terms', text: 'Terms', defaultLabel: 'Terms', targetSlide: 4,
      bounds: { x: 600, y: 100, w: 200, h: 100 },
    });
    deck.navLinks = [
      { slide: 2, id: 'n1', shapeName: 'BTN_Next', label: 'Next', targetSlide: 3, bounds: { x: 500, y: 500, w: 200, h: 100 } },
      { slide: 2, id: 'n2', shapeName: 'BTN_Terms', label: 'Terms', targetSlide: 4, bounds: { x: 800, y: 500, w: 200, h: 100 } },
      { slide: 3, id: 'n3', shapeName: 'BTN_Terms', label: 'Terms', targetSlide: 4, bounds: { x: 800, y: 500, w: 200, h: 100 } },
    ];
    deck.backLinks = [{ slide: 4, id: 'k1', shapeName: 'BTN_Back', label: 'Back', bounds: { x: 500, y: 700, w: 200, h: 100 } }];
    return deck;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    root = document.createElement('div');
    document.body.appendChild(root);
    logs = [];
  });

  afterEach(() => {
    controller?.stop();
    root.remove();
    vi.useRealTimers();
  });

  async function makeTermsController(cfgOver: Partial<KioskConfig> = {}) {
    controller = new KioskController({
      root,
      deck: fakeTermsDeck(),
      config: fakeConfig(cfgOver),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested: vi.fn<() => void>(),
    });
    await controller.start();
    return controller;
  }

  function tapAfterDebounce(p: { x: number; y: number }): void {
    vi.advanceTimersByTime(150);
    tap(root, p.x, p.y);
  }

  it('returns to the slide the visitor came from, logged as slide_nav', async () => {
    await makeTermsController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> 2
    tapAfterDebounce(TERMS); // -> 4
    logs.length = 0;

    tapAfterDebounce(BACK);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'slide_nav', button_id: 'b1', slide_from: 4, slide_to: 2 });
    expect(lastStage!.showCalls.at(-1)?.index).toBe(2);
  });

  it('goes back to whichever slide linked to it, not a fixed one', async () => {
    await makeTermsController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> 2
    tapAfterDebounce(NEXT); // -> 3
    tapAfterDebounce(TERMS); // -> 4
    logs.length = 0;

    tapAfterDebounce(BACK);
    expect(logs[0]).toMatchObject({ event: 'slide_nav', slide_from: 4, slide_to: 3 });
    expect(lastStage!.showCalls.at(-1)?.index).toBe(3);
  });

  it('returns Home when the slide was reached straight from a home-slide button', async () => {
    await makeTermsController();
    tap(root, BUTTON_2.x, BUTTON_2.y); // -> 4 directly
    logs.length = 0;

    tapAfterDebounce(BACK);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'return_home', method: 'home_button', button_id: 'b2', slide_from: 4, slide_to: 1 });
    expect(lastStage!.showCalls.at(-1)?.index).toBe(1);
  });

  it('starts each visit with fresh history, so a timeout does not leak the previous path', async () => {
    await makeTermsController({ timeoutSec: 5, returnMethods: { homeButton: true, tapAnywhere: false, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> 2
    tapAfterDebounce(TERMS); // -> 4
    vi.advanceTimersByTime(6000); // timeout -> home
    expect(logs.at(-1)).toMatchObject({ event: 'return_home', method: 'timeout' });

    tap(root, BUTTON_2.x, BUTTON_2.y); // new visit, -> 4 directly
    logs.length = 0;
    tapAfterDebounce(BACK);
    expect(logs[0]).toMatchObject({ event: 'return_home', slide_from: 4 });
  });

  it('does not draw the fallback Home button on a slide that has a back link', async () => {
    await makeTermsController();
    tap(root, BUTTON_2.x, BUTTON_2.y); // -> 4
    expect(lastStage!.overlay.querySelectorAll('.kiosk-fallback-home').length).toBe(0);
  });
});

describe('KioskController: attract loop', () => {
  let root: HTMLElement;
  let logs: Omit<LogEvent, 'ts' | 'session_id'>[];
  let onAdminRequested: Mock<() => void>;
  let controller: InstanceType<typeof KioskController>;

  function fakeSlide(index: number): Slide {
    return { index, background: { type: 'none' }, elements: [] };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    root = document.createElement('div');
    document.body.appendChild(root);
    logs = [];
    onAdminRequested = vi.fn<() => void>();
  });

  afterEach(() => {
    controller?.stop();
    root.remove();
    vi.useRealTimers();
  });

  /** Builds and starts a controller with the attract loop configured; every other config field
   * comes from `fakeConfig` unless overridden. */
  async function makeAttractController(
    cfgOver: Partial<KioskConfig> = {},
    attractOver: Partial<KioskConfig['attract']> = {},
    deckOver?: Deck,
  ): Promise<InstanceType<typeof KioskController>> {
    controller = new KioskController({
      root,
      deck: deckOver ?? fakeDeck(),
      config: fakeConfig({
        attract: { enabled: true, idleSec: 5, mode: 'pulse', slides: [], slideSec: 4, ...attractOver },
        ...cfgOver,
      }),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    return controller;
  }

  it('is off by default: idling on Home never starts the loop', async () => {
    controller = new KioskController({
      root,
      deck: fakeDeck(),
      config: fakeConfig(), // attract.enabled: false, per defaultConfig
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    logs.length = 0;
    vi.advanceTimersByTime(10 * 60_000);
    expect(logs.some((l) => l.event === 'attract_start')).toBe(false);
    expect(root.classList.contains('kiosk-attract-pulse')).toBe(false);
  });

  it('starts after idleSec of no accepted taps on Home', async () => {
    await makeAttractController();
    logs.length = 0;
    vi.advanceTimersByTime(4999);
    expect(logs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(logs.map((l) => l.event)).toEqual(['attract_start']);
  });

  it('a miss tap on Home re-arms the idle timer instead of leaving the old one running', async () => {
    await makeAttractController();
    logs.length = 0;
    vi.advanceTimersByTime(4000);
    tap(root, MISS.x, MISS.y); // miss_tap, still activity: re-arms for another 5s from here
    expect(logs.map((l) => l.event)).toEqual(['miss_tap']);

    vi.advanceTimersByTime(4999);
    expect(logs.some((l) => l.event === 'attract_start')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(logs.at(-1)?.event).toBe('attract_start');
  });

  it('a tap in attract mode wakes the kiosk without pressing a button or logging miss_tap, even directly over a button', async () => {
    await makeAttractController();
    vi.advanceTimersByTime(5000);
    logs.length = 0;

    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // sits inside b1's bounds

    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe('attract_end');
    expect(typeof logs[0].dwell_ms).toBe('number');
    // Never navigated to b1's target (slide 2): the tap only woke the kiosk.
    expect(lastStage!.showCalls.every((c) => c.index !== 2)).toBe(true);
  });

  it('a destination visit clears the idle timer, so it never starts attract behind an open visit', async () => {
    await makeAttractController(
      { timeoutSec: null, returnMethods: { homeButton: true, tapAnywhere: false, timeout: false } },
      { idleSec: 3 },
    );
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> destination slide 2
    logs.length = 0;

    vi.advanceTimersByTime(10_000); // would have started attract if the Home idle timer weren't cleared
    expect(logs.some((l) => l.event === 'attract_start')).toBe(false);
  });

  it('returning home re-arms the idle timer', async () => {
    await makeAttractController(
      { timeoutSec: null, returnMethods: { homeButton: true, tapAnywhere: false, timeout: false } },
      { idleSec: 3 },
    );
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> destination slide 2
    vi.advanceTimersByTime(150); // clear debounce
    tap(root, HOME_LINK_POINT.x, HOME_LINK_POINT.y); // -> back home
    logs.length = 0;

    vi.advanceTimersByTime(3000);
    expect(logs.map((l) => l.event)).toEqual(['attract_start']);
  });

  it('the secret sequence still completes while in attract mode', async () => {
    await makeAttractController({ secretPattern: 'corners_cw', secretWindowMs: 5000 });
    vi.advanceTimersByTime(5000); // -> attract
    logs.length = 0;

    // The corner sequence's first tap also happens to be the tap that wakes the kiosk (the
    // wake tap and the sequence's own first step are the same physical tap); every following
    // corner tap is consumed by the detector as normal, and the sequence still completes.
    tap(root, TL.x, TL.y);
    tap(root, TR.x, TR.y);
    tap(root, BR.x, BR.y);
    tap(root, BL.x, BL.y);

    expect(onAdminRequested).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.event === 'button_press')).toBe(false);
    expect(logs.some((l) => l.event === 'miss_tap')).toBe(false);
    expect(logs.filter((l) => l.event === 'attract_end')).toHaveLength(1);
  });

  it('cycle mode advances every slideSec and wraps back to Home', async () => {
    const deck = fakeDeck();
    deck.slides = [fakeSlide(1), fakeSlide(2), fakeSlide(3)];
    await makeAttractController({}, { mode: 'cycle', slides: [2, 3], slideSec: 4 }, deck);
    logs.length = 0;

    vi.advanceTimersByTime(5000); // idle -> attract_start; cycle stays on Home until the first step
    expect(logs.map((l) => l.event)).toEqual(['attract_start']);

    vi.advanceTimersByTime(4000); // first step -> slide 2
    expect(lastStage!.showCalls.at(-1)).toMatchObject({ index: 2, transition: { type: 'fade', ms: ATTRACT_CROSSFADE_MS } });

    vi.advanceTimersByTime(4000); // -> slide 3
    expect(lastStage!.showCalls.at(-1)?.index).toBe(3);

    vi.advanceTimersByTime(4000); // wraps back to Home
    expect(lastStage!.showCalls.at(-1)).toMatchObject({ index: 1, transition: { type: 'fade', ms: ATTRACT_CROSSFADE_MS } });
  });

  it('cycle mode with nothing else to cycle behaves like pulse mode', async () => {
    // config.attract.slides names slides that don't exist in this deck, so cycleSlides
    // collapses to just [1] (Home), with nothing to crossfade to.
    await makeAttractController({}, { mode: 'cycle', slides: [2, 3], slideSec: 4 });
    vi.advanceTimersByTime(5000);
    expect(root.classList.contains('kiosk-attract-pulse')).toBe(true);
  });

  it('pulse mode toggles the kiosk-attract-pulse class on start and on wake', async () => {
    await makeAttractController();
    expect(root.classList.contains('kiosk-attract-pulse')).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(root.classList.contains('kiosk-attract-pulse')).toBe(true);

    // The class is toggled on the controller's own root (not some other ancestor such as
    // App's outer .kiosk-root), which is what styles.css's `.kiosk-attract-pulse
    // .kiosk-attract-pulse-layer` descendant selector (no `.kiosk-root` prefix) actually
    // matches against. Regression guard for a bug where the CSS wrongly required both
    // classes on the same element.
    const layer = lastStage!.overlay.querySelector('.kiosk-attract-pulse-layer')!;
    expect(layer.closest('.kiosk-attract-pulse')).toBe(root);
    expect(layer.matches('.kiosk-attract-pulse .kiosk-attract-pulse-layer')).toBe(true);

    tap(root, MISS.x, MISS.y); // any tap wakes
    expect(root.classList.contains('kiosk-attract-pulse')).toBe(false);
  });

  it('a wake tap mid-cycle-crossfade lands on Home, shows only Home\'s glow, and logs one attract_end with no button press', async () => {
    const deck = fakeDeck();
    deck.slides = [fakeSlide(1), fakeSlide(2)];
    await makeAttractController(
      { glow: { enabled: true, color: '#ffffff', intensity: 5, periodMs: 2000 } },
      { mode: 'cycle', slides: [2], slideSec: 4 },
      deck,
    );
    logs.length = 0;

    vi.advanceTimersByTime(5000); // idle -> attract_start, cycle running on Home
    vi.advanceTimersByTime(4000); // first cycle step: crossfade under way to slide 2
    expect(lastStage!.showCalls.at(-1)?.index).toBe(2);
    logs.length = 0;

    // The wake tap arrives before the crossfade's own timer would have settled it.
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // sits inside b1's bounds

    expect(lastStage!.current).toBe(1);
    expect(logs.map((l) => l.event)).toEqual(['attract_end']);
    expect(logs.some((l) => l.event === 'button_press')).toBe(false);

    const visibleLayers = Array.from(
      lastStage!.overlay.querySelectorAll<HTMLElement>('.kiosk-glow-layer'),
    ).filter((l) => l.style.display !== 'none');
    expect(visibleLayers).toHaveLength(1);
    expect(visibleLayers[0].querySelector('.kiosk-glow')).not.toBeNull(); // Home's own glow
  });

  it('stop() clears every attract timer and the pulse class, leaving nothing pending', async () => {
    const deck = fakeDeck();
    deck.slides = [fakeSlide(1), fakeSlide(2)];
    await makeAttractController({}, { mode: 'cycle', slides: [2], slideSec: 4 }, deck);
    vi.advanceTimersByTime(5000); // idle -> attract_start, cycle running (one pending timer)
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(root.classList.contains('kiosk-attract-pulse')).toBe(false);
  });

  it('stop() while pulsing removes the class and leaves no pending timers', async () => {
    await makeAttractController();
    vi.advanceTimersByTime(5000);
    expect(root.classList.contains('kiosk-attract-pulse')).toBe(true);

    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(root.classList.contains('kiosk-attract-pulse')).toBe(false);
  });
});

describe('KioskController: polls and ratings', () => {
  let root: HTMLElement;
  let logs: Omit<LogEvent, 'ts' | 'session_id'>[];
  let onAdminRequested: Mock<() => void>;
  let controller: InstanceType<typeof KioskController>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    root = document.createElement('div');
    document.body.appendChild(root);
    logs = [];
    onAdminRequested = vi.fn<() => void>();
  });

  afterEach(() => {
    controller?.stop();
    root.remove();
    vi.useRealTimers();
  });

  /**
   * A deck with: two home buttons (b1 -> slide 2, b2 -> slide 5, b2 doubling as a linked
   * VOTE_Topic_Zero option); an unlinked VOTE_Mood_Happy option on Home; on slide 2, an
   * unlinked RATE_Stand_3 option and a VOTE_Extra_Yes option that is also a nav link to
   * slide 6 (so a linked destination vote can be exercised without a second button).
   */
  function pollDeck(): Deck {
    const deck = fakeDeck();
    deck.buttons.push({
      id: 'b2',
      shapeName: 'BTN_2',
      text: 'Button 2',
      defaultLabel: 'Button 2',
      targetSlide: 5,
      bounds: { x: 700, y: 100, w: 200, h: 100 },
    });
    deck.navLinks = [
      {
        slide: 2,
        id: 'nav1',
        shapeName: 'VOTE_Extra_Yes',
        label: 'Yes',
        targetSlide: 6,
        bounds: { x: 800, y: 800, w: 100, h: 60 },
      },
    ];
    deck.pollOptions = [
      {
        slide: 1,
        id: 'v-mood',
        shapeName: 'VOTE_Mood_Happy',
        poll: 'Mood',
        choice: 'Happy',
        kind: 'vote',
        label: 'Happy',
        bounds: { x: 700, y: 700, w: 100, h: 60 },
        linked: false,
      },
      {
        slide: 1,
        id: 'b2',
        shapeName: 'VOTE_Topic_Zero',
        poll: 'Topic',
        choice: 'Zero',
        kind: 'vote',
        label: 'Zero',
        bounds: { x: 700, y: 100, w: 200, h: 100 },
        linked: true,
        targetSlide: 5,
      },
      {
        slide: 2,
        id: 'v-rate',
        shapeName: 'RATE_Stand_3',
        poll: 'Stand',
        choice: '3',
        kind: 'rate',
        label: '3',
        bounds: { x: 500, y: 500, w: 100, h: 60 },
        linked: false,
      },
      {
        slide: 2,
        id: 'nav1',
        shapeName: 'VOTE_Extra_Yes',
        poll: 'Extra',
        choice: 'Yes',
        kind: 'vote',
        label: 'Yes',
        bounds: { x: 800, y: 800, w: 100, h: 60 },
        linked: true,
        targetSlide: 6,
      },
    ];
    return deck;
  }

  async function makePollController(cfgOver: Partial<KioskConfig> = {}): Promise<InstanceType<typeof KioskController>> {
    controller = new KioskController({
      root,
      deck: pollDeck(),
      config: fakeConfig(cfgOver),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    return controller;
  }

  it('logs a destination vote once per visit per poll; a repeat tap in the same visit logs nothing', async () => {
    await makePollController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // b1 -> slide 2
    logs.length = 0;

    vi.advanceTimersByTime(150);
    tap(root, 550, 530); // inside v-rate's bounds (500,500,100,60)
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'vote', poll: 'Stand', choice: '3', slide_from: 2 });
    expect(logs[0].visit_id).toBeTruthy();

    logs.length = 0;
    vi.advanceTimersByTime(150);
    tap(root, 550, 530); // repeat tap, same visit, same poll: not logged
    expect(logs).toHaveLength(0);
  });

  it('a new visit can vote in the same poll again', async () => {
    await makePollController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
    vi.advanceTimersByTime(150);
    tap(root, 550, 530); // vote
    vi.advanceTimersByTime(150);
    tap(root, HOME_LINK_POINT.x, HOME_LINK_POINT.y); // return home, ends the visit
    logs.length = 0;

    vi.advanceTimersByTime(150);
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // a new visit -> slide 2 again
    vi.advanceTimersByTime(150);
    tap(root, 550, 530); // votes again, in the new visit

    expect(logs.filter((l) => l.event === 'vote')).toHaveLength(1);
  });

  it('a linked destination vote logs vote then slide_nav, in that order, and the link is still followed', async () => {
    await makePollController();
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
    logs.length = 0;

    vi.advanceTimersByTime(150);
    tap(root, 850, 830); // inside nav1's bounds (800,800,100,60), linked to slide 6

    expect(logs.map((l) => l.event)).toEqual(['vote', 'slide_nav']);
    expect(logs[0]).toMatchObject({ poll: 'Extra', choice: 'Yes', slide_from: 2 });
    expect(logs[1]).toMatchObject({ event: 'slide_nav', slide_from: 2, slide_to: 6 });
    expect(lastStage!.showCalls.at(-1)?.index).toBe(6);
  });

  it('home unlinked vote logs vote with no visit_id and never a miss_tap; cooldown suppresses a repeat within 3s and allows one after', async () => {
    await makePollController();
    logs.length = 0;
    tap(root, 750, 730); // inside v-mood's bounds (700,700,100,60)

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'vote', poll: 'Mood', choice: 'Happy', slide_from: 1 });
    expect(logs[0].visit_id).toBeUndefined();

    logs.length = 0;
    vi.advanceTimersByTime(150); // past the 100ms debounce, still inside the 3s cooldown
    tap(root, 750, 730);
    expect(logs).toHaveLength(0);
    expect(logs.some((l) => l.event === 'miss_tap')).toBe(false);

    vi.advanceTimersByTime(3000); // now past the cooldown (3150ms since the first vote)
    tap(root, 750, 730);
    expect(logs.filter((l) => l.event === 'vote')).toHaveLength(1);
  });

  it('home linked vote logs button_press then vote with the same visit_id', async () => {
    await makePollController();
    logs.length = 0;
    tap(root, 800, 150); // inside b2's bounds (700,100,200,100), also VOTE_Topic_Zero

    expect(logs.map((l) => l.event)).toEqual(['button_press', 'vote']);
    expect(logs[0]).toMatchObject({ button_id: 'b2', slide_to: 5 });
    expect(logs[1]).toMatchObject({ poll: 'Topic', choice: 'Zero', slide_from: 1 });
    expect(logs[0].visit_id).toBeTruthy();
    expect(logs[1].visit_id).toBe(logs[0].visit_id);
  });

  it('a Home poll option linked to slide 1 (or a "Last Slide Viewed" back link) is not a button: it votes with the cooldown path, never a miss_tap', async () => {
    // `linked: true` here models a VOTE_/RATE_ shape whose own link targets slide 1, or uses
    // "Last Slide Viewed": detectPollOptions sets `linked: true` for any link, but
    // detectButtons only makes a home shape a button when it links to a *later* slide, so
    // this option is never in deck.buttons. Whether the kiosk treats it as a button must
    // therefore go by button membership, not by `opt.linked`.
    const deck = fakeDeck();
    deck.pollOptions = [
      {
        slide: 1,
        id: 'v-home-link',
        shapeName: 'VOTE_Feedback_Yes',
        poll: 'Feedback',
        choice: 'Yes',
        kind: 'vote',
        label: 'Yes',
        bounds: { x: 900, y: 900, w: 100, h: 60 },
        linked: true,
        targetSlide: undefined,
      },
    ];
    controller = new KioskController({
      root,
      deck,
      config: fakeConfig(),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    logs.length = 0;

    tap(root, 950, 930); // inside the option's bounds

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'vote', poll: 'Feedback', choice: 'Yes', slide_from: 1 });
    expect(logs[0].visit_id).toBeUndefined();
    expect(logs.some((l) => l.event === 'miss_tap')).toBe(false);
  });

  it('attract wake tap on a vote shape logs no vote', async () => {
    await makePollController({ attract: { enabled: true, idleSec: 5, mode: 'pulse', slides: [], slideSec: 4 } });
    vi.advanceTimersByTime(5000); // idle -> attract_start
    logs.length = 0;

    tap(root, 750, 730); // sits inside v-mood's bounds, would be a vote on a normal Home tap

    expect(logs.map((l) => l.event)).toEqual(['attract_end']);
  });

  it('shows the Thanks overlay on an unlinked vote and hides it after its own timer', async () => {
    await makePollController();
    tap(root, 750, 730); // home unlinked vote

    const thanks = lastStage!.overlay.querySelector('.kiosk-poll-thanks') as HTMLElement | null;
    expect(thanks).not.toBeNull();
    expect(thanks!.classList.contains('kiosk-poll-thanks--visible')).toBe(true);

    vi.advanceTimersByTime(1499);
    expect(thanks!.classList.contains('kiosk-poll-thanks--visible')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(thanks!.classList.contains('kiosk-poll-thanks--visible')).toBe(false);
  });

  it('stop() clears a pending Thanks timer, leaving nothing pending', async () => {
    await makePollController();
    tap(root, 750, 730); // shows Thanks and starts its timer
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------- video

function videoMedia(): Record<string, MediaItem> {
  return {
    'ppt/media/media1.mp4': { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), mime: 'video/mp4' },
    'ppt/media/media2.mp4': { blob: new Blob([new Uint8Array([4, 5, 6])], { type: 'video/mp4' }), mime: 'video/mp4' },
    'ppt/media/image1.png': { blob: new Blob([new Uint8Array([7])], { type: 'image/png' }), mime: 'image/png' },
  };
}

function videoEl(overrides: Partial<VideoElement> & { id: string }): VideoElement {
  return {
    kind: 'video',
    name: 'Video',
    xfrm: { x: 0, y: 0, w: 400, h: 300, rot: 0, flipH: false, flipV: false },
    mediaKey: 'ppt/media/media1.mp4',
    posterKey: 'ppt/media/image1.png',
    loop: false,
    autoplay: true,
    ...overrides,
  };
}

/** Home (b1 -> slide 2, b2 -> slide 3), a home link back on both destinations, and a video on
 * slide 2 (autoplay by default) and slide 3: enough for every video wiring test below. */
function fakeVideoDeck(slide2Video: Partial<VideoElement> = {}, extraSlide3Elements: VideoElement[] = []): Deck {
  return {
    id: 'deck-video',
    fileName: 'video.pptx',
    parsedAt: '2026-09-24T00:00:00.000Z',
    slideWidthEmu: 12192000,
    slideHeightEmu: 6858000,
    height: 1080,
    slides: [
      { index: 1, background: { type: 'none' }, elements: [] },
      { index: 2, background: { type: 'none' }, elements: [videoEl({ id: 'v2', ...slide2Video })] },
      { index: 3, background: { type: 'none' }, elements: extraSlide3Elements },
    ],
    buttons: [
      { id: 'b1', shapeName: 'BTN_1', text: 'One', defaultLabel: 'One', targetSlide: 2, bounds: { x: 100, y: 100, w: 200, h: 100 } },
      { id: 'b2', shapeName: 'BTN_2', text: 'Two', defaultLabel: 'Two', targetSlide: 3, bounds: { x: 400, y: 100, w: 200, h: 100 } },
    ],
    homeLinks: [
      { slide: 2, id: 'h2', bounds: { x: 0, y: 900, w: 150, h: 100 } },
      { slide: 3, id: 'h3', bounds: { x: 0, y: 900, w: 150, h: 100 } },
    ],
    navLinks: [],
    backLinks: [],
    pollOptions: [],
    media: videoMedia(),
    fonts: [],
  };
}

describe('KioskController: video playback', () => {
  let root: HTMLElement;
  let logs: Omit<LogEvent, 'ts' | 'session_id'>[];
  let onAdminRequested: Mock<() => void>;
  let controller: InstanceType<typeof KioskController>;

  beforeEach(() => {
    stubObjectUrl();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    root = document.createElement('div');
    document.body.appendChild(root);
    logs = [];
    onAdminRequested = vi.fn<() => void>();
  });

  afterEach(() => {
    controller?.stop();
    root.remove();
    vi.useRealTimers();
  });

  async function makeVideoController(deck: Deck, cfgOver: Partial<KioskConfig> = {}) {
    logs.length = 0;
    controller = new KioskController({
      root,
      deck,
      config: fakeConfig(cfgOver),
      sessionId: 'sess-1',
      log: (e) => logs.push(e),
      onAdminRequested,
    });
    await controller.start();
    return controller;
  }

  /** Lets the microtask VideoPlayer.activateOnArrival() is chained onto (after stage.show())
   * actually run before the next assertion: MockSlideStage.show() resolves immediately, but
   * still asynchronously. */
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('activates the first autoplay video on arrival, once the transition settles', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck);
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
    await flush();

    const stageVideo = lastStage!.videosOn(2)[0];
    expect(stageVideo.el.src).toContain('blob:mock');
    expect(stageVideo.el.play).toBeTruthy();
  });

  it('does not activate a non-autoplay video on arrival, but a tap on it starts it', async () => {
    const deck = fakeVideoDeck({ autoplay: false });
    await makeVideoController(deck);
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    expect(stageVideo.el.src).toBe('');

    // Tap the video's own bounds (x:0,y:0,w:400,h:300).
    vi.advanceTimersByTime(200);
    tap(root, 100, 100);
    expect(stageVideo.el.src).toContain('blob:mock');
  });

  it('only one video is ever active: switching to a different video on the same slide deactivates the first', async () => {
    const other = videoEl({ id: 'v3b', mediaKey: 'ppt/media/media2.mp4', xfrm: { x: 900, y: 0, w: 400, h: 300, rot: 0, flipH: false, flipV: false } });
    const deck = fakeVideoDeck({}, [videoEl({ id: 'v3a', autoplay: true }), other]);
    await makeVideoController(deck);
    tap(root, 450, 130); // b2 -> slide 3
    await flush();
    const [first, second] = lastStage!.videosOn(3);
    expect(first.el.src).toContain('blob:mock'); // v3a autoplayed
    expect(second.el.src).toBe('');

    vi.advanceTimersByTime(200);
    tap(root, 1000, 100); // inside v3b's bounds
    expect(second.el.src).toContain('blob:mock');
    expect(first.el.hasAttribute('src')).toBe(false);
  });

  it('leaving the slide (Home link) deactivates the active video: pauses, clears src, calls load()', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck);
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    expect(stageVideo.el.src).toContain('blob:mock');

    vi.advanceTimersByTime(200);
    tap(root, 50, 950); // home link bounds on slide 2
    expect(stageVideo.el.hasAttribute('src')).toBe(false);
  });

  /** Advances the fake clock in <=2s steps, dispatching `timeupdate` on `video` between each
   * step so VideoPlayer's 6s stall watchdog (src/kiosk/video.ts) never mistakes "no one told it
   * to advance the clock" for "the decoder is stuck": these tests are about the destination
   * timeout, not the watchdog, which has its own dedicated tests in tests/kiosk/video.test.ts. */
  function advancePlaying(video: HTMLVideoElement, totalMs: number): void {
    let remaining = totalMs;
    while (remaining > 0) {
      const step = Math.min(2000, remaining);
      vi.advanceTimersByTime(step);
      remaining -= step;
      if (remaining > 0) video.dispatchEvent(new Event('timeupdate'));
    }
  }

  it('pauses the destination timeout while the video plays, and restarts it from the full duration once it ends', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck, { timeoutSec: 5, returnMethods: { homeButton: true, tapAnywhere: false, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2, starts a 5s timeout
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];

    stageVideo.el.dispatchEvent(new Event('playing')); // pauses the timeout
    advancePlaying(stageVideo.el, 10_000); // well past 5s: nothing should happen, the timeout is paused
    expect(logs.some((l) => l.event === 'return_home')).toBe(false);

    stageVideo.el.dispatchEvent(new Event('ended')); // restarts the timeout from the full 5s
    vi.advanceTimersByTime(4999);
    expect(logs.some((l) => l.event === 'return_home')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(logs.some((l) => l.event === 'return_home')).toBe(true);
  });

  it('a tap that would otherwise reset the destination timeout does not restart it while the video plays (decision 3)', async () => {
    // tapAnywhere off: a tap that hits no link/poll/video on the slide falls through to
    // resetDestinationTimer() (SPEC: "otherwise just reset the timeout"). Decision 3 says that
    // reset must not happen while the active video is playing.
    const deck = fakeVideoDeck();
    await makeVideoController(deck, { timeoutSec: 5, returnMethods: { homeButton: true, tapAnywhere: false, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    stageVideo.el.dispatchEvent(new Event('playing'));

    vi.advanceTimersByTime(200);
    tap(root, 1500, 500); // outside the video (x:0,y:0,w:400,h:300) and every link: falls through
    expect(logs.some((l) => l.event === 'return_home')).toBe(false);
    // If this tap had wrongly restarted the (paused) timer, it would fire around now+5000
    // (i.e. ~5200 after the button press); it must not, since the timer stayed paused/cleared.
    advancePlaying(stageVideo.el, 10_000);
    expect(logs.some((l) => l.event === 'return_home')).toBe(false);
  });

  it('loop: restarts the timeout only after the first full play, even though playback keeps looping', async () => {
    const deck = fakeVideoDeck({ loop: true });
    await makeVideoController(deck, { timeoutSec: 5, returnMethods: { homeButton: true, tapAnywhere: false, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];

    stageVideo.el.dispatchEvent(new Event('playing'));
    stageVideo.el.dispatchEvent(new Event('ended')); // lap 1 done -> timeout restarts from 5s
    stageVideo.el.dispatchEvent(new Event('playing')); // lap 2 starts: must NOT re-pause it

    vi.advanceTimersByTime(5000);
    expect(logs.some((l) => l.event === 'return_home')).toBe(true);
  });

  it('an error on the active video resumes the timeout immediately and deactivates it', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck, { timeoutSec: 5, returnMethods: { homeButton: true, tapAnywhere: false, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    stageVideo.el.dispatchEvent(new Event('playing'));

    stageVideo.el.dispatchEvent(new Event('error'));

    expect(stageVideo.el.hasAttribute('src')).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(logs.some((l) => l.event === 'return_home')).toBe(true);
  });

  it('logs video_end (with watched_ms and completed) exactly once when the visitor leaves mid-play', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck);
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    stageVideo.el.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(3000);

    tap(root, 50, 950); // home link: leaves the slide

    const videoEnds = logs.filter((l) => l.event === 'video_end');
    expect(videoEnds).toHaveLength(1);
    expect(videoEnds[0]).toMatchObject({ slide_from: 2, watched_ms: 3000, completed: false, button_id: 'b1', button_label: 'One' });
  });

  it('never activates a video on Home, even one placed on slide 1', async () => {
    const deck = fakeVideoDeck();
    deck.slides[0] = { index: 1, background: { type: 'none' }, elements: [videoEl({ id: 'home-video' })] };
    await makeVideoController(deck);
    await flush();
    const homeVideo = lastStage!.videosOn(1)[0];
    expect(homeVideo.el.src).toBe('');

    // Go to slide 2 and back Home: still never activated.
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    await flush();
    vi.advanceTimersByTime(200);
    tap(root, 50, 950);
    await flush();
    expect(homeVideo.el.src).toBe('');
  });

  it('never activates a video during the attract loop, even when it cycles onto that slide', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck, {
      attract: { enabled: true, idleSec: 10, mode: 'cycle', slides: [2], slideSec: 4 },
    });
    vi.advanceTimersByTime(10_000); // idle timeout on Home -> attract starts, cycling Home/2
    vi.advanceTimersByTime(4000); // one cycle step: crossfades to slide 2

    const stageVideo = lastStage!.videosOn(2)[0];
    expect(stageVideo.el.src).toBe('');
  });

  it('stop() leaves no timer, no src, and every created object URL revoked', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck);
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    stageVideo.el.dispatchEvent(new Event('playing'));

    controller.stop();

    expect(stageVideo.el.hasAttribute('src')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a tap that activates a video before the slide-arrival promise resolves does not leak: one URL, one video_end', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck);
    lastStage!.manualShow = true;
    const createSpy = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    const revokeSpy = URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;

    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2; stage.show() is now pending
    vi.advanceTimersByTime(150); // past debounce
    tap(root, 300, 200); // lands on the video (not a corner) before arrival's .then() has run
    const stageVideo = lastStage!.videosOn(2)[0];
    expect(stageVideo.el.src).toContain('blob:mock');
    expect(createSpy.mock.calls.length).toBe(1);

    lastStage!.resolveNextShow(); // arrival's .then() now runs: activateOnArrival must no-op
    await flush();

    expect(createSpy.mock.calls.length).toBe(1); // still only the one URL ever created
    expect(revokeSpy.mock.calls.length).toBe(0); // the tap's own activation was never torn down

    stageVideo.el.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(3000);
    vi.advanceTimersByTime(200);
    tap(root, 50, 950); // home link: leaves the slide

    expect(createSpy.mock.calls.length).toBe(revokeSpy.mock.calls.length); // every URL revoked
    expect(logs.filter((l) => l.event === 'video_end')).toHaveLength(1); // exactly one
  });

  it('visibilitychange to visible resumes a video an external interruption paused', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck);
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    stageVideo.el.dispatchEvent(new Event('playing'));
    stageVideo.el.dispatchEvent(new Event('pause')); // external pause (screen lock, app switch...)
    await flush();
    const playCallsBefore = (stageVideo.el.play as ReturnType<typeof vi.fn>).mock.calls.length;

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    expect((stageVideo.el.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playCallsBefore + 1);
  });

  it('a home link overlapping a video returns home and logs video_end once (links win over a full-bleed video)', async () => {
    const deck = fakeVideoDeck({ xfrm: { x: 0, y: 0, w: 1920, h: 1080, rot: 0, flipH: false, flipV: false } });
    await makeVideoController(deck);
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y); // -> slide 2
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    stageVideo.el.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(3000);

    vi.advanceTimersByTime(200);
    tap(root, 50, 950); // inside both the home link and the now full-bleed video's bounds

    expect(logs.some((l) => l.event === 'return_home')).toBe(true);
    expect(logs.filter((l) => l.event === 'video_end')).toHaveLength(1);
  });

  it('a tap on the already-active video falls through past the video check: tapAnywhere on returns home', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck, { returnMethods: { homeButton: true, tapAnywhere: true, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    stageVideo.el.dispatchEvent(new Event('playing'));

    vi.advanceTimersByTime(200);
    tap(root, 300, 200); // inside the active video's own bounds (not a corner, no other link there)

    expect(logs.some((l) => l.event === 'return_home')).toBe(true);
  });

  it('a tap on the already-active video with tapAnywhere off does nothing harmful (falls through to a no-op)', async () => {
    const deck = fakeVideoDeck();
    await makeVideoController(deck, { timeoutSec: 5, returnMethods: { homeButton: true, tapAnywhere: false, timeout: true } });
    tap(root, CENTER_BUTTON.x, CENTER_BUTTON.y);
    await flush();
    const stageVideo = lastStage!.videosOn(2)[0];
    stageVideo.el.dispatchEvent(new Event('playing'));

    vi.advanceTimersByTime(200);
    expect(() => tap(root, 300, 200)).not.toThrow();

    expect(logs.some((l) => l.event === 'return_home')).toBe(false);
    expect(stageVideo.el.hasAttribute('src')).toBe(true); // still active, untouched
  });
});

describe('styles.css: kiosk-attract-pulse selector', () => {
  it('never requires .kiosk-root together with .kiosk-attract-pulse on the same element', () => {
    // kiosk-attract-pulse is toggled on the controller's own root (the stage host div inside
    // App's kioskRoot, not kioskRoot itself), so a compound selector like
    // `.kiosk-root.kiosk-attract-pulse ...` would never match in production. Guards against
    // that regression regardless of which rule (or a future one) it might sneak back into.
    const css = fs.readFileSync(path.resolve(__dirname, '../../src/styles.css'), 'utf8');
    expect(css).not.toContain('.kiosk-root.kiosk-attract-pulse');
  });
});
