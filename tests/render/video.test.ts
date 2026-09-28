import { describe, it, expect, beforeEach } from 'vitest';
import { SlideStage, rasterizeSlide } from '../../src/render';
import { deck, slide, video, pngBlob, mp4Blob } from './helpers';
import { stubObjectUrl } from './setup-url';

beforeEach(() => {
  stubObjectUrl();
});

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540 }),
  });
  document.body.appendChild(el);
  return el;
}

function deckWithVideo(overrides: Parameters<typeof video>[0] = {}) {
  return deck({
    slides: [slide({ index: 1, elements: [video(overrides)] })],
    media: {
      'ppt/media/media1.mp4': { blob: mp4Blob(), mime: 'video/mp4' },
      'ppt/media/image1.png': { blob: pngBlob(), mime: 'image/png' },
    },
  });
}

describe('SlideStage: video element', () => {
  it('builds a <video> once with muted/playsinline/preload/poster and no src', () => {
    const d = deckWithVideo();
    const container = makeContainer();
    const stage = new SlideStage(container, d);

    const videoEl = container.querySelector('video.sr-video') as HTMLVideoElement;
    expect(videoEl).toBeTruthy();
    expect(videoEl.muted).toBe(true);
    expect(videoEl.hasAttribute('muted')).toBe(true);
    expect(videoEl.playsInline).toBe(true);
    expect(videoEl.hasAttribute('playsinline')).toBe(true);
    expect(videoEl.preload).toBe('metadata');
    expect(videoEl.hasAttribute('disablepictureinpicture')).toBe(true);
    expect(videoEl.poster).toContain('blob:mock-');
    expect(videoEl.hasAttribute('src')).toBe(false);
    stage.destroy();
  });

  it('exposes the built video via videosOn(), zipped with its VideoElement def', () => {
    const d = deckWithVideo({ id: 'v42', autoplay: false, loop: true });
    const container = makeContainer();
    const stage = new SlideStage(container, d);

    const videos = stage.videosOn(1);
    expect(videos).toHaveLength(1);
    expect(videos[0].def.id).toBe('v42');
    expect(videos[0].def.autoplay).toBe(false);
    expect(videos[0].def.loop).toBe(true);
    expect(videos[0].el.tagName).toBe('VIDEO');
    stage.destroy();
  });

  it('videosOn() is empty for a slide with no videos', () => {
    const d = deck({ slides: [slide({ index: 1, elements: [] })] });
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    expect(stage.videosOn(1)).toEqual([]);
    stage.destroy();
  });

  it('destroy() revokes the poster object URL', () => {
    const { revoke } = stubObjectUrl();
    const d = deckWithVideo();
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const posterUrl = stage.videosOn(1)[0].el.poster;
    expect(posterUrl).toContain('blob:mock-');

    stage.destroy();

    expect(revoke).toHaveBeenCalledWith(posterUrl);
  });

  it('destroy() also revokes a leftover playback src as defense in depth', () => {
    // In the normal kiosk flow VideoPlayer.destroy() always clears src before the stage is
    // destroyed (see KioskController.stop()); this covers the case where it wasn't, so a
    // stage is always safe to destroy on its own (CLAUDE.md: no leaked object URLs).
    const { revoke } = stubObjectUrl();
    const d = deckWithVideo();
    const container = makeContainer();
    const stage = new SlideStage(container, d);
    const videoEl = stage.videosOn(1)[0].el;
    const activeSrc = URL.createObjectURL(new Blob());
    videoEl.src = activeSrc;

    stage.destroy();

    expect(revoke).toHaveBeenCalledWith(activeSrc);
    expect(videoEl.hasAttribute('src')).toBe(false);
  });
});

describe('rasterizeSlide: video walk', () => {
  it('includes the poster in the media it resolves for the snapshot (does not throw, no video played)', async () => {
    // jsdom cannot actually decode an <img> (see tests/render/stage.test.ts's rasterizeDeck
    // test for the same stub); this just confirms the video branch of collectSlideMediaKeys
    // (which resolves the poster to a data URL before the snapshot) runs without crashing on
    // a slide that has a video, rather than asserting anything about the resulting PNG.
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

    const d = deckWithVideo();
    const result = await rasterizeSlide(d, 1, 100);
    expect(result).toBeNull();

    globalThis.Image = originalImage;
  });
});
