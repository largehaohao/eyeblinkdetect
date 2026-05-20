import { createAggregator, type MinuteBucket } from '@/lib/aggregator';
import { shouldRemind } from '@/lib/reminder-policy';
import { writeMinute, getRange, writeSession, updateSessionEnd, writeBlink, getBlinks } from '@/lib/db';
import { loadSettings, saveSettings } from '@/lib/settings';
import type { DetectorMsg, ControlMsg, UIQuery, UIEvent } from '@/lib/messages';

type AppState = 'OFF' | 'RUNNING' | 'PAUSED' | 'ABSENT';

const SESSION_KEY = 'sessionState';
let agg = createAggregator();
const recentBuckets: MinuteBucket[] = [];
let currentMinuteStart: number | null = null;
let lastReminderAt = 0;
let sessionId = '';
let state: AppState = 'OFF';

function nowMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

async function setState(s: AppState): Promise<void> {
  state = s;
  await chrome.storage.session.set({ [SESSION_KEY]: { state, sessionId, lastReminderAt } });
  await broadcast({ kind: 'state_changed', state });
  await updateBadge();
}

async function updateBadge(): Promise<void> {
  if (state === 'OFF') { chrome.action.setBadgeText({ text: '' }); return; }
  if (state === 'RUNNING') { chrome.action.setBadgeText({ text: 'ON' }); chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }); return; }
  if (state === 'PAUSED') { chrome.action.setBadgeText({ text: 'II' }); chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); return; }
  if (state === 'ABSENT') { chrome.action.setBadgeText({ text: '?' }); chrome.action.setBadgeBackgroundColor({ color: '#64748b' }); }
}

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.() ?? false;
  if (has) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
    justification: 'Webcam-based blink detection'
  });
}

async function closeOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.() ?? false;
  if (has) await chrome.offscreen.closeDocument();
}

function postToOffscreen(payload: ControlMsg): void {
  chrome.runtime.sendMessage({ from: 'sw', payload }).catch(() => {});
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

async function startSession(): Promise<void> {
  if (!await hasCameraPermission()) {
    await openPermissionPage();
    return;
  }
  agg = createAggregator();
  recentBuckets.length = 0;
  sessionId = crypto.randomUUID();
  await writeSession({ sessionId, startedAt: Date.now(), endedAt: null, reason: 'manual' });
  await ensureOffscreen();
  const settings = await loadSettings();
  postToOffscreen(settings.ear.personalized ? { kind: 'start' } : { kind: 'recalibrate' });
  currentMinuteStart = nowMinute();
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  await setState('RUNNING');
}

async function stopSession(reason: 'manual' | 'idle' | 'error'): Promise<void> {
  postToOffscreen({ kind: 'stop' });
  await closeOffscreen();
  if (sessionId) {
    await updateSessionEnd(sessionId, Date.now(), reason);
  }
  chrome.alarms.clear('tick');
  currentMinuteStart = null;
  await setState('OFF');
}

function handleDetector(m: DetectorMsg): void {
  if (m.kind === 'blink') {
    agg.onEvent({ type: 'blink', t: m.t });
    void writeBlink({ t: m.t, sessionId });
  }
  else if (m.kind === 'face_lost') { agg.onEvent({ type: 'face_lost', t: m.t }); void setState('ABSENT'); }
  else if (m.kind === 'face_present') { agg.onEvent({ type: 'face_present', t: m.t }); if (state === 'ABSENT') void setState('RUNNING'); }
  else if (m.kind === 'error') { console.error('detector error', m); void stopSession('error'); }
  else if (m.kind === 'calibration_done') {
    void saveSettings({ ear: { closeThresh: m.closeThresh, openThresh: m.openThresh, personalized: true } });
  }
}

async function handleUI(q: UIQuery): Promise<unknown> {
  if (q.kind === 'status') return { state, sessionId, lastReminderAt };
  if (q.kind === 'toggle') {
    if (q.on && state === 'OFF') await startSession();
    if (!q.on && state !== 'OFF') await stopSession('manual');
    return { state };
  }
  if (q.kind === 'recent_minutes') return getRange(q.sinceMs, Date.now() + 60_000);
  if (q.kind === 'range') return getRange(q.fromMs, q.toMs);
  if (q.kind === 'blinks_range') return getBlinks(q.fromMs, q.toMs);
  if (q.kind === 'settings_get') return loadSettings();
  if (q.kind === 'settings_set') return saveSettings(q.patch as any);
  if (q.kind === 'recalibrate') {
    postToOffscreen({ kind: 'recalibrate' });
    return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.from === 'offscreen') {
    handleDetector(msg.payload as DetectorMsg);
    return;
  }
  if (msg?.from === 'ui') {
    handleUI(msg.payload as UIQuery).then(sendResponse);
    return true;
  }
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'tick') return;
  if (state !== 'RUNNING' && state !== 'ABSENT') return;
  if (currentMinuteStart === null) return;
  const start = currentMinuteStart;
  const end = start + 60_000;
  const bucket = agg.flush(start, end);
  await writeMinute({ tsMinute: start, ...bucket, sessionId });
  recentBuckets.push(bucket);
  if (recentBuckets.length > 60) recentBuckets.shift();
  currentMinuteStart = end;
  await broadcast({ kind: 'minute_committed', tsMinute: start });

  const settings = await loadSettings();
  if (settings.reminderModes.systemNotification || settings.reminderModes.fullscreenOverlay) {
    const cfg = {
      lowBpm: settings.threshold.lowBpm,
      windowMinutes: settings.threshold.windowMinutes,
      sustainMinutes: settings.threshold.sustainMinutes,
      cooldownMs: settings.cooldownMinutes * 60_000
    };
    if (shouldRemind(recentBuckets, lastReminderAt, cfg, Date.now())) {
      await fireReminder(settings);
      lastReminderAt = Date.now();
      await chrome.storage.session.set({ [SESSION_KEY]: { state, sessionId, lastReminderAt } });
    }
  }
});

