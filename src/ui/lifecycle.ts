import type { KioskState } from '../types';

export type StartupScreen = 'kiosk' | 'setup';

/**
 * On launch, main.ts loads the persisted KioskState and decides where to route:
 * straight into kiosk mode on the home slide if a session was running, else Setup
 * (SPEC: "reopening the app resumes where it left off, including straight back into
 * kiosk mode if it was running").
 */
export function decideStartupScreen(state: KioskState): StartupScreen {
  return state.running && !!state.sessionId ? 'kiosk' : 'setup';
}
