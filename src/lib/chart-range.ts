export const BPM_RANGES = {
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
  if (range === '6h' || range === '12h' || range === 'day') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
