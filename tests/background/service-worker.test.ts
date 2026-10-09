import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  writeMinute: vi.fn(),
  getRange: vi.fn(),
  writeSession: vi.fn(),
  updateSessionEnd: vi.fn(),
  writeBlink: vi.fn(),
  getBlinks: vi.fn(),
  pruneBlinks: vi.fn(),
  BLINK_RETENTION_MS: 7 * 24 * 60 * 60_000
}));

const settings = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn()
}));

vi.mock('@/lib/db', () => db);
vi.mock('@/lib/settings', () => settings);

type Listener = (...args: any[]) => any;

function deferred(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function installChromeMock(
  initialSessionState?: Record<string, unknown>,
  initialLocalState?: Record<string, unknown>
) {
  let onMessage: Listener | null = null;
  let onAlarm: Listener | null = null;
  let onIdle: Listener | null = null;
  let onStartup: Listener | null = null;
  let onInstalled: Listener | null = null;
  let hasOffscreen = false;
  const sessionStore = new Map<string, unknown>(Object.entries(initialSessionState ?? {}));
  const localStore = new Map<string, unknown>(Object.entries(initialLocalState ?? {}));

  const chromeMock = {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      sendMessage: vi.fn(() => Promise.resolve()),
      getContexts: vi.fn(async () => []),
      onMessage: { addListener: vi.fn((cb: Listener) => { onMessage = cb; }) },
      onStartup: { addListener: vi.fn((cb: Listener) => { onStartup = cb; }) },
      onInstalled: { addListener: vi.fn((cb: Listener) => { onInstalled = cb; }) }
    },
    offscreen: {
      hasDocument: vi.fn(async () => hasOffscreen),
      createDocument: vi.fn(async () => { hasOffscreen = true; }),
      closeDocument: vi.fn(async () => { hasOffscreen = false; })
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      onAlarm: { addListener: vi.fn((cb: Listener) => { onAlarm = cb; }) }
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn()
    },
    storage: {
      session: {
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) sessionStore.set(key, value);
        }),
        get: vi.fn(async (key: string) => ({ [key]: sessionStore.get(key) })),
        remove: vi.fn(async (key: string) => { sessionStore.delete(key); })
      },
      local: {
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) localStore.set(key, value);
        }),
        get: vi.fn(async (key: string) => ({ [key]: localStore.get(key) })),
        remove: vi.fn(async (key: string) => { localStore.delete(key); })
      }
    },
    tabs: {
      create: vi.fn(),
      query: vi.fn()
    },
    notifications: {
      create: vi.fn()
    },
    scripting: {
      executeScript: vi.fn()
    },
    permissions: {
      contains: vi.fn(async () => true)
    },
    idle: {
      onStateChanged: { addListener: vi.fn((cb: Listener) => { onIdle = cb; }) },
      setDetectionInterval: vi.fn()
    }
  };

  vi.stubGlobal('chrome', chromeMock);
  vi.stubGlobal('navigator', {
    permissions: { query: vi.fn(async () => ({ state: 'granted' })) }
  });

  return {
    chromeMock,
    sessionStore,
    localStore,
    get onMessage() { return onMessage!; },
    get onAlarm() { return onAlarm!; },
    get onIdle() { return onIdle!; },
    get onStartup() { return onStartup; },
    get onInstalled() { return onInstalled; }
  };
}

async function sendUI(onMessage: Listener, payload: unknown): Promise<unknown> {
  return new Promise(resolve => {
    onMessage({ from: 'ui', payload }, {}, resolve);
  });
}

