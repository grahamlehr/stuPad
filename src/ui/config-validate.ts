import type { KioskConfig } from '../types';

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

  return errors;
}
