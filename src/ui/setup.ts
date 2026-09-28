/**
 * Setup screen: one scrolling screen with five steps (SPEC "Admin setup flow"):
 * Load -> Check -> Preview -> Configure -> Go live.
 */
import type { Deck, Issue, KioskConfig, ButtonDef, PollOptionDef, Rect, GlowConfig, AttractConfig } from '../types';
import { defaultConfig, pollLabelKey, GLOW_INTENSITY_MIN, GLOW_INTENSITY_MAX, GLOW_PERIOD_MIN_MS, GLOW_PERIOD_MAX_MS } from '../types';
import { parsePptx, validateDeck, totalVideoBytes } from '../pptx';
import { SlideStage, renderThumbnail, rasterizeDeck, releaseThumbnails } from '../render';
import { checklist, acquireWakeLock } from '../kiosk';
import { applyGlowStyle, createGlowLayer } from '../kiosk/glow';
import { saveDeck, saveConfig, countEvents } from '../store';
import { uuid } from '../util';
import { validateConfig } from './config-validate';
import { h, clear, debounce, fmtBytes } from './dom';
import { openClearDataModal } from './clear-data';

export interface SetupDeps {
  container: HTMLElement;
  initialDeck?: Deck;
  initialConfig?: KioskConfig;
  /** Called once the admin confirms Go Live. */
  onGoLive: (deck: Deck, config: KioskConfig, sessionId: string) => void;
  /** "Clear previous data" confirmed: caller wipes storage and restarts on an empty Setup. */
  onClearAll: () => Promise<void>;
}

/** Ready-made glow colours shown as swatches; any other colour comes from the colour picker. */
export const GLOW_SWATCHES: { color: string; name: string }[] = [
  { color: '#ffffff', name: 'White' },
  { color: '#ffc400', name: 'Gold' },
  { color: '#ff7a00', name: 'Orange' },
  { color: '#ff3b6b', name: 'Pink' },
  { color: '#39e67a', name: 'Green' },
  { color: '#00d4ff', name: 'Cyan' },
  { color: '#6b7cff', name: 'Blue' },
];

/** Options for the Transition "Length" select (`KioskConfig.transitionMs`). */
const TRANSITION_MS_OPTIONS = [150, 300, 500, 800];

/** Options for the Secret exit sequence "Window" select (`KioskConfig.secretWindowMs`). */
const SECRET_WINDOW_MS_OPTIONS = [3000, 5000, 8000, 10000];

/** Options for the Attract loop "Idle time" select (`KioskConfig.attract.idleSec`). */
const ATTRACT_IDLE_SEC_OPTIONS = [30, 60, 120, 300];
/** Options for the Attract loop "Seconds per slide" select (`KioskConfig.attract.slideSec`, cycle mode only). */
const ATTRACT_SLIDE_SEC_OPTIONS = [4, 6, 8, 12];

/** Label for an idle-time value: seconds under a minute, else "N min". */
function formatIdleSec(v: number): string {
  if (v < 60) return `${v} s`;
  const min = v / 60;
  return `${Number.isInteger(min) ? min : min.toFixed(1)} min`;
}

/**
 * Describes what to tap for each `SecretPattern`, in the exact corner order the
 * `SecretSequenceDetector` in src/kiosk/index.ts expects (its `SECRET_PATTERNS` map).
 * Kept as a small literal here rather than importing that map, since it's UI copy, not
 * detector logic.
 */
const SECRET_PATTERN_HINTS: Record<KioskConfig['secretPattern'], string> = {
  corners_cw: 'Tap top-left, top-right, bottom-right, then bottom-left',
  corners_ccw: 'Tap top-left, bottom-left, bottom-right, then top-right',
  tl3_br2: 'Tap top-left three times, then bottom-right twice',
};

/** Hint text under "Secret exit sequence", reflecting the selected pattern and window. */
function secretSequenceHint(pattern: KioskConfig['secretPattern'], windowMs: number): string {
  return `${SECRET_PATTERN_HINTS[pattern]}, within ${windowMs / 1000} seconds, on any slide.`;
}

const ISSUE_LABELS: Record<Issue['code'], string> = {
  unreadable_file: 'Could not read the file',
  too_few_buttons: 'Not enough buttons',
  broken_link: 'Broken button link',
  no_slides: 'No slides',
  unlinked_slide: 'Unlinked slide',
  missing_font: 'Missing font',
  unsupported_element: 'Unsupported element',
  non_16_9: 'Non 16:9 slide size',
  no_home_link: 'No home link',
  too_large: 'File too large',
  small_button: 'Small button',
  self_link: 'Self link',
  poll_single_option: 'Poll has one option',
  poll_duplicate_choice: 'Duplicate poll choice',
  poll_bad_rating: 'Non-numeric rating choice',
  poll_mixed_kind: 'Poll mixes vote and rating',
  large_video: 'Large video total',
};

export class SetupScreen {
  private deck: Deck | undefined;
  private issues: Issue[] = [];
  private config: KioskConfig;
  private acceptedWarnings = false;
  private parsing = false;
  private fileInfo: { name: string; size: number } | undefined;
  private previewSlide = 1;
  /** Destination slides visited in the preview since leaving slide 1, for back links. */
  private previewPath: number[] = [];
  private previewStage: SlideStage | undefined;
  /** The glow layer in the live preview, restyled in place while a glow slider moves. */
  private previewGlowLayer: HTMLElement | undefined;
  private goLiveBusy = false;