describe('service worker idle handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    db.getRange.mockResolvedValue([]);
    db.getBlinks.mockResolvedValue([]);
    db.writeMinute.mockResolvedValue(undefined);
    db.writeSession.mockResolvedValue(undefined);
    db.updateSessionEnd.mockResolvedValue(undefined);
    db.writeBlink.mockResolvedValue(undefined);
    db.pruneBlinks.mockResolvedValue(0);
    settings.loadSettings.mockResolvedValue({
      threshold: { lowBpm: 10, windowMinutes: 5, sustainMinutes: 3 },
      cooldownMinutes: 5,
      reminderModes: { systemNotification: true, fullscreenOverlay: false },
      ear: { closeThresh: 0.2, openThresh: 0.25, personalized: false }
    });
    settings.saveSettings.mockResolvedValue(undefined);
  });

  it('keeps calibration progress and completion available after reopening the UI', async () => {
    const env = installChromeMock();
    await import('../../src/background/service-worker');
    await sendUI(env.onMessage, { kind: 'toggle', on: true });
    expect(await sendUI(env.onMessage, { kind: 'status' })).toMatchObject({ calibration: 'running' });
    await new Promise<void>(resolve => env.onMessage({ from: 'offscreen', payload: {
      kind: 'calibration_done', closeThresh: 0.22, openThresh: 0.28
    } }, {}, () => resolve()));
    expect(await sendUI(env.onMessage, { kind: 'status' })).toMatchObject({ calibration: 'done' });
    expect(env.sessionStore.get('sessionState')).toMatchObject({ calibration: 'done' });
    expect(env.chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ from: 'sw_ui', payload: { kind: 'detector_feedback' } });
  });

  it('reports that permission setup was opened instead of pretending tracking started', async () => {
    const env = installChromeMock();
    vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'prompt' }) } });
    await import('../../src/background/service-worker');
    expect(await sendUI(env.onMessage, { kind: 'toggle', on: true })).toMatchObject({ state: 'OFF', permissionRequired: true });
    expect(env.chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    expect(env.chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('serializes independent settings saves so read/merge/write operations cannot overlap', async () => {
    const env = installChromeMock();
    await import('../../src/background/service-worker');
    let resolveFirst!: () => void;
    settings.saveSettings.mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirst = resolve; }));
    const first = sendUI(env.onMessage, { kind: 'settings_set', patch: { cooldownMinutes: 12 } });
    const second = sendUI(env.onMessage, { kind: 'settings_set', patch: { audio: { rawBlinkSoundMuted: true } } });
    await deferred();
    expect(settings.saveSettings).toHaveBeenCalledTimes(1);
    resolveFirst();
    await Promise.all([first, second]);
    expect(settings.saveSettings).toHaveBeenCalledTimes(2);
  });

  it('restarts interrupted calibration after returning from idle', async () => {
    const env = installChromeMock();
    await import('../../src/background/service-worker');
    await sendUI(env.onMessage, { kind: 'toggle', on: true });
    await env.onIdle('locked');
    expect(await sendUI(env.onMessage, { kind: 'status' })).toMatchObject({ state: 'PAUSED', calibration: 'idle' });
    env.chromeMock.runtime.sendMessage.mockClear();
    await env.onIdle('active');
    expect(env.chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ from: 'sw', payload: { kind: 'recalibrate' } });
    expect(await sendUI(env.onMessage, { kind: 'status' })).toMatchObject({ state: 'RUNNING', calibration: 'running' });
  });

  it('does not write minute buckets while paused by idle lock', async () => {
    const env = installChromeMock();
    await import('../../src/background/service-worker');

    await sendUI(env.onMessage, { kind: 'toggle', on: true });
    await deferred();

    await env.onIdle('locked');
    await deferred();

    await env.onAlarm({ name: 'tick' });

    expect(db.writeMinute).not.toHaveBeenCalled();
  });

  it('starts calibration automatically before personalized EAR thresholds exist', async () => {
    const env = installChromeMock();
    await import('../../src/background/service-worker');

    await sendUI(env.onMessage, { kind: 'toggle', on: true });
    await deferred();

    expect(env.chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      from: 'sw',
      payload: { kind: 'recalibrate' }
    });
  });

  it('uses runtime contexts when offscreen.hasDocument is unavailable', async () => {
    settings.loadSettings.mockResolvedValue({
      threshold: { lowBpm: 10, windowMinutes: 5, sustainMinutes: 3 },
      cooldownMinutes: 5,
      reminderModes: { systemNotification: true, fullscreenOverlay: false },
      audio: { rawBlinkSoundMuted: false },
      ear: { closeThresh: 0.2, openThresh: 0.25, personalized: true }
    });
    const env = installChromeMock();
    (env.chromeMock.offscreen as any).hasDocument = undefined;
    env.chromeMock.runtime.getContexts.mockResolvedValue([{} as never]);
    await import('../../src/background/service-worker');

    await sendUI(env.onMessage, { kind: 'toggle', on: true });

    expect(env.chromeMock.runtime.getContexts).toHaveBeenCalled();
    expect(env.chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('fires a notification when low blink rate crosses the reminder policy', async () => {
    settings.loadSettings.mockResolvedValue({
      threshold: { lowBpm: 10, windowMinutes: 1, sustainMinutes: 1 },
      cooldownMinutes: 5,
      reminderModes: { systemNotification: true, fullscreenOverlay: false },
      audio: { rawBlinkSoundMuted: false },
      ear: { closeThresh: 0.2, openThresh: 0.25, personalized: true }
    });
    // Reminder decisions always read persisted minute rows, so the window has to
    // be seeded here rather than relying on in-memory buckets.
    const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
    db.getRange.mockResolvedValue([
      { tsMinute: nowMinute, blinks: 0, faceVisibleMs: 60_000, status: 'ok', sessionId: 's1' }
    ]);
    const env = installChromeMock();
    await import('../../src/background/service-worker');

    await sendUI(env.onMessage, { kind: 'toggle', on: true });
    await deferred();
    const nextTick = Date.now() + 60_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(nextTick);
    await env.onAlarm({ name: 'tick' });
    dateNow.mockRestore();

    expect(env.chromeMock.notifications.create).toHaveBeenCalledWith(expect.stringMatching(/^low-blink-/), expect.objectContaining({
      iconUrl: 'chrome-extension://test/src/icons/icon-128.png',
      title: 'Eyes need a break'
    }));
  });

  it('can send a Chrome notification from the dashboard diagnostic', async () => {
    const env = installChromeMock();
    await import('../../src/background/service-worker');

    await sendUI(env.onMessage, { kind: 'test_notification' });

    expect(env.chromeMock.notifications.create).toHaveBeenCalledWith(expect.stringMatching(/^test-/), expect.objectContaining({
      title: 'Eye Blink Detector test'
    }));
  });

  it('uses persisted minute history for reminder windows after service worker restarts', async () => {
    settings.loadSettings.mockResolvedValue({
      threshold: { lowBpm: 10, windowMinutes: 3, sustainMinutes: 3 },
      cooldownMinutes: 5,
      reminderModes: { systemNotification: true, fullscreenOverlay: false },
      audio: { rawBlinkSoundMuted: false },
      ear: { closeThresh: 0.2, openThresh: 0.25, personalized: true }
    });
    db.getRange.mockResolvedValue([
      { tsMinute: 0, blinks: 0, faceVisibleMs: 60_000, status: 'ok', sessionId: 's1' },
      { tsMinute: 60_000, blinks: 0, faceVisibleMs: 60_000, status: 'ok', sessionId: 's1' },
      { tsMinute: 120_000, blinks: 0, faceVisibleMs: 60_000, status: 'ok', sessionId: 's1' }
    ]);
    const env = installChromeMock();
    await import('../../src/background/service-worker');

    await sendUI(env.onMessage, { kind: 'toggle', on: true });
    await deferred();
    const nextTick = Date.now() + 60_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(nextTick);
    await env.onAlarm({ name: 'tick' });
    dateNow.mockRestore();

    expect(db.getRange).toHaveBeenCalled();
    expect(env.chromeMock.notifications.create).toHaveBeenCalledWith(expect.stringMatching(/^low-blink-/), expect.objectContaining({
      title: 'Eyes need a break'
    }));
  });

  it('restores running session state before handling an alarm after service worker reload', async () => {
    settings.loadSettings.mockResolvedValue({
      threshold: { lowBpm: 10, windowMinutes: 1, sustainMinutes: 1 },
      cooldownMinutes: 5,
      reminderModes: { systemNotification: true, fullscreenOverlay: false },
      audio: { rawBlinkSoundMuted: false },
      ear: { closeThresh: 0.2, openThresh: 0.25, personalized: true }
    });
    const minuteStart = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
    const env = installChromeMock({
      sessionState: { state: 'RUNNING', sessionId: 's1', lastReminderAt: 0, currentMinuteStart: minuteStart }
    });
    await import('../../src/background/service-worker');

    await env.onAlarm({ name: 'tick' });

    expect(db.writeMinute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      tsMinute: minuteStart
    }));
  });

  it('does not commit the current minute before it has ended', async () => {
    const minuteStart = Math.floor(Date.now() / 60_000) * 60_000;
    const env = installChromeMock({
      sessionState: { state: 'RUNNING', sessionId: 's1', lastReminderAt: 0, currentMinuteStart: minuteStart }
    });
    await import('../../src/background/service-worker');

    await env.onAlarm({ name: 'tick' });

    expect(db.writeMinute).not.toHaveBeenCalled();
  });

  it('replays persisted raw blinks when rebuilding an unfinished minute', async () => {
    const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
    db.getBlinks.mockResolvedValue([{ t: nowMinute - 30_000, sessionId: 's1' }]);
    const env = installChromeMock({
      sessionState: {
        state: 'RUNNING', sessionId: 's1', lastReminderAt: 0,
        currentMinuteStart: nowMinute - 60_000, faceEvents: []
      }
    });
    await import('../../src/background/service-worker');

    await env.onAlarm({ name: 'tick' });

    expect(db.writeMinute).toHaveBeenCalledWith(expect.objectContaining({ blinks: 1 }));
  });

  it('restores persisted face-loss intervals after worker reload', async () => {
    const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
    const env = installChromeMock({
      sessionState: {
        state: 'ABSENT', sessionId: 's1', lastReminderAt: 0,
        currentMinuteStart: nowMinute - 60_000,
        presentAtMinuteStart: true,
        faceEvents: [{ type: 'face_lost', t: nowMinute - 50_000 }]
      }
    });
    await import('../../src/background/service-worker');

    await env.onAlarm({ name: 'tick' });

    expect(db.writeMinute).toHaveBeenCalledWith(expect.objectContaining({
      faceVisibleMs: 10_000,
      status: 'insufficient'
    }));
    expect((env.sessionStore.get('sessionState') as { presentAtMinuteStart: boolean }).presentAtMinuteStart).toBe(false);
  });

  it('restores an absent minute baseline followed by a face-present event', async () => {
    const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
    const env = installChromeMock({
      sessionState: {
        state: 'RUNNING', sessionId: 's1', lastReminderAt: 0,
        currentMinuteStart: nowMinute - 60_000,
        presentAtMinuteStart: false,
        faceEvents: [{ type: 'face_present', t: nowMinute - 50_000 }]
      }
    });
    await import('../../src/background/service-worker');

    await env.onAlarm({ name: 'tick' });

    expect(db.writeMinute).toHaveBeenCalledWith(expect.objectContaining({
      faceVisibleMs: 50_000,
      status: 'ok'
    }));
  });

  it('flushes every elapsed minute when an alarm fires late', async () => {
    const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
    const behindBy = 4;
    const env = installChromeMock({
      sessionState: {
        state: 'RUNNING',
        sessionId: 's1',
        lastReminderAt: 0,
        currentMinuteStart: nowMinute - behindBy * 60_000
      }
    });
    await import('../../src/background/service-worker');

    await env.onAlarm({ name: 'tick' });

    // Only completed minutes are committed; the current minute remains open.
    const written = db.writeMinute.mock.calls.map(c => (c[0] as { tsMinute: number }).tsMinute);
    expect(written).toEqual(
      Array.from({ length: behindBy }, (_, i) => nowMinute - behindBy * 60_000 + i * 60_000)
    );
  });

  it('caps catch-up work after a very long gap', async () => {
    const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
    const env = installChromeMock({
      sessionState: {
        state: 'RUNNING',
        sessionId: 's1',
        lastReminderAt: 0,
        currentMinuteStart: nowMinute - 5000 * 60_000
      }
    });
    await import('../../src/background/service-worker');

    await env.onAlarm({ name: 'tick' });

    expect(db.writeMinute).toHaveBeenCalledTimes(120);
    const first = (db.writeMinute.mock.calls[0]![0] as { tsMinute: number }).tsMinute;
    expect(first).toBe(nowMinute - 120 * 60_000);
  });

  it('does not resume a camera session after a browser restart', async () => {
    const env = installChromeMock();
    await import('../../src/background/service-worker');

    await env.onStartup!();

    expect(env.chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
    expect(env.chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('closes out a durably recorded interrupted session on browser restart', async () => {
    const env = installChromeMock(undefined, {
      activeSession: { sessionId: 'old-session', lastSeenAt: 123_456 }
    });
    await import('../../src/background/service-worker');

    await env.onStartup!();

    expect(db.updateSessionEnd).toHaveBeenCalledWith('old-session', 123_456, 'error');
    expect(env.localStore.has('activeSession')).toBe(false);
  });
});
