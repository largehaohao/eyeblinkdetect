import { describe, it, expect, beforeEach } from 'vitest';
import { openDB, writeMinute, getRange, listAll, clearAll } from '../../src/lib/db';

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
