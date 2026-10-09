import { describe, expect, it } from 'vitest';
import { averageBpm, recentBpm, statusView } from '../../src/lib/ui';
import type { MinuteRow } from '../../src/lib/db';
const row = (tsMinute: number, blinks = 10, faceVisibleMs = 60_000): MinuteRow => ({ tsMinute, blinks, faceVisibleMs, status: 'ok', sessionId: 'test' });
describe('UI summaries', () => {
  it('uses elapsed calendar minutes instead of the number of records', () => {
    const now = 20 * 60_000 + 1234;
    expect(recentBpm([row(5 * 60_000)], now)).toBeNull();
    expect(recentBpm([row(5 * 60_000, 100), row(15 * 60_000, 15), row(19 * 60_000, 5), row(20 * 60_000, 100)], now)).toBe(10);
  });
  it('weights by visible duration and never divides by zero', () => {
    expect(averageBpm([row(0, 10, 30_000), row(60_000, 10, 60_000)])).toBeCloseTo(13.333);
    expect(averageBpm([row(0, 10, 0)])).toBeNull();
  });
  it('explains why calibration cannot proceed while away or paused', () => {
    expect(statusView({ state: 'ABSENT', calibration: 'running' }).label).toBe('Away from camera');
    expect(statusView({ state: 'PAUSED', calibration: 'running' }).label).toBe('Paused');
    expect(statusView({ state: 'OFF', calibration: 'idle', lastError: 'Camera disconnected' }).detail).toContain('Camera disconnected');
  });
});
