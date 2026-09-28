/**
 * Video playback for a destination slide (ROADMAP "Video on destination slides"; see
 * docs/PLAN.md "Kiosk API" and docs/SPEC.md "Kiosk mode behaviour"). This is the one place
 * in the kiosk that creates a video's playback object URL, and the one place that revokes
 * it: the invariant CLAUDE.md cares most about for this feature ("the video `src` object
 * URL must exist only while its slide is the active destination").
 *
 * `KioskController` owns one `VideoPlayer` for the whole kiosk session and only calls it at
 * slide-change points (`activateOnArrival`/`activateTapped`/`deactivate`) and `stop()`
 * (`destroy`); it never touches a video element's `src` itself. `SlideStage` builds the
 * `<video>` elements (muted/playsinline/preload/poster, no `src`) and exposes them via
 * `videosOn()`; this module is the only thing that ever sets or clears their `src`.
 *
 * Only one video is ever active across the whole kiosk. Watched time (`watched_ms`) is wall
 * time accumulated between each `playing` event and the next `pause`/`ended`/give-up, not the
 * video's own `currentTime` (documented here since the ROADMAP leaves the choice open).
 */
import type { Deck, VideoElement, LogEvent } from '../types';
import type { SlideStage, StageVideo } from '../render';

export type VideoLogFn = (e: Omit<LogEvent, 'ts' | 'session_id'>) => void;

/** The visit context to stamp on `video_end`, matching `slide_nav`'s own fields (SPEC
 * "Interaction logging"). Passed in fresh at every `activate*` call since it can change
 * between activations (a new visit, or none at all if reached without a button press:
 * shouldn't happen in practice, but nothing requires a video to be mid-visit). */
export interface VideoLogCtx {
  visitId?: string;
  buttonId?: string;
  buttonLabel?: string;
}

export interface VideoPlayerOpts {
  log: VideoLogFn;
  /** The active video is (or has resumed) playing and hasn't finished its timeout-pausing
   * window yet: the controller pauses the destination timeout and idle countdown (decision
   * 3). Fires again after `onPaused` if playback resumes, unless a loop's first play is
   * already done or a non-loop video already completed, see the class doc on `ended`. */
  onPlaying: () => void;
  /** The active video finished: a non-loop video's `ended`, or a looping video's *first*
   * `ended` (decision 3: "for loops the timeout restarts after the first full play"). The
   * controller restarts the destination timeout from the full `timeoutSec`. */
  onFinished: () => void;
  /** The active video gave up (error, stalled, a rejected `play()`, or the watchdog): it has
   * been deactivated (poster shown again) and the controller should resume the timeout at
   * once, exactly as `onFinished` does, so a broken file can never trap the kiosk. */
  onStalled: () => void;
  /** An external pause interrupted the active video (screen lock, app switch, Control
   * Center, or anything else not caused by this module's own teardown): the controller
   * resumes the timeout at once, exactly as `onFinished`/`onStalled` do, so a `timeoutSec`-only
   * kiosk can never be trapped on the slide waiting for a video that isn't coming back on its
   * own. Never fires for the pause that immediately precedes `ended` (see `handlePause`). */
  onPaused: () => void;
  /** Wall-clock source for `watched_ms`; overridable in tests. Defaults to `performance.now`
   * (falling back to `Date.now`), matching `KioskController.now()`. */
  now?: () => number;
}

/** No `timeupdate` for this long while a video is playing means it's stuck (SPEC/ROADMAP
 * "12-hour safety"): give up on it rather than let a stalled decoder trap the kiosk. */
const WATCHDOG_MS = 6000;

