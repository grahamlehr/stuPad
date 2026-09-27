# stuPad

Offline iPad PWA: loads a structured .pptx from the Files app, renders it in the browser, runs it as an unattended touch kiosk, logs every tap to IndexedDB, and exports CSV/PDF reports via the iOS share sheet.

The repo, IndexedDB database and console prefixes are `stuPad`; the product users see is **GGPad** (page title, PWA manifest, Setup header, PDF footer, template deck), with the Emota brand on the admin UI.

- Requirements: `docs/SPEC.md` (source of truth). How it works and a codebase tour: `docs/ARCHITECTURE.md`. Module APIs and ownership: `docs/PLAN.md`.
- Keep the docs in step with the code: a behaviour change updates SPEC, a module API change updates PLAN, a structural change updates ARCHITECTURE (and the README map if a directory changes).
- Shared contracts: `src/types.ts`. Every module depends on it — make additive changes only, and update all consumers in the same change.

## Commands

```bash
npm run dev        # Vite dev server on the LAN (open on the iPad via the Mac's IP)
npm test           # vitest (jsdom + fake-indexeddb)
npm run typecheck
npm run build      # typecheck + production build to dist/
npm run fixtures   # regenerate tests/fixtures/*.pptx with pptxgenjs (public/template.pptx is edited by hand, not generated)
npm run fonts      # re-download public/fonts and regenerate src/render/font-faces.ts (generated: don't hand-edit)
node scripts/make-icons.mjs  # regenerate public/icons/*.png (no npm script)
```

## Layout

| Dir | What |
| --- | --- |
| `src/pptx/` | JSZip + DOMParser PPTX parser → `Deck`; button, Home, nav and back-link detection; validation `Issue`s |
| `src/render/` | `Deck` → DOM; `SlideStage` (letterboxed, fixed 1920-wide slide px canvas), thumbnails, raster fallback |
| `src/store/` | IndexedDB (`idb`): deck, config, kiosk state, append-only event log |
| `src/kiosk/` | Kiosk runtime: tap handling, secret exit sequence, debounce, timeout, wake lock; `glow.ts` button glow |
| `src/report/` | Stats, CSV, jsPDF report with hand-drawn canvas charts, share-sheet export |
| `src/ui/`, `src/main.ts` | Setup screen, admin panel, PIN pad, Clear previous data dialog, routing, resume-into-kiosk on launch |
| `src/types.ts`, `src/util.ts` | Shared contracts; `isoLocal()` and `uuid()` |
| `src/styles.css` | All styling: Emota `--em-` tokens mapped to semantic tokens, kiosk lock-down rules, glow keyframes |
| `public/` | `template.pptx` (hand-edited in PowerPoint), `fonts/` and `icons/` (generated), Emota logos |
| `docs/` | SPEC, ARCHITECTURE, PLAN; `docs/brand/` holds the Emota brand CSS and cheat sheet the admin UI follows |
| `scripts/` | `make-fixtures.mjs` (test fixture decks), `make-icons.mjs`, `make-fonts.mjs` |
| `tests/` | Mirrors `src/`; fixtures in `tests/fixtures/` are generated, not hand-edited |

## Rules that matter

- **No UI framework, no chart library, no runtime network.** Everything must work offline after first load; the service worker precaches the app shell, fonts and libraries.
- **12-hour unattended runs:** every `stop()`/`destroy()` removes its listeners, timers and wake lock and revokes the object URLs it created. Never rebuild slide DOM on each tap. Tap to slide change must stay under 150 ms.
- **Log durability:** `appendEvent` resolves only after the IndexedDB transaction completes. Never use `localStorage` for data. Events are append-only; the only deletions are `clearEvents` and `clearAllData` ("Clear previous data"), and each is itself logged.
- **Geometry:** all deck coordinates are slide px (slide width = `SLIDE_W` = 1920). Convert EMU in the parser only; convert screen coordinates via `SlideStage.toSlide()` only.
- **Timestamps:** use `isoLocal()` from `src/util.ts` (ISO 8601 with local offset). Compare instants, not strings.
- **Kiosk input:** the secret sequence is checked before any other tap handling. Taps that continue or complete a sequence are consumed and never trigger buttons; the first corner tap of a sequence is handled normally so corner buttons still work. Debounced taps are not logged.
- **Base path:** the app is served from a sub-path on GitHub Pages (`/stuPad/`). Never hard-code `/` URLs: use `import.meta.env.BASE_URL` in code (e.g. for `template.pptx`) and `%BASE_URL%` in `index.html`.
- **Privacy:** no personal data; nothing leaves the device except admin-initiated exports.

## Testing on an iPad

Real behaviour (share sheet, wake lock, Guided Access, Home Screen standalone mode, storage persistence) only exists on iPadOS Safari. After any change to kiosk, export or the service worker, check on a device via the Pages URL or `npm run dev`. The dev server is plain HTTP, so service worker and share sheet need the HTTPS Pages build.

## Deployment

`.github/workflows/deploy-pages.yml` runs the tests, builds with `BASE_PATH` from `actions/configure-pages`, and deploys `dist/` to GitHub Pages on every push to `main`. The repo setting is Settings → Pages → Source: **GitHub Actions**.

`main` is protected by a repository ruleset: no direct pushes, force pushes or deletion, so every change lands through a pull request. `.github/workflows/ci.yml` runs `npm test` and `npm run build` on each PR, and its `test` job must pass before merging.

**Versioning:** every push or PR to `main` is a release, so it must bump `version` in `package.json` (then `npm install --package-lock-only` to sync the lockfile). Use semver: patch (1.2.1 → 1.2.2) for fixes, tweaks and copy changes; minor (1.2.x → 1.3.0) for new features or new config options; major only for breaking changes, e.g. a deck format or stored data that older builds can't read. `package.json` is the only place to edit: `vite.config.ts` injects it as `import.meta.env.VITE_APP_VERSION`, which the Setup header and the page title (`%VITE_APP_VERSION%` in `index.html`) display. Never hard-code the version anywhere else.
