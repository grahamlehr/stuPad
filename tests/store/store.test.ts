import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { Deck, KioskConfig, LogEvent } from '../../src/types';
import { defaultConfig } from '../../src/types';

async function freshStore() {
  // Reset the fake IndexedDB between tests so each test starts from an empty DB, and
  // re-import the module fresh so its module-level connection cache is cleared too.
  (globalThis as any).indexedDB = new IDBFactory();
  vi.resetModules();
  const store = await import('../../src/store/index');
  return store;
}

function makeEvent(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: '2026-10-14T10:00:00.000+01:00',
    session_id: 'sess-1',
    event: 'button_press',
    ...over,
  };
}

function fakeDeck(): Deck {
  return {
    id: 'deck-1',
    fileName: 'demo.pptx',
    parsedAt: '2026-09-24T00:00:00.000Z',
    slideWidthEmu: 12192000,
    slideHeightEmu: 6858000,
    height: 1080,
    slides: [],
    buttons: [],
    homeLinks: [],
  navLinks: [],
  backLinks: [],
    media: {},
    fonts: [],
  };
}

describe('store: deck / config / state', () => {
  it('round-trips deck, config and kiosk state', async () => {
    const store = await freshStore();
    expect(await store.loadDeck()).toBeUndefined();

    const deck = fakeDeck();
    await store.saveDeck(deck);
    expect(await store.loadDeck()).toEqual(deck);

    await store.deleteDeck();
    expect(await store.loadDeck()).toBeUndefined();

    const cfg: KioskConfig = defaultConfig('demo.pptx');
    expect(await store.loadConfig()).toBeUndefined();
    await store.saveConfig(cfg);
    expect(await store.loadConfig()).toEqual(cfg);

    expect(await store.getKioskState()).toEqual({ running: false, sessionId: null, startedAt: null });
    await store.setKioskState({ running: true, sessionId: 'sess-1', startedAt: '2026-10-14T10:00:00.000+01:00' });
    expect(await store.getKioskState()).toEqual({
      running: true,
      sessionId: 'sess-1',
      startedAt: '2026-10-14T10:00:00.000+01:00',
    });
  });
});

describe('store: events CRUD and ordering', () => {
  it('appendEvent assigns increasing ids and getEvents returns them in id order', async () => {
    const store = await freshStore();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await store.appendEvent(makeEvent({ event: 'miss_tap', x: i, y: i })));
    }
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    const events = await store.getEvents();
    expect(events.map((e) => e.id)).toEqual(ids);
    // internal `t` field must never leak out
    for (const e of events) expect((e as any).t).toBeUndefined();
  });

  it('appendEvent resolves only once the write is durable (readable immediately after)', async () => {
    const store = await freshStore();
    const id = await store.appendEvent(makeEvent());
    const events = await store.getEvents();
    expect(events.some((e) => e.id === id)).toBe(true);
  });

  it('keeps order under concurrent rapid appends (write queue)', async () => {
    const store = await freshStore();
    const n = 50;
    const promises = Array.from({ length: n }, (_, i) =>
      store.appendEvent(makeEvent({ event: 'miss_tap', x: i })),
    );
    const ids = await Promise.all(promises);
    // ids assigned in call order
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const events = await store.getEvents();
    expect(events.map((e) => e.x)).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it('countEvents matches getEvents length for various filters', async () => {
    const store = await freshStore();
    for (let i = 0; i < 10; i++) {
      await store.appendEvent(
        makeEvent({ session_id: i < 5 ? 'a' : 'b', ts: `2026-10-14T10:${String(i).padStart(2, '0')}:00.000+01:00` }),
      );
    }
    expect(await store.countEvents()).toBe(10);
    expect(await store.countEvents({ sessionId: 'a' })).toBe(5);
    expect(await store.countEvents({ sessionId: 'b' })).toBe(5);
    expect(await store.countEvents({ from: '2026-10-14T10:00:00.000+01:00', to: '2026-10-14T10:04:00.000+01:00' })).toBe(5);
  });
});

describe('store: filters with mixed UTC offsets', () => {
  it('filters by instant regardless of the offset written in ts', async () => {
    const store = await freshStore();
    // Same instant in different notations, plus one clearly before and one clearly after.
    await store.appendEvent(makeEvent({ event: 'miss_tap', ts: '2026-10-14T08:00:00.000Z', x: 1 })); // before window
    await store.appendEvent(makeEvent({ event: 'miss_tap', ts: '2026-10-14T10:00:00.000+01:00', x: 2 })); // == 09:00Z
    await store.appendEvent(makeEvent({ event: 'miss_tap', ts: '2026-10-14T05:00:00.000-04:00', x: 3 })); // == 09:00Z
    await store.appendEvent(makeEvent({ event: 'miss_tap', ts: '2026-10-14T11:00:00.000Z', x: 4 })); // after window

    const events = await store.getEvents({ from: '2026-10-14T09:00:00.000Z', to: '2026-10-14T09:00:00.000Z' });
    expect(events.map((e) => e.x).sort()).toEqual([2, 3]);
  });

  it('sessionId + range filter combines both constraints', async () => {
    const store = await freshStore();
    await store.appendEvent(makeEvent({ session_id: 'a', ts: '2026-10-14T09:00:00.000Z', x: 1 }));
    await store.appendEvent(makeEvent({ session_id: 'b', ts: '2026-10-14T09:00:00.000Z', x: 2 }));
    await store.appendEvent(makeEvent({ session_id: 'a', ts: '2026-10-14T12:00:00.000Z', x: 3 }));

    const events = await store.getEvents({
      sessionId: 'a',
      from: '2026-10-14T08:00:00.000Z',
      to: '2026-10-14T10:00:00.000Z',
    });
    expect(events.map((e) => e.x)).toEqual([1]);
  });
});

