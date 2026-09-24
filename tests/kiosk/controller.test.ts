import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Deck, KioskConfig, LogEvent } from '../../src/types';
import { defaultConfig, SLIDE_W } from '../../src/types';

// -------------------------------------------------------------- mock render

class MockSlideStage {
  current = 1;
  overlay: HTMLElement;
  showCalls: { index: number; transition?: unknown }[] = [];
  destroyed = false;

  constructor(
    public container: HTMLElement,
    public deck: Deck,
  ) {
    this.overlay = document.createElement('div');
    container.appendChild(this.overlay);
  }

  show(index: number, transition?: unknown): Promise<void> {
    this.current = index;
    this.showCalls.push({ index, transition });
    return Promise.resolve();
  }

  toSlide(clientX: number, clientY: number): { px: number; py: number; xPct: number; yPct: number } | null {
    if (clientX < 0 || clientY < 0 || clientX > SLIDE_W || clientY > this.deck.height) return null;
    return { px: clientX, py: clientY, xPct: (clientX / SLIDE_W) * 100, yPct: (clientY / this.deck.height) * 100 };
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
  };
});

// Imported after the mock so KioskController picks up the mocked SlideStage.
const { KioskController } = await import('../../src/kiosk/index');

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
});
