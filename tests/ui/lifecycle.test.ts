import { describe, it, expect } from 'vitest';
import { decideStartupScreen } from '../../src/ui/lifecycle';
import type { KioskState } from '../../src/types';

describe('decideStartupScreen', () => {
  it('goes straight to kiosk when a session is running', () => {
    const state: KioskState = { running: true, sessionId: 'abc', startedAt: '2026-01-01T00:00:00+00:00' };
    expect(decideStartupScreen(state)).toBe('kiosk');
  });

  it('goes to setup when not running', () => {
    const state: KioskState = { running: false, sessionId: null, startedAt: null };
    expect(decideStartupScreen(state)).toBe('setup');
  });

  it('goes to setup if running is true but sessionId is missing (defensive)', () => {
    const state: KioskState = { running: true, sessionId: null, startedAt: null };
    expect(decideStartupScreen(state)).toBe('setup');
  });
});
