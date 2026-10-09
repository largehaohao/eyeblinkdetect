import { createAggregator } from '@/lib/aggregator';
import { evaluateReminder, type ReminderConfig } from '@/lib/reminder-policy';
import { writeMinute, getRange, writeSession, updateSessionEnd, writeBlink, getBlinks, pruneBlinks, BLINK_RETENTION_MS } from '@/lib/db';
import { loadSettings, saveSettings, type Settings } from '@/lib/settings';
import type { DetectorMsg, ControlMsg, UIQuery, UIEvent, DetectorStatus } from '@/lib/messages';

/** Flip to true to trace tick/reminder decisions in the service worker console. */
const DEBUG = false;
function log(...args: unknown[]): void {
  if (DEBUG) console.log('[ebd]', ...args);
}

type AppState = 'OFF' | 'RUNNING' | 'PAUSED' | 'ABSENT';
type StoredSessionState = {
  state?: AppState;
  sessionId?: string;
  lastReminderAt?: number;
  currentMinuteStart?: number | null;
  faceEvents?: FaceEvent[];
  presentAtMinuteStart?: boolean;
  calibration?: DetectorStatus['calibration'];
  calibrationMessage?: string;
  lastError?: string;
};

type FaceEvent = { type: 'face_lost' | 'face_present'; t: number };
type ActiveSession = { sessionId: string; lastSeenAt?: number };

const SESSION_KEY = 'sessionState';
const ACTIVE_SESSION_KEY = 'activeSession';
let agg = createAggregator();
let currentMinuteStart: number | null = null;
let faceEvents: FaceEvent[] = [];
let presentAtMinuteStart = true;
let lastReminderAt = 0;
let sessionId = '';
let state: AppState = 'OFF';
let calibration: DetectorStatus['calibration'] = 'idle';
let calibrationMessage = '';
let lastError = '';

function nowMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

async function setState(s: AppState): Promise<void> {
  state = s;
  await persistSessionState();
  await broadcast({ kind: 'state_changed', state });
  await updateBadge();
}

async function persistSessionState(): Promise<void> {
  const writes: Promise<unknown>[] = [
    chrome.storage.session.set({
      [SESSION_KEY]: {
        state, sessionId, lastReminderAt, currentMinuteStart, faceEvents, presentAtMinuteStart,
        calibration, calibrationMessage, lastError
      }
    })
  ];
  if (state !== 'OFF' && sessionId) {
    writes.push(chrome.storage.local.set({
      [ACTIVE_SESSION_KEY]: { sessionId, lastSeenAt: Date.now() } satisfies ActiveSession
    }));
  }
  await Promise.all(writes);
}

/**
 * Restores state after the service worker is torn down and respawned.
 *
 * Memoized deliberately: this must run at most once per worker lifetime. Running
 * it per message would race with in-flight persistSessionState() writes and roll
 * live in-memory state (state, currentMinuteStart) back to a stale snapshot.
 */
let hydration: Promise<void> | null = null;

function ensureHydrated(): Promise<void> {
  return hydration ??= hydrateRuntimeState();
}

async function hydrateRuntimeState(): Promise<void> {
  const data = await chrome.storage.session.get(SESSION_KEY);
  const saved = data[SESSION_KEY] as StoredSessionState | undefined;
  if (!saved?.state) return;

  state = saved.state;
  calibration = saved.calibration ?? 'idle';
  calibrationMessage = saved.calibrationMessage ?? '';
  lastError = saved.lastError ?? '';
  sessionId = saved.sessionId ?? sessionId;
  lastReminderAt = saved.lastReminderAt ?? lastReminderAt;
  if (saved.currentMinuteStart !== undefined && saved.currentMinuteStart !== null) {
    currentMinuteStart = saved.currentMinuteStart;
  } else if (state !== 'OFF' && currentMinuteStart === null) {
    currentMinuteStart = nowMinute() - 60_000;
  }

  // The aggregator lives only in memory. Rebuild the unfinished window from
  // durable raw blinks and the small face-transition log kept in session state.
  agg = createAggregator();
  presentAtMinuteStart = saved.presentAtMinuteStart ?? state !== 'ABSENT';
  faceEvents = (saved.faceEvents ?? []).filter(ev =>
    currentMinuteStart !== null && ev.t >= currentMinuteStart
  );
  if (currentMinuteStart !== null && state !== 'OFF' && state !== 'PAUSED') {
    const blinks = await getBlinks(currentMinuteStart, Date.now() + 1);
    for (const blink of blinks) agg.onEvent({ type: 'blink', t: blink.t });
    if (!presentAtMinuteStart) {
      agg.onEvent({ type: 'face_lost', t: currentMinuteStart });
    }
    for (const event of faceEvents) agg.onEvent(event);
  }
}

