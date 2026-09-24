import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/types';
import { validateConfig } from '../../src/ui/config-validate';

describe('validateConfig', () => {
  it('accepts the default config', () => {
    expect(validateConfig(defaultConfig('deck.pptx'))).toEqual([]);
  });

  it('rejects an empty session name', () => {
    const cfg = { ...defaultConfig('deck.pptx'), sessionName: '   ' };
    expect(validateConfig(cfg)).toContain('Session name is required.');
  });

  it('rejects an out-of-range timeout', () => {
    expect(validateConfig({ ...defaultConfig('deck.pptx'), timeoutSec: 4 }).length).toBeGreaterThan(0);
    expect(validateConfig({ ...defaultConfig('deck.pptx'), timeoutSec: 301 }).length).toBeGreaterThan(0);
    expect(validateConfig({ ...defaultConfig('deck.pptx'), timeoutSec: 5 })).toEqual([]);
    expect(validateConfig({ ...defaultConfig('deck.pptx'), timeoutSec: 300 })).toEqual([]);
  });

  it('allows timeoutSec = null (off)', () => {
    const cfg = {
      ...defaultConfig('deck.pptx'),
      timeoutSec: null,
      returnMethods: { homeButton: true, tapAnywhere: false, timeout: false },
    };
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('requires at least one return method', () => {
    const cfg = { ...defaultConfig('deck.pptx'), returnMethods: { homeButton: false, tapAnywhere: false, timeout: false } };
    expect(validateConfig(cfg)).toContain('At least one return method must be enabled.');
  });

  it('flags timeout method on with no duration set', () => {
    const cfg = {
      ...defaultConfig('deck.pptx'),
      timeoutSec: null,
      returnMethods: { homeButton: false, tapAnywhere: false, timeout: true },
    };
    expect(validateConfig(cfg).some((e) => e.includes('Timeout'))).toBe(true);
  });

  it('validates the admin PIN is 4-6 digits when set', () => {
    expect(validateConfig({ ...defaultConfig('deck.pptx'), adminPin: '123' }).length).toBeGreaterThan(0);
    expect(validateConfig({ ...defaultConfig('deck.pptx'), adminPin: '1234567' }).length).toBeGreaterThan(0);
    expect(validateConfig({ ...defaultConfig('deck.pptx'), adminPin: 'abcd' }).length).toBeGreaterThan(0);
    expect(validateConfig({ ...defaultConfig('deck.pptx'), adminPin: '1234' })).toEqual([]);
    expect(validateConfig({ ...defaultConfig('deck.pptx'), adminPin: '123456' })).toEqual([]);
  });

  it('allows adminPin = null (off)', () => {
    expect(validateConfig({ ...defaultConfig('deck.pptx'), adminPin: null })).toEqual([]);
  });

  it('rejects a negative debounce', () => {
    expect(validateConfig({ ...defaultConfig('deck.pptx'), debounceMs: -1 }).length).toBeGreaterThan(0);
  });
});