  private readonly root: HTMLElement;
  private readonly saveDebounced = debounce(() => this.persist(), 400);

  constructor(private readonly deps: SetupDeps) {
    this.deck = deps.initialDeck;
    this.config = deps.initialConfig ?? defaultConfig('deck');
    if (this.deck) {
      this.fileInfo = { name: this.deck.fileName, size: 0 };
      // No raw file bytes for a deck loaded from storage (only `parsePptx` sees those), so
      // re-run the deck-level checks the Check step still needs to show.
      this.issues = validateDeck(this.deck);
    }
    this.root = h('div', { class: 'setup-screen' });
    deps.container.appendChild(this.root);
    this.render();
  }

  destroy(): void {
    // A pending autosave must not re-save this deck after "Clear previous data" wiped it.
    this.saveDebounced.cancel();
    this.destroyPreview();
    this.root.remove();
  }

  /** Tears down the live preview (ResizeObserver + object URLs) — every teardown path goes through here. */
  private destroyPreview(): void {
    this.previewStage?.destroy();
    this.previewStage = undefined;
    releaseThumbnails();
  }

  private persist(): void {
    if (this.deck) void saveDeck(this.deck);
    void saveConfig(this.config);
  }

  // ------------------------------------------------------------- render

  /**
   * Full rebuild of the screen. `clear(this.root)` would otherwise detach the live preview's
   * DOM (and any thumbnails) without tearing it down first, leaking its ResizeObserver and
   * object URLs on every re-render — so always destroy it first; `renderPreviewStep` below
   * mounts a fresh one when a deck is loaded.
   */
  private render(): void {
    this.destroyPreview();
    clear(this.root);
    this.root.append(
      h('header', { class: 'setup-header' }, [
        h('div', { class: 'setup-title-row' }, [
          h('div', {}, [
            h('h1', {}, ['GGPad setup']),
            h('p', { class: 'setup-version' }, [`v${import.meta.env.VITE_APP_VERSION}`]),
          ]),
          emotaLogo(),
        ]),
        h('p', { class: 'setup-sub' }, ['Load linked PowerPoint, configure the kiosk, go live, run reports.']),
      ]),
      this.renderLoadStep(),
      this.renderCheckStep(),
      this.renderPreviewStep(),
      this.renderConfigureStep(),
      this.renderGoLiveStep(),
    );
  }

  /**
   * Replaces a single `data-step` section in place, without touching the rest of the screen —
   * in particular without tearing down and remounting the live preview (SlideStage +
   * thumbnails) for a change that doesn't affect it, e.g. accepting warnings.
   */
  private replaceStep(step: string, el: HTMLElement): void {
    const existing = this.root.querySelector(`[data-step="${step}"]`);
    if (existing) existing.replaceWith(el);
  }

  // -------------------------------------------------------------- 1. load

  private renderLoadStep(): HTMLElement {
    const base = import.meta.env.BASE_URL;
    const fileInput = h('input', {
      type: 'file',
      accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation',
      id: 'file-input',
      class: 'sr-only-input',
      onchange: (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) void this.loadFile(file);
      },
    });

