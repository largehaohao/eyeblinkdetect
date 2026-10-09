import { describe, it, expect } from 'vitest';
import { createAggregator } from '../../src/lib/aggregator';

const MIN = 60_000;

describe('aggregator', () => {
  it('carries face loss across skipped windows after a delayed alarm', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 10_000 });
    expect(agg.flush(5 * MIN, 6 * MIN).faceVisibleMs).toBe(0);
    agg.onEvent({ type: 'face_present', t: 6 * MIN + 20_000 });
    expect(agg.flush(6 * MIN, 7 * MIN).faceVisibleMs).toBe(40_000);
  });
  it('counts blinks within the minute', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'blink', t: 100 });
    agg.onEvent({ type: 'blink', t: 200 });
    agg.onEvent({ type: 'blink', t: 30_000 });
    const b = agg.flush(0, MIN);
    expect(b.blinks).toBe(3);
  });

  it('excludes blinks outside the minute window', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'blink', t: 100 });
    agg.onEvent({ type: 'blink', t: 70_000 });
    const b = agg.flush(0, MIN);
    expect(b.blinks).toBe(1);
  });

  it('reports full face-visible time when face never lost', () => {
    const agg = createAggregator();
    const b = agg.flush(0, MIN);
    expect(b.faceVisibleMs).toBe(MIN);
  });

  it('subtracts face-lost intervals from faceVisibleMs', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 10_000 });
    agg.onEvent({ type: 'face_present', t: 40_000 });
    const b = agg.flush(0, MIN);
    expect(b.faceVisibleMs).toBe(MIN - 30_000);
  });

  it('handles face_lost crossing the minute boundary', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 50_000 });
    const b = agg.flush(0, MIN);
    expect(b.faceVisibleMs).toBe(50_000);
    const b2 = agg.flush(MIN, 2 * MIN);
    expect(b2.faceVisibleMs).toBe(0);
  });

  it('handles face_lost in previous minute, recovered in current', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 50_000 });
    const b1 = agg.flush(0, MIN);
    expect(b1.faceVisibleMs).toBe(50_000);
    agg.onEvent({ type: 'face_present', t: MIN + 20_000 });
    const b2 = agg.flush(MIN, 2 * MIN);
    expect(b2.faceVisibleMs).toBe(MIN - 20_000);
  });

  it('marks status=insufficient when faceVisibleMs < 30s', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 5_000 });
    const b = agg.flush(0, MIN);
    expect(b.status).toBe('insufficient');
  });

  it('marks status=ok when faceVisibleMs >= 30s', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 35_000 });
    const b = agg.flush(0, MIN);
    expect(b.status).toBe('ok');
  });
});

describe('aggregator reset', () => {
  it('drops buffered events so a resumed minute is not polluted', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'blink', t: 1000 });
    agg.onEvent({ type: 'blink', t: 2000 });
    agg.reset();
    const b = agg.flush(0, MIN);
    expect(b.blinks).toBe(0);
  });

  it('clears a stale face-lost flag so the next minute counts as visible', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 10_000 });
    agg.flush(0, MIN);          // ends absent
    agg.reset();
    const b = agg.flush(MIN, 2 * MIN);
    expect(b.faceVisibleMs).toBe(MIN);
    expect(b.status).toBe('ok');
  });
});
