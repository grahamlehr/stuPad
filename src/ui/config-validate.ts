import type { KioskConfig } from '../types';
import { GLOW_INTENSITY_MIN, GLOW_INTENSITY_MAX, GLOW_PERIOD_MIN_MS, GLOW_PERIOD_MAX_MS } from '../types';

/**
 * Validates a KioskConfig against SPEC's "Configurable settings" ranges. Pure and
 * DOM-free so it's cheaply unit tested; the Configure step in src/ui/setup.ts calls
 * this on every change and blocks Go Live while errors remain.
 */
export function validateConfig(config: KioskConfig): string[] {
  const errors: string[] = [];

  if (!config.sessionName.trim()) {
    errors.push('Session name is required.');
  }

  if (config.timeoutSec !== null && (config.timeoutSec < 5 || config.timeoutSec > 300)) {
    errors.push('Return-to-home timeout must be between 5 and 300 seconds, or off.');
  }

  const { homeButton, tapAnywhere, timeout } = config.returnMethods;
  if (!homeButton && !tapAnywhere && !timeout) {
    errors.push('At least one return method must be enabled.');
  }
  if (timeout && config.timeoutSec === null) {
    errors.push('"Timeout" is enabled as a return method but no timeout duration is set.');
  }

  if (config.adminPin !== null && !/^\d{4,6}$/.test(config.adminPin)) {
    errors.push('Admin PIN must be 4 to 6 digits.');
  }

  if (config.debounceMs < 0) {
    errors.push('Debounce must not be negative.');
  }

  const { glow } = config;
  if (glow.enabled) {
    if (!/^#[0-9a-f]{6}$/i.test(glow.color)) {
      errors.push('Button glow colour must be a hex colour like #ffcc00.');
    }
    if (!(glow.intensity >= GLOW_INTENSITY_MIN && glow.intensity <= GLOW_INTENSITY_MAX)) {
      errors.push(`Button glow intensity must be between ${GLOW_INTENSITY_MIN} and ${GLOW_INTENSITY_MAX}.`);
    }
    if (!(glow.periodMs >= GLOW_PERIOD_MIN_MS && glow.periodMs <= GLOW_PERIOD_MAX_MS)) {
      errors.push(
        `Button glow speed must be between ${GLOW_PERIOD_MIN_MS / 1000} and ${GLOW_PERIOD_MAX_MS / 1000} seconds per pulse.`,
      );
    }
  }

  return errors;
}
