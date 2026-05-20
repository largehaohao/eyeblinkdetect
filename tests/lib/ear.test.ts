import { describe, it, expect } from 'vitest';
import { computeEAR, EAR_INDICES } from '../../src/lib/ear';
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
