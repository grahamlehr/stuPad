# stuPad

Offline iPad PWA: loads a structured .pptx from the Files app, renders it in the browser, runs it as an unattended touch kiosk, logs every tap to IndexedDB, and exports CSV/PDF reports via the iOS share sheet.

- Requirements: `docs/SPEC.md` (source of truth). How it works and a codebase tour: `docs/ARCHITECTURE.md`. Module APIs and ownership: `docs/PLAN.md`.
- Keep the docs in step with the code: a behaviour change updates SPEC, a module API change updates PLAN, a structural change updates ARCHITECTURE (and the README map if a directory changes).
- Shared contracts: `src/types.ts`. Every module depends on it — make additive changes only, and update all consumers in the same change.

## Commands

```bash
npm run dev        # Vite dev server on the LAN (open on the iPad via the Mac's IP)
npm test           # vitest (jsdom + fake-indexeddb)
npm run typecheck
npm run build      # typecheck + production build to dist/
npm run template   # regenerate public/template.pptx and tests/fixtures/*.pptx with pptxgenjs
npm run fonts      # re-download public/fonts and regenerate src/render/font-faces.ts (generated: don't hand-edit)
```

## Layout

| Dir | What |
| --- | --- |
| `src/pptx/` | JSZip + DOMParser PPTX parser → `Deck`; button/home-link detection; validation `Issue`s |
| `src/render/` | `Deck` → DOM; `SlideStage` (letterboxed, fixed 1920-wide slide px canvas), thumbnails, raster fallback |
| `src/store/` | IndexedDB (`idb`): deck, config, kiosk state, append-only event log |
| `src/kiosk/` | Kiosk runtime: tap handling, secret exit sequence, debounce, timeout, wake lock |
| `src/report/` | Stats, CSV, jsPDF report with hand-drawn canvas charts, share-sheet export |
| `src/ui/`, `src/main.ts` | Setup screen, admin panel, PIN pad, routing, resume-into-kiosk on launch |
| `src/types.ts`, `src/util.ts` | Shared contracts; `isoLocal()` and `uuid()` |
| `scripts/` | `make-template.mjs` (template deck + test fixtures), `make-icons.mjs`, `make-fonts.mjs` |
| `tests/` | Mirrors `src/`; fixtures in `tests/fixtures/` are generated, not hand-edited |

## Rules that matter

- **No UI framework, no chart library, no runtime network.** Everything must work offline after first load; the service worker precaches the app shell, fonts and libraries.
- **12-hour unattended runs:** every `stop()`/`destroy()` removes its listeners, timers and wake lock and revokes the object URLs it created. Never rebuild slide DOM on each tap. Tap to slide change must stay under 150 ms.
- **Log durability:** `appendEvent` resolves only after the IndexedDB transaction completes. Never use `localStorage` for data. Events are append-only; the only deletions are `clearEvents` and `clearAllData` ("Clear previous data"), and each is itself logged.
- **Geometry:** all deck coordinates are slide px (slide width = `SLIDE_W` = 1920). Convert EMU in the parser only; convert screen coordinates via `SlideStage.toSlide()` only.
- **Timestamps:** use `isoLocal()` from `src/util.ts` (ISO 8601 with local offset). Compare instants, not strings.
- **Kiosk input:** the secret sequence is checked before any other tap handling; corner taps never trigger buttons. Debounced taps are not logged.
- **Base path:** the app is served from a sub-path on GitHub Pages (`/stuPad/`). Never hard-code `/` URLs: use `import.meta.env.BASE_URL` in code (e.g. for `template.pptx`) and `%BASE_URL%` in `index.html`.
- **Privacy:** no personal data; nothing leaves the device except admin-initiated exports.

## Testing on an iPad

Real behaviour (share sheet, wake lock, Guided Access, Home Screen standalone mode, storage persistence) only exists on iPadOS Safari. After any change to kiosk, export or the service worker, check on a device via the Pages URL or `npm run dev`. The dev server is plain HTTP, so service worker and share sheet need the HTTPS Pages build.

## Deployment

`.github/workflows/deploy-pages.yml` runs the tests, builds with `BASE_PATH` from `actions/configure-pages`, and deploys `dist/` to GitHub Pages on every push to `main`. The repo setting is Settings → Pages → Source: **GitHub Actions**.
