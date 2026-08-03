import { readSetting, writeSetting } from './db';
import { OPEN_THRESH_BOUNDS } from './ear';

export type Settings = {
  threshold: { lowBpm: number; windowMinutes: number; sustainMinutes: number };
  cooldownMinutes: number;
  reminderModes: { systemNotification: boolean; fullscreenOverlay: boolean };
  audio: { rawBlinkSoundMuted: boolean };
  ear: { closeThresh: number; openThresh: number; personalized: boolean };
};

export const DEFAULTS: Settings = {
  threshold: { lowBpm: 10, windowMinutes: 5, sustainMinutes: 3 },
  cooldownMinutes: 5,
  reminderModes: { systemNotification: true, fullscreenOverlay: false },
  audio: { rawBlinkSoundMuted: false },
  ear: { closeThresh: 0.20, openThresh: 0.25, personalized: false }
};

const KEY = 'settings.v1';

/**
 * Bounds for every numeric setting. A value outside its range — or NaN, which is
 * what an empty form field parses to — falls back to the default rather than
 * being persisted, since NaN comparisons silently disable reminders forever.
 */
const NUMERIC_BOUNDS = {
  'threshold.lowBpm': [1, 60],
  'threshold.windowMinutes': [1, 120],
  'threshold.sustainMinutes': [1, 120],
  cooldownMinutes: [1, 240]
} as const;

export async function loadSettings(): Promise<Settings> {
  const raw = await readSetting<Partial<Settings>>(KEY);
  if (!raw) return structuredClone(DEFAULTS);
  return sanitize(deepMerge(structuredClone(DEFAULTS), raw));
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const merged = sanitize(deepMerge(current, patch));
  await writeSetting(KEY, merged);
  return merged;
}

function clamp(value: unknown, fallback: number, [min, max]: readonly [number, number]): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A missing boolean falls back to its default; only a real boolean overrides it. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Coerces untrusted numbers into range and repairs structurally broken settings. */
export function sanitize(s: Settings): Settings {
  const d = DEFAULTS;
  const threshold = s.threshold ?? d.threshold;
  const ear = s.ear ?? d.ear;
  const closeThresh = Number(ear.closeThresh);
  const openThresh = Number(ear.openThresh);
  const validEar = Number.isFinite(closeThresh) && Number.isFinite(openThresh) &&
    openThresh >= OPEN_THRESH_BOUNDS.min && openThresh <= OPEN_THRESH_BOUNDS.max &&
    closeThresh >= OPEN_THRESH_BOUNDS.min * 0.5 && closeThresh < openThresh;
  return {
    threshold: {
      lowBpm: clamp(threshold.lowBpm, d.threshold.lowBpm, NUMERIC_BOUNDS['threshold.lowBpm']),
      windowMinutes: clamp(threshold.windowMinutes, d.threshold.windowMinutes, NUMERIC_BOUNDS['threshold.windowMinutes']),
      sustainMinutes: clamp(threshold.sustainMinutes, d.threshold.sustainMinutes, NUMERIC_BOUNDS['threshold.sustainMinutes'])
    },
    cooldownMinutes: clamp(s.cooldownMinutes, d.cooldownMinutes, NUMERIC_BOUNDS.cooldownMinutes),
    reminderModes: {
      systemNotification: bool(s.reminderModes?.systemNotification, d.reminderModes.systemNotification),
      fullscreenOverlay: bool(s.reminderModes?.fullscreenOverlay, d.reminderModes.fullscreenOverlay)
    },
    audio: { rawBlinkSoundMuted: bool(s.audio?.rawBlinkSoundMuted, d.audio.rawBlinkSoundMuted) },
    ear: validEar
      ? { closeThresh, openThresh, personalized: bool(ear.personalized, false) }
      : { ...d.ear, personalized: false }
  };
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const out: any = Array.isArray(target) ? [...(target as any)] : { ...(target as any) };
  for (const k of Object.keys(source) as Array<keyof T>) {
    const v = (source as any)[k];
    if (v === undefined || v === null) continue;  // never let a patch null out a branch
    if (typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
