import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings, DEFAULTS } from '../../src/lib/settings';
import { clearAll, openDB } from '../../src/lib/db';

describe('settings', () => {
  beforeEach(async () => { await openDB(); await clearAll(); });

  it('returns defaults on first load', async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULTS);
  });

  it('persists overrides and merges with defaults', async () => {
    await saveSettings({ threshold: { lowBpm: 8, windowMinutes: 5, sustainMinutes: 3 } });
    const s = await loadSettings();
    expect(s.threshold.lowBpm).toBe(8);
    expect(s.cooldownMinutes).toBe(DEFAULTS.cooldownMinutes);
    expect(s.audio.rawBlinkSoundMuted).toBe(false);
  });
});
