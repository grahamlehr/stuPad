/**
 * "Clear previous data" confirmation, shared by Setup and the admin panel. Lists what will
 * be removed and only enables the button once the admin types CLEAR (same guard as Clear log).
 */
import { countEvents } from '../store';
import { h } from './dom';

export const CLEAR_CONFIRM_WORD = 'CLEAR';

export interface ClearDataModalOpts {
  /** File name of the stored deck, if any, named in the summary. */
  deckName?: string;
  /** Wipes storage; the modal stays open (buttons disabled) until it settles. */
  onConfirm: () => Promise<void>;
}

export function clearDataSummary(deckName: string | undefined, eventCount: number): string {
  const deck = deckName ? `the deck "${deckName}"` : 'any loaded deck';
  return `This removes ${deck}, all settings and ${eventCount} logged event(s) from this iPad, so the next person starts from an empty Setup.`;
}

export async function openClearDataModal(opts: ClearDataModalOpts): Promise<HTMLElement> {
  const eventCount = await countEvents();

  const modalRoot = h('div', { class: 'modal-backdrop' });
  const input = h('input', {
    type: 'text',
    placeholder: CLEAR_CONFIRM_WORD,
    class: 'clear-confirm-input',
    autocapitalize: 'characters',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modalRoot.remove() }, [
    'Cancel',
  ]) as HTMLButtonElement;
  const confirmBtn = h('button', { class: 'btn btn-danger', type: 'button', disabled: true }, [
    'Clear everything',
  ]) as HTMLButtonElement;

  input.addEventListener('input', () => {
    confirmBtn.disabled = input.value !== CLEAR_CONFIRM_WORD;
  });
  confirmBtn.addEventListener('click', () => {
    if (input.value !== CLEAR_CONFIRM_WORD) return;
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    void opts.onConfirm().catch((err) => {
      console.error('stuPad: failed to clear data', err);
      cancelBtn.disabled = false;
      input.disabled = false;
      confirmBtn.disabled = input.value !== CLEAR_CONFIRM_WORD;
    });
  });

  modalRoot.appendChild(
    h('div', { class: 'modal-card' }, [
      h('h2', {}, ['Clear previous data']),
      h('p', {}, [clearDataSummary(opts.deckName, eventCount)]),
      eventCount > 0
        ? h('p', { class: 'warning-text' }, [
            'Logged taps cannot be recovered. Export them from the admin panel first if they are needed.',
          ])
        : null,
      h('p', {}, [`Type ${CLEAR_CONFIRM_WORD} to confirm.`]),
      input,
      h('div', { class: 'modal-actions' }, [cancelBtn, confirmBtn]),
    ]),
  );
  document.body.appendChild(modalRoot);
  return modalRoot;
}
