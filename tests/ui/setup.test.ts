import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SetupScreen } from '../../src/ui/setup';
import * as render from '../../src/render';
import * as store from '../../src/store';
import { stubObjectUrl } from '../render/setup-url';
import { deck, slide, video } from '../render/helpers';
import { defaultConfig } from '../../src/types';

const FIXTURES = path.resolve(__dirname, '../fixtures');

async function loadFixtureFile(name: string): Promise<File> {
  const buf = await fs.readFile(path.join(FIXTURES, name));
  return new File([buf], name, {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

beforeEach(() => {
  stubObjectUrl();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function makeDeck() {
  return deck({
    slides: [slide({ index: 1 }), slide({ index: 2 })],
    buttons: [
      { id: 'b1', shapeName: 'BTN_A', text: 'A', defaultLabel: 'A', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
      { id: 'b2', shapeName: 'BTN_B', text: 'B', defaultLabel: 'B', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
    ],
    homeLinks: [], // no home link back from slide 2 -> a no_home_link warning
  });
}

describe('SetupScreen: re-validation of a stored deck', () => {
  it('shows warnings for a stored deck without needing the original file bytes', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    const warningItems = container.querySelectorAll('.issue-group--warning li');
    expect(warningItems.length).toBeGreaterThan(0);
    screen.destroy();
  });
});

describe('SetupScreen: Check step video size (feature H)', () => {
  it('shows the total video size when the deck has an embedded video', () => {
    const bytes = 2 * 1024 * 1024;
    const d = deck({
      slides: [
        slide({
          index: 1,
          elements: [video({ id: 'v1', mediaKey: 'ppt/media/media1.mp4', posterKey: 'ppt/media/image1.png' })],
        }),
        slide({ index: 2 }),
      ],
      buttons: [
        { id: 'b1', shapeName: 'BTN_A', text: 'A', defaultLabel: 'A', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
        { id: 'b2', shapeName: 'BTN_B', text: 'B', defaultLabel: 'B', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
      ],
      media: {
        'ppt/media/media1.mp4': { blob: new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), mime: 'video/mp4' },
        'ppt/media/image1.png': { blob: new Blob([new Uint8Array(10)], { type: 'image/png' }), mime: 'image/png' },
      },
    });
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: d, onGoLive: vi.fn(), onClearAll: vi.fn() });
    const checkStep = container.querySelector('[data-step="check"]') as HTMLElement;
    expect(checkStep.textContent).toContain('Total video size');
    expect(checkStep.textContent).toContain('2.0 MB');
    screen.destroy();
  });

  it('shows nothing about video size for a deck with no videos', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    const checkStep = container.querySelector('[data-step="check"]') as HTMLElement;
    expect(checkStep.textContent).not.toContain('Total video size');
    screen.destroy();
  });
});

describe('SetupScreen: preview lifecycle on re-render', () => {
  it('destroys the previous SlideStage and releases thumbnails on a full re-render', async () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    await flushMicrotasks();

    const destroySpy = vi.spyOn(render.SlideStage.prototype, 'destroy');
    const releaseSpy = vi.spyOn(render, 'releaseThumbnails');

    // Selects go through the generic `update()` path, which does a full render().
    const selects = container.querySelectorAll<HTMLSelectElement>('[data-step="configure"] select');
    const transitionSelect = Array.from(selects).find((s) => Array.from(s.options).some((o) => o.value === 'fade'))!;
    expect(transitionSelect).toBeTruthy();
    transitionSelect.value = 'none';
    transitionSelect.dispatchEvent(new Event('change'));
    await flushMicrotasks();

    expect(destroySpy).toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalled();
    screen.destroy();
  });

  it('does not tear down the live preview just to accept warnings', async () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    await flushMicrotasks();

    const destroySpy = vi.spyOn(render.SlideStage.prototype, 'destroy');
    const releaseSpy = vi.spyOn(render, 'releaseThumbnails');

    const checkbox = container.querySelector('.issue-group--warning input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    expect(destroySpy).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
    screen.destroy();
  });

  it('destroy() itself tears down the preview exactly once', async () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    await flushMicrotasks();

    const destroySpy = vi.spyOn(render.SlideStage.prototype, 'destroy');
    const releaseSpy = vi.spyOn(render, 'releaseThumbnails');

    screen.destroy();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SetupScreen: typing in Configure text fields', () => {
  function mount() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    const cleanup = () => {
      screen.destroy();
      container.remove();
    };
    return { container, cleanup };
  }

  function goLiveButton(container: HTMLElement): HTMLButtonElement {
    return container.querySelector('[data-step="golive"] button') as HTMLButtonElement;
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('keeps the focused session-name input and saves the config', async () => {
    vi.useFakeTimers();
    const { container, cleanup } = mount();
    try {
      const saveConfig = vi.spyOn(store, 'saveConfig').mockResolvedValue();
      vi.spyOn(store, 'saveDeck').mockResolvedValue();
      const nameInput = container.querySelector('[data-step="configure"] input[type="text"]') as HTMLInputElement;
      nameInput.focus();
      expect(document.activeElement).toBe(nameInput);

      type(nameInput, 'Booth A');
      type(nameInput, 'Booth AB');

      expect(nameInput.isConnected).toBe(true);
      expect(document.activeElement).toBe(nameInput);
      expect(container.querySelector('[data-step="configure"] input[type="text"]')).toBe(nameInput);

      vi.advanceTimersByTime(1000);
      expect(saveConfig).toHaveBeenCalledTimes(1);
      expect(saveConfig.mock.calls[0][0].sessionName).toBe('Booth AB');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('keeps the focused device-name input', () => {
    const { container, cleanup } = mount();
    const deviceInput = container.querySelector('[data-step="configure"] input[placeholder="e.g. Stand A"]') as HTMLInputElement;
    deviceInput.focus();
    type(deviceInput, 'Stand C');
    expect(deviceInput.isConnected).toBe(true);
    expect(document.activeElement).toBe(deviceInput);
    cleanup();
  });

  it('does not tear down the live preview while typing', async () => {
    const { container, cleanup } = mount();
    await flushMicrotasks();
    const destroySpy = vi.spyOn(render.SlideStage.prototype, 'destroy');
    const releaseSpy = vi.spyOn(render, 'releaseThumbnails');

    type(container.querySelector('[data-step="configure"] input[type="text"]') as HTMLInputElement, 'Typed');
    await flushMicrotasks();

    expect(destroySpy).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
    cleanup();
  });

  it('disables Go live and shows the error when the session name is emptied, and re-enables it', () => {
    const { container, cleanup } = mount();
    // The test deck has warnings; accept them so only the config decides Go live.
    const accept = container.querySelector('.issue-group--warning input[type="checkbox"]') as HTMLInputElement;
    accept.checked = true;
    accept.dispatchEvent(new Event('change'));
    expect(goLiveButton(container).disabled).toBe(false);

    const nameInput = container.querySelector('[data-step="configure"] input[type="text"]') as HTMLInputElement;
    type(nameInput, '');
    expect(goLiveButton(container).disabled).toBe(true);
    expect(container.querySelector('[data-step="configure"] .config-errors')?.textContent).toContain(
      'Session name is required.',
    );

    type(nameInput, 'Back again');
    expect(goLiveButton(container).disabled).toBe(false);
    expect(container.querySelector('[data-step="configure"] .config-errors')?.textContent).toBe('');
    cleanup();
  });

  it('updates the preview outline label in place as a button label is typed', async () => {
    const { container, cleanup } = mount();
    await flushMicrotasks();
    const labelInput = container.querySelectorAll<HTMLInputElement>('[data-step="configure"] .field-list input[type="text"]')[0];
    const outline = container.querySelector<HTMLElement>('.preview-stage .preview-btn-outline[data-button-id="b1"]')!;
    expect(outline).toBeTruthy();

    type(labelInput, 'Alpha');

    expect(outline.isConnected).toBe(true);
    expect(outline.querySelector('.preview-btn-label')?.textContent).toBe('Alpha');
    expect(container.querySelectorAll<HTMLInputElement>('[data-step="configure"] .field-list input[type="text"]')[0]).toBe(labelInput);
    cleanup();
  });
});

describe('SetupScreen: clear previous data', () => {
  it('shows a Clear previous data button in the Load step', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    const btn = container.querySelector('[data-step="load"] .clear-data-btn');
    expect(btn?.textContent).toBe('Clear previous data');
    screen.destroy();
  });

  it('destroy() cancels a pending autosave so a wiped deck is not saved again', async () => {
    vi.useFakeTimers();
    try {
      const saveDeck = vi.spyOn(store, 'saveDeck').mockResolvedValue();
      const saveConfig = vi.spyOn(store, 'saveConfig').mockResolvedValue();
      const container = document.createElement('div');
      const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });

      // Any Configure edit schedules a debounced save.
      const nameInput = container.querySelector('[data-step="configure"] input[type="text"]') as HTMLInputElement;
      nameInput.value = 'Edited';
      nameInput.dispatchEvent(new Event('input'));
      screen.destroy();
      vi.advanceTimersByTime(1000);

      expect(saveDeck).not.toHaveBeenCalled();
      expect(saveConfig).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SetupScreen: device name field', () => {
  function deviceNameInput(container: HTMLElement): HTMLInputElement {
    return container.querySelector('[data-step="configure"] input[placeholder="e.g. Stand A"]') as HTMLInputElement;
  }

  it('shows the stored device name and saves an edit', () => {
    vi.useFakeTimers();
    try {
      const saveConfig = vi.spyOn(store, 'saveConfig').mockResolvedValue();
      const container = document.createElement('div');
      const initialConfig = { ...defaultConfig('deck.pptx'), deviceName: 'Stand A' };
      const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });

      expect(deviceNameInput(container).value).toBe('Stand A');

      deviceNameInput(container).value = 'Stand B';
      deviceNameInput(container).dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(400);

      expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ deviceName: 'Stand B' }));
      screen.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is empty by default', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    expect(deviceNameInput(container).value).toBe('');
    screen.destroy();
  });

  it('carries the device name over when loading a new deck, unlike every other setting', async () => {
    vi.spyOn(store, 'saveDeck').mockResolvedValue();
    vi.spyOn(store, 'saveConfig').mockResolvedValue();
    const container = document.createElement('div');
    const initialConfig = { ...defaultConfig('deck.pptx'), deviceName: 'Stand A', sessionName: 'Old session' };
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });

    const file = await loadFixtureFile('good.pptx');
    // loadFile is private; called directly (as the file input's onchange does) so the test
    // can await its completion instead of racing real zip-parsing microtasks via a DOM event.
    await (screen as unknown as { loadFile: (f: File) => Promise<void> }).loadFile(file);

    // Every other setting resets to defaultConfig(fileName): session name changes...
    const sessionNameInput = container.querySelector('[data-step="configure"] input[type="text"]') as HTMLInputElement;
    expect(sessionNameInput.value).not.toBe('Old session');
    // ...but the device name, which describes the iPad rather than the deck, survives.
    expect(deviceNameInput(container).value).toBe('Stand A');

    screen.destroy();
  });
});

describe('SetupScreen: secret exit sequence hint', () => {
  function hintText(container: HTMLElement): string | null | undefined {
    return container.querySelector('[data-step="configure"] p.muted')?.textContent;
  }

  it('describes the default pattern (corners clockwise) and window', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    expect(hintText(container)).toBe(
      'Tap top-left, top-right, bottom-right, then bottom-left, within 5 seconds, on any slide.',
    );
    screen.destroy();
  });

  it('describes the tl3_br2 pattern distinctly from the four-corner patterns', () => {
    const container = document.createElement('div');
    const initialConfig = { ...defaultConfig('deck.pptx'), secretPattern: 'tl3_br2' as const };
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });
    expect(hintText(container)).toBe(
      'Tap top-left three times, then bottom-right twice, within 5 seconds, on any slide.',
    );
    screen.destroy();
  });

  it('updates live when the pattern select changes', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });

    const selects = container.querySelectorAll<HTMLSelectElement>('[data-step="configure"] select');
    const patternSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === 'corners_ccw'),
    )!;
    patternSelect.value = 'corners_ccw';
    patternSelect.dispatchEvent(new Event('change'));

    expect(hintText(container)).toBe(
      'Tap top-left, bottom-left, bottom-right, then top-right, within 5 seconds, on any slide.',
    );
    screen.destroy();
  });

  it('updates live when the window select changes', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });

    const selects = container.querySelectorAll<HTMLSelectElement>('[data-step="configure"] select');
    const windowSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === '8000'),
    )!;
    windowSelect.value = '8000';
    windowSelect.dispatchEvent(new Event('change'));

    expect(hintText(container)).toBe(
      'Tap top-left, top-right, bottom-right, then bottom-left, within 8 seconds, on any slide.',
    );
    screen.destroy();
  });

  it('shows a stored out-of-list window value rather than silently changing it', () => {
    const container = document.createElement('div');
    const initialConfig = { ...defaultConfig('deck.pptx'), secretWindowMs: 6000 };
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });

    const selects = container.querySelectorAll<HTMLSelectElement>('[data-step="configure"] select');
    const windowSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === '6000'),
    );
    expect(windowSelect?.value).toBe('6000');
    expect(hintText(container)).toBe(
      'Tap top-left, top-right, bottom-right, then bottom-left, within 6 seconds, on any slide.',
    );
    screen.destroy();
  });
});

