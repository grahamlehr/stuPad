/**
 * IndexedDB persistence: deck, config, kiosk state, and the append-only event log.
 * See docs/PLAN.md "Store API" for the public contract.
 *
 * Durability: appendEvent/clearEvents only resolve once their IndexedDB transaction
 * has completed ('complete' event), so a caller that has received the resolved value
 * knows the write survived to disk (Safari/iPadOS flush the transaction before firing
 * 'complete').
 *
 * Ordering: rapid appendEvent calls are serialized through an in-memory write queue so
 * events are written (and thus assigned ids) in call order, even though each call opens
 * its own transaction.
 */
import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { Deck, KioskConfig, KioskState, LogEvent, EventFilter } from '../types';
import { isoLocal } from '../util';

const DB_NAME = 'stupad';
const DB_VERSION = 1;

const STORE_DECK = 'deck';
const STORE_CONFIG = 'config';
const STORE_STATE = 'state';
const STORE_EVENTS = 'events';
const SINGLETON_KEY = 'current';

/**
 * On-disk shape of an event record. `t` is an internal numeric epoch-ms mirror of `ts`,
 * kept only so from/to range filters can use a real IDB index range (and cursors/getAll)
 * instead of parsing every record's `ts` string at query time. It is always stripped
 * before a record is handed back to callers.
 */
interface StoredEvent extends LogEvent {
  t: number;
}

function parseInstant(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

function stripT(row: StoredEvent): LogEvent {
  const { t: _t, ...rest } = row;
  return rest;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function openDatabase(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_DECK)) db.createObjectStore(STORE_DECK);
        if (!db.objectStoreNames.contains(STORE_CONFIG)) db.createObjectStore(STORE_CONFIG);
        if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
        if (!db.objectStoreNames.contains(STORE_EVENTS)) {
          const events = db.createObjectStore(STORE_EVENTS, { keyPath: 'id', autoIncrement: true });
          events.createIndex('session_id', 'session_id');
          events.createIndex('t', 't');
        }
      },
      blocking() {
        // A newer connection (e.g. another tab, or a future version of this app) wants
        // to open; close ours so it isn't blocked indefinitely.
        const p = dbPromise;
        dbPromise = null;
        void p?.then((db) => db.close());
      },
      terminated() {
        // The browser force-closed the connection (e.g. IndexedDB was wiped).
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

// ------------------------------------------------------------- write queue

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn);
  // Keep the chain alive even if a write fails, without turning a caller's own
  // rejection into an unhandled rejection here.
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ------------------------------------------------------------------- deck

export async function saveDeck(deck: Deck): Promise<void> {
  const db = await openDatabase();
  await db.put(STORE_DECK, deck, SINGLETON_KEY);
}

export async function loadDeck(): Promise<Deck | undefined> {
  const db = await openDatabase();
  const deck = (await db.get(STORE_DECK, SINGLETON_KEY)) as Deck | undefined;
  // A deck saved before navLinks/backLinks existed won't have the fields; normalise here
  // so every other module can rely on them always being arrays.
  if (deck && !deck.navLinks) deck.navLinks = [];
  if (deck && !deck.backLinks) deck.backLinks = [];
  return deck;
}

export async function deleteDeck(): Promise<void> {
  const db = await openDatabase();
  await db.delete(STORE_DECK, SINGLETON_KEY);
}

// ----------------------------------------------------------------- config

export async function saveConfig(cfg: KioskConfig): Promise<void> {
  const db = await openDatabase();
  await db.put(STORE_CONFIG, cfg, SINGLETON_KEY);
}

export async function loadConfig(): Promise<KioskConfig | undefined> {
  const db = await openDatabase();
  return db.get(STORE_CONFIG, SINGLETON_KEY);
}

// ------------------------------------------------------------- kiosk state

const DEFAULT_STATE: KioskState = { running: false, sessionId: null, startedAt: null };

export async function getKioskState(): Promise<KioskState> {
  const db = await openDatabase();
  const s = (await db.get(STORE_STATE, SINGLETON_KEY)) as KioskState | undefined;
  return s ?? DEFAULT_STATE;
}

export async function setKioskState(s: KioskState): Promise<void> {
  const db = await openDatabase();
  await db.put(STORE_STATE, s, SINGLETON_KEY);
}

// ------------------------------------------------------------------ events

export async function appendEvent(e: LogEvent): Promise<number> {
  return enqueue(async () => {
    const db = await openDatabase();
    const stored: Partial<StoredEvent> = { ...e, t: parseInstant(e.ts) };
    delete stored.id; // let autoIncrement assign it
    const tx = db.transaction(STORE_EVENTS, 'readwrite');
    const id = await tx.store.add(stored as StoredEvent);
    await tx.done; // durable: resolves only once the transaction has committed
    return id as number;
  });
}

