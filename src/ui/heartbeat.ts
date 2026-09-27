/**
 * Heartbeat timer for proving the kiosk ran unattended. Owned by `App` in `src/main.ts`,
 * not by `KioskController`, so nothing is added to the kiosk tap path. Kept in its own
 * tiny module (rather than inline in `main.ts`, which is not exported and runs
 * `new App().init()` on import) purely so it can be unit-tested with fake timers.
 */

/** How often the kiosk logs a `heartbeat` event while running. */
export const HEARTBEAT_INTERVAL_MS = 15 * 60_000;

/**
 * Starts a repeating heartbeat: calls `log()` every `intervalMs` (default
 * `HEARTBEAT_INTERVAL_MS`). Returns a `stop()` function that clears the interval; calling
 * `stop()` more than once is a no-op. The first tick fires after `intervalMs`, not
 * immediately (the caller's own `kiosk_start`/`app_resume` log already marks the start).
 */
export function startHeartbeat(log: () => void, intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  const id = setInterval(log, intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(id);
  };
}