async function updateBadge(): Promise<void> {
  if (state === 'OFF') { chrome.action.setBadgeText({ text: '' }); return; }
  if (state === 'RUNNING') { chrome.action.setBadgeText({ text: 'ON' }); chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }); return; }
  if (state === 'PAUSED') { chrome.action.setBadgeText({ text: 'II' }); chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); return; }
  if (state === 'ABSENT') { chrome.action.setBadgeText({ text: '?' }); chrome.action.setBadgeBackgroundColor({ color: '#64748b' }); }
}

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creatingOffscreen: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }
  const workerClients = (globalThis as unknown as {
    clients?: { matchAll(): Promise<Array<{ url: string }>> };
  }).clients;
  return workerClients ? (await workerClients.matchAll()).some(client => client.url === offscreenUrl) : false;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
      justification: 'Webcam-based blink detection'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function closeOffscreen(): Promise<void> {
  if (creatingOffscreen) await creatingOffscreen;
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
}

async function postToOffscreen(payload: ControlMsg): Promise<void> {
  const response = await chrome.runtime.sendMessage({ from: 'sw', payload }) as
    | { ok?: boolean; error?: string }
    | undefined;
  if (response?.ok === false) throw new Error(response.error ?? 'Offscreen command failed');
}

async function broadcast(ev: UIEvent): Promise<void> {
  chrome.runtime.sendMessage({ from: 'sw_ui', payload: ev }).catch(() => {});
}

