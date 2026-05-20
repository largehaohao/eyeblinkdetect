import { readSetting, writeSetting } from './db';

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

export async function loadSettings(): Promise<Settings> {
  const raw = await readSetting<Partial<Settings>>(KEY);
  if (!raw) return structuredClone(DEFAULTS);
  return deepMerge(structuredClone(DEFAULTS), raw);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const merged = deepMerge(current, patch);
  await writeSetting(KEY, merged);
  return merged;
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const out: any = Array.isArray(target) ? [...(target as any)] : { ...(target as any) };
  for (const k of Object.keys(source) as Array<keyof T>) {
    const v = (source as any)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
