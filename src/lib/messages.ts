export type DetectorMsg =
  | { kind: 'ready' }
  | { kind: 'blink'; t: number }
  | { kind: 'face_lost'; t: number }
  | { kind: 'face_present'; t: number }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'calibration_done'; closeThresh: number; openThresh: number }
  | { kind: 'calibration_failed'; reason: string };

export type ControlMsg =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'recalibrate' };

export type DetectorStatus = {
  state: 'OFF' | 'RUNNING' | 'PAUSED' | 'ABSENT';
  calibration: 'idle' | 'running' | 'done' | 'failed';
  calibrationMessage?: string;
  lastError?: string;
};

export type ReminderDiagnostic = {
  state: 'OFF' | 'RUNNING' | 'PAUSED' | 'ABSENT';
  lastReminderAt: number;
  lowBpm: number;
  windowMinutes: number;
  sustainMinutes: number;
  systemNotification: boolean;
  fullscreenOverlay: boolean;
  bucketCount: number;
  validBucketCount: number;
  averageBpm: number | null;
  cooldownRemainingMs: number;
  reason:
    | 'ready'
    | 'insufficient_window'
    | 'cooldown'
    | 'no_valid_minutes'
    | 'window_average_not_low'
    | 'insufficient_sustain'
    | 'no_valid_sustain'
    | 'recent_minute_not_low';
};

export type UIQuery =
  | { kind: 'status' }
  | { kind: 'recent_minutes'; sinceMs: number }
  | { kind: 'range'; fromMs: number; toMs: number }
  | { kind: 'blinks_range'; fromMs: number; toMs: number }
  | { kind: 'settings_get' }
  | { kind: 'settings_set'; patch: Record<string, unknown> }
  | { kind: 'reminder_diagnostic' }
  | { kind: 'test_notification' }
  | { kind: 'toggle'; on: boolean }
  | { kind: 'recalibrate' };

export type UIEvent =
  | { kind: 'detector_feedback' }
  | { kind: 'state_changed'; state: 'OFF' | 'RUNNING' | 'PAUSED' | 'ABSENT' }
  | { kind: 'minute_committed'; tsMinute: number };

export const MSG_PORT = 'eye-blink-detect';
