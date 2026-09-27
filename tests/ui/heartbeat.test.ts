import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from '../../src/ui/heartbeat';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startHeartbeat', () => {
  it('does not call log immediately', () => {
    const log = vi.fn();
    startHeartbeat(log);
    expect(log).not.toHaveBeenCalled();
  });

  it('calls log every HEARTBEAT_INTERVAL_MS by default', () => {
    const log = vi.fn();
    startHeartbeat(log);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(log).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(log).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(log).toHaveBeenCalledTimes(4);
  });

  it('honours a custom interval', () => {
    const log = vi.fn();
    startHeartbeat(log, 1000);
    vi.advanceTimersByTime(3500);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('stop() prevents further ticks', () => {
    const log = vi.fn();
    const stop = startHeartbeat(log, 1000);
    vi.advanceTimersByTime(2500);
    expect(log).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(10_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('stop() is idempotent', () => {
    const log = vi.fn();
    const stop = startHeartbeat(log, 1000);
    stop();
    expect(() => stop()).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(log).not.toHaveBeenCalled();
  });

  it('starting a second heartbeat after stopping the first does not duplicate ticks', () => {
    const log = vi.fn();
    const stop1 = startHeartbeat(log, 1000);
    vi.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalledTimes(1);
    stop1();

    const stop2 = startHeartbeat(log, 1000);
    vi.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalledTimes(2);
    stop2();
  });
});