    return h('section', { class: 'setup-step', 'data-step': 'load' }, [
      h('h2', {}, ['1. Load']),
      h('div', { class: 'load-row' }, [
        fileInput,
        h('label', { class: 'btn btn-primary btn-big', for: 'file-input' }, ['Choose .pptx…']),
        h('a', { class: 'btn btn-ghost', href: `${base}template.pptx`, download: true }, ['Download template deck']),
        h(
          'button',
          {
            class: 'btn btn-ghost clear-data-btn',
            type: 'button',
            onclick: () => void openClearDataModal({ deckName: this.deck?.fileName, onConfirm: this.deps.onClearAll }),
          },
          ['Clear previous data'],
        ),
      ]),
      this.parsing ? h('p', { class: 'load-status' }, ['Parsing…']) : null,
      this.fileInfo && !this.parsing
        ? h('p', { class: 'load-status' }, [`${this.fileInfo.name} · ${fmtBytes(this.fileInfo.size)}`])
        : null,
    ]);
  }

  private async loadFile(file: File): Promise<void> {
    this.parsing = true;
    this.fileInfo = { name: file.name, size: file.size };
    this.acceptedWarnings = false;
    this.render();

    const result = await parsePptx(file, file.name);
    this.parsing = false;
    this.deck = result.deck;
    this.issues = result.issues;
    this.previewSlide = 1;
    this.previewPath = [];
    if (this.deck) {
      // Device name describes the iPad, not the deck (SPEC "Configurable settings"), so it's
      // the one setting that survives loading a new file instead of resetting to default.
      this.config = { ...defaultConfig(file.name), buttonLabels: {}, deviceName: this.config.deviceName };
      this.mountPreview();
      this.persist();
    }
    this.render();
  }

  // ------------------------------------------------------------- 2. check

  private renderCheckStep(): HTMLElement {
    if (!this.deck && this.issues.length === 0) {
      return h('section', { class: 'setup-step setup-step--disabled', 'data-step': 'check' }, [
        h('h2', {}, ['2. Check']),
        h('p', { class: 'muted' }, ['Load a deck first.']),
      ]);
    }
    const errors = this.issues.filter((i) => i.severity === 'error');
    const warnings = this.issues.filter((i) => i.severity === 'warning');
    // Videos count toward the 100 MB deck limit already; this is the video-specific total the
    // large_video warning refers to (SPEC "Admin setup flow"), shown whenever the deck has any.
    const videoBytes = this.deck ? totalVideoBytes(this.deck) : 0;

    return h('section', { class: 'setup-step', 'data-step': 'check' }, [
      h('h2', {}, ['2. Check']),
      videoBytes > 0 ? h('p', { class: 'muted' }, [`Total video size: ${fmtBytes(videoBytes)}`]) : null,
      errors.length === 0 && warnings.length === 0
        ? h('p', { class: 'issue-ok' }, ['No issues found.'])
        : null,
      errors.length > 0
        ? h('div', { class: 'issue-group issue-group--error' }, [
            h('h3', {}, [`Errors (${errors.length}) — must fix before going live`]),
            h(
              'ul',
              {},
              errors.map((i) => h('li', {}, [this.issueText(i)])),
            ),
          ])
        : null,
      warnings.length > 0
        ? h('div', { class: 'issue-group issue-group--warning' }, [
            h('h3', {}, [`Warnings (${warnings.length})`]),
            h(
              'ul',
              {},
              warnings.map((i) => h('li', {}, [this.issueText(i)])),
            ),
            h('label', { class: 'checkbox-row' }, [
              h('input', {
                type: 'checkbox',
                checked: this.acceptedWarnings,
                onchange: (e: Event) => {
                  this.acceptedWarnings = (e.target as HTMLInputElement).checked;
                  // Only the check step's own text and the Go live step's ready-state depend
                  // on this — no need to tear down and remount the live preview for it.
                  this.replaceStep('check', this.renderCheckStep());
                  this.replaceStep('golive', this.renderGoLiveStep());
                },
              }),
              ' I accept these warnings',
            ]),
          ])
        : null,
    ]);
  }

  private issueText(i: Issue): string {
    const label = ISSUE_LABELS[i.code] ?? i.code;
    return i.slide !== undefined ? `Slide ${i.slide}: ${label} — ${i.message}` : `${label} — ${i.message}`;
  }

  private hasBlockingErrors(): boolean {
    return this.issues.some((i) => i.severity === 'error');
  }

  private warningsAccepted(): boolean {
    const hasWarnings = this.issues.some((i) => i.severity === 'warning');
    return !hasWarnings || this.acceptedWarnings;
  }

  // ----------------------------------------------------------- 3. preview

  private renderPreviewStep(): HTMLElement {
    if (!this.deck) {
      return h('section', { class: 'setup-step setup-step--disabled', 'data-step': 'preview' }, [
        h('h2', {}, ['3. Preview']),
        h('p', { class: 'muted' }, ['Load a deck first.']),
      ]);
    }
    const deck = this.deck;
    const unlinkedSlides = new Set(
      this.issues.filter((i) => i.code === 'unlinked_slide' && i.slide !== undefined).map((i) => i.slide),
    );

    const stageHost = h('div', { class: 'preview-stage', id: 'preview-stage' });
    const backBtn = h(
      'button',
      {
        class: 'btn btn-ghost',
        type: 'button',
        disabled: this.previewSlide === 1,
        onclick: () => this.showPreviewSlide(1),
      },
      ['Back to home'],
    );

    const thumbs = deck.slides.map((s) =>
      h('div', { class: `thumb${unlinkedSlides.has(s.index) ? ' thumb--unlinked' : ''}` }, [
        renderThumbnail(deck, s.index, 160),
        h('span', { class: 'thumb-label' }, [`Slide ${s.index}${unlinkedSlides.has(s.index) ? ' (unlinked)' : ''}`]),
      ]),
    );

    const section = h('section', { class: 'setup-step', 'data-step': 'preview' }, [
      h('h2', {}, ['3. Preview']),
      h('div', { class: 'preview-toolbar' }, [
        backBtn,
        h('label', { class: 'checkbox-row' }, [
          h('input', {
            type: 'checkbox',
            checked: deck.slides.some((s) => s.rasterKey),
            onchange: (e: Event) => void this.toggleRaster((e.target as HTMLInputElement).checked),
          }),
          ' Use image mode (fallback rendering)',
        ]),
      ]),
      stageHost,
      h('h3', {}, ['All slides']),
      h('div', { class: 'thumb-grid' }, thumbs),
    ]);

    // Mount the live stage after the element exists in the tree.
    queueMicrotask(() => this.mountPreview(stageHost));
    return section;
  }

  private mountPreview(host?: HTMLElement): void {
    if (!this.deck) return;
    const stageHost = host ?? (this.root.querySelector('#preview-stage') as HTMLElement | null);
    if (!stageHost) return;
    this.previewStage?.destroy();
    this.previewStage = new SlideStage(stageHost, this.deck, { useRaster: this.config.useRaster });
    void this.previewStage.show(this.previewSlide, { type: 'none', ms: 0 });
    this.drawPreviewOverlay();
  }

  private drawPreviewOverlay(): void {
    if (!this.previewStage || !this.deck) return;
    const overlay = this.previewStage.overlay;
    overlay.innerHTML = '';
    overlay.style.pointerEvents = 'none';
    this.previewGlowLayer = undefined;
    if (this.config.glow.enabled) {
      this.previewGlowLayer = createGlowLayer(this.deck, this.previewSlide, this.config.glow);
      overlay.appendChild(this.previewGlowLayer);
    }
    if (this.previewSlide === 1) {
      for (const button of this.deck.buttons) {
        const label = this.config.buttonLabels[button.id] ?? button.defaultLabel;
        this.addPreviewOutline(overlay, button.bounds, label, () => this.showPreviewSlide(button.targetSlide), {
          buttonId: button.id,
        });
      }
    } else {
      // Destination slides: outline any onward nav links the same way, so "Tapping a
      // button in preview navigates as it will in kiosk mode" (SPEC) also covers chained
      // slides, not just the home <-> destination pair.
      for (const nav of this.deck.navLinks ?? []) {
        if (nav.slide !== this.previewSlide) continue;
        this.addPreviewOutline(overlay, nav.bounds, nav.label, () => this.showPreviewSlide(nav.targetSlide));
      }
      for (const back of this.deck.backLinks ?? []) {
        if (back.slide !== this.previewSlide) continue;
        this.addPreviewOutline(overlay, back.bounds, back.label, () => this.previewGoBack());
      }
    }

    // Poll/rating options can sit on any slide, including Home alongside buttons (ROADMAP
    // "Polls and ratings"); outlined distinctly (dashed) and labelled "poll: choice".
    // Tapping one in preview follows its link exactly as the kiosk would, without logging.
    for (const opt of this.deck.pollOptions ?? []) {
      if (opt.slide !== this.previewSlide) continue;
      const label = `${this.pollLabel(opt)}: ${this.pollChoiceLabel(opt)}`;
      this.addPreviewOutline(
        overlay,
        opt.bounds,
        label,
        () => {
          if (!opt.linked) return;
          if (opt.targetSlide !== undefined) this.showPreviewSlide(opt.targetSlide);
          else this.previewGoBack();
        },
        { extraClass: 'preview-poll-outline', pollKey: pollLabelKey(opt.poll, opt.choice) },
      );
    }
  }

  /** Display name for a poll (the raw poll segment, prettified the same way choice labels are). */
  private pollLabel(opt: PollOptionDef): string {
    const stripped = opt.poll.replace(/[_-]+/g, ' ').trim();
    return stripped || opt.poll;
  }

  /** A poll option's choice label, honouring an admin rename from Configure. */
  private pollChoiceLabel(opt: PollOptionDef): string {
    return this.config.pollLabels[pollLabelKey(opt.poll, opt.choice)] ?? opt.label;
  }

  /** Mirrors the kiosk's "Last Slide Viewed": previous slide of this preview visit, else Home. */
  private previewGoBack(): void {
    this.previewPath.pop();
    const target = this.previewPath[this.previewPath.length - 1] ?? 1;
    this.showPreviewSlide(target, false);
  }

  private addPreviewOutline(
    overlay: HTMLElement,
    bounds: Rect,
    label: string,
    onTap: () => void,
    opts: { buttonId?: string; pollKey?: string; extraClass?: string } = {},
  ): void {
    const { buttonId, pollKey, extraClass } = opts;
    const box = h(
      'div',
      { class: `preview-btn-outline${extraClass ? ` ${extraClass}` : ''}`, style: { pointerEvents: 'auto' } },
      [h('span', { class: 'preview-btn-label' }, [label])],
    );
    box.style.position = 'absolute';
    box.style.left = `${bounds.x}px`;
    box.style.top = `${bounds.y}px`;
    box.style.width = `${bounds.w}px`;
    box.style.height = `${bounds.h}px`;
    if (buttonId !== undefined) box.dataset.buttonId = buttonId;
    if (pollKey !== undefined) box.dataset.pollKey = pollKey;
    box.addEventListener('click', onTap);
    overlay.appendChild(box);
  }

  /** Updates a home-slide button's outline label in the live preview in place, as its label field is typed. */
  private updatePreviewLabel(buttonId: string, label: string): void {
    const outlines = this.previewStage?.overlay.querySelectorAll<HTMLElement>('.preview-btn-outline') ?? [];
    for (const box of outlines) {
      if (box.dataset.buttonId !== buttonId) continue;
      const span = box.querySelector('.preview-btn-label');
      if (span) span.textContent = label;
    }
  }

  /** Updates a poll option's outline label in the live preview in place, as its label field is typed. */
  private updatePreviewPollLabel(pollKey: string, label: string): void {
    const outlines = this.previewStage?.overlay.querySelectorAll<HTMLElement>('.preview-poll-outline') ?? [];
    for (const box of outlines) {
      if (box.dataset.pollKey !== pollKey) continue;
      const span = box.querySelector('.preview-btn-label');
      if (span) span.textContent = label;
    }
  }

  private showPreviewSlide(index: number, record = true): void {
    if (index === 1) this.previewPath = [];
    else if (record) this.previewPath.push(index);
    this.previewSlide = index;
    void this.previewStage?.show(index, { type: 'none', ms: 0 });
    this.drawPreviewOverlay();
    const backBtn = this.root.querySelector('.preview-toolbar .btn-ghost') as HTMLButtonElement | null;
    if (backBtn) backBtn.disabled = index === 1;
  }

  private async toggleRaster(useRaster: boolean): Promise<void> {
    if (!this.deck) return;
    if (useRaster) {
      const before = this.deck.slides.length;
      this.deck = await rasterizeDeck(this.deck);
      const failed = this.deck.slides.filter((s) => !s.rasterKey).length;
      this.config = { ...this.config, useRaster: true };
      if (failed > 0) {
        // eslint-disable-next-line no-alert
        alert(`${failed} of ${before} slide(s) could not be rasterised and will render live instead.`);
      }
    } else {
      this.config = { ...this.config, useRaster: false };
    }
    this.persist();
    this.render();
  }

  // ---------------------------------------------------------- 4. configure

  private renderConfigureStep(): HTMLElement {
    if (!this.deck) {
      return h('section', { class: 'setup-step setup-step--disabled', 'data-step': 'configure' }, [
        h('h2', {}, ['4. Configure']),
        h('p', { class: 'muted' }, ['Load a deck first.']),
      ]);
    }
    const cfg = this.config;

    // Selects and checkboxes can change which controls exist, so they re-render the screen.
    const update = (patch: Partial<KioskConfig>) => {
      this.config = { ...this.config, ...patch };
      this.saveDebounced();
      this.render();
    };
    // Typed fields must not: a full render replaces the focused input (the iPad keyboard
    // closes after every character) and remounts the preview. Refresh only what depends on
    // the value: this step's error list and the Go live button.
    const edit = (patch: Partial<KioskConfig>) => {
      this.config = { ...this.config, ...patch };
      this.saveDebounced();
      this.refreshConfigErrors();
      this.replaceStep('golive', this.renderGoLiveStep());
    };

    const buttonLabelRows = this.deck.buttons.map((b: ButtonDef) =>
      h('label', { class: 'field-row' }, [
        h('span', {}, [b.defaultLabel]),
        h('input', {
          type: 'text',
          value: cfg.buttonLabels[b.id] ?? b.defaultLabel,
          oninput: (e: Event) => {
            const label = (e.target as HTMLInputElement).value;
            edit({ buttonLabels: { ...this.config.buttonLabels, [b.id]: label } });
            if (this.previewSlide === 1) this.updatePreviewLabel(b.id, label);
          },
        }),
      ]),
    );

    const timeoutOff = cfg.timeoutSec === null;

    return h('section', { class: 'setup-step', 'data-step': 'configure' }, [
      h('h2', {}, ['4. Configure']),

      h('h3', {}, ['Session name']),
      h('input', {
        type: 'text',
        value: cfg.sessionName,
        oninput: (e: Event) => edit({ sessionName: (e.target as HTMLInputElement).value }),
      }),

      h('h3', {}, ['Device name']),
      h('input', {
        type: 'text',
        value: cfg.deviceName,
        maxlength: '40',
        placeholder: 'e.g. Stand A',
        oninput: (e: Event) => edit({ deviceName: (e.target as HTMLInputElement).value }),
      }),

      h('h3', {}, ['Button labels']),
      h('div', { class: 'field-list' }, buttonLabelRows),

      this.pollLabelFields(cfg, edit),

      h('h3', {}, ['Return-to-home timeout']),
      h('label', { class: 'checkbox-row' }, [
        h('input', {
          type: 'checkbox',
          checked: timeoutOff,
          onchange: (e: Event) =>
            update({ timeoutSec: (e.target as HTMLInputElement).checked ? null : 20 }),
        }),
        ' Off',
      ]),
      timeoutOff
        ? null
        : h('input', {
            type: 'number',
            min: '5',
            max: '300',
            value: String(cfg.timeoutSec ?? 20),
            oninput: (e: Event) => edit({ timeoutSec: Number((e.target as HTMLInputElement).value) }),
          }),

      h('h3', {}, ['Return method']),
      h('div', { class: 'field-list' }, [
        this.checkboxField('Home button', cfg.returnMethods.homeButton, (v) =>
          update({ returnMethods: { ...cfg.returnMethods, homeButton: v } }),
        ),
        this.checkboxField('Tap anywhere', cfg.returnMethods.tapAnywhere, (v) =>
          update({ returnMethods: { ...cfg.returnMethods, tapAnywhere: v } }),
        ),
        this.checkboxField('Timeout', cfg.returnMethods.timeout, (v) =>
          update({ returnMethods: { ...cfg.returnMethods, timeout: v } }),
        ),
      ]),

      this.checkboxField('Idle warning (countdown in last 5s)', cfg.idleWarning, (v) => update({ idleWarning: v })),

      h('h3', {}, ['Button press feedback']),
      this.selectField(cfg.pressFeedback, ['none', 'highlight', 'scale'], (v) =>
        update({ pressFeedback: v as KioskConfig['pressFeedback'] }),
      ),

      this.glowFields(cfg, update),

      this.attractFields(cfg, update),

      h('h3', {}, ['Transition']),
      this.selectField(cfg.transition, ['none', 'fade'], (v) => update({ transition: v as KioskConfig['transition'] })),
      cfg.transition === 'fade'
        ? h('label', { class: 'field-row' }, [
            h('span', {}, ['Length']),
            this.numberSelectField(cfg.transitionMs, TRANSITION_MS_OPTIONS, (v) => update({ transitionMs: v }), (v) => `${v} ms`),
          ])
        : null,

      h('h3', {}, ['Debounce (ms)']),
      h('input', {
        type: 'number',
        min: '0',
        value: String(cfg.debounceMs),
        oninput: (e: Event) => edit({ debounceMs: Number((e.target as HTMLInputElement).value) }),
      }),

      h('h3', {}, ['Secret exit sequence']),
      h('p', { class: 'muted' }, [secretSequenceHint(cfg.secretPattern, cfg.secretWindowMs)]),
      this.selectField(
        cfg.secretPattern,
        ['corners_cw', 'corners_ccw', 'tl3_br2'],
        (v) => update({ secretPattern: v as KioskConfig['secretPattern'] }),
        {
          corners_cw: 'Corners clockwise from top-left',
          corners_ccw: 'Corners counter-clockwise from top-left',
          tl3_br2: 'Top-left ×3, bottom-right ×2',
        },
      ),
      h('label', { class: 'field-row' }, [
        h('span', {}, ['Window']),
        this.numberSelectField(cfg.secretWindowMs, SECRET_WINDOW_MS_OPTIONS, (v) => update({ secretWindowMs: v }), (v) => `${v / 1000} s`),
      ]),

      h('h3', {}, ['Admin PIN (optional)']),
      this.pinFields(cfg, update, edit),

      h('div', { class: 'config-errors' }, [this.renderConfigErrors()]),
    ]);
  }

  private renderConfigErrors(): HTMLElement | null {
    const errors = validateConfig(this.config);
    return errors.length > 0
      ? h('div', { class: 'issue-group issue-group--error' }, [h('ul', {}, errors.map((e) => h('li', {}, [e])))])
      : null;
  }

  /** Re-validates after a typed edit and swaps the Configure error list in place. */
  private refreshConfigErrors(): void {
    const host = this.root.querySelector('[data-step="configure"] .config-errors');
    if (!host) return;
    clear(host as HTMLElement);
    const list = this.renderConfigErrors();
    if (list) host.appendChild(list);
  }

  /**
   * Button glow: on/off, colour (swatches plus the iPad colour picker), intensity and speed.
   * The sliders restyle the preview's glow in place and autosave, without a full re-render,
   * so dragging stays smooth; the checkbox and colour go through the normal `update` path.
   */
  private glowFields(cfg: KioskConfig, update: (p: Partial<KioskConfig>) => void): HTMLElement {
    const glow = cfg.glow;
    const setGlow = (patch: Partial<GlowConfig>) => update({ glow: { ...this.config.glow, ...patch } });
    const liveGlow = (patch: Partial<GlowConfig>) => {
      this.config = { ...this.config, glow: { ...this.config.glow, ...patch } };
      if (this.previewGlowLayer) applyGlowStyle(this.previewGlowLayer, this.config.glow);
      this.saveDebounced();
    };

    const toggle = this.checkboxField('Pulse a glow around buttons that can be pressed', glow.enabled, (v) =>
      setGlow({ enabled: v }),
    );
    if (!glow.enabled) return h('div', { class: 'glow-fields' }, [h('h3', {}, ['Button glow']), toggle]);

    const isPreset = GLOW_SWATCHES.some((sw) => sw.color === glow.color.toLowerCase());
    const swatches = h('div', { class: 'glow-swatches', role: 'radiogroup', 'aria-label': 'Glow colour' }, [
      ...GLOW_SWATCHES.map((sw) =>
        h('button', {
          type: 'button',
          class: `glow-swatch${sw.color === glow.color.toLowerCase() ? ' glow-swatch--selected' : ''}`,
          style: { background: sw.color },
          title: sw.name,
          'aria-label': sw.name,
          role: 'radio',
          'aria-checked': String(sw.color === glow.color.toLowerCase()),
          onclick: () => setGlow({ color: sw.color }),
        }),
      ),
      h('label', { class: `glow-custom${isPreset ? '' : ' glow-swatch--selected'}` }, [
        h('input', {
          type: 'color',
          value: glow.color,
          'aria-label': 'Custom glow colour',
          onchange: (e: Event) => setGlow({ color: (e.target as HTMLInputElement).value.toLowerCase() }),
        }),
        ' Custom',
      ]),
    ]);

    const intensityValue = h('span', { class: 'glow-value' }, [String(glow.intensity)]);
    const intensity = h('input', {
      type: 'range',
      min: String(GLOW_INTENSITY_MIN),
      max: String(GLOW_INTENSITY_MAX),
      step: '1',
      value: String(glow.intensity),
      'aria-label': 'Glow intensity',
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        intensityValue.textContent = String(v);
        liveGlow({ intensity: v });
      },
    });

    // The slider runs slow -> fast left to right, so it stores the mirrored period.
    const mirror = (ms: number) => GLOW_PERIOD_MIN_MS + GLOW_PERIOD_MAX_MS - ms;
    const speedText = (ms: number) => `${(ms / 1000).toFixed(1)} s per pulse`;
    const speedValue = h('span', { class: 'glow-value' }, [speedText(glow.periodMs)]);
    const speed = h('input', {
      type: 'range',
      min: String(GLOW_PERIOD_MIN_MS),
      max: String(GLOW_PERIOD_MAX_MS),
      step: '100',
      value: String(mirror(glow.periodMs)),
      'aria-label': 'Glow speed',
      oninput: (e: Event) => {
        const ms = mirror(Number((e.target as HTMLInputElement).value));
        speedValue.textContent = speedText(ms);
        liveGlow({ periodMs: ms });
      },
    });

    return h('div', { class: 'glow-fields' }, [
      h('h3', {}, ['Button glow']),
      toggle,
      h('div', { class: 'field-list' }, [
        h('div', { class: 'field-row' }, [h('span', {}, ['Colour']), swatches]),
        h('label', { class: 'field-row' }, [h('span', {}, ['Intensity']), h('span', { class: 'muted' }, ['Soft']), intensity, h('span', { class: 'muted' }, ['Strong']), intensityValue]),
        h('label', { class: 'field-row' }, [h('span', {}, ['Speed']), h('span', { class: 'muted' }, ['Slow']), speed, h('span', { class: 'muted' }, ['Fast']), speedValue]),
      ]),
      h('p', { class: 'muted' }, ['The preview above shows the glow on the current slide.']),
    ]);
  }

  /**
   * Attract loop: on/off, then (when on) idle time, mode, and in cycle mode a seconds-per-slide
   * select plus a checkbox per slide 2..N to choose which slides are cycled. Home is always
   * included and shown as a note rather than a checkbox, since it can't be removed.
   */
  private attractFields(cfg: KioskConfig, update: (p: Partial<KioskConfig>) => void): HTMLElement {
    const attract = cfg.attract;
    const setAttract = (patch: Partial<AttractConfig>) => update({ attract: { ...cfg.attract, ...patch } });

    const toggle = this.checkboxField(
      'Draw people in when nobody has touched the kiosk for a while',
      attract.enabled,
      (v) => setAttract({ enabled: v }),
    );
    if (!attract.enabled) return h('div', { class: 'attract-fields' }, [h('h3', {}, ['Attract loop']), toggle]);

    const fields: HTMLElement[] = [
      h('label', { class: 'field-row' }, [
        h('span', {}, ['Idle time']),
        this.numberSelectField(attract.idleSec, ATTRACT_IDLE_SEC_OPTIONS, (v) => setAttract({ idleSec: v }), formatIdleSec),
      ]),
      h('label', { class: 'field-row' }, [
        h('span', {}, ['Mode']),
        this.selectField(attract.mode, ['cycle', 'pulse'], (v) => setAttract({ mode: v as AttractConfig['mode'] }), {
          cycle: 'Cycle slides',
          pulse: 'Pulse on Home',
        }),
      ]),
    ];

    if (attract.mode === 'cycle' && this.deck) {
      const otherSlides = this.deck.slides.filter((s) => s.index > 1);
      fields.push(
        h('label', { class: 'field-row' }, [
          h('span', {}, ['Seconds per slide']),
          this.numberSelectField(attract.slideSec, ATTRACT_SLIDE_SEC_OPTIONS, (v) => setAttract({ slideSec: v }), (v) => `${v} s`),
        ]),
        h('h4', {}, ['Slides to include']),
        h('p', { class: 'muted' }, ['Home is always included.']),
        otherSlides.length === 0
          ? h('p', { class: 'muted' }, ['No other slides in this deck.'])
          : h(
              'div',
              { class: 'attract-slide-grid' },
              otherSlides.map((s) => {
                const checked = attract.slides.includes(s.index);
                return h('label', { class: 'attract-slide-check' }, [
                  renderThumbnail(this.deck!, s.index, 100),
                  h('span', {}, [
                    h('input', {
                      type: 'checkbox',
                      checked,
                      onchange: (e: Event) => {
                        const on = (e.target as HTMLInputElement).checked;
                        const slides = on
                          ? [...attract.slides, s.index]
                          : attract.slides.filter((n) => n !== s.index);
                        setAttract({ slides });
                      },
                    }),
                    ` Slide ${s.index}`,
                  ]),
                ]);
              }),
            ),
      );
    }

    return h('div', { class: 'attract-fields' }, [h('h3', {}, ['Attract loop']), toggle, h('div', { class: 'field-list' }, fields)]);
  }

  /**
   * "Poll labels" section (ROADMAP "Polls and ratings"): one renameable text input per poll
   * option, like Button labels, keyed by `pollLabelKey(poll, choice)`. Only shown when the
   * deck actually has poll options, so a deck without polls looks exactly as it did before.
   */
  private pollLabelFields(cfg: KioskConfig, edit: (p: Partial<KioskConfig>) => void): HTMLElement | null {
    const options = this.deck?.pollOptions ?? [];
    if (options.length === 0) return null;

    const rows = options.map((opt) => {
      const key = pollLabelKey(opt.poll, opt.choice);
      return h('label', { class: 'field-row' }, [
        h('span', {}, [`${this.pollLabel(opt)}: ${opt.label}`]),
        h('input', {
          type: 'text',
          value: cfg.pollLabels[key] ?? opt.label,
          // Typed, so it edits in place (see `edit` in renderConfigureStep) and keeps focus.
          oninput: (e: Event) => {
            const label = (e.target as HTMLInputElement).value;
            edit({ pollLabels: { ...this.config.pollLabels, [key]: label } });
            this.updatePreviewPollLabel(key, `${this.pollLabel(opt)}: ${label}`);
          },
        }),
      ]);
    });

    return h('div', {}, [h('h3', {}, ['Poll labels']), h('div', { class: 'field-list' }, rows)]);
  }

  private checkboxField(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
    return h('label', { class: 'checkbox-row' }, [
      h('input', { type: 'checkbox', checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
      ` ${label}`,
    ]);
  }

  private selectField(
    value: string,
    options: string[],
    onChange: (v: string) => void,
    labels?: Record<string, string>,
  ): HTMLElement {
    return h(
      'select',
      { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
      options.map((o) => h('option', { value: o, selected: o === value }, [labels?.[o] ?? o])),
    );
  }

  /**
   * Like `selectField` but for a fixed list of numeric options. A stored config can hold
   * a value outside the list (an older build, or hand-set). The select must still show
   * it rather than silently changing it, so it's added as an extra option when missing.
   */
  private numberSelectField(
    value: number,
    options: number[],
    onChange: (v: number) => void,
    formatLabel: (v: number) => string,
  ): HTMLElement {
    const opts = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
    return h(
      'select',
      { onchange: (e: Event) => onChange(Number((e.target as HTMLSelectElement).value)) },
      opts.map((o) => h('option', { value: String(o), selected: o === value }, [formatLabel(o)])),
    );
  }

  private pinFields(
    cfg: KioskConfig,
    update: (p: Partial<KioskConfig>) => void,
    edit: (p: Partial<KioskConfig>) => void,
  ): HTMLElement {
    const enabled = cfg.adminPin !== null;
    const confirm = h('input', {
      id: 'pin-confirm-input',
      type: 'password',
      inputmode: 'numeric',
      pattern: '[0-9]*',
      maxlength: '6',
      oninput: () => checkConfirm(),
    }) as HTMLInputElement;
    const checkConfirm = () => {
      const mismatch = confirm.value !== (this.config.adminPin ?? '');
      confirm.setCustomValidity(mismatch ? 'PINs do not match' : '');
    };
    return h('div', {}, [
      this.checkboxField('Require a PIN', enabled, (v) => update({ adminPin: v ? '' : null })),
      enabled
        ? h('div', { class: 'field-list' }, [
            h('label', { class: 'field-row' }, [
              h('span', {}, ['PIN (4-6 digits)']),
              h('input', {
                type: 'password',
                inputmode: 'numeric',
                pattern: '[0-9]*',
                maxlength: '6',
                value: cfg.adminPin ?? '',
                oninput: (e: Event) => {
                  const input = e.target as HTMLInputElement;
                  const pin = input.value.replace(/\D/g, '').slice(0, 6);
                  if (input.value !== pin) input.value = pin;
                  edit({ adminPin: pin });
                  if (confirm.value) checkConfirm();
                },
              }),
            ]),
            h('label', { class: 'field-row' }, [h('span', {}, ['Confirm PIN']), confirm]),
          ])
        : null,
    ]);
  }

  // ----------------------------------------------------------- 5. go live

  private renderGoLiveStep(): HTMLElement {
    const ready = !!this.deck && !this.hasBlockingErrors() && this.warningsAccepted() && validateConfig(this.config).length === 0;

    return h('section', { class: 'setup-step', 'data-step': 'golive' }, [
      h('h2', {}, ['5. Go live']),
      h(
        'button',
        {
          class: 'btn btn-primary btn-big',
          type: 'button',
          disabled: !ready || this.goLiveBusy,
          onclick: () => void this.openGoLiveModal(),
        },
        ['Go live'],
      ),
      !ready
        ? h('p', { class: 'muted' }, ['Fix errors, accept warnings and complete Configure to enable Go live.'])
        : null,
      // Keep the last storage reading when this step is replaced in place after an edit.
      h('div', { class: 'storage-info', id: 'storage-info' }, [
        this.root.querySelector('#storage-info')?.textContent ?? 'Storage: …',
      ]),
    ]);
  }

  private async openGoLiveModal(): Promise<void> {
    if (!this.deck) return;
    const wakeLockOk = await acquireWakeLock();
    const items = checklist();

    const modalRoot = h('div', { class: 'modal-backdrop' });
    const checkboxes: HTMLInputElement[] = [];
    const listEl = h(
      'ul',
      { class: 'checklist' },
      items.map((item) => {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        checkboxes.push(cb);
        return h('li', {}, [h('label', { class: 'checkbox-row' }, [cb, ` ${item}`])]);
      }),
    );

    const startBtn = h(
      'button',
      {
        class: 'btn btn-primary btn-big',
        type: 'button',
        onclick: () => {
          modalRoot.remove();
          void this.startKiosk();
        },
      },
      ['Start kiosk'],
    );

    modalRoot.appendChild(
      h('div', { class: 'modal-card' }, [
        h('h2', {}, ['Before you go live']),
        listEl,
        !wakeLockOk
          ? h('p', { class: 'warning-text' }, [
              'Screen Wake Lock is unavailable on this browser/device. Set Settings → Display & Brightness → Auto-Lock to Never.',
            ])
          : null,
        h('div', { class: 'modal-actions' }, [
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modalRoot.remove() }, ['Cancel']),
          startBtn,
        ]),
      ]),
    );
    document.body.appendChild(modalRoot);
  }

  private startKiosk(): void {
    if (!this.deck || this.goLiveBusy) return;
    this.goLiveBusy = true;
    this.persist();
    const sessionId = uuid();
    // Best-effort only: iPad Safari doesn't support requestFullscreen at all (standalone
    // home-screen mode covers it instead), and in some environments the returned promise
    // never settles. Never await it — Go Live must not be able to hang on it.
    try {
      document.documentElement.requestFullscreen?.()?.catch(() => {});
    } catch {
      /* ignore */
    }
    this.deps.onGoLive(this.deck, this.config, sessionId);
  }

  // ------------------------------------------------------------- storage

  async refreshStorageInfo(): Promise<void> {
    const el = this.root.querySelector('#storage-info');
    if (!el) return;
    const count = await countEvents();
    let usageText = '';
    if (navigator.storage?.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        usageText = ` · ${fmtBytes(usage ?? 0)} of ${fmtBytes(quota ?? 0)} used`;
      } catch {
        /* ignore */
      }
    }
    el.textContent = `${count} logged event(s)${usageText}`;
  }
}

/** Emota lockup: the white file on the dark theme, the blackberry file in light appearance. */
function emotaLogo(): HTMLElement {
  const base = import.meta.env.BASE_URL;
  return h('picture', { class: 'setup-logo' }, [
    h('source', { srcset: `${base}emota-logo-blackberry.png`, media: '(prefers-color-scheme: light)' }),
    h('img', { src: `${base}emota-logo-white.png`, alt: 'Emota, an Inizio Engage company' }),
  ]);
}
