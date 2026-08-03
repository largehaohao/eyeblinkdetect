import { describe, it, expect, beforeEach } from 'vitest';
import { openDB, writeMinute, getRange, listAll, clearAll, writeBlink, getBlinks, pruneBlinks } from '../../src/lib/db';

describe('db', () => {
  beforeEach(async () => {
    await openDB();
    await clearAll();
  });

  it('round-trips a minute bucket', async () => {
    await writeMinute({
      tsMinute: 1_700_000_000_000,
      blinks: 12,
      faceVisibleMs: 60_000,
      status: 'ok',
      sessionId: 's1'
    });
    const got = await getRange(1_700_000_000_000, 1_700_000_000_001);
    expect(got).toHaveLength(1);
    expect(got[0]!.blinks).toBe(12);
  });

  it('returns rows in tsMinute order', async () => {
    await writeMinute({ tsMinute: 200, blinks: 1, faceVisibleMs: 60_000, status: 'ok', sessionId: 's' });
    await writeMinute({ tsMinute: 100, blinks: 2, faceVisibleMs: 60_000, status: 'ok', sessionId: 's' });
    const got = await getRange(0, 1000);
    expect(got.map(r => r.tsMinute)).toEqual([100, 200]);
  });

  it('listAll returns everything ordered', async () => {
    await writeMinute({ tsMinute: 1, blinks: 1, faceVisibleMs: 60_000, status: 'ok', sessionId: 's' });
    await writeMinute({ tsMinute: 2, blinks: 1, faceVisibleMs: 60_000, status: 'ok', sessionId: 's' });
    const all = await listAll();
    expect(all).toHaveLength(2);
  });
});

describe('blink storage', () => {
  beforeEach(async () => { await openDB(); await clearAll(); });

  it('keeps both blinks recorded in the same millisecond', async () => {
    await writeBlink({ t: 1000, sessionId: 's1' });
    await writeBlink({ t: 1000, sessionId: 's1' });
    const got = await getBlinks(0, 2000);
    expect(got).toHaveLength(2);
  });

  it('returns blinks in the requested range, ordered', async () => {
    await writeBlink({ t: 300, sessionId: 's' });
    await writeBlink({ t: 100, sessionId: 's' });
    await writeBlink({ t: 9999, sessionId: 's' });
    const got = await getBlinks(0, 1000);
    expect(got.map(b => b.t)).toEqual([100, 300]);
  });

  it('prunes only blinks older than the cutoff', async () => {
    await writeBlink({ t: 100, sessionId: 's' });
    await writeBlink({ t: 5000, sessionId: 's' });
    const removed = await pruneBlinks(1000);
    expect(removed).toBe(1);
    expect((await getBlinks(0, 10_000)).map(b => b.t)).toEqual([5000]);
  });
});