describe('store: clearEvents', () => {
  it('deletes all events and appends a log_cleared record', async () => {
    const store = await freshStore();
    await store.appendEvent(makeEvent());
    await store.appendEvent(makeEvent());
    expect(await store.countEvents()).toBe(2);

    await store.clearEvents('sess-1');
    const events = await store.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('log_cleared');
    expect(events[0].session_id).toBe('sess-1');
  });
});

describe('store: clearAllData', () => {
  it('wipes deck, config, kiosk state and events, leaving only a log_cleared record', async () => {
    const store = await freshStore();
    await store.saveDeck(fakeDeck());
    await store.saveConfig(defaultConfig('demo.pptx'));
    await store.setKioskState({ running: true, sessionId: 'sess-1', startedAt: '2026-10-14T10:00:00.000+01:00' });
    await store.appendEvent(makeEvent());
    await store.appendEvent(makeEvent({ session_id: 'sess-0' }));

    await store.clearAllData('sess-1');

    expect(await store.loadDeck()).toBeUndefined();
    expect(await store.loadConfig()).toBeUndefined();
    expect(await store.getKioskState()).toEqual({ running: false, sessionId: null, startedAt: null });
    const events = await store.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('log_cleared');
    expect(events[0].session_id).toBe('sess-1');
  });

  it('stays wiped after the app relaunches', async () => {
    const store = await freshStore();
    await store.saveDeck(fakeDeck());
    await store.setKioskState({ running: true, sessionId: 'sess-1', startedAt: '2026-10-14T10:00:00.000+01:00' });
    await store.clearAllData('sess-1');

    await store._closeForTests();
    expect(await store.loadDeck()).toBeUndefined();
    expect((await store.getKioskState()).running).toBe(false);
  });

  it('is ordered after appends already queued ahead of it', async () => {
    const store = await freshStore();
    const pending = [store.appendEvent(makeEvent()), store.appendEvent(makeEvent())];
    const cleared = store.clearAllData('sess-1');
    await Promise.all([...pending, cleared]);
    const events = await store.getEvents();
    expect(events.map((e) => e.event)).toEqual(['log_cleared']);
  });
});

describe('store: listSessions', () => {
  it('groups events by session with first/last/count', async () => {
    const store = await freshStore();
    await store.appendEvent(makeEvent({ session_id: 'a', ts: '2026-10-14T09:00:00.000Z' }));
    await store.appendEvent(makeEvent({ session_id: 'a', ts: '2026-10-14T09:10:00.000Z' }));
    await store.appendEvent(makeEvent({ session_id: 'b', ts: '2026-10-14T08:00:00.000Z' }));

    const sessions = await store.listSessions();
    const a = sessions.find((s) => s.sessionId === 'a')!;
    const b = sessions.find((s) => s.sessionId === 'b')!;
    expect(a.count).toBe(2);
    expect(a.first).toBe('2026-10-14T09:00:00.000Z');
    expect(a.last).toBe('2026-10-14T09:10:00.000Z');
    expect(b.count).toBe(1);
  });
});

describe('store: persistence across reopen', () => {
  it('data written before closing is visible after reopening the connection', async () => {
    const store = await freshStore();
    await store.saveDeck(fakeDeck());
    await store.appendEvent(makeEvent());
    await store._closeForTests();

    expect(await store.loadDeck()).toEqual(fakeDeck());
    expect(await store.countEvents()).toBe(1);
  });
});

describe('store: 100k events perf sanity', () => {
  it('bulk inserts and reads 100,000 events well within budget', async () => {
    const store = await freshStore();
    const n = 100_000;
    const events: LogEvent[] = Array.from({ length: n }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i).toISOString(),
      session_id: i % 2 === 0 ? 'even' : 'odd',
      event: 'miss_tap',
      x: i % 100,
      y: (i % 100) / 10,
    }));

    const t0 = Date.now();
    await store._bulkInsertForTests(events);
    const insertMs = Date.now() - t0;

    const t1 = Date.now();
    const count = await store.countEvents();
    const all = await store.getEvents();
    const bySession = await store.getEvents({ sessionId: 'even' });
    const readMs = Date.now() - t1;

    expect(count).toBe(n);
    expect(all).toHaveLength(n);
    expect(bySession).toHaveLength(n / 2);
    // ordered by id throughout
    expect(all.every((e, i) => e.id === i + 1)).toBe(true);

    // generous budget so this stays reliable on slow CI, well under the ~20s target
    expect(insertMs + readMs).toBeLessThan(15000);
  }, 20000);
});
