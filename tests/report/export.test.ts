import { describe, it, expect, vi, afterEach } from 'vitest';
import { exportFile } from '../../src/report/export';

function makeFile(): File {
  return new File(['hello'], 'report.csv', { type: 'text/csv' });
}

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error - test cleanup of a property we may have added to navigator
  delete navigator.canShare;
  // @ts-expect-error - test cleanup
  delete navigator.share;
});

describe('exportFile', () => {
  it('uses the share sheet when navigator.canShare({files}) is true', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: shareMock, configurable: true });

    const file = makeFile();
    const outcome = await exportFile(file);

    expect(outcome).toBe('shared');
    expect(shareMock).toHaveBeenCalledWith({ files: [file], title: file.name });
  });

  it('returns "cancelled" when the user dismisses the share sheet (AbortError)', async () => {
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: vi.fn().mockRejectedValue(abortError), configurable: true });

    const outcome = await exportFile(makeFile());
    expect(outcome).toBe('cancelled');
  });

  it('falls back to an anchor download when Web Share is unavailable', async () => {
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });

    const clickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const outcome = await exportFile(makeFile());

    expect(outcome).toBe('downloaded');
    expect(clickSpy).toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('falls back to download when canShare returns false for this file', async () => {
    Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
    Object.defineProperty(navigator, 'share', { value: vi.fn(), configurable: true });

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });

    const outcome = await exportFile(makeFile());
    expect(outcome).toBe('downloaded');
  });
});
