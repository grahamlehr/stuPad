import { h } from './dom';
import { PinPadState } from './pinpad-logic';

const IDLE_MS = 30_000;

export interface PinPadOpts {
  pin: string;
  /** PIN accepted. */
  onSuccess: () => void;
  /** Wrong PIN entered; caller logs admin_unlock_fail. */
  onFail: () => void;
  /** 3 failed attempts, or 30s idle: back to kiosk without admin access. */
  onGiveUp: () => void;
}

/** Full-screen numeric PIN pad overlay shown after a correct secret sequence. */
export class PinPad {
  private readonly root: HTMLElement;
  private readonly dotsEl: HTMLElement;
  private readonly state: PinPadState;
  private entered = '';
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor(container: HTMLElement, private readonly opts: PinPadOpts) {
    this.state = new PinPadState(opts.pin);
    this.dotsEl = h('div', { class: 'pinpad-dots' });
    this.root = this.build();
    container.appendChild(this.root);
    this.armIdleTimer();
    this.renderDots();
  }

  private armIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.giveUp(), IDLE_MS);
  }

  private build(): HTMLElement {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    const pad = h(
      'div',
      { class: 'pinpad-grid' },
      keys.map((k) =>
        k === ''
          ? h('div', { class: 'pinpad-spacer' })
          : h(
              'button',
              {
                class: 'pinpad-key',
                type: 'button',
                'aria-label': k === '⌫' ? 'Backspace' : k,
                onclick: () => (k === '⌫' ? this.backspace() : this.press(k)),
              },
              [k],
            ),
      ),
    );
    return h('div', { class: 'pinpad-overlay', role: 'dialog', 'aria-label': 'Admin PIN' }, [
      h('div', { class: 'pinpad-card' }, [
        h('div', { class: 'pinpad-title' }, ['Enter admin PIN']),
        this.dotsEl,
        pad,
        h('button', { class: 'pinpad-cancel btn btn-ghost', type: 'button', onclick: () => this.giveUp() }, [
          'Cancel',
        ]),
      ]),
    ]);
  }

  private renderDots(): void {
    const dots: HTMLElement[] = [];
    const target = Math.max(this.opts.pin.length, 4);
    for (let i = 0; i < target; i++) {
      dots.push(h('span', { class: `pinpad-dot${i < this.entered.length ? ' pinpad-dot--filled' : ''}` }));
    }
    this.dotsEl.replaceChildren(...dots);
  }

  private press(digit: string): void {
    if (this.destroyed) return;
    this.armIdleTimer();
    if (this.entered.length >= 6) return;
    this.entered += digit;
    this.renderDots();
    if (this.entered.length >= this.opts.pin.length) this.submit();
  }

  private backspace(): void {
    if (this.destroyed) return;
    this.armIdleTimer();
    this.entered = this.entered.slice(0, -1);
    this.renderDots();
  }

  private submit(): void {
    const result = this.state.submit(this.entered);
    if (result === 'success') {
      this.destroy();
      this.opts.onSuccess();
      return;
    }
    this.opts.onFail();
    this.shake();
    this.entered = '';
    this.renderDots();
    if (result === 'locked') {
      this.giveUp();
    }
  }

  private shake(): void {
    this.root.classList.remove('pinpad-shake');
    // force reflow so the animation restarts even on consecutive failures
    void this.root.offsetWidth;
    this.root.classList.add('pinpad-shake');
  }

  private giveUp(): void {
    if (this.destroyed) return;
    this.destroy();
    this.opts.onGiveUp();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.root.remove();
  }
}