async function hasCameraPermission(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

async function openPermissionPage(): Promise<void> {
  const url = chrome.runtime.getURL('src/permission/permission.html');
  await chrome.tabs.create({ url });
}

let operationQueue: Promise<void> = Promise.resolve();

function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function clearActiveSession(endedAt: number, reason: 'manual' | 'idle' | 'error'): Promise<void> {
  if (sessionId) await updateSessionEnd(sessionId, endedAt, reason);
  await chrome.storage.local.remove(ACTIVE_SESSION_KEY);
}

async function reconcileInterruptedSession(): Promise<void> {
  const data = await chrome.storage.local.get(ACTIVE_SESSION_KEY);
  const active = data[ACTIVE_SESSION_KEY] as ActiveSession | undefined;
  if (active?.sessionId) await updateSessionEnd(active.sessionId, active.lastSeenAt ?? Date.now(), 'error');
  await chrome.storage.local.remove(ACTIVE_SESSION_KEY);
}

async function startSession(): Promise<boolean> {
  if (!await hasCameraPermission()) {
    await openPermissionPage();
    return false;
  }
  agg = createAggregator();
  faceEvents = [];
  presentAtMinuteStart = true;
  sessionId = crypto.randomUUID();
  await writeSession({ sessionId, startedAt: Date.now(), endedAt: null, reason: 'manual' });
  try {
    await chrome.storage.local.set({
      [ACTIVE_SESSION_KEY]: { sessionId, lastSeenAt: Date.now() } satisfies ActiveSession
    });
    await ensureOffscreen();
    const settings = await loadSettings();
    lastError = '';
    calibrationMessage = '';
    calibration = settings.ear.personalized ? 'idle' : 'running';
    await postToOffscreen(settings.ear.personalized ? { kind: 'start' } : { kind: 'recalibrate' });
    currentMinuteStart = nowMinute();
    chrome.alarms.create('tick', { periodInMinutes: 1 });
    await setState('RUNNING');
    return true;
  } catch (error) {
    await closeOffscreen().catch(() => {});
    await clearActiveSession(Date.now(), 'error');
    sessionId = '';
    currentMinuteStart = null;
    faceEvents = [];
    presentAtMinuteStart = true;
    calibration = 'idle';
    lastError = String(error);
    await setState('OFF');
    throw error;
  }
}

async function stopSession(reason: 'manual' | 'idle' | 'error'): Promise<void> {
  try {
    await postToOffscreen({ kind: 'stop' }).catch(() => {});
    await closeOffscreen();
  } finally {
    await clearActiveSession(Date.now(), reason);
    chrome.alarms.clear('tick');
    currentMinuteStart = null;
    faceEvents = [];
    presentAtMinuteStart = true;
    sessionId = '';
    calibration = 'idle';
    await setState('OFF');
  }
}

async function handleDetector(m: DetectorMsg): Promise<void> {
  await ensureHydrated();
  if (m.kind === 'ready') return;  // liveness ping; carries no detection state
  if ((m.kind === 'blink' || m.kind === 'face_lost' || m.kind === 'face_present') &&
      state !== 'RUNNING' && state !== 'ABSENT') return;
  if (m.kind === 'blink') {
    agg.onEvent({ type: 'blink', t: m.t });
    await writeBlink({ t: m.t, sessionId });
  }
  else if (m.kind === 'face_lost') {
    const event = { type: 'face_lost' as const, t: m.t };
    agg.onEvent(event);
    faceEvents.push(event);
    await setState('ABSENT');
  }
  else if (m.kind === 'face_present') {
    const event = { type: 'face_present' as const, t: m.t };
    agg.onEvent(event);
    faceEvents.push(event);
    if (state === 'ABSENT') await setState('RUNNING');
    else await persistSessionState();
  }
  else if (m.kind === 'error') {
    lastError = m.message;
    console.error('detector error', m);
    if (state !== 'OFF') await stopSession('error');
  }
  else if (m.kind === 'calibration_done') {
    await saveSettings({ ear: { closeThresh: m.closeThresh, openThresh: m.openThresh, personalized: true } });
    calibration = 'done';
    calibrationMessage = 'Calibration complete. Your personal thresholds are active.';
    await persistSessionState();
    await broadcast({ kind: 'detector_feedback' });
  }
  else if (m.kind === 'calibration_failed') {
    // Keep personalized:false so the next session retries instead of locking in
    // thresholds that would never register a blink.
    console.warn('[ebd] calibration rejected:', m.reason);
    calibration = 'failed';
    calibrationMessage = `Calibration could not finish: ${m.reason}. Face the camera in good light and try again.`;
    await persistSessionState();
    await broadcast({ kind: 'detector_feedback' });
  }
}

async function handleUI(q: UIQuery): Promise<unknown> {
  await ensureHydrated();
  if (q.kind === 'status') return { state, sessionId, lastReminderAt, calibration, calibrationMessage, lastError };
  if (q.kind === 'toggle') {
    return runExclusive(async () => {
      if (q.on && state === 'OFF' && !await startSession()) return { state, permissionRequired: true };
      if (!q.on && state !== 'OFF') await stopSession('manual');
      return { state };
    });
  }
  if (q.kind === 'recent_minutes') return getRange(q.sinceMs, Date.now() + 60_000);
  if (q.kind === 'range') return getRange(q.fromMs, q.toMs);
  if (q.kind === 'blinks_range') return getBlinks(q.fromMs, q.toMs);
  if (q.kind === 'settings_get') return loadSettings();
  if (q.kind === 'reminder_diagnostic') return getReminderDiagnostic();
  if (q.kind === 'test_notification') {
    await showSystemNotification(
      `test-${Date.now()}`,
      'Eye Blink Detector test',
      'Chrome extension notifications are working.'
    );
    return { ok: true };
  }
  // saveSettings() sanitizes; a malformed patch cannot poison stored settings.
  // Settings are read/merge/write. Serialize UI saves with calibration saves so
  // two pages cannot overwrite each other's independent preferences.
  if (q.kind === 'settings_set') return runExclusive(() => saveSettings(q.patch as Partial<Settings>));
  if (q.kind === 'recalibrate') {
    return runExclusive(async () => {
      if (state !== 'RUNNING' && state !== 'ABSENT') return { ok: false };
      await postToOffscreen({ kind: 'recalibrate' });
      calibration = 'running';
      calibrationMessage = '';
      await persistSessionState();
      await broadcast({ kind: 'detector_feedback' });
      return { ok: true };
    });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.from === 'offscreen') {
    runExclusive(() => handleDetector(msg.payload as DetectorMsg)).then(
      () => sendResponse({ ok: true }),
      error => sendResponse({ ok: false, error: String(error) })
    );
    return true;
  }
  if (msg?.from === 'ui') {
    handleUI(msg.payload as UIQuery).then(
      sendResponse,
      error => sendResponse({ __error: String(error) })
    );
    return true;
  }
});

