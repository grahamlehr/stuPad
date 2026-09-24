import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SetupScreen } from '../../src/ui/setup';
import * as render from '../../src/render';
import { stubObjectUrl } from '../render/setup-url';
import { deck, slide } from '../render/helpers';

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
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn() });
    const warningItems = container.querySelectorAll('.issue-group--warning li');
    expect(warningItems.length).toBeGreaterThan(0);
    screen.destroy();
  });
});

describe('SetupScreen: preview lifecycle on re-render', () => {
  it('destroys the previous SlideStage and releases thumbnails on a full re-render', async () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn() });
    await flushMicrotasks();

    const destroySpy = vi.spyOn(render.SlideStage.prototype, 'destroy');
    const releaseSpy = vi.spyOn(render, 'releaseThumbnails');

    // The session-name field goes through the generic `update()` path, which does a full render().
    const nameInput = container.querySelector('[data-step="configure"] input[type="text"]') as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    nameInput.value = 'New name';
    nameInput.dispatchEvent(new Event('input'));
    await flushMicrotasks();

    expect(destroySpy).toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalled();
    screen.destroy();
  });

  it('does not tear down the live preview just to accept warnings', async () => {
    const container = document.createElement('div');
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn() });
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
    const screen = new SetupScreen({ container, initialDeck: makeDeck(), onGoLive: vi.fn() });
    await flushMicrotasks();

    const destroySpy = vi.spyOn(render.SlideStage.prototype, 'destroy');
    const releaseSpy = vi.spyOn(render, 'releaseThumbnails');

    screen.destroy();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});
