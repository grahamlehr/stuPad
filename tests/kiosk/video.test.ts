import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VideoPlayer } from '../../src/kiosk/video';
import type { VideoLogCtx } from '../../src/kiosk/video';
import type { Deck, VideoElement, MediaItem } from '../../src/types';
import type { SlideStage, StageVideo } from '../../src/render';
import { stubObjectUrl } from '../render/setup-url';

beforeEach(() => {
  stubObjectUrl();
});

// ------------------------------------------------------------------- helpers

/** A real jsdom <video> with play/pause/load stubbed (jsdom's own implementations just log
 * "not implemented" and no-op / return undefined, per CLAUDE.md's "stub play, pause, load and
 * dispatch events manually" test guidance). `play` defaults to resolving immediately. */
function stubVideoEl(playImpl: () => Promise<void> = () => Promise.resolve()): HTMLVideoElement {
  const el = document.createElement('video');
  el.play = vi.fn(playImpl);
  el.pause = vi.fn();
  el.load = vi.fn();
  return el;
}

function videoDef(overrides: Partial<VideoElement> = {}): VideoElement {
  return {
    kind: 'video',
    id: overrides.id ?? 'v1',
    name: overrides.name ?? 'Video 1',
    xfrm: { x: 0, y: 0, w: 100, h: 100, rot: 0, flipH: false, flipV: false },
    mediaKey: overrides.mediaKey ?? 'ppt/media/media1.mp4',
    posterKey: overrides.posterKey ?? 'ppt/media/image1.png',
    loop: overrides.loop ?? false,
    autoplay: overrides.autoplay ?? true,
    ...overrides,
  };
}

function stageVideo(overrides: Partial<VideoElement> = {}, playImpl?: () => Promise<void>): StageVideo {
  return { el: stubVideoEl(playImpl), def: videoDef(overrides) };
}

/** Minimal fake SlideStage: only `videosOn` is ever called by VideoPlayer. */
function fakeStage(bySlide: Record<number, StageVideo[]>): SlideStage {
  return { videosOn: (slide: number) => bySlide[slide] ?? [] } as unknown as SlideStage;
}

function fakeDeck(media: Record<string, MediaItem> = { 'ppt/media/media1.mp4': mediaItem() }): Deck {
  return {
    id: 'd1',
    fileName: 'video.pptx',
    parsedAt: '2026-09-24T00:00:00.000Z',
    slideWidthEmu: 12192000,
    slideHeightEmu: 6858000,
    height: 1080,
    slides: [],
    buttons: [],
    homeLinks: [],
    navLinks: [],
    backLinks: [],
    pollOptions: [],
    media,
    fonts: [],
  };
}

function mediaItem(): MediaItem {
  return { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), mime: 'video/mp4' };
}

const ctx: VideoLogCtx = { visitId: 'visit-1', buttonId: 'b1', buttonLabel: 'Sustainability' };

