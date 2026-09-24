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

/** A layer counts as "showing" once it's opacity 1 + visibility visible (what a viewer sees). */
function isShowing(el: Element): boolean {
  const style = (el as HTMLElement).style;
  return style.visibility === 'visible' && style.opacity === '1';
}

describe('show() / current', () => {
  it('mounts every slide layer once and never removes/re-appends it', async () => {
    const d = deck({
      slides: [slide({ index: 1 }), slide({ index: 2 }), slide({ index: 3 })],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    expect(stage.current).toBe(1);
    const layers = container.querySelectorAll('.sr-slide-layer');
    expect(layers.length).toBe(3);

    await stage.show(2, { type: 'none', ms: 0 });
    expect(stage.current).toBe(2);

    // All layers stay connected to the DOM across show() calls (never torn down/rebuilt);
    // exactly one is visible at a time under a 'none' transition.
    expect(Array.from(container.querySelectorAll('.sr-slide-layer')).every((l) => l.isConnected)).toBe(
      true
    );
    const showing = Array.from(layers).filter(isShowing);
    expect(showing.length).toBe(1);
    stage.destroy();
  });

  it('stacks every layer at the slide origin (not position: relative from .sr-slide)', () => {
    const d = deck({ slides: [slide({ index: 1 }), slide({ index: 2 })] });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    for (const layer of Array.from(container.querySelectorAll<HTMLElement>('.sr-slide-layer'))) {
      const cs = getComputedStyle(layer);
      expect(cs.position).toBe('absolute');
      expect(cs.top).toBe('0px');
    }
    stage.destroy();
  });

  it('show(current) while not fading is a no-op', async () => {
    const d = deck({ slides: [slide({ index: 1 }), slide({ index: 2 })] });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const layers = container.querySelectorAll('.sr-slide-layer');

    await stage.show(1, { type: 'none', ms: 0 });
    expect(stage.current).toBe(1);
    expect(Array.from(layers).filter(isShowing).length).toBe(1);
    stage.destroy();
  });

  it("'none' transition swaps the visible layer immediately", async () => {
    const d = deck({ slides: [slide({ index: 1 }), slide({ index: 2 })] });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const layers = Array.from(container.querySelectorAll('.sr-slide-layer'));

    await stage.show(2, { type: 'none', ms: 0 });
    expect(isShowing(layers[0])).toBe(false);
    expect(isShowing(layers[1])).toBe(true);
    stage.destroy();
  });

  it('cross-fades with fade transition and resolves after ms', async () => {
    vi.useFakeTimers();
    const d = deck({ slides: [slide({ index: 1 }), slide({ index: 2 })] });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const layers = Array.from(container.querySelectorAll('.sr-slide-layer'));

    const p = stage.show(2, { type: 'fade', ms: 300 });
    // Mid-fade: outgoing layer (slide 1) stays fully opaque underneath while the incoming
    // layer (slide 2) is on top starting from opacity 0 -- never both semi-transparent.
    expect(layers[0].isConnected).toBe(true);
    expect(layers[1].isConnected).toBe(true);
    expect((layers[0] as HTMLElement).style.opacity).toBe('1');
    expect(Number((layers[1] as HTMLElement).style.zIndex)).toBeGreaterThan(
      Number((layers[0] as HTMLElement).style.zIndex)
    );

    await vi.advanceTimersByTimeAsync(300);
    await p;

    // Settled: exactly one layer showing, the outgoing one fully hidden.
    expect(isShowing(layers[0])).toBe(false);
    expect(isShowing(layers[1])).toBe(true);
    expect((layers[0] as HTMLElement).style.pointerEvents).toBe('none');
    expect(stage.current).toBe(2);
    stage.destroy();
    vi.useRealTimers();
  });

  it("'none' transition interrupts an in-flight fade immediately", async () => {
    vi.useFakeTimers();
    const d = deck({ slides: [slide({ index: 1 }), slide({ index: 2 })] });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const layers = Array.from(container.querySelectorAll('.sr-slide-layer'));

    void stage.show(2, { type: 'fade', ms: 300 });
    await vi.advanceTimersByTimeAsync(50); // mid-fade, not settled

    await stage.show(1, { type: 'none', ms: 0 });
    expect(stage.current).toBe(1);
    expect(isShowing(layers[0])).toBe(true);
    expect(isShowing(layers[1])).toBe(false);
    // No leftover transition/will-change from the interrupted fade.
    expect((layers[0] as HTMLElement).style.transition).toBe('');
    expect((layers[1] as HTMLElement).style.willChange).toBe('');
    stage.destroy();
    vi.useRealTimers();
  });

  it('an interrupted fade (rapid multi-slide nav) leaves exactly one visible layer after settling', async () => {
    vi.useFakeTimers();
    const d = deck({
      slides: [slide({ index: 1 }), slide({ index: 2 }), slide({ index: 3 })],
    });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const layers = Array.from(container.querySelectorAll('.sr-slide-layer'));

    void stage.show(2, { type: 'fade', ms: 300 });
    await vi.advanceTimersByTimeAsync(50); // interrupt slide 1 -> 2 mid-fade
    const p = stage.show(3, { type: 'fade', ms: 300 });
    expect(stage.current).toBe(3);
    // The interrupted fade settled instantly: slide 1 hidden, slide 2 was briefly fully
    // visible before slide 3's fade started on top of it.
    expect(isShowing(layers[0])).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    await p;

    const showing = layers.filter(isShowing);
    expect(showing.length).toBe(1);
    expect(isShowing(layers[2])).toBe(true);
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
