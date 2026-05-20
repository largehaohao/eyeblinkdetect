export type DetectorMsg =
  | { kind: 'blink'; t: number }
  | { kind: 'face_lost'; t: number }
  | { kind: 'face_present'; t: number }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'calibration_done'; closeThresh: number; openThresh: number };

export type ControlMsg =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'recalibrate' };

export type UIQuery =
  | { kind: 'status' }
  | { kind: 'recent_minutes'; sinceMs: number }
  | { kind: 'range'; fromMs: number; toMs: number }
  | { kind: 'settings_get' }
  | { kind: 'settings_set'; patch: Record<string, unknown> }
  | { kind: 'toggle'; on: boolean }
  | { kind: 'recalibrate' };

export type UIEvent =
  | { kind: 'state_changed'; state: 'OFF' | 'RUNNING' | 'PAUSED' | 'ABSENT' }
  | { kind: 'minute_committed'; tsMinute: number };

export const MSG_PORT = 'eye-blink-detect';