describe('SetupScreen: transition length control', () => {
  it('shows the length select only when transition is fade', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });

    let selects = container.querySelectorAll<HTMLSelectElement>('[data-step="configure"] select');
    let msSelect = Array.from(selects).find((s) => Array.from(s.options).some((o) => o.value === '300'));
    expect(msSelect).toBeTruthy();

    const transitionSelect = Array.from(selects).find(
      (s) => Array.from(s.options).some((o) => o.value === 'none') && Array.from(s.options).some((o) => o.value === 'fade'),
    )!;
    transitionSelect.value = 'none';
    transitionSelect.dispatchEvent(new Event('change'));

    selects = container.querySelectorAll<HTMLSelectElement>('[data-step="configure"] select');
    msSelect = Array.from(selects).find((s) => Array.from(s.options).some((o) => o.value === '300'));
    expect(msSelect).toBeUndefined();
    screen.destroy();
  });

  it('shows a stored out-of-list transitionMs value rather than silently changing it', () => {
    const container = document.createElement('div');
    const initialConfig = { ...defaultConfig('deck.pptx'), transitionMs: 275 };
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });

    const selects = container.querySelectorAll<HTMLSelectElement>('[data-step="configure"] select');
    const msSelect = Array.from(selects).find((s) => Array.from(s.options).some((o) => o.value === '275'));
    expect(msSelect?.value).toBe('275');
    screen.destroy();
  });
});

