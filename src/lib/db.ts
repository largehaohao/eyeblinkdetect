import { openDB as idbOpen, type IDBPDatabase } from 'idb';

export type MinuteRow = {
  tsMinute: number;
  blinks: number;
  faceVisibleMs: number;
  status: 'ok' | 'insufficient';
  sessionId: string;
};

export type SessionRow = {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  reason: 'manual' | 'idle' | 'error';
};

export type BlinkRow = {
  id?: number;        // autoIncrement key; absent on rows not yet written
  t: number;          // blink timestamp (ms since epoch)
  sessionId: string;
};

const DB_NAME = 'eye-blink-detect';
const DB_VERSION = 3;

/** Raw blink events older than this are pruned; minute buckets are kept forever. */
export const BLINK_RETENTION_MS = 7 * 24 * 60 * 60_000;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function openDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = idbOpen(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains('minutes')) {
          db.createObjectStore('minutes', { keyPath: 'tsMinute' });
        }
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }

        // v2 keyed blinks by `t`, so two blinks in the same millisecond silently
        // overwrote each other. v3 uses an autoIncrement key with a `t` index.
        let carried: BlinkRow[] = [];
        if (db.objectStoreNames.contains('blinks')) {
          if (oldVersion >= 3) return;
          carried = await tx.objectStore('blinks').getAll() as BlinkRow[];
          db.deleteObjectStore('blinks');
        }
        const blinks = db.createObjectStore('blinks', { keyPath: 'id', autoIncrement: true });
        blinks.createIndex('t', 't');
        for (const row of carried) {
          blinks.add({ t: row.t, sessionId: row.sessionId });
        }
      }
    });
  }
  return dbPromise;
}

export async function writeMinute(row: MinuteRow): Promise<void> {
  const db = await openDB();
  await db.put('minutes', row);
}

export async function getRange(fromMs: number, toMs: number): Promise<MinuteRow[]> {
  const db = await openDB();
  const range = IDBKeyRange.bound(fromMs, toMs, false, true);
  const rows = await db.getAll('minutes', range);
  return rows.sort((a, b) => a.tsMinute - b.tsMinute);
}

export async function listAll(): Promise<MinuteRow[]> {
  const db = await openDB();
  const rows = await db.getAll('minutes');
  return rows.sort((a, b) => a.tsMinute - b.tsMinute);
}

export async function writeSession(row: SessionRow): Promise<void> {
  const db = await openDB();
  await db.put('sessions', row);
}

export async function updateSessionEnd(sessionId: string, endedAt: number, reason: SessionRow['reason']): Promise<void> {
  const db = await openDB();
  const existing = await db.get('sessions', sessionId) as SessionRow | undefined;
  if (!existing) return;  // session was never started; nothing to update
  await db.put('sessions', { ...existing, endedAt, reason });
}

export async function readSetting<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return db.get('settings', key);
}

export async function writeSetting<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  await db.put('settings', value, key);
}

export async function writeBlink(row: BlinkRow): Promise<void> {
  const db = await openDB();
  // add(), not put(): every blink is a distinct row even at identical timestamps.
  await db.add('blinks', { t: row.t, sessionId: row.sessionId });
}

export async function getBlinks(fromMs: number, toMs: number): Promise<BlinkRow[]> {
  const db = await openDB();
  const range = IDBKeyRange.bound(fromMs, toMs, false, true);
  const rows = await db.getAllFromIndex('blinks', 't', range) as BlinkRow[];
  return rows.sort((a, b) => a.t - b.t);
}

/** Deletes raw blink events older than `cutoffMs`. Returns how many were removed. */
export async function pruneBlinks(cutoffMs: number): Promise<number> {
  const db = await openDB();
  const tx = db.transaction('blinks', 'readwrite');
  const index = tx.store.index('t');
  let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoffMs, true));
  let removed = 0;
  while (cursor) {
    await cursor.delete();
    removed += 1;
    cursor = await cursor.continue();
  }
  await tx.done;
  return removed;
}

export async function clearAll(): Promise<void> {
  const db = await openDB();
  await Promise.all([
    db.clear('minutes'),
    db.clear('sessions'),
    db.clear('settings'),
    db.clear('blinks')
  ]);
}