/** Cap on minutes flushed in one tick, so a long sleep cannot stall the worker. */
const MAX_CATCHUP_MINUTES = 120;

const PRUNE_INTERVAL_MS = 60 * 60_000;
let lastPruneAt = 0;

function reminderConfig(settings: Settings): ReminderConfig {
  return {
    lowBpm: settings.threshold.lowBpm,
    windowMinutes: settings.threshold.windowMinutes,
    sustainMinutes: settings.threshold.sustainMinutes,
    cooldownMs: settings.cooldownMinutes * 60_000
  };
}

async function getReminderDiagnostic(): Promise<import('@/lib/messages').ReminderDiagnostic> {
  const settings = await loadSettings();
  const cfg = reminderConfig(settings);
  const end = nowMinute();
  const historyMinutes = Math.max(cfg.windowMinutes, cfg.sustainMinutes);
  const rows = await getRange(end - historyMinutes * 60_000, end);
  const decision = evaluateReminder(rows, lastReminderAt, cfg, Date.now());
  return {
    state,
    lastReminderAt,
    lowBpm: cfg.lowBpm,
    windowMinutes: cfg.windowMinutes,
    sustainMinutes: cfg.sustainMinutes,
    systemNotification: settings.reminderModes.systemNotification,
    fullscreenOverlay: settings.reminderModes.fullscreenOverlay,
    bucketCount: decision.bucketCount,
    validBucketCount: decision.validBucketCount,
    averageBpm: decision.averageBpm,
    cooldownRemainingMs: decision.cooldownRemainingMs,
    reason: decision.reason
  };
}