describe('SetupScreen: button glow settings', () => {
  it('shows only the on/off switch while the glow is off', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    expect(container.querySelector('.glow-fields input[type="checkbox"]')).toBeTruthy();
    expect(container.querySelector('.glow-swatches')).toBeNull();
    screen.destroy();
  });

  it('shows swatches and sliders when on, and the sliders restyle the preview glow in place', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const initialConfig = { ...defaultConfig('deck.pptx'), glow: { enabled: true, color: '#ffc400', intensity: 5, periodMs: 2000 } };
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });
    await flushMicrotasks();

    expect(container.querySelector('.glow-swatch--selected')?.getAttribute('aria-label')).toBe('Gold');
    const layer = container.querySelector<HTMLElement>('.preview-stage .kiosk-glow-layer')!;
    expect(layer.querySelectorAll('.kiosk-glow')).toHaveLength(2);

    const destroySpy = vi.spyOn(render.SlideStage.prototype, 'destroy');
    const speed = container.querySelector<HTMLInputElement>('input[aria-label="Glow speed"]')!;
    speed.value = '3500'; // mirrored: fast end -> 1000 ms per pulse
    speed.dispatchEvent(new Event('input'));

    expect(layer.style.getPropertyValue('--glow-half-period')).toBe('500ms');
    expect(container.querySelector('.preview-stage .kiosk-glow-layer')).toBe(layer); // not rebuilt
    expect(destroySpy).not.toHaveBeenCalled();
    screen.destroy();
    container.remove();
  });
});

