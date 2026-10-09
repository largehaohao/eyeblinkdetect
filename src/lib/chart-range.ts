export const BPM_RANGES = {
  '10m': 10 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
  all: 'all'
} as const;

export type BpmRangeKey = keyof typeof BPM_RANGES;

export function bpmTickLimit(range: BpmRangeKey): number {
  if (range === '6h') return 5;
  if (range === '12h' || range === 'day') return 6;
  if (range === 'week') return 7;
  return 6;
}

export function formatBpmTick(value: string | number, range: BpmRangeKey): string {
  const d = new Date(Number(value));
  const duration = BPM_RANGES[range];
  if (duration !== 'all' && duration <= BPM_RANGES.day) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Chart points beyond this get averaged into buckets before rendering. */
export const MAX_CHART_POINTS = 600;

/**
 * Averages consecutive rows into at most `maxPoints` buckets. Long ranges
 * ('month', 'all') can hold tens of thousands of minutes — far more than a
 * ~900px canvas can resolve — so plotting them raw only costs time.
 * Bucket weighting is by blinks and visible time, not by per-minute BPM, so the
 * averaged rate matches what the summary stats report.
 */
export function downsample<T extends { tsMinute: number; blinks: number; faceVisibleMs: number; status: 'ok' | 'insufficient' }>(
  rows: T[],
  maxPoints: number = MAX_CHART_POINTS
): Array<{ tsMinute: number; blinks: number; faceVisibleMs: number; status: 'ok' | 'insufficient' }> {
  if (rows.length <= maxPoints) return rows;
  const groupSize = Math.ceil(rows.length / maxPoints);
  const out: Array<{ tsMinute: number; blinks: number; faceVisibleMs: number; status: 'ok' | 'insufficient' }> = [];
  for (let i = 0; i < rows.length; i += groupSize) {
    const group = rows.slice(i, i + groupSize);
    const ok = group.filter(r => r.status === 'ok');
    // Totals, not averages: downstream BPM is blinks / (faceVisibleMs / 60s), so
    // summing both preserves the true rate across the bucket.
    out.push({
      tsMinute: group[0]!.tsMinute,
      blinks: ok.reduce((s, r) => s + r.blinks, 0),
      faceVisibleMs: ok.reduce((s, r) => s + r.faceVisibleMs, 0),
      status: ok.length > 0 ? 'ok' : 'insufficient'
    });
  }
  return out;
}
