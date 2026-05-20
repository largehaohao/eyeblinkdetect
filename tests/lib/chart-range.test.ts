import { describe, expect, it } from 'vitest';
import { BPM_RANGES, bpmTickLimit, formatBpmTick } from '../../src/lib/chart-range';

describe('BPM chart range helpers', () => {
  it('provides short and long range choices for the main BPM chart', () => {
    expect(Object.keys(BPM_RANGES)).toEqual(['6h', '12h', 'day', 'week', 'month', 'all']);
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

    expect(formatBpmTick(t, '6h')).toMatch(/09:05|5:05/);
    expect(formatBpmTick(t, 'week')).toContain('May');
    expect(formatBpmTick(t, 'month')).toContain('May');
  });
});