describe('SetupScreen: attract loop settings', () => {
  it('shows only the on/off switch while attract is off (the default)', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    expect(container.querySelector('.attract-fields input[type="checkbox"]')).toBeTruthy();
    expect(container.querySelector('.attract-slide-grid')).toBeNull();
    screen.destroy();
  });

  it('shows idle time, mode and a checkbox per other slide in cycle mode when on', () => {
    const container = document.createElement('div');
    const initialConfig = {
      ...defaultConfig('deck.pptx'),
      attract: { enabled: true, idleSec: 60, mode: 'cycle' as const, slides: [], slideSec: 6 },
    };
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });

    // makeDeck() has slides 1 and 2; Home (1) is never a checkbox, so exactly one is shown.
    const checks = container.querySelectorAll('.attract-slide-grid .attract-slide-check');
    expect(checks).toHaveLength(1);
    screen.destroy();
  });

  it('hides the slide checkboxes in pulse mode', () => {
    const container = document.createElement('div');
    const initialConfig = {
      ...defaultConfig('deck.pptx'),
      attract: { enabled: true, idleSec: 60, mode: 'pulse' as const, slides: [], slideSec: 6 },
    };
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });
    expect(container.querySelector('.attract-slide-grid')).toBeNull();
    screen.destroy();
  });

  it('checking a slide saves it into config.attract.slides', () => {
    vi.useFakeTimers();
    try {
      const saveConfig = vi.spyOn(store, 'saveConfig').mockResolvedValue();
      const container = document.createElement('div');
      const initialConfig = {
        ...defaultConfig('deck.pptx'),
        attract: { enabled: true, idleSec: 60, mode: 'cycle' as const, slides: [], slideSec: 6 },
      };
      const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });

      const checkbox = container.querySelector<HTMLInputElement>('.attract-slide-check input[type="checkbox"]')!;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
      vi.advanceTimersByTime(400);

      expect(saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ attract: expect.objectContaining({ slides: [2] }) }),
      );
      screen.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loading a new deck resets attract to the default, unlike deviceName', async () => {
    vi.spyOn(store, 'saveDeck').mockResolvedValue();
    vi.spyOn(store, 'saveConfig').mockResolvedValue();
    const container = document.createElement('div');
    const initialConfig = {
      ...defaultConfig('deck.pptx'),
      deviceName: 'Stand A',
      attract: { enabled: true, idleSec: 30, mode: 'pulse' as const, slides: [2], slideSec: 4 },
    };
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });

    const file = await loadFixtureFile('good.pptx');
    await (screen as unknown as { loadFile: (f: File) => Promise<void> }).loadFile(file);

    // Attract is deck-specific, so it resets to off, unlike deviceName (which survives).
    const attractToggle = container.querySelector<HTMLInputElement>('.attract-fields input[type="checkbox"]')!;
    expect(attractToggle.checked).toBe(false);
    screen.destroy();
  });
});

