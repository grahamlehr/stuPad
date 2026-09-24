/**
 * Admin panel: Resume, Export, Clear log, Setup + quick stats.
 * Reached via the secret sequence (+ optional PIN) from kiosk mode.
 */
import type { Deck, KioskConfig } from '../types';
import { getEvents, countEvents, clearEvents } from '../store';
import { computeStats, toCsv, csvFileName, pdfFileName, buildPdf, exportFile } from '../report';
import { rasterizeSlide } from '../render';
import { scopeToFilter, type ExportScope } from './export-scope';
import { h, clear, fmtBytes } from './dom';

export interface AdminDeps {
  container: HTMLElement;
  deck: Deck;
  config: KioskConfig;
  sessionId: string;
  /** Back into kiosk mode, same session — no new session_id, no kiosk_start log. */
  onResume: () => void;
  /** Admin chose Setup: caller logs kiosk_stop, stops the controller, clears running state. */
  onSetup: () => void;
}

const CLEAR_CONFIRM_WORD = 'CLEAR';

export class AdminPanel {
  private readonly root: HTMLElement;
  private scope: ExportScope;
  private rangeFrom = '';
  private rangeTo = '';

  constructor(private readonly deps: AdminDeps) {
    this.scope = { kind: 'session', sessionId: deps.sessionId };
    this.root = h('div', { class: 'admin-screen' });
    deps.container.appendChild(this.root);
    void this.render();
  }

  destroy(): void {
    this.root.remove();
  }