/** A controllable fake clock for watched_ms accounting. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function makePlayer(overrides: { now?: () => number } = {}) {
  const log = vi.fn();
  const onPlaying = vi.fn();
  const onFinished = vi.fn();
  const onStalled = vi.fn();
  const onPaused = vi.fn();
  const player = new VideoPlayer({ log, onPlaying, onFinished, onStalled, onPaused, now: overrides.now });
  return { player, log, onPlaying, onFinished, onStalled, onPaused };
}

// --------------------------------------------------------------------- tests

describe('VideoPlayer: arrival and activation', () => {
  it('activateOnArrival sets src from the deck media blob and calls play() on the first autoplay video', () => {
    const { player } = makePlayer();
    const auto = stageVideo({ id: 'auto', autoplay: true });
    const notAuto = stageVideo({ id: 'manual', autoplay: false });
    const stage = fakeStage({ 3: [notAuto, auto] }); // autoplay one is not first in the array on purpose

    player.activateOnArrival(fakeDeck(), stage, 3, ctx);

    expect(auto.el.src).toContain('blob:mock-');
    expect(auto.el.play).toHaveBeenCalledTimes(1);
    expect(notAuto.el.src).toBe('');
    expect(notAuto.el.play).not.toHaveBeenCalled();
    expect(player.activeId).toBe('auto');
  });

  it('does nothing when the slide has no autoplay video', () => {
    const { player } = makePlayer();
    const notAuto = stageVideo({ id: 'manual', autoplay: false });
    const stage = fakeStage({ 2: [notAuto] });

    player.activateOnArrival(fakeDeck(), stage, 2, ctx);

    expect(notAuto.el.play).not.toHaveBeenCalled();
    expect(player.isActive).toBe(false);
  });

  it('does nothing when the media is missing from deck.media (degrades to poster)', () => {
    const { player } = makePlayer();
    const auto = stageVideo({ id: 'auto', autoplay: true, mediaKey: 'missing.mp4' });
    const stage = fakeStage({ 2: [auto] });

    player.activateOnArrival(fakeDeck({}), stage, 2, ctx);

    expect(auto.el.play).not.toHaveBeenCalled();
    expect(player.isActive).toBe(false);
  });

  it('a tap on a non-autoplay video starts it', () => {
    const { player } = makePlayer();
    const manual = stageVideo({ id: 'manual', autoplay: false });

    player.activateTapped(fakeDeck(), manual, 3, ctx);

    expect(manual.el.play).toHaveBeenCalledTimes(1);
    expect(player.activeId).toBe('manual');
  });
});

describe('VideoPlayer: only one active, switching', () => {
  it('a tap on a different video deactivates the current one and activates the tapped one', () => {
    const { player, log } = makePlayer();
    const a = stageVideo({ id: 'a' });
    const b = stageVideo({ id: 'b' });
    const stage = fakeStage({ 3: [a, b] });

    player.activateOnArrival(fakeDeck(), stage, 3, ctx);
    expect(player.activeId).toBe('a');

    player.activateTapped(fakeDeck(), b, 3, ctx);

    expect(player.activeId).toBe('b');
    expect(a.el.pause).toHaveBeenCalled();
    expect(a.el.hasAttribute('src')).toBe(false);
    // "a" never played (no `playing` event dispatched), so it had zero watched time: no
    // video_end for it (ROADMAP).
    expect(log).not.toHaveBeenCalled();
  });

  it('tapping the already-active video is a no-op', () => {
    const { player } = makePlayer();
    const a = stageVideo({ id: 'a' });
    const stage = fakeStage({ 3: [a] });
    player.activateOnArrival(fakeDeck(), stage, 3, ctx);
    const playCallsBefore = (a.el.play as ReturnType<typeof vi.fn>).mock.calls.length;

    player.activateTapped(fakeDeck(), a, 3, ctx);

    expect((a.el.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playCallsBefore);
  });
});

describe('VideoPlayer: leaving / deactivate', () => {
  it('deactivate pauses, removes src, calls load(), and revokes the object URL', () => {
    const { revoke } = stubObjectUrl();
    const { player } = makePlayer();
    const a = stageVideo({ id: 'a' });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    const url = a.el.src;

    player.deactivate();

    expect(a.el.pause).toHaveBeenCalled();
    expect(a.el.hasAttribute('src')).toBe(false);
    expect(a.el.load).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(url);
    expect(player.isActive).toBe(false);
  });

  it('deactivate() with nothing active is a safe no-op', () => {
    const { player } = makePlayer();
    expect(() => player.deactivate()).not.toThrow();
  });

  it('logs video_end exactly once with watched_ms and completed on ended (non-loop)', () => {
    const clock = fakeClock(1000);
    const { player, log, onFinished } = makePlayer({ now: clock.now });
    const a = stageVideo({ id: 'a', loop: false });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);

    a.el.dispatchEvent(new Event('playing'));
    clock.advance(4321);
    a.el.dispatchEvent(new Event('ended'));

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'video_end',
        slide_from: 2,
        watched_ms: 4321,
        completed: true,
        visit_id: 'visit-1',
        button_id: 'b1',
        button_label: 'Sustainability',
      }),
    );

    // Leaving the slide afterwards must not log video_end a second time.
    player.deactivate();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not log video_end for a video that never played (zero watched time)', () => {
    const { player, log } = makePlayer();
    const a = stageVideo({ id: 'a' });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    // No 'playing' event dispatched: watchedMs stays 0.
    player.deactivate();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs video_end on deactivate (leaving mid-play) with the watched time so far, completed false', () => {
    const clock = fakeClock(0);
    const { player, log } = makePlayer({ now: clock.now });
    const a = stageVideo({ id: 'a' });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    a.el.dispatchEvent(new Event('playing'));
    clock.advance(2500);

    player.deactivate();

    expect(log).toHaveBeenCalledWith(expect.objectContaining({ watched_ms: 2500, completed: false }));
  });
});

describe('VideoPlayer: timeout pause/resume (decision 3)', () => {
  it('isPlaying is true once playing starts, and stays false before activation', () => {
    const { player } = makePlayer();
    expect(player.isPlaying).toBe(false);
    const a = stageVideo({ id: 'a' });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    expect(player.isPlaying).toBe(false); // not yet playing, just started
    a.el.dispatchEvent(new Event('playing'));
    expect(player.isPlaying).toBe(true);
  });

  it('calls onPlaying exactly once and restarts (onFinished) on non-loop ended; isPlaying false after', () => {
    const { player, onPlaying, onFinished } = makePlayer();
    const a = stageVideo({ id: 'a', loop: false });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);

    a.el.dispatchEvent(new Event('playing'));
    expect(onPlaying).toHaveBeenCalledTimes(1);
    expect(player.isPlaying).toBe(true);

    a.el.dispatchEvent(new Event('ended'));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(player.isPlaying).toBe(false);
  });

  it('loop: restarts playback on ended, and onFinished/onPlaying each fire only once across laps', () => {
    const { player, onPlaying, onFinished } = makePlayer();
    const a = stageVideo({ id: 'a', loop: true });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);

    a.el.dispatchEvent(new Event('playing')); // lap 1 starts
    expect(onPlaying).toHaveBeenCalledTimes(1);
    expect(player.isPlaying).toBe(true);

    a.el.currentTime = 5; // pretend playback progressed
    a.el.dispatchEvent(new Event('ended')); // lap 1 ends -> restarts itself
    expect(onFinished).toHaveBeenCalledTimes(1); // decision 3: only the first lap restarts the timeout
    expect(player.isPlaying).toBe(false); // timeout runs normally from here even though it's still looping
    expect(a.el.currentTime).toBe(0); // restarted by hand, not the native `loop` attribute
    expect(a.el.play).toHaveBeenCalledTimes(2); // initial + restart

    a.el.dispatchEvent(new Event('playing')); // lap 2 starts
    expect(onPlaying).toHaveBeenCalledTimes(1); // not fired again
    expect(player.isPlaying).toBe(false); // stays false: the timeout is not re-paused

    a.el.dispatchEvent(new Event('ended')); // lap 2 ends -> restarts again, still no second onFinished
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(a.el.play).toHaveBeenCalledTimes(3);
  });
});

describe('VideoPlayer: error, stalled, rejected play() and the watchdog', () => {
  it('error deactivates the video and calls onStalled', () => {
    const { player, onStalled } = makePlayer();
    const a = stageVideo({ id: 'a' });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    a.el.dispatchEvent(new Event('playing'));

    a.el.dispatchEvent(new Event('error'));

    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(player.isActive).toBe(false);
    expect(a.el.pause).toHaveBeenCalled();
    expect(a.el.hasAttribute('src')).toBe(false);
  });

  it('stalled deactivates the video and calls onStalled', () => {
    const { player, onStalled } = makePlayer();
    const a = stageVideo({ id: 'a' });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);

    a.el.dispatchEvent(new Event('stalled'));

    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(player.isActive).toBe(false);
  });

  it('a rejected play() promise deactivates the video and calls onStalled', async () => {
    const { player, onStalled } = makePlayer();
    const a = stageVideo({ id: 'a' }, () => Promise.reject(new Error('NotAllowedError')));
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);

    await vi.waitFor(() => expect(onStalled).toHaveBeenCalledTimes(1));
    expect(player.isActive).toBe(false);
  });

  it('the watchdog gives up after 6s with no timeupdate while playing', () => {
    vi.useFakeTimers();
    try {
      const { player, onStalled } = makePlayer();
      const a = stageVideo({ id: 'a' });
      player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
      a.el.dispatchEvent(new Event('playing'));

      vi.advanceTimersByTime(6000);

      expect(onStalled).toHaveBeenCalledTimes(1);
      expect(player.isActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timeupdate resets the watchdog so a healthy video is never given up on', () => {
    vi.useFakeTimers();
    try {
      const { player, onStalled } = makePlayer();
      const a = stageVideo({ id: 'a' });
      player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
      a.el.dispatchEvent(new Event('playing'));

      vi.advanceTimersByTime(4000);
      a.el.dispatchEvent(new Event('timeupdate'));
      vi.advanceTimersByTime(4000);

      expect(onStalled).not.toHaveBeenCalled();
      expect(player.isActive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VideoPlayer: arrival race (a tap activates a video before the slide-arrival call runs)', () => {
  it('activateOnArrival is a no-op when a video is already active, so it never overwrites it without teardown', () => {
    const { revoke } = stubObjectUrl();
    const createSpy = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    const { player } = makePlayer();
    const a = stageVideo({ id: 'a', autoplay: true });
    const stage = fakeStage({ 2: [a] });

    // A tap on the video lands first (e.g. during the slide's own transition, before its
    // arrival promise has resolved) and activates it.
    player.activateTapped(fakeDeck(), a, 2, ctx);
    expect(createSpy.mock.calls.length).toBe(1);
    const urlAfterTap = a.el.src;

    // The slide's arrival call then runs, per the controller's own `.then()` chain, and finds
    // the same (already autoplay) video. It must not start it again.
    player.activateOnArrival(fakeDeck(), stage, 2, ctx);

    expect(createSpy.mock.calls.length).toBe(1); // no second URL created
    expect(a.el.src).toBe(urlAfterTap); // src untouched by the arrival call
    expect(revoke).not.toHaveBeenCalled(); // the tap's activation was never torn down either
  });

  it('start() defensively deactivates any existing active video before activating a new one', () => {
    const { revoke } = stubObjectUrl();
    const createSpy = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    const { player } = makePlayer();
    const a = stageVideo({ id: 'a' });
    const b = stageVideo({ id: 'b' });
    player.activateTapped(fakeDeck(), a, 2, ctx);
    const urlA = a.el.src;

    // Bypass activateTapped's own same-active-id guard to exercise start()'s own defence
    // directly (activateTapped already deactivates first; this proves the invariant holds even
    // if a future call site reaches start() without doing that itself).
    (player as unknown as { start: (deck: unknown, video: unknown, slide: number, ctx: unknown) => void }).start(
      fakeDeck(),
      b,
      2,
      ctx,
    );

    expect(revoke).toHaveBeenCalledWith(urlA);
    expect(a.el.hasAttribute('src')).toBe(false);
    expect(player.activeId).toBe('b');
    expect(createSpy.mock.calls.length).toBe(2);
  });
});

describe('VideoPlayer: external pause (screen lock, app switch, Control Center)', () => {
  it('a pause not followed by ended resumes the timeout (onPaused) and clears isPlaying', async () => {
    const { player, onPlaying, onPaused, onFinished } = makePlayer();
    const a = stageVideo({ id: 'a', loop: false });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);

    a.el.dispatchEvent(new Event('playing'));
    expect(onPlaying).toHaveBeenCalledTimes(1);
    expect(player.isPlaying).toBe(true);

    a.el.dispatchEvent(new Event('pause')); // no `ended` follows: an external interruption
    await Promise.resolve(); // the external-pause check is deferred to a microtask
    await Promise.resolve();

    expect(onPaused).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
    expect(player.isPlaying).toBe(false);
    expect(player.isActive).toBe(true); // the video itself is untouched, only the timeout resumed
  });

  it('a pause immediately followed by ended is NOT treated as an external pause', async () => {
    const { player, onPaused, onFinished } = makePlayer();
    const a = stageVideo({ id: 'a', loop: false });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    a.el.dispatchEvent(new Event('playing'));

    a.el.dispatchEvent(new Event('pause'));
    a.el.dispatchEvent(new Event('ended')); // fires synchronously right after, as browsers do
    await Promise.resolve();
    await Promise.resolve();

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onPaused).not.toHaveBeenCalled();
  });

  it('playback resuming after an external pause calls onPlaying again (re-pauses the timeout)', async () => {
    const { player, onPlaying, onPaused } = makePlayer();
    const a = stageVideo({ id: 'a', loop: false });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    a.el.dispatchEvent(new Event('playing'));
    a.el.dispatchEvent(new Event('pause'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onPaused).toHaveBeenCalledTimes(1);
    expect(player.isPlaying).toBe(false);

    a.el.dispatchEvent(new Event('playing')); // app returns to foreground, playback resumes

    expect(onPlaying).toHaveBeenCalledTimes(2);
    expect(player.isPlaying).toBe(true);
  });

  it('a loop past its first full play never re-pauses the timeout, even across an external pause/resume', async () => {
    const { player, onPlaying, onFinished, onPaused } = makePlayer();
    const a = stageVideo({ id: 'a', loop: true });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);

    a.el.dispatchEvent(new Event('playing')); // lap 1
    a.el.dispatchEvent(new Event('ended')); // lap 1 done: timeoutEligible turns false, restarts itself
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onPlaying).toHaveBeenCalledTimes(1);

    a.el.dispatchEvent(new Event('playing')); // lap 2 starts: must not call onPlaying again
    expect(onPlaying).toHaveBeenCalledTimes(1);
    expect(player.isPlaying).toBe(false);

    a.el.dispatchEvent(new Event('pause')); // external pause mid lap 2
    await Promise.resolve();
    await Promise.resolve();
    expect(onPaused).not.toHaveBeenCalled(); // the timeout wasn't paused on this video's account

    a.el.dispatchEvent(new Event('playing')); // resumes: still must not re-pause
    expect(onPlaying).toHaveBeenCalledTimes(1);
    expect(player.isPlaying).toBe(false);
  });
});

describe('VideoPlayer: resumeIfNeeded() (visibilitychange back to visible)', () => {
  it('calls play() again when the active video is not currently playing and has not finished', () => {
    const { player } = makePlayer();
    const a = stageVideo({ id: 'a' });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    a.el.dispatchEvent(new Event('playing'));
    a.el.dispatchEvent(new Event('pause')); // external pause: no longer playing

    const playCallsBefore = (a.el.play as ReturnType<typeof vi.fn>).mock.calls.length;
    player.resumeIfNeeded();

    expect((a.el.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playCallsBefore + 1);
  });

  it('does nothing when the video is already playing', () => {
    const { player } = makePlayer();
    const a = stageVideo({ id: 'a' });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    a.el.dispatchEvent(new Event('playing'));
    const playCallsBefore = (a.el.play as ReturnType<typeof vi.fn>).mock.calls.length;

    player.resumeIfNeeded();

    expect((a.el.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playCallsBefore);
  });

  it('does nothing when a non-loop video already finished for good', () => {
    const { player } = makePlayer();
    const a = stageVideo({ id: 'a', loop: false });
    player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
    a.el.dispatchEvent(new Event('playing'));
    a.el.dispatchEvent(new Event('ended'));
    const playCallsBefore = (a.el.play as ReturnType<typeof vi.fn>).mock.calls.length;

    player.resumeIfNeeded();

    expect((a.el.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playCallsBefore);
  });

  it('does nothing when no video is active', () => {
    const { player } = makePlayer();
    expect(() => player.resumeIfNeeded()).not.toThrow();
  });
});

describe('VideoPlayer: destroy()', () => {
  it('leaves no timer, no src, and revokes every created object URL', () => {
    vi.useFakeTimers();
    try {
      const { revoke, } = stubObjectUrl();
      const createSpy = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
      const { player, onStalled } = makePlayer();
      const a = stageVideo({ id: 'a' });
      player.activateOnArrival(fakeDeck(), fakeStage({ 2: [a] }), 2, ctx);
      a.el.dispatchEvent(new Event('playing'));

      player.destroy();

      expect(a.el.hasAttribute('src')).toBe(false);
      expect(createSpy.mock.calls.length).toBe(revoke.mock.calls.length);
      // The watchdog timer must be cleared too: advancing past its window afterwards must
      // not call onStalled (nothing to give up on any more anyway, but this also proves no
      // stray timer is left running).
      vi.advanceTimersByTime(10_000);
      expect(onStalled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
