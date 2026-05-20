import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  writeMinute: vi.fn(),
  getRange: vi.fn(),
  writeSession: vi.fn(),
  updateSessionEnd: vi.fn(),
  writeBlink: vi.fn(),
  getBlinks: vi.fn()
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

function installChromeMock() {
  let onMessage: Listener | null = null;
  let onAlarm: Listener | null = null;
  let onIdle: Listener | null = null;
  let onStartup: Listener | null = null;
  let onInstalled: Listener | null = null;
  let hasOffscreen = false;
  const sessionStore = new Map<string, unknown>();

  const chromeMock = {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      sendMessage: vi.fn(() => Promise.resolve()),
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
        get: vi.fn(async (key: string) => ({ [key]: sessionStore.get(key) }))
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
    settings.loadSettings.mockResolvedValue({
      threshold: { lowBpm: 10, windowMinutes: 5, sustainMinutes: 3 },
      cooldownMinutes: 5,
      reminderModes: { systemNotification: true, fullscreenOverlay: false },
      ear: { closeThresh: 0.2, openThresh: 0.25, personalized: false }
    });
    settings.saveSettings.mockResolvedValue(undefined);
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
});