async function fireReminder(settings: Awaited<ReturnType<typeof loadSettings>>): Promise<void> {
  if (settings.reminderModes.systemNotification) {
    chrome.notifications.create('low-blink', {
      type: 'basic',
      iconUrl: 'src/icons/icon-128.png',
      title: 'Eyes need a break',
      message: 'Your blink rate has been low. Look at something 20ft away for 20 seconds.',
      priority: 2
    });
  }
  if (settings.reminderModes.fullscreenOverlay) {
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

// Runs in the target page's content world. Self-contained — no closure over SW state.
function injectOverlay(): void {
  const ID = '__ebd_overlay__';
  if (document.getElementById(ID)) return;
  const el = document.createElement('div');
  el.id = ID;
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,0.85);color:#f8fafc;display:flex;align-items:center;justify-content:center;font:18px/1.5 system-ui;';
  el.innerHTML = '<div style="background:#1e293b;padding:32px;border-radius:12px;text-align:center;max-width:480px;"><h2 style="margin:0 0 12px 0;">Eyes need a break</h2><p>Your blink rate has been low for a few minutes.</p><p>Look at something <strong>20 feet away</strong> for <strong>20 seconds</strong>.</p><button id="__ebd_close" style="padding:8px 16px;cursor:pointer;font-size:16px;margin-top:12px;">Dismiss</button></div>';
  document.documentElement.appendChild(el);
  const closeBtn = el.querySelector('#__ebd_close') as HTMLButtonElement;
  const autoClose = window.setTimeout(() => el.remove(), 20000);
  closeBtn.addEventListener('click', () => { window.clearTimeout(autoClose); el.remove(); });
}

chrome.idle.onStateChanged.addListener(async (newState) => {
  if (newState === 'active' && state === 'PAUSED') {
    postToOffscreen({ kind: 'start' });
    currentMinuteStart = nowMinute();
    await setState('RUNNING');
  } else if ((newState === 'idle' || newState === 'locked') && (state === 'RUNNING' || state === 'ABSENT')) {
    postToOffscreen({ kind: 'stop' });
    currentMinuteStart = null;
    await setState('PAUSED');
  }
});
chrome.idle.setDetectionInterval(60);

chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.session.get(SESSION_KEY);
  const saved = data[SESSION_KEY] as { state?: AppState; sessionId?: string; lastReminderAt?: number } | undefined;
  if (saved?.state && saved.state !== 'OFF') {
    sessionId = saved.sessionId ?? '';
    lastReminderAt = saved.lastReminderAt ?? 0;
    await startSession();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await setState('OFF');
});
