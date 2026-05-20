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
  t: number;          // blink timestamp (ms since epoch)
  sessionId: string;
};

const DB_NAME = 'eye-blink-detect';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function openDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = idbOpen(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('minutes')) {
          db.createObjectStore('minutes', { keyPath: 'tsMinute' });
        }
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
        if (!db.objectStoreNames.contains('blinks')) {
          db.createObjectStore('blinks', { keyPath: 't' });
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
  await db.put('blinks', row);
}

export async function getBlinks(fromMs: number, toMs: number): Promise<BlinkRow[]> {
  const db = await openDB();
  const range = IDBKeyRange.bound(fromMs, toMs, false, true);
  const rows = await db.getAll('blinks', range);
  return rows.sort((a, b) => a.t - b.t);
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
