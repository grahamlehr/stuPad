# stuPad roadmap

Development plan for the next set of features, written Sep 27, 2026 against v1.2.4. Requirements stay in [SPEC.md](SPEC.md): each feature below updates SPEC (behaviour), PLAN (module APIs) and ARCHITECTURE (structure) in the same PR that ships it, per CLAUDE.md.

## Summary and order

Each row is one pull request and one release (every merge to `main` bumps `package.json`). E waits on sample decks (decision 5), so it ships after H with its own version. The order puts report-only work first (no stored-data changes, lowest risk), then new logging that later reports build on, then parser and kiosk features, with video last because it carries the most risk for 12-hour runs.

| # | Release | Feature | Size | Shared contract changes (`src/types.ts`) |
| --- | --- | --- | --- | --- |
| A | 1.2.6 | 4. Setup controls for transition length and exit window; pattern-aware hint | S | None (fields already exist) |
| B | 1.3.0 | 1. Miss-tap heatmap on the home slide (PDF) | S | None |
| C | 1.4.0 | 2. Time per slide and common paths (PDF) | M | None |
| D | 1.5.0 | 3. Heartbeat and uptime | S | `EventType += 'heartbeat'`; `KioskConfig.deviceName` |
| E | later | Embedded fonts from the .pptx | M-L | `Deck.embeddedFonts`; new `Issue` code |
| F | 1.6.0 | 5. Attract loop | M | `KioskConfig.attract`; `EventType += 'attract_start' \| 'attract_end'` |
| G | 1.7.0 | 9. Polls and ratings | M | `Deck.pollOptions`; `EventType += 'vote'`; `LogEvent.poll`, `LogEvent.choice` |
| H | 1.8.0 | 8. Video on destination slides | L | `SlideElement += VideoElement`; `EventType += 'video_end'`; `LogEvent.watched_ms` |

All contract changes are additive. New `LogEvent` fields are optional, and new `CSV_COLUMNS` are appended at the end so existing spreadsheets that read the CSV by column position keep working. Each new `Deck` or `KioskConfig` field gets a default on load in `src/store/index.ts`, following the existing `navLinks` and `glow` shims.

Parallel work: A, B and C touch only `src/ui/setup.ts` or `src/report/`, so they can run alongside D. E (parser and renderer) is independent of everything before it. F, G and H all edit `KioskController.handleTap`, so land them one after another.

Every PR: `npm run typecheck`, `npm test`, `npm run build`, then a device check on the Pages build for anything touching kiosk, export or the service worker.

---

## A. Setup controls and hint text (item 4) (done in 1.2.6)

**Goal.** Expose the two `KioskConfig` fields that have no control, and make the exit hint describe the selected pattern.

- `src/ui/setup.ts` `renderConfigureStep`:
  - Under Transition, when it is "fade": a select for `transitionMs` (150 / 300 / 500 / 800 ms).
  - Under Secret exit sequence: a select for `secretWindowMs` (3 / 5 / 8 / 10 s).
  - Replace the fixed hint with one per pattern, e.g. "Tap top-left three times, then bottom-right twice, within 5 seconds, on any slide."
- `src/ui/config-validate.ts`: `transitionMs` 0 to 1000; `secretWindowMs` 2000 to 15000.
- Also fix `index.html`: `apple-mobile-web-app-status-bar-style` must be `black-translucent` (the current `black-fullscreen` is not a valid value).
- Tests: `tests/ui/config-validate.test.ts` ranges; `tests/ui/setup.test.ts` that the hint text follows the pattern.
- Docs: SPEC settings table (remove "fixed"), ARCHITECTURE known gaps (remove the entry).

## B. Miss-tap heatmap (item 1) (done in 1.3.0)

**Goal.** Show where visitors tap on the home slide when they miss a button, to reveal buttons people expect but that don't exist, or hit areas that are too small.

- Data: `miss_tap` already logs `x`, `y` as % of the slide. No logging change.
- `src/report/stats.ts`: add `missGrid: number[][]`, a 48 × 27 grid (16:9 cells) of miss-tap counts, filled in the existing single pass. Keep raw points out of `ReportStats` so memory stays flat at 100k events.
- `src/report/charts.ts`: `drawTapHeatmap(ctx, w, h, { grid, buttons, deckHeight }, fontScale)`. Draws cells with the existing white-to-blackberry ramp at partial opacity, then the `deck.buttons` bounds as outlines with their labels. When a home thumbnail is available it is drawn underneath first.
- `src/report/pdf.ts`: a new page "Home slide taps" after Button share, only when `missTaps > 0`. Caption: miss taps as a share of all home-slide taps.
- The thumbnail can fail (Safari canvas tainting in `rasterizeSlide`). The button outlines alone still make the chart readable, so the page never depends on it.
- Tests: grid binning at the edges (x = 100 lands in the last cell), empty grid, chart with a mock context.

