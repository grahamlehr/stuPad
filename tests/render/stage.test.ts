import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlideStage, renderThumbnail, releaseThumbnails, rasterizeDeck } from '../../src/render';
import { SLIDE_W } from '../../src/types';
import { deck, slide, shape, pngBlob } from './helpers';
import { stubObjectUrl } from './setup-url';

beforeEach(() => {
  stubObjectUrl();
});

function makeContainer(width = 960, height = 540): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ width, height, left: 0, top: 0, right: width, bottom: height }),
  });
  document.body.appendChild(el);
  return el;
}

describe('toSlide()', () => {
  it('inverts the fit transform for a point inside the slide', () => {
    // deck.height = 1080 (16:9), container 960x540 -> scale = min(960/1920, 540/1080) = 0.5
    // offsetX = (960 - 1920*0.5)/2 = 0, offsetY = (540 - 1080*0.5)/2 = 0
    const d = deck();
    const container = makeContainer(960, 540);
    const stage = new SlideStage(container, d);
    const p = stage.toSlide(480, 270); // center of viewport
    expect(p).not.toBeNull();
    expect(p!.px).toBeCloseTo(960, 0);
    expect(p!.py).toBeCloseTo(540, 0);
    expect(p!.xPct).toBeCloseTo(50, 0);
    expect(p!.yPct).toBeCloseTo(50, 0);
    stage.destroy();
  });

  it('returns null for a point in the letterbox', () => {
    // wide container: 1000x400 -> scale limited by height: 400/1080 = 0.370...
    // scaled slide width = 1920*0.370 ~= 711, offsetX = (1000-711)/2 ~= 144
    const d = deck();
    const container = makeContainer(1000, 400);
    const stage = new SlideStage(container, d);
    const p = stage.toSlide(5, 5); // near top-left corner, inside letterbox
    expect(p).toBeNull();
    stage.destroy();
  });
});

describe('show() / current', () => {
  it('switches visible slide and toggles connection to the DOM', async () => {
    const d = deck({
      slides: [slide({ index: 1 }), slide({ index: 2 }), slide({ index: 3 })],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    expect(stage.current).toBe(1);

    await stage.show(2, { type: 'none', ms: 0 });
    expect(stage.current).toBe(2);

    const layers = container.querySelectorAll('.sr-slide-layer');
    // only the current slide should remain mounted after a 'none' transition
    const mountedCount = Array.from(layers).filter((l) => l.isConnected).length;
    expect(mountedCount).toBe(1);
    stage.destroy();
  });

  it('cross-fades with fade transition and resolves after ms', async () => {
    vi.useFakeTimers();
    const d = deck({ slides: [slide({ index: 1 }), slide({ index: 2 })] });
    const container = makeContainer();
    const stage = new SlideStage(container, d);

    const p = stage.show(2, { type: 'fade', ms: 300 });
    // both layers connected mid-fade
    let connected = Array.from(container.querySelectorAll('.sr-slide-layer')).filter((l) => l.isConnected);
    expect(connected.length).toBe(2);

    await vi.advanceTimersByTimeAsync(300);
    await p;

    connected = Array.from(container.querySelectorAll('.sr-slide-layer')).filter((l) => l.isConnected);
    expect(connected.length).toBe(1);
    expect(stage.current).toBe(2);
    stage.destroy();
    vi.useRealTimers();
  });
});

describe('destroy()', () => {
  it('revokes every object URL it created', () => {
    const { revoke } = stubObjectUrl();
    const d = deck({
      media: { 'img/1.png': { blob: pngBlob(), mime: 'image/png' } },
      slides: [
        slide({
          elements: [
            shape({ id: '1', fill: { type: 'image', mediaKey: 'img/1.png', mode: 'stretch' } }),
          ],
        }),
      ],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    stage.destroy();
    expect(revoke).toHaveBeenCalled();
  });

  it('disconnects the ResizeObserver and removes the scaler from the DOM', () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    class FakeRO {
      observe = observe;
      disconnect = disconnect;
    }
    // @ts-expect-error test stub
    globalThis.ResizeObserver = FakeRO;

    const d = deck();
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    expect(observe).toHaveBeenCalledWith(container);
    stage.destroy();
    expect(disconnect).toHaveBeenCalled();
    expect(container.children.length).toBe(0);
  });
});

describe('renderThumbnail', () => {
  it('scales the slide to the requested width and keeps aspect', () => {
    const d = deck();
    const el = renderThumbnail(d, 1, 192);
    expect(el.style.width).toBe('192px');
    const expectedHeight = Math.round(d.height * (192 / SLIDE_W));
    expect(el.style.height).toBe(`${expectedHeight}px`);
    releaseThumbnails();
  });

  it('releaseThumbnails revokes cached object URLs', () => {
    const { revoke } = stubObjectUrl();
    const d = deck({
      media: { 'img/1.png': { blob: pngBlob(), mime: 'image/png' } },
      slides: [
        slide({
          elements: [
            shape({ id: '1', fill: { type: 'image', mediaKey: 'img/1.png', mode: 'stretch' } }),
          ],
        }),
      ],
    });
    renderThumbnail(d, 1, 100);
    releaseThumbnails();
    expect(revoke).toHaveBeenCalled();
  });
});

describe('raster mode', () => {
  it('SlideStage shows the raster PNG when useRaster is set and slide.rasterKey exists', () => {
    const d = deck({
      media: { 'raster/1.png': { blob: pngBlob(), mime: 'image/png' } },
      slides: [slide({ index: 1, rasterKey: 'raster/1.png' })],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d, { useRaster: true });
    const img = container.querySelector('.sr-slide img.sr-full-img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain('blob:mock');
    stage.destroy();
  });
});

describe('rasterizeDeck', () => {
  it('does not mutate the input deck and leaves rasterKey unset when the canvas snapshot fails', async () => {
    // jsdom cannot actually decode an <img>, so stub Image to fail fast (asynchronously,
    // like a real decode failure would) and verify the per-slide try/catch swallows it,
    // leaving that slide without a rasterKey rather than rejecting the whole deck.
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onerror && this.onerror(), 0);
      }
    }
    const originalImage = globalThis.Image;
    // @ts-expect-error test stub
    globalThis.Image = FailingImage;

    const d = deck({ slides: [slide({ index: 1 })] });
    const result = await rasterizeDeck(d, 100);
    expect(result).not.toBe(d);
    expect(d.slides[0].rasterKey).toBeUndefined();
    expect(result.slides[0].rasterKey).toBeUndefined();

    globalThis.Image = originalImage;
  });
});
