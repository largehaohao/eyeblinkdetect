import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings, DEFAULTS } from '../../src/lib/settings';
import { clearAll, openDB, writeSetting } from '../../src/lib/db';

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

describe('settings sanitization', () => {
  beforeEach(async () => { await openDB(); await clearAll(); });

  it('rejects NaN from an empty form field instead of persisting it', async () => {
    const saved = await saveSettings({
      threshold: { lowBpm: NaN, windowMinutes: 5, sustainMinutes: 3 }
    } as any);
    expect(saved.threshold.lowBpm).toBe(DEFAULTS.threshold.lowBpm);
    expect(Number.isFinite((await loadSettings()).threshold.lowBpm)).toBe(true);
  });

  it('clamps out-of-range numbers into bounds', async () => {
    const saved = await saveSettings({
      threshold: { lowBpm: 9999, windowMinutes: 0, sustainMinutes: 3 },
      cooldownMinutes: -5
    } as any);
    expect(saved.threshold.lowBpm).toBe(60);
    expect(saved.threshold.windowMinutes).toBe(1);
    expect(saved.cooldownMinutes).toBe(1);
  });

  it('never lets a null patch blank out a settings branch', async () => {
    const saved = await saveSettings({ threshold: null } as any);
    expect(saved.threshold.lowBpm).toBe(DEFAULTS.threshold.lowBpm);
  });

  it('repairs settings already stored in a broken shape', async () => {
    await writeSetting('settings.v1', { threshold: { lowBpm: 'abc' }, reminderModes: null });
    const s = await loadSettings();
    expect(s.threshold.lowBpm).toBe(DEFAULTS.threshold.lowBpm);
    expect(s.reminderModes.systemNotification).toBe(DEFAULTS.reminderModes.systemNotification);
    expect(s.reminderModes.fullscreenOverlay).toBe(false);
  });

  it('rejects EAR thresholds that are out of range or reversed', async () => {
    const saved = await saveSettings({
      ear: { closeThresh: 0.4, openThresh: 0.2, personalized: true }
    });
    expect(saved.ear).toEqual(DEFAULTS.ear);
  });

  it('accepts a plausible personalized EAR threshold pair', async () => {
    const saved = await saveSettings({
      ear: { closeThresh: 0.24, openThresh: 0.3, personalized: true }
    });
    expect(saved.ear).toEqual({ closeThresh: 0.24, openThresh: 0.3, personalized: true });
  });
});