## C. Time per slide and common paths (item 2)

**Goal.** For decks with onward navigation, show how long people spend on each slide and which routes they take.

- `src/report/stats.ts`, new `visitPaths` pass over events in id order, grouped by `visit_id`:
  - The path is the button's target slide plus each `slide_nav.slide_to`, ended by `return_home`.
  - Time on a slide left by navigation is `slide_nav.dwell_ms` (already logged).
  - Time on the last slide of a visit is the `return_home` timestamp minus the last arrival.
  - Visits with no `return_home` (the app was killed) are left out of times but counted in paths as "(ended)".
- Output: `slideTime: { slide, visits, medianMs, meanMs }[]` and `topPaths: { path: number[], count }[]` (top 8, with the rest counted as "other").
- **Timeout skew.** A visit that ends by timeout overstates time on its last slide by up to the timeout. Report the median rather than the mean in the chart. Also show a second bar that excludes timeout-ended visits, so the skew is visible without guessing what the timeout was when the event was logged.
- `src/report/pdf.ts`: page "Slides and paths", only when `totalNavTaps > 0`. Left: horizontal bars of median time per slide. Right: a table of the top paths ("3 → 4 → T&Cs → 4", with count and %). Use slide numbers; titles are not in the deck model.
- Tests: multi-slide visit, back-link revisit (the same slide twice in a path), a visit orphaned by a kill, and a timeout-ended visit.

## D. Heartbeat and uptime (item 3)

**Goal.** Prove the kiosk ran all day, and show when it didn't (crash, battery, someone leaving the app).

- `src/types.ts`: `EventType += 'heartbeat'`. `KioskConfig.deviceName: string` (default "", shown in the PDF header so reports from different stands can be told apart). Default `''` for configs saved before the field existed.
- `src/main.ts` `App` owns the timer, not the controller, so the tap path stays untouched. It sets a 15-minute `setInterval` in `enterKiosk` and clears it in `exitToSetup` and `clearAll`. It logs `heartbeat` on each tick. No extra log on resume: `app_resume` is already logged.
- iOS suspends timers when the app is backgrounded or the screen locks. The resulting gap in heartbeats is exactly the downtime signal we want.
- `src/report/stats.ts`: `uptime` from the running spans (`kiosk_start`/`app_resume` to `kiosk_stop` or the last event). Any gap longer than 20 minutes between consecutive events inside a span counts as down. Output: `uptimeMs`, `downtimeMs`, `gaps: { from, to }[]`.
- PDF: an "Uptime 97%" tile on Summary, and a thin up/down strip under the Activity chart.
- Setup: a "Device name" field (e.g. "Stand A"). It is printed in the PDF header.
- Volume: about 100 events a day, negligible against the 100k target.
- Tests: fake timers for the interval and its cleanup on stop; stats gap detection across midnight and across a `kiosk_stop`/`kiosk_start`.

## E. Embedded fonts from the .pptx

**Goal.** A deck that embeds its fonts (File > Options > Save > Embed fonts in PowerPoint) renders in those fonts instead of falling back with a warning.

**How PowerPoint stores them.**
- `ppt/presentation.xml` has `<p:embeddedFontLst>`. Each `<p:embeddedFont>` holds `<p:font typeface="…">` and up to four relationships: `<p:regular>`, `<p:bold>`, `<p:italic>`, `<p:boldItalic>`.
- Each relationship points at `ppt/fonts/fontN.fntdata`. These files are Embedded OpenType (EOT): a header, then the TrueType data. The data may be XOR-obfuscated (header flag `0x10000000`, key `0x50`) and may be MicroType Express compressed (flag `0x4`).
- Browsers don't load EOT, so the parser must unwrap it to plain TrueType.

**Phase E0, spike (first, before code).** Collect real decks saved with embedded fonts from PowerPoint for Windows, PowerPoint for Mac and PowerPoint for the web. Record for each: the EOT version, the flags, and whether the font is subsetted ("embed only characters used"). This settles whether MicroType Express decompression is needed on day one. If every sample is uncompressed, ship E1 alone and treat compressed fonts as a warning.

**Phase E1, uncompressed EOT.**
- `src/pptx/embedded-fonts.ts` (new):
  - `readEmbeddedFonts(pkg, presDoc, presRels)` → `{ fonts: EmbeddedFontDef[], issues }`.
  - `eotToTtf(bytes)` parses the EOT header: `EOTSize`, `FontDataSize`, `Version`, `Flags`, then skips the padded name records. It un-XORs if flagged and returns the TrueType bytes, or `null` for compressed data.
  - The result is stored as a media blob (`font/ttf`) under a key like `fonts/<family>-<bold|regular>-<italic|normal>.ttf`.