interface ActiveVideo {
  el: HTMLVideoElement;
  def: VideoElement;
  slide: number;
  url: string;
  ctx: VideoLogCtx;
  watchedMs: number;
  /** `now()` when the current `playing` span started; null while paused/not yet playing. */
  playingSinceMs: number | null;
  completed: boolean;
  /**
   * Whether playback is still within the window where it should ever pause the destination
   * timeout: true until a non-loop video's `ended`, or a loop's *first* `ended`, whichever
   * comes first, then permanently false. A loop keeps firing `playing`/`ended` every lap after
   * that, but none of them should re-pause the timeout, so `handlePlaying` checks this before
   * calling `onPlaying` again.
   */
  timeoutEligible: boolean;
  /**
   * Whether the destination timeout is currently paused because of this video (decision 3).
   * True while `timeoutEligible` and actually mid-`playing`; set back to false on an external
   * pause (`onPaused`) or once `timeoutEligible` itself turns false. Deliberately not the same
   * thing as `playingSinceMs !== null`: a looping video keeps firing `playing`/`pause` on every
   * lap once past its first, but the timeout stays unpaused for those.
   */
  pausingTimeout: boolean;
  /** Whether `video_end` has already been logged for this activation (the non-loop `ended`
   * path logs immediately; `deactivate`/`giveUp` must not log it again on top). */
  loggedAtEnd: boolean;
  /**
   * Set synchronously by `handleEnded`, right before it does anything else, and consumed
   * (read then reset) by the very next deferred pause check in `handlePause`. Browsers fire
   * `pause` immediately before `ended` for the natural end of a lap, but nothing guarantees
   * `el.ended` is already `true` at the moment `pause` fires, so this flag (rather than reading
   * `el.ended`) is what tells that "this pause is about to end" apart from a genuine external
   * pause (screen lock, app switch, Control Center) with more of the video left to play.
   */
  justEnded: boolean;
  listeners: { type: string; fn: EventListener }[];
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class VideoPlayer {
  private active: ActiveVideo | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: VideoPlayerOpts) {
    this.now = opts.now ?? defaultNow;
  }

  /** Whether *any* video is currently the active one (playing or paused-but-active; a
   * video that failed to start never becomes active at all, see `start`). */
  get isActive(): boolean {
    return this.active !== null;
  }

  /** Whether the destination timeout should currently stay paused because of the active video
   * (decision 3: taps during playback must not restart it). See `ActiveVideo.pausingTimeout`:
   * false once a loop's first play has completed and `onFinished` has fired, even though the
   * (still-looping) video keeps playing; from that point on the timeout runs normally again. */
  get isPlaying(): boolean {
    return this.active !== null && this.active.pausingTimeout;
  }

  /** The active video's shape id, or undefined. Used to tell "tap on the already-active
   * video" apart from "tap on a different video" (see `activateTapped`). */
  get activeId(): string | undefined {
    return this.active?.def.id;
  }

  /** Arrival at a destination slide: activates the first autoplay video in element order, if
   * any (ROADMAP: "the first autoplay video (in element order) becomes active on arrival; the
   * others show their poster"). No-op if the slide has none, or if a video is already active:
   * a tap can land on a video (via `activateTapped`) before the slide's own transition promise
   * resolves and calls this, and this call must never clobber that already-started activation
   * (it would otherwise overwrite `this.active` without tearing down the first one, leaking its
   * object URL and listeners and losing its watched time). */
  activateOnArrival(deck: Deck, stage: SlideStage, slide: number, ctx: VideoLogCtx): void {
    if (this.active) return;
    const first = stage.videosOn(slide).find((v) => v.def.autoplay);
    if (first) this.start(deck, first, slide, ctx);
  }

  /** A tap landed on a video's bounds on the current slide. Starts it if nothing is active
   * there yet (works for a non-autoplay video too, ROADMAP: "a tap on a non-autoplay video
   * starts it"); switches to it if a *different* video is currently active (deactivating that
   * one first, without logging `video_end` if it had zero watched time, ROADMAP); does
   * nothing if it's already the active one. */
  activateTapped(deck: Deck, video: StageVideo, slide: number, ctx: VideoLogCtx): void {
    if (this.active?.def.id === video.def.id) return;
    this.deactivate();
    this.start(deck, video, slide, ctx);
  }