async function handleTick(): Promise<void> {
  await ensureHydrated();
  if (state !== 'RUNNING' && state !== 'ABSENT') return;
  if (currentMinuteStart === null) return;

  // MV3 alarms can fire late (power saving, laptop lid). Advancing by a single
  // minute per tick would let currentMinuteStart drift permanently behind the
  // wall clock, and the aggregator prunes on flush — so lagging windows would
  // discard real data. Flush every whole minute that has elapsed instead.
  const target = nowMinute();
  if (currentMinuteStart > target) return;  // clock moved backwards; wait it out

  const pending = Math.floor((target - currentMinuteStart) / 60_000);
  if (pending === 0) return;
  let cursor = currentMinuteStart;
  if (pending > MAX_CATCHUP_MINUTES) {
    log('skipping', pending - MAX_CATCHUP_MINUTES, 'stale minutes after long gap');
    cursor = target - MAX_CATCHUP_MINUTES * 60_000;
  }

  let lastEnd = cursor;
  while (cursor < target) {
    const start = cursor;
    const end = start + 60_000;
    const bucket = agg.flush(start, end);
    await writeMinute({ tsMinute: start, ...bucket, sessionId });
    log('tick bucket', { tsMinute: start, ...bucket });
    cursor = end;
    lastEnd = end;
    await broadcast({ kind: 'minute_committed', tsMinute: start });
  }
  currentMinuteStart = cursor;
  for (const event of faceEvents) {
    if (event.t < cursor) presentAtMinuteStart = event.type === 'face_present';
  }
  faceEvents = faceEvents.filter(event => event.t >= cursor);
  await persistSessionState();

  const settings = await loadSettings();
  if (settings.reminderModes.systemNotification || settings.reminderModes.fullscreenOverlay) {
    const cfg = reminderConfig(settings);
    const historyMinutes = Math.max(cfg.windowMinutes, cfg.sustainMinutes);
    const rows = await getRange(lastEnd - historyMinutes * 60_000, lastEnd);
    const reminderBuckets = rows.map(row => ({
      blinks: row.blinks,
      faceVisibleMs: row.faceVisibleMs,
      status: row.status
    }));
    const decision = evaluateReminder(reminderBuckets, lastReminderAt, cfg, Date.now());
    log('reminder check', { cfg, lastReminderAt, buckets: reminderBuckets, decision });
    if (decision.shouldRemind) {
      await fireReminder(settings);
      lastReminderAt = Date.now();
      await persistSessionState();
      log('reminder fired, cooldown until', new Date(lastReminderAt + cfg.cooldownMs).toLocaleTimeString());
    }
  }

  // Retention is measured in days, so an hourly sweep is plenty; running it on
  // every tick would scan the index 60x more often for nothing.
  if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = Date.now();
    void pruneBlinks(Date.now() - BLINK_RETENTION_MS).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'tick') return;
  await runExclusive(handleTick);
});

async function fireReminder(settings: Awaited<ReturnType<typeof loadSettings>>): Promise<void> {
  if (settings.reminderModes.systemNotification) {
    await showSystemNotification(
      `low-blink-${Date.now()}`,
      'Eyes need a break',
      'Your blink rate has been low. Look at something 20ft away for 20 seconds.'
    );
  }
  if (settings.reminderModes.fullscreenOverlay) {
    const allowed = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (!allowed) {
      console.warn('[ebd] fullscreen overlay skipped: host access was not granted');
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectOverlay
        });
      } catch { /* restricted page */ }
    }
  }
}

async function showSystemNotification(id: string, title: string, message: string): Promise<void> {
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('src/icons/icon-128.png'),
    title,
    message,
    priority: 2
  });
}

