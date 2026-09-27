/**
 * Setup screen: one scrolling screen with five steps (SPEC "Admin setup flow"):
 * Load -> Check -> Preview -> Configure -> Go live.
 */
import type { Deck, Issue, KioskConfig, ButtonDef, Rect, GlowConfig } from '../types';
import { defaultConfig, GLOW_INTENSITY_MIN, GLOW_INTENSITY_MAX, GLOW_PERIOD_MIN_MS, GLOW_PERIOD_MAX_MS } from '../types';
import { parsePptx, validateDeck } from '../pptx';
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
      this.config = { ...defaultConfig(file.name), buttonLabels: {} };
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

    return h('section', { class: 'setup-step', 'data-step': 'check' }, [
      h('h2', {}, ['2. Check']),
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
        this.addPreviewOutline(overlay, button.bounds, label, () => this.showPreviewSlide(button.targetSlide));
      }
      return;
    }
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

  /** Mirrors the kiosk's "Last Slide Viewed": previous slide of this preview visit, else Home. */
  private previewGoBack(): void {
    this.previewPath.pop();
    const target = this.previewPath[this.previewPath.length - 1] ?? 1;
    this.showPreviewSlide(target, false);
  }

  private addPreviewOutline(overlay: HTMLElement, bounds: Rect, label: string, onTap: () => void): void {
    const box = h('div', { class: 'preview-btn-outline', style: { pointerEvents: 'auto' } }, [
      h('span', { class: 'preview-btn-label' }, [label]),
    ]);
    box.style.position = 'absolute';
    box.style.left = `${bounds.x}px`;
    box.style.top = `${bounds.y}px`;
    box.style.width = `${bounds.w}px`;
    box.style.height = `${bounds.h}px`;
    box.addEventListener('click', onTap);
    overlay.appendChild(box);
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
    const errors = validateConfig(cfg);

    const update = (patch: Partial<KioskConfig>) => {
      this.config = { ...this.config, ...patch };
      this.saveDebounced();
      this.render();
    };

    const buttonLabelRows = this.deck.buttons.map((b: ButtonDef) =>
      h('label', { class: 'field-row' }, [
        h('span', {}, [b.defaultLabel]),
        h('input', {
          type: 'text',
          value: cfg.buttonLabels[b.id] ?? b.defaultLabel,
          oninput: (e: Event) =>
            update({ buttonLabels: { ...cfg.buttonLabels, [b.id]: (e.target as HTMLInputElement).value } }),
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
        oninput: (e: Event) => update({ sessionName: (e.target as HTMLInputElement).value }),
      }),

      h('h3', {}, ['Button labels']),
      h('div', { class: 'field-list' }, buttonLabelRows),

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
            oninput: (e: Event) => update({ timeoutSec: Number((e.target as HTMLInputElement).value) }),
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
        oninput: (e: Event) => update({ debounceMs: Number((e.target as HTMLInputElement).value) }),
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
      this.pinFields(cfg, update),

      errors.length > 0
        ? h('div', { class: 'issue-group issue-group--error' }, [
            h('ul', {}, errors.map((e) => h('li', {}, [e]))),
          ])
        : null,
    ]);
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

  private pinFields(cfg: KioskConfig, update: (p: Partial<KioskConfig>) => void): HTMLElement {
    const enabled = cfg.adminPin !== null;
    const confirmId = 'pin-confirm-input';
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
                oninput: (e: Event) =>
                  update({ adminPin: (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6) }),
              }),
            ]),
            h('label', { class: 'field-row' }, [
              h('span', {}, ['Confirm PIN']),
              h('input', {
                id: confirmId,
                type: 'password',
                inputmode: 'numeric',
                pattern: '[0-9]*',
                maxlength: '6',
                oninput: (e: Event) => {
                  const val = (e.target as HTMLInputElement).value;
                  const mismatch = val !== (cfg.adminPin ?? '');
                  (e.target as HTMLInputElement).setCustomValidity(mismatch ? 'PINs do not match' : '');
                },
              }),
            ]),
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
      h('div', { class: 'storage-info', id: 'storage-info' }, ['Storage: …']),
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