  private start(deck: Deck, video: StageVideo, slide: number, ctx: VideoLogCtx): void {
    const item = deck.media[video.def.mediaKey];
    if (!item) return; // media missing from storage: nothing to play, poster stays up

    // Defensive: every caller already deactivates any current video before calling this
    // (activateTapped explicitly; activateOnArrival by refusing to run at all when one is
    // active), but this guarantees `this.active` can never be overwritten without a teardown
    // regardless of how a future call site is added, so its object URL and listeners can never
    // leak.
    if (this.active) this.deactivate();

    const url = URL.createObjectURL(item.blob);
    const el = video.el;
    el.src = url;

    const active: ActiveVideo = {
      el,
      def: video.def,
      slide,
      url,
      ctx,
      watchedMs: 0,
      playingSinceMs: null,
      completed: false,
      timeoutEligible: true,
      pausingTimeout: false,
      loggedAtEnd: false,
      justEnded: false,
      listeners: [],
    };
    this.active = active;

    const on = (type: string, fn: EventListener): void => {
      el.addEventListener(type, fn);
      active.listeners.push({ type, fn });
    };
    on('playing', () => this.handlePlaying(active));
    on('pause', () => this.handlePause(active));
    on('ended', () => this.handleEnded(active));
    on('error', () => this.giveUp(active));
    on('stalled', () => this.giveUp(active));
    on('timeupdate', () => this.armWatchdog(active));

    const playResult = el.play();
    // Older jsdom/test doubles may return undefined rather than a Promise.
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => this.giveUp(active));
    }
  }

  private handlePlaying(active: ActiveVideo): void {
    if (this.active !== active) return;
    if (active.playingSinceMs === null) active.playingSinceMs = this.now();
    this.armWatchdog(active);
    // Past the point where playback should ever pause the timeout again (a loop's first lap
    // already finished, or a non-loop video already completed): never call onPlaying again,
    // even if it resumes playing (decision 3).
    if (!active.timeoutEligible) return;
    // Already paused for this play span (e.g. a `playing` that fires again without an
    // intervening external pause): avoid a redundant onPlaying call.
    if (active.pausingTimeout) return;
    active.pausingTimeout = true;
    this.opts.onPlaying();
  }

  private accumulate(active: ActiveVideo): void {
    if (active.playingSinceMs !== null) {
      active.watchedMs += this.now() - active.playingSinceMs;
      active.playingSinceMs = null;
    }
  }

  private handlePause(active: ActiveVideo): void {
    if (this.active !== active) return;
    this.accumulate(active);
    this.clearWatchdog();
    // Browsers dispatch `pause` immediately before `ended` for the natural end of a lap, but
    // nothing guarantees `el.ended` is already true at the instant `pause` fires, so defer the
    // "was this an external pause" decision to a microtask: by the time it runs, `ended` (if
    // this pause precedes one) has already been dispatched synchronously and `handleEnded` has
    // already set `justEnded`, letting this tell the two cases apart without depending on the
    // DOM `ended` property's timing.
    queueMicrotask(() => {
      if (this.active !== active) return; // deactivated/switched since the pause fired
      if (active.justEnded) {
        active.justEnded = false;
        return; // part of the natural end of a lap; handleEnded already dealt with it
      }
      this.handleExternalPause(active);
    });
  }

  /**
   * A `pause` that wasn't immediately followed by `ended`: an OS interruption (screen lock, app
   * switch, Control Center) or anything else outside this module's own teardown (which always
   * removes its listeners before calling `pause()`, so it never reaches here). Left alone, a
   * `timeoutSec`-only kiosk would be stuck on the slide forever waiting for a video that isn't
   * coming back on its own, so this resumes the destination timeout immediately, exactly like a
   * finished or given-up video. Playback resuming later (`handlePlaying`) re-pauses it, unless
   * `timeoutEligible` has since turned false.
   */
  private handleExternalPause(active: ActiveVideo): void {
    if (!active.pausingTimeout) return; // the timeout wasn't paused on this video's account anyway
    active.pausingTimeout = false;
    this.opts.onPaused();
  }

  private handleEnded(active: ActiveVideo): void {
    if (this.active !== active) return;
    active.justEnded = true; // read (and cleared) by the pause microtask this `ended` follows
    this.accumulate(active);
    // The watchdog only means anything while frames are expected to keep advancing; clear it
    // here so a stale one (armed by the last `timeupdate`/`playing` before this `ended`) can
    // never fire spuriously right after: the loop branch below re-arms it fresh once the
    // restarted play's own `playing` event lands.
    this.clearWatchdog();
    active.completed = true;

    if (active.def.loop) {
      if (active.timeoutEligible) {
        active.timeoutEligible = false;
        active.pausingTimeout = false; // decision 3: timeout resumes after the first full play
        this.opts.onFinished();
      }
      // Not the native `loop` attribute (CLAUDE.md/ROADMAP): restart by hand so `ended` keeps
      // firing and this same accounting runs on every lap.
      active.el.currentTime = 0;
      const playResult = active.el.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => this.giveUp(active));
      }
      return;
    }

    active.timeoutEligible = false;
    active.pausingTimeout = false;
    this.logVideoEnd(active);
    active.loggedAtEnd = true;
    this.opts.onFinished();
  }

  /**
   * Called by the controller's own `visibilitychange` handler when the app returns to the
   * foreground: if a video is active and not currently playing, but hasn't finished for good
   * (a non-loop video's `ended`), resumes it: an OS interruption (screen lock, app switch,
   * Control Center) pauses the element itself, and nothing else would ever call `play()` again.
   * A rejected `play()` here gives up on the video exactly as any other failed `play()` would.
   */
  resumeIfNeeded(): void {
    const active = this.active;
    if (!active) return;
    if (active.loggedAtEnd) return; // finished for good (non-loop ended): nothing to resume
    if (active.playingSinceMs !== null) return; // already playing
    const playResult = active.el.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => this.giveUp(active));
    }
  }

  /** Error, stalled, a rejected `play()`, or the watchdog: give up on this video for good
   * (tear it down, poster shows again) and tell the controller to resume the timeout at once. */
  private giveUp(active: ActiveVideo): void {
    if (this.active !== active) return;
    this.accumulate(active);
    this.teardown(active);
    this.active = null;
    this.opts.onStalled();
  }

  /** Leaving the slide, returning home, a timeout, `stop()`, or switching to a different
   * video on the same slide. Logs `video_end` itself only if the non-loop-`ended` path above
   * hasn't already logged it for this activation, and only when there's any watched time to
   * report (ROADMAP: never logged for a video with zero watched time). */
  deactivate(): void {
    const active = this.active;
    if (!active) return;
    this.accumulate(active);
    this.teardown(active);
    this.active = null;
  }

  private teardown(active: ActiveVideo): void {
    this.clearWatchdog();
    for (const { type, fn } of active.listeners) active.el.removeEventListener(type, fn);
    active.el.pause();
    active.el.removeAttribute('src');
    active.el.load(); // releases the decoder (Safari)
    URL.revokeObjectURL(active.url);
    if (!active.loggedAtEnd && active.watchedMs > 0) this.logVideoEnd(active);
  }

  private logVideoEnd(active: ActiveVideo): void {
    this.opts.log({
      event: 'video_end',
      slide_from: active.slide,
      watched_ms: Math.round(active.watchedMs),
      completed: active.completed,
      visit_id: active.ctx.visitId,
      button_id: active.ctx.buttonId,
      button_label: active.ctx.buttonLabel,
    });
  }

  private armWatchdog(active: ActiveVideo): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => this.giveUp(active), WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /** Full teardown, called by `KioskController.stop()` before the stage is destroyed: leaves
   * no timer, no `src`, and every created object URL revoked. */
  destroy(): void {
    this.deactivate();
    this.clearWatchdog();
  }
}
