import { describe, expect, it } from 'vitest';
import { BPM_RANGES, bpmTickLimit, formatBpmTick, downsample } from '../../src/lib/chart-range';

describe('BPM chart range helpers', () => {
  it('provides short and long range choices for the main BPM chart', () => {
    expect(Object.keys(BPM_RANGES)).toEqual(['10m', '30m', '1h', '6h', '12h', 'day', 'week', 'month', 'all']);
    expect(BPM_RANGES['10m']).toBe(10 * 60_000);
    expect(BPM_RANGES['30m']).toBe(30 * 60_000);
    expect(BPM_RANGES['1h']).toBe(60 * 60_000);
    expect(BPM_RANGES['6h']).toBe(6 * 60 * 60_000);
    expect(BPM_RANGES.all).toBe('all');
  });

  it('keeps x-axis tick counts sparse as ranges get wider', () => {
    expect(bpmTickLimit('6h')).toBe(5);
    expect(bpmTickLimit('day')).toBe(6);
    expect(bpmTickLimit('week')).toBe(7);
    expect(bpmTickLimit('month')).toBe(6);
    expect(bpmTickLimit('all')).toBe(6);
  });

  it('formats short ranges as time and long ranges as dates', () => {
    const t = Date.UTC(2026, 4, 20, 9, 5);

    for (const range of ['10m', '30m', '1h'] as const) {
      expect(formatBpmTick(t, range)).toBe(formatBpmTick(t, '6h'));
    }
    expect(formatBpmTick(t, '6h')).toMatch(/09:05|5:05/);
    expect(formatBpmTick(t, 'week')).toContain('May');
    expect(formatBpmTick(t, 'month')).toContain('May');
  });
});

describe('downsample', () => {
  const row = (tsMinute: number, blinks: number) => ({
    tsMinute, blinks, faceVisibleMs: 60_000, status: 'ok' as const
  });

  it('leaves small series untouched', () => {
    const rows = [row(0, 1), row(60_000, 2)];
    expect(downsample(rows, 600)).toEqual(rows);
  });

  it('reduces long series to at most maxPoints', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(i * 60_000, 1));
    expect(downsample(rows, 600).length).toBeLessThanOrEqual(600);
  });

  it('preserves the overall blink rate across buckets', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i * 60_000, 10));
    const out = downsample(rows, 100);
    const bpm = out.map(r => r.blinks / (r.faceVisibleMs / 60_000));
    for (const v of bpm) expect(v).toBeCloseTo(10, 6);
  });

  it('marks a bucket insufficient only when every row in it is', () => {
    const rows = [
      { tsMinute: 0, blinks: 0, faceVisibleMs: 1000, status: 'insufficient' as const },
      { tsMinute: 60_000, blinks: 0, faceVisibleMs: 1000, status: 'insufficient' as const }
    ];
    expect(downsample(rows, 1)[0]!.status).toBe('insufficient');
  });
});
