/**
 * Pure PIN-check state machine, separated from src/ui/pinpad.ts's DOM so it's cheaply
 * unit tested. SPEC: wrong PIN -> log admin_unlock_fail + shake; return to kiosk after
 * 3 fails or 30 s idle (the idle timer is DOM/timer glue, kept in pinpad.ts).
 */
export type PinAttemptResult = 'success' | 'fail' | 'locked';

export const MAX_PIN_ATTEMPTS = 3;

export class PinPadState {
  private attempts = 0;

  constructor(
    private readonly correctPin: string,
    private readonly maxAttempts: number = MAX_PIN_ATTEMPTS,
  ) {}

  get attemptCount(): number {
    return this.attempts;
  }

  /** Submits an entered PIN. 'locked' means this was the attempt that hit the limit. */
  submit(entered: string): PinAttemptResult {
    if (entered === this.correctPin) return 'success';
    this.attempts += 1;
    return this.attempts >= this.maxAttempts ? 'locked' : 'fail';
  }

  reset(): void {
    this.attempts = 0;
  }
}
