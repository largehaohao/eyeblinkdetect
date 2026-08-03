import type { MinuteBucket } from './aggregator';

export type ReminderConfig = {
  lowBpm: number;
  windowMinutes: number;
  sustainMinutes: number;
  cooldownMs: number;
};

export type ReminderDecisionReason =
  | 'ready'
  | 'insufficient_window'
  | 'cooldown'
  | 'no_valid_minutes'
  | 'window_average_not_low'
  | 'insufficient_sustain'
  | 'no_valid_sustain'
  | 'recent_minute_not_low';

export type ReminderDecision = {
  shouldRemind: boolean;
  reason: ReminderDecisionReason;
  bucketCount: number;
  validBucketCount: number;
  averageBpm: number | null;
  cooldownRemainingMs: number;
};

function windowAvgBpm(buckets: MinuteBucket[]): number | null {
  const ok = buckets.filter(b => b.status === 'ok');
  if (ok.length === 0) return null;
  const totalBlinks = ok.reduce((s, b) => s + b.blinks, 0);
  const totalMs = ok.reduce((s, b) => s + b.faceVisibleMs, 0);
  if (totalMs === 0) return null;
  return totalBlinks / (totalMs / 60_000);
}

export function evaluateReminder(
  buckets: MinuteBucket[],
  lastFiredAt: number,
  cfg: ReminderConfig,
  nowMs: number
): ReminderDecision {
  const base = {
    bucketCount: buckets.length,
    validBucketCount: buckets.filter(b => b.status === 'ok').length,
    averageBpm: null,
    cooldownRemainingMs: 0
  };
  if (buckets.length < cfg.windowMinutes) {
    return { ...base, shouldRemind: false, reason: 'insufficient_window' };
  }
  if (lastFiredAt > 0 && nowMs - lastFiredAt < cfg.cooldownMs) {
    return {
      ...base,
      shouldRemind: false,
      reason: 'cooldown',
      cooldownRemainingMs: cfg.cooldownMs - (nowMs - lastFiredAt)
    };
  }

  const window = buckets.slice(-cfg.windowMinutes);
  const avg = windowAvgBpm(window);
  const withAverage = { ...base, averageBpm: avg };
  if (avg === null) return { ...withAverage, shouldRemind: false, reason: 'no_valid_minutes' };
  if (avg >= cfg.lowBpm) {
    return { ...withAverage, shouldRemind: false, reason: 'window_average_not_low' };
  }

  const sustainSlice = buckets.slice(-cfg.sustainMinutes);
  if (sustainSlice.length < cfg.sustainMinutes) {
    return { ...withAverage, shouldRemind: false, reason: 'insufficient_sustain' };
  }
  const sustainOk = sustainSlice.filter(b => b.status === 'ok');
  if (sustainOk.length === 0) {
    return { ...withAverage, shouldRemind: false, reason: 'no_valid_sustain' };
  }
  for (const b of sustainOk) {
    const minuteBpm = b.blinks / (b.faceVisibleMs / 60_000);
    if (minuteBpm >= cfg.lowBpm) {
      return { ...withAverage, shouldRemind: false, reason: 'recent_minute_not_low' };
    }
  }
  return { ...withAverage, shouldRemind: true, reason: 'ready' };
}

export function shouldRemind(
  buckets: MinuteBucket[],
  lastFiredAt: number,
  cfg: ReminderConfig,
  nowMs: number
): boolean {
  return evaluateReminder(buckets, lastFiredAt, cfg, nowMs).shouldRemind;
}