// Runs in the target page's content world. Self-contained — no closure over SW state.
function injectOverlay(): void {
  const ID = '__ebd_overlay__';
  if (document.getElementById(ID)) return;
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { color-scheme: dark; }
      * { box-sizing: border-box; }
      .backdrop {
        position: fixed; inset: 0; display: grid; place-items: center; padding: 24px;
        background: radial-gradient(circle at 50% 35%, rgba(20,184,166,.16), transparent 42%), rgba(2,6,23,.78);
        backdrop-filter: blur(14px) saturate(.85); -webkit-backdrop-filter: blur(14px) saturate(.85);
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        animation: ebd-fade-in .28s ease-out both;
      }
      .card {
        position: relative; width: min(100%, 520px); overflow: hidden; padding: 36px;
        border: 1px solid rgba(148,163,184,.22); border-radius: 28px;
        background: linear-gradient(145deg, rgba(30,41,59,.98), rgba(15,23,42,.98));
        box-shadow: 0 32px 90px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.06);
        color: #f8fafc; text-align: center;
        animation: ebd-card-in .36s cubic-bezier(.2,.8,.2,1) both;
      }
      .card::before {
        content: ""; position: absolute; inset: 0 0 auto; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(94,234,212,.78), transparent);
      }
      .close {
        position: absolute; top: 16px; right: 16px; display: grid; place-items: center;
        width: 36px; height: 36px; border: 1px solid rgba(148,163,184,.16); border-radius: 999px;
        background: rgba(15,23,42,.5); color: #94a3b8; cursor: pointer; font: 22px/1 system-ui;
        transition: color .18s ease, border-color .18s ease, background .18s ease;
      }
      .close:hover { color: #f8fafc; border-color: rgba(94,234,212,.42); background: rgba(30,41,59,.9); }
      .icon {
        display: grid; place-items: center; width: 68px; height: 68px; margin: 0 auto 20px;
        border: 1px solid rgba(94,234,212,.28); border-radius: 22px;
        background: linear-gradient(145deg, rgba(20,184,166,.22), rgba(45,212,191,.08));
        box-shadow: 0 14px 36px rgba(20,184,166,.12); color: #5eead4;
      }
      .eyebrow { margin: 0 0 8px; color: #5eead4; font-size: 12px; font-weight: 800; letter-spacing: .15em; text-transform: uppercase; }
      h2 { margin: 0; color: #f8fafc; font-size: clamp(27px, 6vw, 34px); line-height: 1.14; letter-spacing: -.035em; }
      .message { max-width: 390px; margin: 14px auto 26px; color: #cbd5e1; font-size: 15px; line-height: 1.65; }
      .rule {
        display: grid; grid-template-columns: 1fr 1px 1fr; align-items: center; gap: 20px;
        margin: 0 0 28px; padding: 18px 20px; border: 1px solid rgba(148,163,184,.14); border-radius: 18px;
        background: rgba(15,23,42,.48);
      }
      .rule-divider { width: 1px; height: 38px; background: rgba(148,163,184,.18); }
      .rule-value { display: block; color: #f8fafc; font-size: 27px; font-weight: 850; letter-spacing: -.03em; }
      .rule-label { display: block; margin-top: 2px; color: #94a3b8; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      .action {
        width: 100%; min-height: 50px; border: 0; border-radius: 14px;
        background: linear-gradient(135deg, #2dd4bf, #5eead4); color: #042f2e;
        cursor: pointer; font: 800 15px/1 system-ui; letter-spacing: -.01em;
        box-shadow: 0 12px 26px rgba(20,184,166,.2);
        transition: transform .18s ease, box-shadow .18s ease, filter .18s ease;
      }
      .action:hover { transform: translateY(-1px); filter: brightness(1.04); box-shadow: 0 16px 32px rgba(20,184,166,.26); }
      .action:active { transform: translateY(0); }
      button:focus-visible { outline: 3px solid rgba(94,234,212,.5); outline-offset: 3px; }
      .timer { margin: 13px 0 0; color: #64748b; font-size: 11px; font-weight: 650; }
      .progress { position: absolute; inset: auto 0 0; height: 3px; background: rgba(148,163,184,.1); }
      .progress::after {
        content: ""; display: block; width: 100%; height: 100%; transform-origin: left;
        background: linear-gradient(90deg, #14b8a6, #5eead4); animation: ebd-countdown 20s linear forwards;
      }
      @keyframes ebd-fade-in { from { opacity: 0; } }
      @keyframes ebd-card-in { from { opacity: 0; transform: translateY(14px) scale(.98); } }
      @keyframes ebd-countdown { to { transform: scaleX(0); } }
      @media (max-width: 520px) {
        .backdrop { padding: 14px; }
        .card { padding: 32px 22px 28px; border-radius: 22px; }
        .rule { gap: 14px; padding-inline: 14px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .backdrop, .card, .progress::after { animation: none; }
        .action { transition: none; }
      }
    </style>
    <div class="backdrop">
      <section class="card" role="dialog" aria-modal="true" aria-labelledby="ebd-title" aria-describedby="ebd-description">
        <button class="close" type="button" aria-label="Dismiss reminder">×</button>
        <div class="icon" aria-hidden="true">
          <svg width="38" height="38" viewBox="0 0 48 48" fill="none">
            <path d="M5.5 24s6.7-10.5 18.5-10.5S42.5 24 42.5 24 35.8 34.5 24 34.5 5.5 24 5.5 24Z" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>
            <circle cx="24" cy="24" r="5.5" fill="currentColor"/>
          </svg>
        </div>
        <p class="eyebrow">Low blink rate detected</p>
        <h2 id="ebd-title">Give your eyes a reset</h2>
        <p class="message" id="ebd-description">Relax your focus and look at something farther away. A short pause helps your eyes recover.</p>
        <div class="rule" aria-label="20-20 eye break">
          <div><span class="rule-value">20 ft</span><span class="rule-label">Look away</span></div>
          <span class="rule-divider" aria-hidden="true"></span>
          <div><span class="rule-value">20 sec</span><span class="rule-label">Rest your eyes</span></div>
        </div>
        <button class="action" type="button">I’m taking a break</button>
        <p class="timer" aria-live="polite">Closing in <span>20</span> seconds</p>
        <div class="progress" aria-hidden="true"></div>
      </section>
    </div>`;

  const previousFocus = document.activeElement as HTMLElement | null;
  const action = shadow.querySelector('.action') as HTMLButtonElement;
  const close = shadow.querySelector('.close') as HTMLButtonElement;
  const seconds = shadow.querySelector('.timer span')!;
  let remaining = 20;
  let countdown = 0;
  let autoClose = 0;

  const dismiss = () => {
    window.clearInterval(countdown);
    window.clearTimeout(autoClose);
    document.removeEventListener('keydown', onKeyDown, true);
    host.remove();
    previousFocus?.focus?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismiss();
  };

  document.documentElement.appendChild(host);
  document.addEventListener('keydown', onKeyDown, true);
  action.addEventListener('click', dismiss);
  close.addEventListener('click', dismiss);
  countdown = window.setInterval(() => {
    remaining -= 1;
    seconds.textContent = String(Math.max(remaining, 0));
  }, 1000);
  autoClose = window.setTimeout(dismiss, 20_000);
  action.focus();
}

chrome.idle.onStateChanged.addListener(async (newState) => {
  await runExclusive(async () => {
    await ensureHydrated();
    if (newState === 'active' && state === 'PAUSED') {
      try {
        await ensureOffscreen();
        const settings = await loadSettings();
        calibration = settings.ear.personalized ? 'idle' : 'running';
        calibrationMessage = '';
        await postToOffscreen(settings.ear.personalized ? { kind: 'start' } : { kind: 'recalibrate' });
      } catch (error) {
        lastError = String(error);
        await stopSession('error');
        return;
      }
      // Discard events buffered before the pause and clear the stale presence
      // flag; otherwise the first minute after resume reports a wrong
      // faceVisibleMs.
      agg.reset();
      faceEvents = [];
      presentAtMinuteStart = true;
      currentMinuteStart = nowMinute();
      await setState('RUNNING');
    } else if ((newState === 'idle' || newState === 'locked') && (state === 'RUNNING' || state === 'ABSENT')) {
      await postToOffscreen({ kind: 'stop' }).catch(() => {});
      calibration = 'idle';
      currentMinuteStart = null;
      faceEvents = [];
      presentAtMinuteStart = true;
      await setState('PAUSED');
    }
  });
});
chrome.idle.setDetectionInterval(60);

async function resetAfterInterruption(): Promise<void> {
  await reconcileInterruptedSession();
  await postToOffscreen({ kind: 'stop' }).catch(() => {});
  await closeOffscreen().catch(() => {});
  chrome.alarms.clear('tick');
  state = 'OFF';
  sessionId = '';
  currentMinuteStart = null;
  faceEvents = [];
  presentAtMinuteStart = true;
  calibration = 'idle';
  calibrationMessage = '';
  lastError = '';
  hydration = Promise.resolve();
  await chrome.storage.session.remove(SESSION_KEY);
  await updateBadge();
}

chrome.runtime.onStartup.addListener(async () => {
  await runExclusive(resetAfterInterruption);
});

chrome.runtime.onInstalled.addListener(async () => {
  await runExclusive(resetAfterInterruption);
});
