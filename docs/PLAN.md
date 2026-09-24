# stuPad implementation plan

Source of truth for requirements: [SPEC.md](SPEC.md). Shared contracts: [`src/types.ts`](../src/types.ts) (do not change without coordinating; additive changes only).

## Stack

- Vite + TypeScript (strict), **no UI framework** — plain DOM. Keep the bundle small and the runtime predictable for 12-hour runs.
- `jszip` (PPTX), `idb` (IndexedDB), `jspdf` (PDF), charts drawn by hand on `<canvas>` (no chart library).
- `vite-plugin-pwa` (Workbox) precaches everything for offline use.
- Tests: `vitest` + `jsdom` + `fake-indexeddb`. `pptxgenjs` (dev only) generates the template deck and test fixtures.

## Module layout and ownership

| Dir | Owner (phase) | Responsibility | Public API |
| --- | --- | --- | --- |
| `src/pptx/` + `scripts/make-template.mjs` | Agent A (1) | Unzip, parse slides/layouts/masters/theme, resolve colours/fonts/backgrounds, detect buttons, home links, onward nav links & "Last Slide Viewed" back links, validate (reachability via buttons + nav-link chains) | `parsePptx(input: Blob \| ArrayBuffer, fileName: string): Promise<ParseResult>` |
| `src/render/` | Agent B (1) | Deck model → DOM at SLIDE_W x height, stage that letterboxes to screen, thumbnails, raster fallback | see below |
| `src/store/`, `src/kiosk/` | Agent C (1) | IndexedDB persistence + append-only log; kiosk runtime state machine | see below |
| `src/report/` | Agent D (1) | Stats, CSV, PDF (charts on canvas), share-sheet export | see below |
| `src/ui/`, `src/main.ts`, `src/styles.css`, `public/` | Agent E (2) | Setup screen, admin panel, PIN pad, checklist, routing, PWA icons, resume-on-launch | — |

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
  /** re-fit on resize/orientation change (also auto via ResizeObserver) */
  fit(): void;
  destroy(): void; // must revoke every object URL it created
}
export function renderThumbnail(deck: Deck, index: number, widthPx: number): HTMLElement;
export function rasterizeDeck(deck: Deck, widthPx?: number): Promise<Deck>; // adds raster/N.png media + slide.rasterKey
```

### Store API (`src/store/index.ts`)

```ts
saveDeck(deck), loadDeck(): Promise<Deck|undefined>, deleteDeck()
saveConfig(cfg), loadConfig(): Promise<KioskConfig|undefined>
getKioskState(): Promise<KioskState>, setKioskState(s)
appendEvent(e: LogEvent): Promise<number>        // durable once resolved (tx 'complete')
getEvents(f?: EventFilter): Promise<LogEvent[]>  // ordered by id
countEvents(f?): Promise<number>
listSessions(): Promise<{ sessionId: string; first: string; last: string; count: number }[]>
clearEvents(sessionId: string): Promise<void>     // clears all, then appends a log_cleared record
requestPersistence(): Promise<boolean>
```

### Kiosk API (`src/kiosk/index.ts`)

```ts
export class KioskController {
  constructor(opts: { root: HTMLElement; deck: Deck; config: KioskConfig; sessionId: string;
                      log: (e: Omit<LogEvent,'ts'|'session_id'>) => void; onAdminRequested: () => void });
  start(): Promise<void>;  // renders home, binds input, wake lock, logs nothing (caller logs kiosk_start / app_resume)
  stop(): void;            // unbinds everything, releases wake lock, destroys stage
}
export class SecretSequenceDetector { constructor(pattern, windowMs, cornerFraction = 0.12); feed(xPct, yPct, t): boolean; reset(): void }
export function checklist(): string[]; export async function acquireWakeLock(): Promise<boolean>
```

Kiosk rules (SPEC "Kiosk mode behaviour"): secret sequence checked before normal handling (corner taps never trigger buttons); home: button hit → `button_press` + new visit_id + transition; else `miss_tap` with x/y %; destination: home-link hit → `return_home`, else a back-link hit (deck.backLinks) → `slide_nav` to the previous slide of this visit (a per-visit history, cleared on return home), or `return_home` if the visit started on this slide, else a nav-link hit (deck.navLinks for the current slide) → `slide_nav` + move to the target slide (still destination mode: fallback Home button and timeout are re-applied for the new slide) → else tap-anywhere / timeout → `return_home` with method + dwell_ms (the whole visit's dwell, from the first button press, not just the last slide); `slide_nav`'s own dwell_ms is just the time on the slide being left; timeout resets on any tap, including a nav tap; debounce ignores repeat taps (not logged); idle warning countdown in last 5 s; press feedback; disable gestures (touch-action, user-select, contextmenu, gesturestart, dblclick); visibilitychange re-acquires wake lock. If `returnMethods.homeButton` is on and a destination slide has no home link or back link (whether reached directly or via a chain of nav links), show a discreet ≥44pt "Home" overlay button so users are never stranded; the previous slide's fallback button (if any) is removed before drawing a new one.

### Report API (`src/report/index.ts`)

```ts
computeStats(events: LogEvent[], labels: Record<string,string>): ReportStats  // pure, heavily tested
toCsv(events): string; csvFileName(sessionName, now): string
buildPdf(events, deck, config, homeThumbPng?: Blob): Promise<Blob>   // A4 landscape, pages per SPEC
exportFile(file: File): Promise<'shared'|'downloaded'|'cancelled'>   // navigator.share({files}) → fallback <a download>
buttonColor(i: number): string    // consistent palette across all charts
```

## Conventions

- Hard rules: no network at runtime, no `localStorage` for data, revoke object URLs, remove every listener/timer in `stop()/destroy()` (12h soak, no memory growth).
- Tests live in `tests/` mirroring `src/` (`tests/pptx/*.test.ts` etc). Fixtures in `tests/fixtures/`, generated by `npm run template` (writes `public/template.pptx` and fixture decks).
- Don't commit; the orchestrator commits each phase.
- `npm run typecheck` and `npm test` must pass for your module before you finish. Ignore type errors in directories you don't own while phase 1 is in flight.

## Phases

1. **Parallel modules** (A parser+template, B renderer, C store+kiosk, D reports).
2. **Integration** (E): UI, main.ts, PWA, end-to-end check in a browser with the template deck.
3. **Review**: code review pass, fix, push. Deployment is GitHub Pages via `.github/workflows/deploy-pages.yml` (served under `/stuPad/`; use `import.meta.env.BASE_URL` for asset URLs).
