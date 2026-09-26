import { describe, it, expect, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openClearDataModal, clearDataSummary, CLEAR_CONFIRM_WORD } from '../../src/ui/clear-data';

afterEach(() => {
  document.body.innerHTML = '';
});

function parts(modal: HTMLElement) {
  const input = modal.querySelector('.clear-confirm-input') as HTMLInputElement;
  const [cancel, confirm] = Array.from(modal.querySelectorAll('.modal-actions button')) as HTMLButtonElement[];
  return { input, cancel, confirm };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('clearDataSummary', () => {
  it('names the deck and the event count', () => {
    expect(clearDataSummary('Stand.pptx', 12)).toContain('the deck "Stand.pptx", all settings and 12 logged event(s)');
    expect(clearDataSummary(undefined, 0)).toContain('any loaded deck');
  });
});

describe('openClearDataModal', () => {
  it('only enables the confirm button once CLEAR is typed', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const modal = await openClearDataModal({ deckName: 'Stand.pptx', onConfirm });
    const { input, confirm } = parts(modal);

    expect(confirm.disabled).toBe(true);
    type(input, 'clear');
    expect(confirm.disabled).toBe(true);
    type(input, CLEAR_CONFIRM_WORD);
    expect(confirm.disabled).toBe(false);

    confirm.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(true);
  });

  it('Cancel closes without clearing', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const modal = await openClearDataModal({ onConfirm });
    parts(modal).cancel.click();
    expect(document.body.contains(modal)).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('re-enables the dialog if clearing fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onConfirm = vi.fn().mockRejectedValue(new Error('boom'));
    const modal = await openClearDataModal({ onConfirm });
    const { input, cancel, confirm } = parts(modal);
    type(input, CLEAR_CONFIRM_WORD);
    confirm.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(cancel.disabled).toBe(false);
    expect(confirm.disabled).toBe(false);
  });
});