- `src/types.ts`: `EmbeddedFontDef { family; weight: 400 | 700; style: 'normal' | 'italic'; mediaKey }` and `Deck.embeddedFonts: EmbeddedFontDef[]` (`[]` on load for older decks). Also a new `Issue` code `embedded_font_unreadable` (warning), added to `ISSUE_LABELS` in Setup.
- `src/pptx/validate.ts`: a family with a decoded embedded font no longer raises `missing_font`. A family whose font was embedded but can't be decoded raises `embedded_font_unreadable` instead, naming the family and saying it will fall back.
- `src/render/fonts.ts`:
  - `registerDeckFonts(deck)` creates `new FontFace(family, arrayBuffer, { weight, style })` for each entry and adds it to `document.fonts`. It returns a disposer that deletes them.
  - `SlideStage` calls it in the constructor and the disposer in `destroy()`, alongside the object URLs it already revokes. Thumbnails use the same registration.
  - `preloadDeckFonts` waits on these faces too.
  - The raster fallback's `embeddedFontCss` also inlines the deck's fonts as `data:font/ttf` URLs, so image mode and the PDF thumbnail use them.
- Name collisions: an embedded family with the same name as a bundled font (e.g. an embedded Montserrat subset) wins inside slides only. `.sr-slide` scopes it, and the admin UI keeps using the bundled file.
- Licensing: PowerPoint only embeds fonts whose `fsType` allows it. Rendering them in the same deck on a display is within "preview and print" permission, so no extra check is needed, but document it in SPEC.
- Fixtures: pptxgenjs cannot embed fonts. `scripts/make-fixtures.mjs` gains `embedded-font.pptx`, built by patching `good.pptx` with JSZip: add a small OFL TrueType file wrapped in an EOT header (one plain, one XOR-flagged) plus the `embeddedFontLst` entries. The source TTF is checked in under `tests/fixtures/fonts/` with its licence.
- Tests: EOT header parsing (version 0x00020001 and 0x00020002, XOR, compressed → null), `missing_font` suppression, FontFace registration and disposal (stub `FontFace`/`document.fonts` in jsdom).

**Phase E2, MicroType Express (only if E0 finds compressed fonts in the wild).** Port an MTX decoder (LZCOMP plus the CTF glyph transforms; the reference is the open-source `libeot`) into `src/pptx/mtx.ts`. It's roughly 1,000 lines. It has to be bundled locally (no runtime network) and lazy-imported, so it costs nothing for decks without compressed fonts. Test against the E0 sample files.

**Docs.** SPEC "Fonts" (embedded fonts now honoured), README deck rules, ARCHITECTURE parser and render sections, and ARCHITECTURE known gaps (remove the entry).

## F. Attract loop (item 5)

**Goal.** Draw people in when nobody has touched the kiosk for a while.

- Config: `KioskConfig.attract: { enabled: false, idleSec: 60, mode: 'cycle' | 'pulse', slides: number[], slideSec: 6 }`, default off.
  - **cycle** crossfades through the chosen slides.
  - **pulse** stays on Home and runs a stronger glow (reusing `glow.ts`) with a "Tap to start" overlay.
  - Setup gets a toggle, idle time, mode, and in cycle mode checkboxes on the slide thumbnails to pick attract slides (Home is always included).
- Kiosk (`src/kiosk/index.ts`):
  - A new third mode, `attract`. On Home, an idle timer starts after the last accepted tap. When it fires, the kiosk logs `attract_start` and cycles with `stage.show()` (layers already exist, so no DOM rebuild).
  - The first tap in attract mode stops the loop, shows Home and logs `attract_end` with `dwell_ms`. The tap never presses a button, in either mode and even when the loop happens to be showing Home (decided): it only wakes the kiosk.
  - The secret sequence still takes priority in attract mode.
- 12-hour safety: the cycle uses one `setTimeout` chain, cleared in `stop()` and on every mode change. Pulse mode adds one CSS class, and only `opacity` animates.
- Stats and PDF:
  - Engagement in the Activity chart shows attract periods as shaded bands.
  - A Summary tile "Taps that ended an attract loop" / attract starts gives the pull-in rate.
  - Miss taps during attract are not logged, which keeps B's heatmap clean.
- Tests: controller flows with fake timers (idle to attract, tap to Home with no press, the secret sequence during attract, stop clears timers).

## G. Polls and ratings (item 9)

**Goal.** Let a deck ask a question ("Which topic matters most?", "Rate this stand 1 to 5") without collecting personal data.

- Authoring convention (same spirit as `BTN_` names): a shape named `VOTE_<poll>_<choice>` is a poll option, e.g. `VOTE_Topic_Sustainability` or `RATE_Stand_4`. It may sit on any slide.
  - If it also has a slide link, the kiosk records the vote and then follows the link, so "vote then see a thank-you slide" needs no new concept.
  - Without a link it records the vote and shows press feedback plus a brief "Thanks" overlay.
