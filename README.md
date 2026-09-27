# stuPad

Offline iPad PWA that turns a structured PowerPoint deck into a self-running, touch-driven kiosk, logs every interaction, and exports CSV and PDF reports. On the iPad it appears as **GGPad**; stuPad is the codebase name.

- [docs/SPEC.md](docs/SPEC.md): what the app must do (requirements, source of truth)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works and a tour of the codebase
- [docs/PLAN.md](docs/PLAN.md): module contracts and ownership from the original build plan
- [docs/ROADMAP.md](docs/ROADMAP.md): development plan for upcoming features
- [docs/brand/](docs/brand/): Emota brand stylesheet and cheat sheet the admin UI follows

## How it works

1. **Load.** On the iPad, an admin opens the app and picks a `.pptx` from the Files app. The app unzips and parses it in the browser (no conversion, no upload).
2. **Check and preview.** Slide 1 is the home slide. Every shape on it that has PowerPoint's "Link to: Slide N" action becomes a tappable button. The app lists errors and warnings, shows the slides, and outlines the detected buttons so the admin can confirm everything looks right.
3. **Configure.** Return-to-home timeout, return methods, press feedback, an optional pulsing glow around tappable areas, transition, debounce, button labels for reports, the secret exit sequence, an optional PIN, and a session name.
4. **Go live.** After an operator checklist (Guided Access, Auto-Lock, charge) the app becomes a full-screen kiosk. The public taps a home-slide button, sees its destination slide (which may chain onward through "Next"/"Back" shapes), and returns home by a Home shape, a tap, or an idle timeout.
5. **Log.** Every press, navigation, return and missed tap is written to IndexedDB the moment it happens, so nothing is lost if the iPad restarts. Reopening the app resumes straight into the kiosk.
6. **Exit and report.** The admin taps the four screen corners in order (and enters the PIN, if set) to reach the admin panel: resume, export a CSV or PDF summary through the iOS share sheet, clear the log, clear all previous data before handing the iPad on, or go back to setup.

Everything runs on the device. After the first load there is no network use, no server, and no personal data collected.

## Preparing a deck

Download `template.pptx` from the Setup screen (or find it at `public/template.pptx`) and edit it in PowerPoint or Keynote. The rules in brief:

- Slide 1 is the home slide with at least 2 button shapes, each linked to a later slide (Insert > Link > Place in This Document). Name each shape in the Selection Pane (e.g. `BTN_Sustainability`) to get a clean label in reports.
- A destination slide can have a shape linked back to slide 1 (a Home button), shapes linked onward to other slides (Next/Back), or a "Last Slide Viewed" shape that returns to the previous slide of the visit.
- Use 16:9, static content, and fonts from the iPad or the bundled set (Inter, Lato, Montserrat, Open Sans, Roboto). Fonts embedded in the file are not used. Charts, SmartArt, video, audio and animations are not supported.

The full list is in [docs/SPEC.md](docs/SPEC.md#powerpoint-template-rules).

## Development

```bash
npm install
npm run dev          # Vite dev server on the LAN (open on the iPad via the Mac's IP)
npm test             # vitest (jsdom + fake-indexeddb)
npm run typecheck
npm run build        # typecheck + production build to dist/
npm run fixtures     # regenerate tests/fixtures/*.pptx
npm run fonts        # re-download the bundled web fonts into public/fonts and regenerate the manifest
node scripts/make-icons.mjs   # regenerate the PWA icons in public/icons
```

The dev server is plain HTTP, so the service worker and the share sheet only work on the HTTPS GitHub Pages build.

### Contributing

`main` is protected: every change goes through a pull request, and the `test` job in `.github/workflows/ci.yml` (tests plus a production build) must pass before merging. Every merge to `main` is a release, so bump `version` in `package.json` (semver) and run `npm install --package-lock-only` to sync the lockfile. The version shows in the Setup header and the page title. [CLAUDE.md](CLAUDE.md) has the full rules.

## Codebase map

| Path | What |
| --- | --- |
| `src/types.ts` | Shared contracts: deck model, config, events. Every module depends on it |
| `src/pptx/` | PPTX parser and validator, producing the `Deck` and a list of issues |
| `src/render/` | `Deck` to DOM at a fixed 1920 px-wide canvas, letterboxed to the screen; thumbnails; raster fallback |
| `src/kiosk/` | Kiosk runtime: taps, secret sequence, debounce, timeout, wake lock |
| `src/store/` | IndexedDB: deck, config, kiosk state, append-only event log |
| `src/report/` | Statistics, CSV, PDF with hand-drawn charts, share-sheet export |
| `src/ui/`, `src/main.ts` | Setup screen, admin panel, PIN pad, Clear previous data dialog, routing and resume on launch |
| `src/styles.css` | All styling, on Emota brand tokens |
| `public/` | Template deck (edited by hand), bundled fonts, PWA icons, Emota logos |
| `docs/` | Spec, architecture, build plan, and the Emota brand files in `docs/brand/` |
| `tests/` | Mirrors `src/`; fixtures are generated by `npm run fixtures` |
| `scripts/` | Test fixture, icon and font generators |
| `.github/workflows/` | PR checks (`ci.yml`) and GitHub Pages deploy (`deploy-pages.yml`) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the details.

## Deploying to GitHub Pages

Pushing to `main` runs `.github/workflows/deploy-pages.yml`, which tests, builds, and publishes to `https://grahamlehr.github.io/stuPad/`.

One-time setup: go to Settings → Pages → Build and deployment → Source and choose **GitHub Actions**. Then open the URL in Safari on the iPad, use Share → Add to Home Screen, and launch it once while online so it caches for offline use. For an event, turn on Guided Access and set Auto-Lock to Never.
