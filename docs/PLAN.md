# stuPad implementation plan

Source of truth for requirements: [SPEC.md](SPEC.md). Shared contracts: [`src/types.ts`](../src/types.ts) (do not change without coordinating; additive changes only).

This is the build plan the app was created from: stack, module ownership and public APIs. All phases are complete, and the module APIs below match the code. For a walkthrough of how the app behaves at runtime and how the code fits together, read [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

- Vite + TypeScript (strict), **no UI framework** — plain DOM. Keep the bundle small and the runtime predictable for 12-hour runs.
- `jszip` (PPTX), `idb` (IndexedDB), `jspdf` (PDF), charts drawn by hand on `<canvas>` (no chart library).
- `vite-plugin-pwa` (Workbox) precaches everything for offline use (`registerType: 'autoUpdate'`).
- Tests: `vitest` + `jsdom` + `fake-indexeddb`. `pptxgenjs` (dev only) generates the test fixtures. (It originally generated `public/template.pptx` too; the template is now edited by hand in PowerPoint.)

## Module layout and ownership

| Dir | Owner (phase) | Responsibility | Public API |
| --- | --- | --- | --- |
| `src/pptx/` + `scripts/make-fixtures.mjs` | Agent A (1) | Unzip, parse slides/layouts/masters/theme, resolve colours/fonts/backgrounds, detect buttons, home links, onward nav links, "Last Slide Viewed" back links & poll/rating options, validate (reachability via buttons + nav-link chains; poll warnings) | `parsePptx(input: Blob \| ArrayBuffer, fileName: string): Promise<ParseResult>` |
| `src/render/` | Agent B (1) | Deck model → DOM at SLIDE_W x height, stage that letterboxes to screen, thumbnails, raster fallback | see below |
| `src/store/`, `src/kiosk/` | Agent C (1) | IndexedDB persistence + append-only log; kiosk runtime state machine | see below |
| `src/report/` | Agent D (1) | Stats, CSV, PDF (charts on canvas), share-sheet export | see below |
| `src/ui/`, `src/main.ts`, `src/styles.css`, `public/` | Agent E (2) | Setup screen, admin panel, PIN pad, checklist, Clear previous data dialog, routing, PWA icons, resume-on-launch, heartbeat timer | `startHeartbeat(log, intervalMs?): () => void` and `HEARTBEAT_INTERVAL_MS` (`src/ui/heartbeat.ts`); everything else is internal to `App`/the screens |

Phase 1 agents run in parallel on disjoint directories. Phase 2 integrates. Phase 3: review + fix.

### Render API (`src/render/index.ts`)

```ts
export class SlideStage {
  constructor(container: HTMLElement, deck: Deck, opts?: { useRaster?: boolean });
  /** show slide (1-based); resolves when transition done */
  show(index: number, transition?: { type: 'none' | 'fade'; ms: number }): Promise<void>;
  get current(): number;
  /** client coords -> slide px and % (x,y as 0..100); null if in letterbox */
  toSlide(clientX: number, clientY: number): { px: number; py: number; xPct: number; yPct: number } | null;
  /** element for overlays positioned in slide px (buttons outlines, feedback) */
  readonly overlay: HTMLElement;
  /** every video built for slide `index` (1-based), in document order; src/kiosk/video.ts is the only thing that ever sets/clears their `src` */
  videosOn(index: number): { el: HTMLVideoElement; def: VideoElement }[];
  /** re-fit on resize/orientation change (also auto via ResizeObserver) */
  fit(): void;
  destroy(): void; // must revoke every object URL it created, incl. each video's poster and (defensively) any leftover playback src
}
export interface StageVideo { el: HTMLVideoElement; def: VideoElement; }
export function renderThumbnail(deck: Deck, index: number, widthPx: number): HTMLElement;
export function preloadDeckFonts(families: string[], timeoutMs?): Promise<void>; // warms the bundled fonts a deck uses (never throws; no-op without document.fonts)
export function ensureFontFaces(): void;                                      // injects the bundled @font-face rules once (renderer and app startup)
export function releaseThumbnails(): void;                                   // revokes the object URLs renderThumbnail cached
export function rasterizeDeck(deck: Deck, widthPx?: number): Promise<Deck>; // clone with raster/N.png media + slide.rasterKey; a slide that fails to rasterise is left without one
export function rasterizeSlide(deck: Deck, index: number, widthPx?: number): Promise<Blob | null>; // one slide as PNG (used for the PDF home thumbnail)
```

`SlideStage` builds every slide's DOM once in the constructor and only toggles layers afterwards. With `useRaster`, a slide that has a `rasterKey` shows its PNG instead of the live DOM. A `VideoElement` builds a `<video muted playsinline preload="metadata" poster>` once, with no `src`; `videosOn()` exposes it, zipped against `deck.slides[i].elements` in document order, for `src/kiosk/video.ts` to control. Setup previews, thumbnails and the rasterizer never call into that module, so a video only ever shows its poster there.

### Store API (`src/store/index.ts`)

```ts
saveDeck(deck), loadDeck(): Promise<Deck|undefined>, deleteDeck()
saveConfig(cfg), loadConfig(): Promise<KioskConfig|undefined>  // defaults glow/deviceName for a config saved before those fields existed
getKioskState(): Promise<KioskState>, setKioskState(s)
appendEvent(e: LogEvent): Promise<number>        // durable once resolved (tx 'complete'); calls are serialised so ids follow call order
getEvents(f?: EventFilter): Promise<LogEvent[]>  // ordered by id
countEvents(f?): Promise<number>
listSessions(): Promise<{ sessionId: string; first: string; last: string; count: number }[]>
clearEvents(sessionId: string): Promise<void>     // clears all, then appends a log_cleared record
clearAllData(sessionId: string): Promise<void>    // "Clear previous data": wipes deck, config, state and events in one transaction, plus a log_cleared record
requestPersistence(): Promise<boolean>
```

### Kiosk API (`src/kiosk/index.ts`)

```ts
export class KioskController {
  constructor(opts: { root: HTMLElement; deck: Deck; config: KioskConfig; sessionId: string;
                      log: (e: Omit<LogEvent,'ts'|'session_id'>) => void; onAdminRequested: () => void });
  start(): Promise<void>;  // renders home, binds input, wake lock, arms the attract idle timer, logs nothing (caller logs kiosk_start / app_resume)
  stop(): void;            // unbinds everything, clears every timer (destination + attract idle/cycle), releases wake lock, destroys stage
}
export class SecretSequenceDetector {
  constructor(pattern: SecretPattern, windowMs: number, cornerFraction = 0.12);
  feed(xPct, yPct, t): boolean;                          // true iff this tap completed the sequence
  step(xPct, yPct, t): 'none' | 'continued' | 'complete'; // the kiosk consumes 'continued' and 'complete' taps only
  reset(): void;
}
export function checklist(): string[];                   // operator checklist text shown at Go live
export async function acquireWakeLock(): Promise<boolean>; // one-shot probe (acquire then release) so Setup can warn; the controller holds its own long-lived lock
export const ATTRACT_CROSSFADE_MS: number;                // fixed crossfade length for every attract-cycle step, independent of config.transitionMs
export const HOME_POLL_COOLDOWN_MS: number;                // per-poll cooldown for an unlinked Home vote (no visit to dedupe against)
// also exported for tests and reuse: pointInRect, round1, cornerOf
```

Mode is now `'home' | 'destination' | 'attract'`. The attract loop (config: `KioskConfig.attract`, off by default): an idle timer (`config.attract.idleSec`) armed whenever the kiosk is on Home and idle (after `start()`, an accepted Home tap that doesn't leave Home, a return to Home, or a wake from attract; cleared on leaving Home and in `stop()`) starts it, logging `attract_start`. **Cycle** mode crossfades `stage.show()` through Home plus `config.attract.slides` (filtered to slides that exist in the deck, deduped, sorted, Home first) via a single `setTimeout` chain at `ATTRACT_CROSSFADE_MS`, staying `config.attract.slideSec` on each; it falls back to **pulse** mode (stay on Home, toggle the `kiosk-attract-pulse` class built once lazily, reusing `glow.ts` for a stronger always-visible glow) when there's nothing else to cycle. The first tap in attract mode, wherever it lands, only wakes the kiosk (`wakeFromAttract`): never a button press, never a `miss_tap`, logs `attract_end` with `dwell_ms`, and re-arms the idle timer. The secret sequence is still checked first in every mode.

`src/kiosk/glow.ts` (button glow, also used by the Setup preview):

```ts
glowTargets(deck, slide): GlowTarget[]           // tappable areas on a slide, each with a border-radius matching its shape
glowRadius(elements, id, bounds): string         // '50%' ellipse, 'Npx' roundRect, '0' rect, else a soft radius
glowStyle(cfg: GlowConfig)                       // shadow colour, blur/spread (slide px) and half-period from the settings
applyGlowStyle(el, cfg); createGlow(target); createGlowLayer(deck, slide, cfg): HTMLElement
```

Only `pointerdown` is used for taps, so the 150 ms tap-to-slide budget is not spent waiting for a click. Kiosk rules (SPEC "Kiosk mode behaviour"): secret sequence checked before normal handling (taps that continue or complete a sequence are consumed and never trigger buttons; a sequence's first corner tap is handled normally); home: a poll/rating option that isn't also a button hit first (see below), else button hit → `button_press` + new visit_id + transition (and, if the button is also a poll option, `vote` logged right after with the same visit_id); else `miss_tap` with x/y %; destination: a poll/rating option on the slide is tested first (see below), then home-link hit → `return_home`, else a back-link hit (deck.backLinks) → `slide_nav` to the previous slide of this visit (a per-visit history, cleared on return home), or `return_home` if the visit started on this slide, else a nav-link hit (deck.navLinks for the current slide) → `slide_nav` + move to the target slide (still destination mode: fallback Home button and timeout are re-applied for the new slide), else a video on the slide that isn't already active (see "Video" below; checked *after* every link, so a link drawn over or under a video always wins, and a tap on the already-active video falls straight through instead) → else tap-anywhere / timeout → `return_home` with method + dwell_ms (the whole visit's dwell, from the first button press, not just the last slide); `slide_nav`'s own dwell_ms is just the time on the slide being left; timeout resets on any tap (unless the active video is playing, see "Video"), including a nav tap; debounce ignores repeat taps (not logged); idle warning countdown in last 5 s; press feedback; disable gestures (touch-action, user-select, contextmenu, gesturestart, dblclick); visibilitychange re-acquires wake lock. If `returnMethods.homeButton` is on and a destination slide has no home link or back link (whether reached directly or via a chain of nav links), show a discreet ≥44pt "Home" overlay button so users are never stranded; the previous slide's fallback button (if any) is removed before drawing a new one. Attract mode: any accepted tap → `wakeFromAttract`, never a button press, `miss_tap` or `vote`, logs `attract_end` + dwell_ms, back to home mode, idle timer re-armed; a video is never activated on Home or during attract.

**Polls and ratings** (`deck.pollOptions`, `PollOptionDef[]`, precomputed into `pollOptionsBySlide: Map<slide, PollOptionDef[]>` in the constructor). One vote per poll per visit: `visitVotedPolls: Set<string>` (poll names already voted in this visit) is checked before logging, and cleared whenever a visit starts or ends, alongside `visitPath`. On a destination slide the option is tested before every link; a hit logs `vote` (unless already voted this visit) and, if the option is linked, falls through to the normal link handling below it for the same tap (so the link is followed, whether or not this tap logged a new vote); if unlinked, the kiosk shows press feedback and the Thanks overlay, resets the destination timeout, and stops (no further link tested). On Home, whether an option takes the button path is decided by button membership (`homeButtonIds`, precomputed from `deck.buttons`), not by the option's own `linked` flag: `linked` is true for any link, including one to slide 1 or a "Last Slide Viewed" back link, neither of which is a button (`detectButtons` requires `targetSlide > 1`). An option that isn't a button has no visit to dedupe against, so a per-poll cooldown (`HOME_POLL_COOLDOWN_MS`, keyed by `now()`) stands in: press feedback and the Thanks overlay always show, but the `vote` log (with no `visit_id`) and re-arming the attract idle timer only happen once the cooldown has passed; a suppressed tap is never `miss_tap`. A Home option that is a button runs the normal button path and then logs `vote` with the same `visit_id`. The Thanks overlay (`.kiosk-poll-thanks`, in `styles.css`) is built once lazily in the stage overlay; only its visibility class and a single 1.5 s hide timer are touched afterwards, and the timer is cleared on every slide change and in `stop()`.

**Video** (`src/kiosk/video.ts`'s `VideoPlayer`, owned one-per-session by `KioskController`, called only at slide-change points):

```ts
export interface VideoLogCtx { visitId?: string; buttonId?: string; buttonLabel?: string; }
export class VideoPlayer {
  constructor(opts: { log: (e) => void; onPlaying: () => void; onFinished: () => void; onStalled: () => void; onPaused: () => void; now?: () => number });
  activateOnArrival(deck, stage: SlideStage, slide: number, ctx: VideoLogCtx): void;  // first autoplay video in element order, if any; no-op if a video is already active
  activateTapped(deck, video: StageVideo, slide: number, ctx: VideoLogCtx): void;     // tap hit on a video that isn't already active: switch to it, or start it if nothing is active
  deactivate(): void;   // leaving the slide/return home/timeout/switching; logs video_end if any time was watched
  destroy(): void;      // stop(): same as deactivate() plus clears the watchdog
  resumeIfNeeded(): void;   // visibilitychange back to visible: play() again if active, not playing and not finished for good
  get isActive(): boolean;
  get isPlaying(): boolean;   // whether the destination timeout should stay paused (decision 3): not the same as "is it literally playing" for a looping video past its first lap
  get activeId(): string | undefined;
}
```

Only one video is ever active. `activateOnArrival`/`activateTapped` create one `URL.createObjectURL` from `deck.media[mediaKey].blob` and set it as the video's `src`; `deactivate` (and the internal `giveUp`, used by error/stalled/rejected-play/watchdog) always `pause()`, `removeAttribute('src')`, `load()` and `URL.revokeObjectURL()`, tracked in one field so it can never leak or double-revoke. `start()` (the private method both `activateOnArrival` and `activateTapped` call) itself deactivates any already-active video first, and `activateOnArrival` refuses to run at all when one is already active: a tap can start a video before that slide's own arrival call runs (its promise is still pending on the transition), and the arrival call must never clobber that activation without a teardown. `watched_ms` is wall time between each `playing` and the next `pause`/`ended`/give-up; `video_end` (with `visit_id`/`button_id`/`button_label` like `slide_nav`) logs once per activation, either on a non-loop video's `ended` or otherwise on `deactivate`/`giveUp` when there's any watched time (never for zero). A looping video is restarted by hand (`currentTime = 0` then `play()`), not the native `loop` attribute, so `ended` keeps firing every lap; only the first lap's `ended` calls `onFinished` (decision 3: the timeout resumes after the first full play and stays resumed for later laps). An OS interruption (screen lock, app switch, Control Center) fires a `pause` with no `ended` to follow; that's told apart from the `pause` that always immediately precedes a genuine `ended` by deferring the check to a microtask (not by reading the DOM `ended` property, whose timing next to `pause` isn't guaranteed) and calls `onPaused`, which resumes the timeout exactly like `onFinished`/`onStalled`; if playback then resumes, `onPlaying` fires again too (unless the video is already past its one timeout-pausing play). `resumeIfNeeded()`, called by `KioskController`'s own `visibilitychange` handler, plays the active video again if an external pause left it stopped and it hasn't finished for good. A 6 s no-`timeupdate` watchdog, an `error`/`stalled` event, or a rejected `play()` promise all call the same internal `giveUp`, which tears the video down (poster shows again) and calls `onStalled`. `KioskController` wires `onPlaying`/`onFinished`/`onStalled`/`onPaused` to pause/restart its own destination timer, and skips a plain tap-driven timer reset while `videoPlayer.isPlaying`. Home and the attract loop never call into `VideoPlayer`.

### Report API (`src/report/index.ts`)

```ts
computeStats(events: LogEvent[], labels: Record<string,string>, opts?: ComputeStatsOpts): ReportStats  // pure, heavily tested
// ComputeStatsOpts = { pollOptions?: PollOptionMeta[]; pollLabels?: Record<string,string> }
//   PollOptionMeta = { poll, choice, kind: 'vote'|'rate', label } (from Deck.pollOptions); pollLabels
//   is KioskConfig.pollLabels (admin renames), keyed by pollLabelKey(poll, choice) (src/types.ts).
// ReportStats.homeVotes: number    // vote events with no visit_id (unlinked Home votes)
// ReportStats.interactions: number // totalVisits + homeVotes; Summary's headline "Interactions" tile
// ReportStats.polls: PollStat[] = { poll, label, kind: 'vote'|'rate', total, choices, mean }[]
//   choices: { choice, label, count, pct }[]. Every vote counts (home and destination alike, decision
//   4); poll/choice order follows opts.pollOptions (deck order) then first-seen in events; kind is
//   'rate' only if every opts.pollOptions entry for that poll is 'rate' (mixed VOTE_/RATE_, per the
//   parser's poll_mixed_kind warning, aggregates as 'vote'); mean averages numeric choices weighted
//   by count (rate polls only), excluding a non-numeric RATE_ choice (still counted in total/choices).
// ReportStats.missGrid: number[][], MISS_GRID_ROWS x MISS_GRID_COLS (27 x 48) home-slide miss-tap density, missGrid[row][col]
// ReportStats.slideTime: SlideTimeStat[] = { slide, visits, medianMs, meanMs, medianMsExclTimeout, visitsExclTimeout }[]
//   one entry per slide with a timed stay (see visitPaths below); medianMsExclTimeout/visitsExclTimeout
//   exclude the last-slide stay of timeout-ended visits (timeout skew), null when none remain
// ReportStats.topPaths: PathStat[] = { path: number[], count, ended }[], top 8 by count desc
// ReportStats.otherPaths: number   // path-tracked visits not in topPaths
// ReportStats.totalPaths: number   // topPaths' counts + otherPaths, for the % column
//   "visitPaths": a pass (folded into computeStats' single loop) that reconstructs each visit's
//   route (button target slide, then each slide_nav.slide_to) from button_press/slide_nav/return_home,
//   keyed by visit_id in an open-visits map, closed on return_home. It's orphaned instead (counted in
//   paths as ended, left out of slideTime) on a new button_press, an app_resume/kiosk_start/kiosk_stop,
//   or end of the event list. A slide_nav/return_home with no matching button_press is ignored.
// ReportStats.uptime: UptimeStats = { uptimeMs, downtimeMs, unmonitoredMs, gaps: {from,to}[], spans: {from,to,monitored}[] }
// ReportStats.uptimePct: number | null   // uptimeMs / (uptimeMs+downtimeMs) over monitored spans only; null when there are none
//   computeUptime (a separate pass over the same sorted events, see src/report/stats.ts and ARCHITECTURE
//   section 7 for the full span/gap semantics) reconstructs running spans: kiosk_start opens one, and so
//   does any other event when none is open (kiosk_stop is the one exception), since an event with no span
//   open means the scope cut off the kiosk_start that would have opened it. A span is "monitored" only if
//   it contains a heartbeat (i.e. logged by 1.5.0+); an unmonitored span's whole duration goes to
//   unmonitoredMs instead of uptimeMs/downtimeMs/gaps. Inside a monitored span, a gap over UPTIME_GAP_MS
//   (20 min) between consecutive events is downtime, everything else is uptime. heartbeat events take
//   part in this pass, and extend firstTs/lastTs like any event, but never affect isMultiDay or any count.
// ReportStats.attractStarts / attractEnds: number   // attract_start / attract_end event counts in scope
// ReportStats.attractPullInPct: number | null       // attractEnds / attractStarts * 100; null when attractStarts is 0
//   Attract periods (folded into the same single pass): attract_start opens one, closed by the next
//   attract_end, or by whichever of kiosk_stop/kiosk_start/app_resume comes first, or by the end of the
//   log. Only closed { fromMs, toMs } periods are kept; each is clipped into the ActivityBucket(s) it
//   overlaps once bucket sizing is known, so memory stays flat regardless of event count.
// ActivityBucket.attractMs: number   // ms of this bucket's own span spent in an attract period, clipped to it
// ReportStats.videos: VideoStat[] = { slide, plays, medianWatchedMs, completedPct }[]
//   one entry per slide with any video_end event, ascending by slide; folded into the same single pass,
//   keeping only each slide's array of watched_ms values (for the median) and a completed count, so
//   memory stays flat regardless of event count. plays is the array length; completedPct is the
//   completed count over plays, 0 when there are none.
toCsv(events): string; csvFileName(sessionName, now): string   // heartbeat/attract_start/attract_end/vote/video_end rows included like any other event; poll/choice/watched_ms/completed are the last four CSV_COLUMNS
buildPdf(events, deck, config, homeThumbPng?: Blob): Promise<Blob>   // A4 landscape, pages per SPEC; jsPDF is lazy-imported; config.deviceName (trimmed), when set, is shown on Summary and in every footer; Summary gains an "Attract pull-in" tile once attractStarts > 0 and an "Interactions" tile (shown first) once the log has any vote events; a "Poll results" page is added per poll with at least one vote; the Slides page renders when there are onward nav taps, any video plays, or both, adding a Video table (drawVideoTable, plain doc.text) below the path table, or alone under the title "Video" when there are no nav taps
pdfFileName(sessionName, now): string                                // same <session>_<yyyy-mm-dd-hhmm> pattern as csvFileName
exportFile(file: File): Promise<'shared'|'downloaded'|'cancelled'>   // navigator.share({files}) → fallback <a download>
buttonColor(i: number): string    // consistent palette across all charts
returnMethodColor(m: ReturnMethod): string        // in src/report/colors.ts; not re-exported from index.ts
draw*Chart(ctx, width, height, data, fontScale?)  // donut, dwell bar, activity, bar, percent bar, heatmap: hand-drawn canvas charts (src/report/charts.ts)
drawActivityChart(ctx, w, h, { buckets: { label, counts, attractMs? }[], series, bucketMs? }, fontScale?)  // stacked bars; a light shaded band behind a bucket with attractMs, opacity scaled by attractMs / bucketMs (src/report/charts.ts); ATTRACT_BAND_LEGEND_COLOR is the matching PDF legend swatch
drawTapHeatmap(ctx, w, h, { grid, buttons, deckHeight, thumbnail? }, fontScale?)  // home-slide miss-tap grid + button outlines, thumbnail optional (src/report/charts.ts)
drawSlideTimeChart(ctx, w, h, { entries: { slide, medianMs, medianMsExclTimeout }[] }, fontScale?)  // paired horizontal bars, median time per slide; caps at the 16 busiest slides (by stays, then ascending slide order) with a "+N more" note (src/report/charts.ts)
drawPathTable(ctx, w, h, { entries: { path, count, pct, ended, label? }[] }, fontScale?)  // "3 → 4 → 5" style table drawn on canvas, so the arrow renders (jsPDF's Helvetica can't); caller does the top-8/"Other" bucketing (src/report/charts.ts)
drawUptimeStrip(ctx, w, h, { startMs, endMs, spans: {from,to,monitored}[], gaps }, fontScale?)  // thin up/down strip, same time axis as drawActivityChart (shares its marginL/marginR formula so the two line up when given the same fontScale); green/red/grey for running/down/stopped, neutral grey for an unmonitored span, with a legend that adds "No heartbeat data" only when one is present (src/report/charts.ts)
drawPollChart(ctx, w, h, { bars: { label, count, pct, color }[] }, fontScale?)  // horizontal bars for one poll's results, count and % per choice, in the order the caller supplies (src/report/charts.ts)
```

## Conventions

- Hard rules: no network at runtime, no `localStorage` for data, revoke object URLs, remove every listener/timer in `stop()/destroy()` (12h soak, no memory growth).
- Tests live in `tests/` mirroring `src/` (`tests/pptx/*.test.ts` etc). Fixtures in `tests/fixtures/`, generated by `npm run fixtures`. `public/template.pptx` is edited by hand, not generated.
- (Phase 1 only) Don't commit; the orchestrator commits each phase.
- `npm run typecheck` and `npm test` must pass for your module before you finish. Ignore type errors in directories you don't own while phase 1 is in flight.

## Phases

1. **Parallel modules** (A parser+template, B renderer, C store+kiosk, D reports).
2. **Integration** (E): UI, main.ts, PWA, end-to-end check in a browser with the template deck.
3. **Review**: code review pass, fix, push. Deployment is GitHub Pages via `.github/workflows/deploy-pages.yml` (served under `/stuPad/`; use `import.meta.env.BASE_URL` for asset URLs).

Later work, all additive, landed through pull requests once `main` was protected: nav links, "Last Slide Viewed" back links and slide-view stats (parser, kiosk, report); bundled web fonts (`src/render/fonts.ts`, `npm run fonts`); button glow (`src/kiosk/glow.ts`, `KioskConfig.glow`); Clear previous data (`clearAllData`, `src/ui/clear-data.ts`); the Emota rebrand of the admin UI and template deck, with the user-facing name GGPad; the version in the Setup header and page title; the PR check in `.github/workflows/ci.yml`; and the roadmap features in [ROADMAP.md](ROADMAP.md): Setup controls for the transition length and exit window, the miss-tap heatmap, time per slide and common paths, heartbeat and uptime (`src/ui/heartbeat.ts`), the attract loop, polls and ratings, and video on destination slides (`src/kiosk/video.ts`).