- Parser (`src/pptx/buttons.ts`): `detectPollOptions` → `Deck.pollOptions: { slide, id, poll, choice, bounds, targetSlide? }[]`.
  - On the home slide, a poll option with a link is also a normal button, logging `button_press` and `vote`. Without a link it is not counted toward the two-button minimum.
  - Validation warnings: a poll with one option, or the same choice twice.
- Kiosk: hit-test poll options before nav links on destination slides and before buttons on Home. Log `vote` with `poll` and `choice`. It's one vote per poll per visit: repeat taps in the same visit update nothing and are not logged. Home-slide polls have no visit, so the debounce plus a per-poll 3 s cooldown applies.
- Setup: poll options appear outlined in the preview; labels can be renamed like buttons.
- PDF: page "Poll results" per poll: bar chart of choices with counts and %. For `RATE_` polls, add the mean score.
- Tests: name parsing (underscores in choice names), vote once per visit, link-then-navigate, CSV columns.
- Stats (decision 4): a home-slide vote with no link is not a visit, because it has no destination, dwell or return. `computeStats` adds `homeVotes` and `interactions` (visits plus home-slide votes without a link). Summary shows an "Interactions" tile as the headline engagement count, and Poll results counts every vote. Visits, average dwell, Return behaviour and Button share count real visits only, so their totals stay consistent. A vote shape with a link starts a normal visit and counts once, as that visit.

## H. Video on destination slides (item 8)

**Goal.** Play videos that are embedded in the deck (the most common v2 ask).

**Today.** A video in PowerPoint is a `<p:pic>` whose `nvPr` holds `<a:videoFile r:link>` and a `p14:media r:embed` extension. The parser reads it as a plain picture, so the kiosk shows the poster frame silently, with no warning.

- Parser (`src/pptx/shapes.ts`): detect `a:videoFile` / `p14:media`. Resolve the embedded media rel (MP4/MOV/M4V; other formats and linked, non-embedded files get an `unsupported_element` warning). Emit `VideoElement { kind: 'video', mediaKey, posterKey, loop, autoplay }`. Read playback options from the slide timing XML where present, else autoplay on arrival.
- `src/types.ts`: `VideoElement` joins the `SlideElement` union. Every `switch (el.kind)` must handle it: `renderElement` and the rasteriser's media walk in `src/render/index.ts`, text/font collection in `src/pptx/deck.ts` and `buttons.ts`, and glow radius lookup.
- Renderer: `<video playsinline preload="metadata" poster>` with an object URL, revoked in `destroy()`. The stage gains `onShow(slide)` / `onHide(slide)` hooks so the controller can play on arrival and pause plus rewind on leaving. Only one video is ever playing. Image mode shows the poster.
- Sound: videos always play muted (decided), whatever the deck's own volume setting. Muted `playsinline` video may autoplay in iPad Safari without a user gesture, so `play()` can wait until the fade has finished. There is no volume control, and the operator checklist's "volume set" item stays as it is.
- Timeout interaction (decided): while a video plays, the return-to-home timeout and idle warning are paused, and they restart from the full timeout when the video ends. Otherwise a 20 s timeout cuts off a 60 s film. A looping video never ends, so for loops the timeout restarts after the first full play. A video that stalls or errors resumes the timeout at once, so a broken file can never trap the kiosk on a slide.
- Logging: `video_end` with `watched_ms` and `slide_from`, logged when the visitor leaves the slide or the video finishes (not on every play, to keep volume low).
- Size: videos count toward the 100 MB deck limit. The Check step shows total video size, and a warning above 50 MB points to storage headroom on the iPad.
- 12-hour safety: a soak run with a looping video slide, checking memory in Safari Web Inspector. Video decode is the most likely source of memory growth in the whole roadmap.
- PDF: a "Video" section on the Slides page: plays, median watched time, % watched to the end.
- Tests: parser detection on a fixture patched with a tiny MP4 (a few KB, generated once, checked in), controller play/pause/timeout pause with a stubbed `HTMLMediaElement`.

---

## Decisions

Agreed Sep 27, 2026:

1. **Attract loop:** the tap that ends the loop only wakes the kiosk and never presses a button, even when the loop is showing Home.
2. **Polls:** one vote per poll per visit; repeat taps in the same visit are not logged.
3. **Video:** always muted. The return-to-home timeout pauses while a video plays.
4. **Home-slide votes:** a vote on Home with no link is counted as an interaction (a new Summary headline: visits plus these votes) and on Poll results, but not as a visit, so dwell, return behaviour and Button share stay consistent.

Waiting on:

5. **Embedded fonts:** Graham is finding a deck with an embedded font for the E0 spike. E1 can start once one sample is in hand; more samples (PowerPoint for Windows, Mac and web) would settle whether E2 is needed.