export async function getEvents(f?: EventFilter): Promise<LogEvent[]> {
  const db = await openDatabase();
  const hasRange = f?.from !== undefined || f?.to !== undefined;
  const fromT = f?.from !== undefined ? parseInstant(f.from) : -Infinity;
  const toT = f?.to !== undefined ? parseInstant(f.to) : Infinity;

  let rows: StoredEvent[];
  if (f?.sessionId !== undefined) {
    rows = (await db.getAllFromIndex(STORE_EVENTS, 'session_id', f.sessionId)) as StoredEvent[];
    // index('session_id').getAll for a single key value is already ordered by
    // primary key (id), so this stays id-ordered.
    if (hasRange) rows = rows.filter((r) => r.t >= fromT && r.t <= toT);
  } else if (hasRange) {
    const range = IDBKeyRange.bound(fromT, toT);
    rows = (await db.getAllFromIndex(STORE_EVENTS, 't', range)) as StoredEvent[];
    // Ordered by t here, not necessarily by id (two events can share a millisecond) -
    // re-sort to keep the documented "ordered by id" contract.
    rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  } else {
    rows = (await db.getAll(STORE_EVENTS)) as StoredEvent[];
  }
  return rows.map(stripT);
}

export async function countEvents(f?: EventFilter): Promise<number> {
  const db = await openDatabase();
  const hasRange = f?.from !== undefined || f?.to !== undefined;
  if (f?.sessionId === undefined && !hasRange) {
    return db.count(STORE_EVENTS);
  }
  if (f?.sessionId !== undefined && !hasRange) {
    return db.countFromIndex(STORE_EVENTS, 'session_id', f.sessionId);
  }
  if (f?.sessionId === undefined && hasRange) {
    const fromT = f?.from !== undefined ? parseInstant(f.from) : -Infinity;
    const toT = f?.to !== undefined ? parseInstant(f.to) : Infinity;
    return db.countFromIndex(STORE_EVENTS, 't', IDBKeyRange.bound(fromT, toT));
  }
  // Both sessionId and a date range: no single index covers both, fall back to a filtered fetch.
  const rows = await getEvents(f);
  return rows.length;
}

export async function listSessions(): Promise<
  { sessionId: string; first: string; last: string; count: number }[]
> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_EVENTS, 'readonly');
  const index = tx.store.index('session_id');
  const stats = new Map<string, { first: string; firstT: number; last: string; lastT: number; count: number }>();
  let cursor = await index.openCursor();
  while (cursor) {
    const row = cursor.value as StoredEvent;
    const sid = row.session_id;
    const existing = stats.get(sid);
    if (!existing) {
      stats.set(sid, { first: row.ts, firstT: row.t, last: row.ts, lastT: row.t, count: 1 });
    } else {
      existing.count += 1;
      if (row.t < existing.firstT) {
        existing.first = row.ts;
        existing.firstT = row.t;
      }
      if (row.t > existing.lastT) {
        existing.last = row.ts;
        existing.lastT = row.t;
      }
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return Array.from(stats.entries())
    .map(([sessionId, s]) => ({ sessionId, first: s.first, last: s.last, count: s.count, firstT: s.firstT }))
    .sort((a, b) => a.firstT - b.firstT)
    .map(({ sessionId, first, last, count }) => ({ sessionId, first, last, count }));
}

export async function clearEvents(sessionId: string): Promise<void> {
  return enqueue(async () => {
    const db = await openDatabase();
    const clearTx = db.transaction(STORE_EVENTS, 'readwrite');
    await clearTx.store.clear();
    await clearTx.done;

    const clearedEvent: LogEvent = { ts: isoLocal(), session_id: sessionId, event: 'log_cleared' };
    const stored: Partial<StoredEvent> = { ...clearedEvent, t: parseInstant(clearedEvent.ts) };
    delete stored.id;
    const appendTx = db.transaction(STORE_EVENTS, 'readwrite');
    await appendTx.store.add(stored as StoredEvent);
    await appendTx.done;
  });
}

/**
 * "Clear previous data": wipes the deck (with its media and rasters), config, kiosk state
 * and every event in one transaction, so the next person starts from an empty Setup. The
 * same transaction appends a `log_cleared` record, so the wipe itself is logged.
 */
export async function clearAllData(sessionId: string): Promise<void> {
  return enqueue(async () => {
    const db = await openDatabase();
    const tx = db.transaction([STORE_DECK, STORE_CONFIG, STORE_STATE, STORE_EVENTS], 'readwrite');
    await Promise.all([
      tx.objectStore(STORE_DECK).clear(),
      tx.objectStore(STORE_CONFIG).clear(),
      tx.objectStore(STORE_STATE).clear(),
      tx.objectStore(STORE_EVENTS).clear(),
    ]);
    const clearedEvent: LogEvent = { ts: isoLocal(), session_id: sessionId, event: 'log_cleared' };
    const stored: Partial<StoredEvent> = { ...clearedEvent, t: parseInstant(clearedEvent.ts) };
    delete stored.id;
    await tx.objectStore(STORE_EVENTS).add(stored as StoredEvent);
    await tx.done;
  });
}

// ------------------------------------------------------------- persistence

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- testing
// Not part of the documented Store API (docs/PLAN.md); used only by tests/store to
// set up large fixtures quickly and to exercise "persistence across reopen".

/** Inserts many events in one transaction, bypassing the write queue. Test fixtures only. */
export async function _bulkInsertForTests(events: LogEvent[]): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_EVENTS, 'readwrite');
  for (const e of events) {
    const stored: Partial<StoredEvent> = { ...e, t: parseInstant(e.ts) };
    delete stored.id;
    void tx.store.add(stored as StoredEvent);
  }
  await tx.done;
}

/** Closes the current connection so a later call re-opens it. Simulates app relaunch. */
export async function _closeForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    dbPromise = null;
    db.close();
  }
}
