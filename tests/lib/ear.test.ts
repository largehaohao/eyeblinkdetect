import { describe, it, expect } from 'vitest';
import { computeEAR, EAR_INDICES, calibrateThresholds } from '../../src/lib/ear';
import { openEye, closedEye } from '../fixtures/landmarks';

describe('computeEAR', () => {
  it('returns ~0.4 for open eyes', () => {
    const ear = computeEAR(openEye);
    expect(ear).toBeGreaterThan(0.35);
    expect(ear).toBeLessThan(0.45);
  });

  it('returns < 0.15 for closed eyes', () => {
    const ear = computeEAR(closedEye);
    expect(ear).toBeLessThan(0.15);
  });

  it('exposes the eye landmark indices it uses', () => {
    expect(EAR_INDICES.left.p1).toBe(33);
    expect(EAR_INDICES.right.p1).toBe(362);
  });

  it('throws on empty landmark array', () => {
    expect(() => computeEAR([])).toThrow();
  });
});

describe('calibrateThresholds', () => {
  const samples = (value: number, n = 300) => Array.from({ length: n }, () => value);

  it('derives thresholds from a normal open-eye distribution', () => {
    const result = calibrateThresholds(samples(0.32));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.openThresh).toBeCloseTo(0.256, 3);
    expect(result.closeThresh).toBeCloseTo(0.2048, 3);
    expect(result.closeThresh).toBeLessThan(result.openThresh);
  });

  it('rejects a calibration taken with eyes mostly closed', () => {
    const result = calibrateThresholds(samples(0.05));
    expect(result.ok).toBe(false);
  });

  it('rejects implausibly high thresholds', () => {
    const result = calibrateThresholds(samples(0.9));
    expect(result.ok).toBe(false);
  });

  it('rejects too few usable samples rather than guessing', () => {
    expect(calibrateThresholds([0.3, 0.3, 0.3]).ok).toBe(false);
  });

  it('ignores non-finite and non-positive samples', () => {
    const dirty = [...samples(0.32, 100), NaN, 0, -1, Infinity];
    const result = calibrateThresholds(dirty);
    expect(result.ok).toBe(true);
  });
});