  private labels(): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const b of this.deps.deck.buttons) labels[b.id] = this.deps.config.buttonLabels[b.id] ?? b.defaultLabel;
    return labels;
  }

  private async render(): Promise<void> {
    clear(this.root);

    const sessionEvents = await getEvents({ sessionId: this.deps.sessionId });
    const stats = computeStats(sessionEvents, this.labels());
    const totalCount = await countEvents();

    let usageText = '';
    if (navigator.storage?.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        usageText = `${fmtBytes(usage ?? 0)} of ${fmtBytes(quota ?? 0)}`;
      } catch {
        /* ignore */
      }
    }

    this.root.append(
      h('header', { class: 'admin-header' }, [
        h('h1', {}, ['Admin']),
        h('div', { class: 'admin-actions' }, [
          h('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: () => this.deps.onResume() }, [
            'Resume',
          ]),
          h('button', { class: 'btn btn-ghost btn-big', type: 'button', onclick: () => this.deps.onSetup() }, [
            'Setup',
          ]),
        ]),
      ]),

      h('section', { class: 'admin-stats' }, [
        h('h2', {}, ['Current session']),
        h('div', { class: 'stat-row' }, [
          this.statTile('Presses', String(stats.totalPresses)),
          this.statTile('Visits', String(stats.totalVisits)),
          this.statTile('Avg dwell', stats.avgDwellMs !== null ? `${Math.round(stats.avgDwellMs / 1000)}s` : '—'),
          this.statTile('Miss taps', String(stats.missTaps)),
        ]),
      ]),

      this.renderExportSection(),
      this.renderClearSection(),

      h('footer', { class: 'admin-footer muted' }, [
        `${totalCount} event(s) stored total${usageText ? ` · ${usageText} used` : ''}`,
      ]),
    );
  }

  private statTile(label: string, value: string): HTMLElement {
    return h('div', { class: 'stat-tile' }, [h('div', { class: 'stat-value' }, [value]), h('div', { class: 'stat-label' }, [label])]);
  }

  // ------------------------------------------------------------- export

  private renderExportSection(): HTMLElement {
    const previewEl = h('p', { class: 'export-preview muted' }, ['…']);
    void this.updatePreview(previewEl);

    const scopeRadios = h('div', { class: 'field-list' }, [
      this.radioRow('scope', 'session', this.scope.kind === 'session', () => {
        this.scope = { kind: 'session', sessionId: this.deps.sessionId };
        void this.updatePreview(previewEl);
      }, 'Current session'),
      this.radioRow('scope', 'range', this.scope.kind === 'range', () => {
        this.scope = { kind: 'range', from: this.rangeFrom, to: this.rangeTo };
        void this.updatePreview(previewEl);
      }, 'Date range'),
      this.radioRow('scope', 'all', this.scope.kind === 'all', () => {
        this.scope = { kind: 'all' };
        void this.updatePreview(previewEl);
      }, 'All data'),
    ]);

    const fromInput = h('input', {
      type: 'datetime-local',
      onchange: (e: Event) => {
        this.rangeFrom = (e.target as HTMLInputElement).value;
        if (this.scope.kind === 'range') this.scope = { ...this.scope, from: this.isoFromLocalInput(this.rangeFrom) };
        void this.updatePreview(previewEl);
      },
    });
    const toInput = h('input', {
      type: 'datetime-local',
      onchange: (e: Event) => {
        this.rangeTo = (e.target as HTMLInputElement).value;
        if (this.scope.kind === 'range') this.scope = { ...this.scope, to: this.isoFromLocalInput(this.rangeTo) };
        void this.updatePreview(previewEl);
      },
    });

    return h('section', { class: 'admin-export' }, [
      h('h2', {}, ['Export']),
      scopeRadios,
      h('div', { class: 'field-row' }, [h('span', {}, ['From']), fromInput, h('span', {}, ['To']), toInput]),
      previewEl,
      h('div', { class: 'export-buttons' }, [
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => void this.exportCsv() }, ['Export CSV']),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => void this.exportPdf() }, [
          'Export PDF report',
        ]),
      ]),
    ]);
  }

  private isoFromLocalInput(v: string): string {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }

  private radioRow(name: string, value: string, checked: boolean, onChange: () => void, label: string): HTMLElement {
    return h('label', { class: 'checkbox-row' }, [
      h('input', { type: 'radio', name, value, checked, onchange: onChange }),
      ` ${label}`,
    ]);
  }

  private async updatePreview(el: HTMLElement): Promise<void> {
    const count = await countEvents(scopeToFilter(this.scope));
    el.textContent = `${count} event(s) in scope`;
  }

  private async exportCsv(): Promise<void> {
    const events = await getEvents(scopeToFilter(this.scope));
    const csv = toCsv(events);
    const fileName = csvFileName(this.deps.config.sessionName);
    const file = new File([csv], fileName, { type: 'text/csv' });
    await exportFile(file);
  }

  private async exportPdf(): Promise<void> {
    const events = await getEvents(scopeToFilter(this.scope));
    const homeThumbPng = await this.getHomeThumbnail();
    const blob = await buildPdf(events, this.deps.deck, this.deps.config, homeThumbPng);
    const fileName = pdfFileName(this.deps.config.sessionName);
    const file = new File([blob], fileName, { type: 'application/pdf' });
    await exportFile(file);
  }

  /**
   * Best-effort PNG of slide 1 for the report's Summary page. Image-mode decks already have
   * a pre-rasterised home slide (`rasterKey`), used directly; otherwise a single slide is
   * rasterised on the fly. Never throws — a failure here (e.g. Safari canvas tainting) just
   * means the PDF is built without a thumbnail.
   */
  private async getHomeThumbnail(): Promise<Blob | undefined> {
    const home = this.deps.deck.slides[0];
    if (home?.rasterKey && this.deps.deck.media[home.rasterKey]) {
      return this.deps.deck.media[home.rasterKey].blob;
    }
    try {
      const blob = await rasterizeSlide(this.deps.deck, 1);
      return blob ?? undefined;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------- clear

  private renderClearSection(): HTMLElement {
    const input = h('input', { type: 'text', placeholder: CLEAR_CONFIRM_WORD, class: 'clear-confirm-input' }) as HTMLInputElement;
    const btn = h(
      'button',
      {
        class: 'btn btn-danger',
        type: 'button',
        disabled: true,
        onclick: () => void this.doClear(),
      },
      ['Clear log'],
    ) as HTMLButtonElement;
    input.addEventListener('input', () => {
      btn.disabled = input.value !== CLEAR_CONFIRM_WORD;
    });

    return h('section', { class: 'admin-clear' }, [
      h('h2', {}, ['Clear log']),
      h('p', { class: 'warning-text' }, [
        `This permanently deletes all logged events. Type ${CLEAR_CONFIRM_WORD} to confirm.`,
      ]),
      h('div', { class: 'field-row' }, [input, btn]),
    ]);
  }

  private async doClear(): Promise<void> {
    await clearEvents(this.deps.sessionId);
    await this.render();
  }
}