describe('SetupScreen: poll labels', () => {
  function makePollDeck() {
    return deck({
      slides: [slide({ index: 1 }), slide({ index: 2 })],
      buttons: [
        { id: 'b1', shapeName: 'BTN_A', text: 'A', defaultLabel: 'A', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
        { id: 'b2', shapeName: 'BTN_B', text: 'B', defaultLabel: 'B', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
      ],
      homeLinks: [{ slide: 2, id: 'h1', bounds: { x: 0, y: 0, w: 50, h: 50 } }],
      pollOptions: [
        {
          slide: 1,
          id: 'v1',
          shapeName: 'VOTE_Mood_Happy',
          poll: 'Mood',
          choice: 'Happy',
          kind: 'vote' as const,
          label: 'Happy',
          bounds: { x: 400, y: 400, w: 100, h: 60 },
          linked: false,
        },
        {
          slide: 1,
          id: 'v2',
          shapeName: 'VOTE_Mood_Sad',
          poll: 'Mood',
          choice: 'Sad',
          kind: 'vote' as const,
          label: 'Sad',
          bounds: { x: 500, y: 400, w: 100, h: 60 },
          linked: false,
        },
      ],
    });
  }

  it('does not show a "Poll labels" section for a deck with no poll options', () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    const headings = Array.from(container.querySelectorAll('[data-step="configure"] h3')).map((h) => h.textContent);
    expect(headings).not.toContain('Poll labels');
    screen.destroy();
  });

  it('lists each poll option with its default label, and saves an admin rename', () => {
    vi.useFakeTimers();
    try {
      const saveConfig = vi.spyOn(store, 'saveConfig').mockResolvedValue();
      const container = document.createElement('div');
      const screen = new SetupScreen({ container, initialDeck: makePollDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });

      const headings = Array.from(container.querySelectorAll('[data-step="configure"] h3')).map((h) => h.textContent);
      expect(headings).toContain('Poll labels');

      const inputs = Array.from(
        container.querySelectorAll<HTMLInputElement>('[data-step="configure"] .field-list input[type="text"]'),
      );
      const happyInput = inputs.find((i) => i.value === 'Happy');
      expect(happyInput).toBeTruthy();

      happyInput!.value = 'Delighted';
      happyInput!.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(400);

      expect(saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ pollLabels: expect.objectContaining({ ['Mood\u0000Happy']: 'Delighted' }) }),
      );
      screen.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the preview outline label in place as a poll label is typed, without a full re-render', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const saveConfig = vi.spyOn(store, 'saveConfig').mockResolvedValue();
      const screen = new SetupScreen({ container, initialDeck: makePollDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
      await flushMicrotasks();

      const inputs = Array.from(
        container.querySelectorAll<HTMLInputElement>('[data-step="configure"] .field-list input[type="text"]'),
      );
      const happyInput = inputs.find((i) => i.value === 'Happy')!;
      expect(happyInput).toBeTruthy();

      // The preview is already showing slide 1 (the deck's Home poll option's own slide).
      const outline = container.querySelector<HTMLElement>('.preview-stage .preview-poll-outline')!;
      expect(outline).toBeTruthy();
      expect(outline.querySelector('.preview-btn-label')?.textContent).toBe('Mood: Happy');

      happyInput.value = 'Delighted';
      happyInput.dispatchEvent(new Event('input'));

      // Same input, same outline element: a typed edit refreshes only errors/Go-live, not a
      // full render (which would replace the focused input and remount the preview).
      expect(happyInput.isConnected).toBe(true);
      expect(outline.isConnected).toBe(true);
      expect(outline.querySelector('.preview-btn-label')?.textContent).toBe('Mood: Delighted');
      expect(
        container.querySelectorAll<HTMLInputElement>('[data-step="configure"] .field-list input[type="text"]')[
          inputs.indexOf(happyInput)
        ],
      ).toBe(happyInput);

      vi.advanceTimersByTime(400);
      expect(saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ pollLabels: expect.objectContaining({ ['Mood\u0000Happy']: 'Delighted' }) }),
      );
      screen.destroy();
    } finally {
      container.remove();
      vi.useRealTimers();
    }
  });

  it('shows an admin-renamed label from initialConfig.pollLabels', () => {
    const container = document.createElement('div');
    const initialConfig = { ...defaultConfig('deck.pptx'), pollLabels: { ['Mood\u0000Sad']: 'Unhappy' } };
    const screen = new SetupScreen({ container, initialDeck: makePollDeck(), initialConfig, onGoLive: vi.fn(), onClearAll: vi.fn() });
    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('[data-step="configure"] .field-list input[type="text"]'),
    );
    expect(inputs.some((i) => i.value === 'Unhappy')).toBe(true);
    screen.destroy();
  });
});

describe('SetupScreen: preview outlines poll options', () => {
  function makePollDeck() {
    return deck({
      slides: [slide({ index: 1 })],
      buttons: [
        { id: 'b1', shapeName: 'BTN_A', text: 'A', defaultLabel: 'A', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
        { id: 'b2', shapeName: 'BTN_B', text: 'B', defaultLabel: 'B', targetSlide: 2, bounds: { x: 0, y: 0, w: 200, h: 200 } },
      ],
      pollOptions: [
        {
          slide: 1,
          id: 'v1',
          shapeName: 'VOTE_Mood_Happy',
          poll: 'Mood',
          choice: 'Happy',
          kind: 'vote' as const,
          label: 'Happy',
          bounds: { x: 400, y: 400, w: 100, h: 60 },
          linked: false,
        },
      ],
    });
  }

  it('outlines a poll option distinctly (dashed) and labels it "poll: label"', async () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makePollDeck(), onGoLive: vi.fn(), onClearAll: vi.fn() });
    await flushMicrotasks();

    const outline = container.querySelector('.preview-poll-outline');
    expect(outline).toBeTruthy();
    expect(outline?.querySelector('.preview-btn-label')?.textContent).toBe('Mood: Happy');
    screen.destroy();
  });
});
