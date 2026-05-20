import { describe, it, expect } from 'vitest';
import { shouldRemind } from '../../src/lib/reminder-policy';
import type { MinuteBucket } from '../../src/lib/aggregator';

const CFG = {
  lowBpm: 10,
  windowMinutes: 5,
  sustainMinutes: 3,
  cooldownMs: 5 * 60_000
};

function bucket(blinks: number, faceMs = 60_000): MinuteBucket {
  return { blinks, faceVisibleMs: faceMs, status: faceMs >= 30_000 ? 'ok' : 'insufficient' };
}

describe('shouldRemind', () => {
  it('returns false if not enough data', () => {
    const buckets = [bucket(5), bucket(5)];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(false);
  });

  it('fires when window avg < threshold and sustained >= sustainMinutes', () => {
    const buckets = [bucket(5), bucket(5), bucket(5), bucket(5), bucket(5)];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(true);
  });

  it('does not fire if recent minute is above threshold (not sustained)', () => {
    const buckets = [bucket(5), bucket(5), bucket(20), bucket(5), bucket(5)];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(false);
  });

  it('respects cooldown window', () => {
    const buckets = [bucket(5), bucket(5), bucket(5), bucket(5), bucket(5)];
    const lastFiredAt = 100_000;
    const now = lastFiredAt + 60_000;
    expect(shouldRemind(buckets, lastFiredAt, CFG, now)).toBe(false);
  });

  it('fires again after cooldown', () => {
    const buckets = [bucket(5), bucket(5), bucket(5), bucket(5), bucket(5)];
    const lastFiredAt = 100_000;
    const now = lastFiredAt + 6 * 60_000;
    expect(shouldRemind(buckets, lastFiredAt, CFG, now)).toBe(true);
  });

  it('ignores insufficient minutes in the window', () => {
    const buckets = [
      bucket(5),
      bucket(5),
      bucket(5),
      bucket(0, 10_000),
      bucket(0, 10_000)
    ];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(true);
  });

  it('does not fire if all minutes in window are insufficient', () => {
    const buckets = [
      bucket(0, 10_000),
      bucket(0, 10_000),
      bucket(0, 10_000),
      bucket(0, 10_000),
      bucket(0, 10_000)
    ];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(false);
  });
});
