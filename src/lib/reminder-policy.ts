import type { MinuteBucket } from './aggregator';

export type ReminderConfig = {
  lowBpm: number;
  windowMinutes: number;
  sustainMinutes: number;
  cooldownMs: number;
};

function windowAvgBpm(buckets: MinuteBucket[]): number | null {
  const ok = buckets.filter(b => b.status === 'ok');
  if (ok.length === 0) return null;
  const totalBlinks = ok.reduce((s, b) => s + b.blinks, 0);
  const totalMs = ok.reduce((s, b) => s + b.faceVisibleMs, 0);
  if (totalMs === 0) return null;
  return totalBlinks / (totalMs / 60_000);
}

export function shouldRemind(
  buckets: MinuteBucket[],
  lastFiredAt: number,
  cfg: ReminderConfig,
  nowMs: number
): boolean {
  if (buckets.length < cfg.windowMinutes) return false;
  if (lastFiredAt > 0 && nowMs - lastFiredAt < cfg.cooldownMs) return false;

  const window = buckets.slice(-cfg.windowMinutes);
  const avg = windowAvgBpm(window);
  if (avg === null) return false;
  if (avg >= cfg.lowBpm) return false;

  const sustainSlice = buckets.slice(-cfg.sustainMinutes);
  if (sustainSlice.length < cfg.sustainMinutes) return false;
  const sustainOk = sustainSlice.filter(b => b.status === 'ok');
  if (sustainOk.length === 0) return false;
  for (const b of sustainOk) {
    const minuteBpm = b.blinks / (b.faceVisibleMs / 60_000);
    if (minuteBpm >= cfg.lowBpm) return false;
  }
  return true;
}
