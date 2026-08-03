import Chart from 'chart.js/auto';
import type { UIQuery, UIEvent, ReminderDiagnostic } from '@/lib/messages';
import type { MinuteRow, BlinkRow } from '@/lib/db';
import type { Settings } from '@/lib/settings';
import { nextRawBlinkSoundState, type RawBlinkSoundState } from '@/lib/blink-sound';
import { BPM_RANGES, bpmTickLimit, formatBpmTick, downsample, type BpmRangeKey } from '@/lib/chart-range';

async function sendUI<T>(q: UIQuery): Promise<T> {
  const response = await chrome.runtime.sendMessage({ from: 'ui', payload: q }) as T & { __error?: string };
  if (response && typeof response === 'object' && response.__error) throw new Error(response.__error);
  return response;
}

const BLINK_RANGES: Record<string, number | 'inherit'> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  'all': 'inherit'
};

let chart: Chart | null = null;
let blinkChart: Chart | null = null;
let currentBlinkRange: keyof typeof BLINK_RANGES = '5m';
let currentBpmRange: BpmRangeKey = 'day';
let outerRange: { fromMs: number; toMs: number } = { fromMs: 0, toMs: 0 };
let blinkSoundMuted = false;
let audioCtx: AudioContext | null = null;
let soundState: RawBlinkSoundState = { initialized: false, lastSeenBlinkAt: null };

const soundToggle = document.getElementById('sound-toggle') as HTMLButtonElement;

async function loadRange(rangeKey: BpmRangeKey): Promise<void> {
  currentBpmRange = rangeKey;
  const rangeMs = BPM_RANGES[rangeKey];
  const fromMs = rangeMs === 'all' ? 0 : Date.now() - rangeMs;
  const toMs = Date.now() + 60_000;
  outerRange = { fromMs, toMs };
  const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs, toMs });
  render(rows);
  await loadBlinks();
}

async function loadBlinks(): Promise<void> {
  const win = BLINK_RANGES[currentBlinkRange];
  const fromMs = win === 'inherit' ? outerRange.fromMs : Date.now() - (win as number);
  const toMs = win === 'inherit' ? outerRange.toMs : Date.now() + 5_000;
  const blinks = await sendUI<BlinkRow[]>({ kind: 'blinks_range', fromMs, toMs });
  renderBlinks(blinks, fromMs, toMs);
  const result = nextRawBlinkSoundState(blinks, soundState, blinkSoundMuted);
  soundState = result.state;
  if (result.play) playBlinkTick();
}

function timeAxisFormatter(spanMs: number): (v: string | number) => string {
  if (spanMs < 5 * 60_000) {
    return (v) => {
      const d = new Date(Number(v));
      return `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    };
  }
  if (spanMs < 24 * 60 * 60_000) {
    return (v) => new Date(Number(v)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return (v) => new Date(Number(v)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderBlinks(blinks: BlinkRow[], fromMs: number, toMs: number): void {
  const points = blinks.map((b, i) => ({ x: b.t, y: i % 2 === 0 ? 1.05 : 0.95 }));
  const lastLabel = blinks.length > 0 ? ` · last at ${new Date(blinks[blinks.length - 1]!.t).toLocaleTimeString()}` : '';
  document.getElementById('blink-count')!.textContent =
    `${blinks.length} blink${blinks.length === 1 ? '' : 's'} in window${lastLabel}`;

  const canvas = document.getElementById('blink-chart') as HTMLCanvasElement;
  const fmt = timeAxisFormatter(toMs - fromMs);

  if (!blinkChart) {
    blinkChart = new Chart(canvas, {
      type: 'scatter',
      data: { datasets: [{ label: 'blink', data: points, pointRadius: 5, pointHoverRadius: 7, backgroundColor: '#14b8a6', borderColor: '#99f6e4', borderWidth: 1 }] },
      options: {
        animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `Blink ${new Date((ctx.raw as any).x).toLocaleTimeString()}` } } },
        scales: {
          x: { type: 'linear', min: fromMs, max: toMs, grid: { color: 'rgba(148, 163, 184, 0.16)' }, ticks: { color: '#9ca3af', callback: fmt, maxRotation: 0, autoSkipPadding: 24 } },
          y: { display: false, min: 0, max: 2 }
        }
      }
    });
  } else {
    blinkChart.data.datasets[0]!.data = points as any;
    const xScale = blinkChart.options.scales!.x as any;
    xScale.min = fromMs;
    xScale.max = toMs;
    xScale.ticks.callback = fmt;
    blinkChart.update('none');
  }
}

document.querySelectorAll<HTMLButtonElement>('#blink-range-nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#blink-range-nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentBlinkRange = btn.dataset.blinkRange as keyof typeof BLINK_RANGES;
    loadBlinks();
  });
});

/** Downsampled buckets span more than one minute, so this axis cannot be fixed at 1. */
function visibleAxisMax(visibleMinutes: number[]): number {
  const peak = visibleMinutes.reduce((m, v) => Math.max(m, v), 0);
  return peak > 1 ? Math.ceil(peak) : 1;
}

function render(rows: MinuteRow[]): void {
  // Plot a downsampled series, but compute the summary stats from every raw row
  // so the totals stay exact.
  const plotted = downsample(rows);
  const labels = plotted.map(r => new Date(r.tsMinute).toLocaleString());
  const bpm = plotted.map(r => r.status === 'ok' && r.faceVisibleMs > 0 ? r.blinks / (r.faceVisibleMs / 60_000) : null);
  const visibleMinutes = plotted.map(r => r.faceVisibleMs / 60_000);

  if (!chart) {
    chart = new Chart(document.getElementById('main-chart') as HTMLCanvasElement, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'BPM', data: bpm as any, borderColor: '#14b8a6', backgroundColor: 'rgba(20, 184, 166, 0.16)', fill: true, pointRadius: 0, tension: 0.28, borderWidth: 3 },
          { label: 'Visible minutes', data: visibleMinutes as any, borderColor: '#a78bfa', backgroundColor: 'rgba(167, 139, 250, 0.08)', fill: false, pointRadius: 0, tension: 0.25, borderWidth: 2, yAxisID: 'visible' }
        ]
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(148, 163, 184, 0.16)' }, ticks: { color: '#9ca3af' } },
          visible: { position: 'right', min: 0, max: visibleAxisMax(visibleMinutes), grid: { drawOnChartArea: false }, ticks: { color: '#a78bfa', callback: v => `${Number(v).toFixed(1)}m` } },
          x: { grid: { color: 'rgba(148, 163, 184, 0.08)' }, ticks: { color: '#9ca3af', maxTicksLimit: bpmTickLimit(currentBpmRange), callback: v => formatBpmTick(v, currentBpmRange) } }
        },
        plugins: { legend: { labels: { color: '#d1d5db', boxWidth: 10, usePointStyle: true } } }
      }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0]!.data = bpm as any;
    chart.data.datasets[1]!.data = visibleMinutes as any;
    (chart.options.scales!.visible as any).max = visibleAxisMax(visibleMinutes);
    const xTicks = (chart.options.scales!.x as any).ticks;
    xTicks.maxTicksLimit = bpmTickLimit(currentBpmRange);
    xTicks.callback = (v: string | number) => formatBpmTick(v, currentBpmRange);
    chart.update('none');
  }

  const ok = rows.filter(r => r.status === 'ok');
  const totalBlinks = ok.reduce((s, r) => s + r.blinks, 0);
  const totalMin = ok.reduce((s, r) => s + r.faceVisibleMs / 60_000, 0);
  document.getElementById('avg')!.textContent = totalMin > 0 ? (totalBlinks / totalMin).toFixed(1) : '—';
  document.getElementById('tracked')!.textContent = totalMin > 60
    ? `${(totalMin / 60).toFixed(1)} h`
    : `${totalMin.toFixed(0)} min`;
  document.getElementById('reminders')!.textContent = '—';
}

document.querySelectorAll<HTMLButtonElement>('#bpm-range-nav button[data-range]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#bpm-range-nav button[data-range]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadRange(btn.dataset.range as BpmRangeKey);
  });
});

async function loadSettingsForm(): Promise<void> {
  const s = await sendUI<Settings>({ kind: 'settings_get' });
  const overlayAllowed = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  const f = document.getElementById('settings-form') as HTMLFormElement;
  (f.lowBpm as HTMLInputElement).value = String(s.threshold.lowBpm);
  (f.windowMinutes as HTMLInputElement).value = String(s.threshold.windowMinutes);
  (f.sustainMinutes as HTMLInputElement).value = String(s.threshold.sustainMinutes);
  (f.cooldownMinutes as HTMLInputElement).value = String(s.cooldownMinutes);
  (f.systemNotification as HTMLInputElement).checked = s.reminderModes.systemNotification;
  (f.fullscreenOverlay as HTMLInputElement).checked = s.reminderModes.fullscreenOverlay && overlayAllowed;
  blinkSoundMuted = s.audio.rawBlinkSoundMuted;
  updateSoundToggle();
}

const settingsStatus = document.getElementById('settings-status')!;
let settingsStatusTimer: number | null = null;

function showSettingsStatus(text: string, tone: 'ok' | 'err'): void {
  settingsStatus.textContent = text;
  settingsStatus.dataset.tone = tone;
  if (settingsStatusTimer !== null) window.clearTimeout(settingsStatusTimer);
  settingsStatusTimer = window.setTimeout(() => {
    settingsStatus.textContent = '';
    delete settingsStatus.dataset.tone;
  }, 2500);
}

function describeReminderDiagnostic(d: ReminderDiagnostic): string {
  if (d.state === 'OFF') return 'Detection is off.';
  if (d.state === 'PAUSED') return 'Detection is paused while the computer is idle or locked.';
  if (d.state === 'ABSENT') return 'Face is not currently detected.';
  if (!d.systemNotification && !d.fullscreenOverlay) return 'No reminder delivery mode is enabled.';
  if (d.reason === 'ready') return `Low BPM confirmed (${d.averageBpm?.toFixed(1)} < ${d.lowBpm}); reminder should fire.`;
  if (d.reason === 'insufficient_window' || d.reason === 'insufficient_sustain') {
    return `Waiting for complete minutes: ${d.bucketCount}/${Math.max(d.windowMinutes, d.sustainMinutes)}.`;
  }
  if (d.reason === 'cooldown') return `Cooldown active for ${Math.ceil(d.cooldownRemainingMs / 60_000)} more minute(s).`;
  if (d.reason === 'no_valid_minutes' || d.reason === 'no_valid_sustain') {
    return `No valid minute yet (${d.validBucketCount}/${d.bucketCount}); keep your face visible for at least 30 seconds per minute.`;
  }
  if (d.reason === 'window_average_not_low') {
    return `Average BPM is ${d.averageBpm?.toFixed(1)}, not below the ${d.lowBpm} threshold.`;
  }
  return `A recent minute was not below the ${d.lowBpm} BPM threshold.`;
}

async function loadReminderDiagnostic(): Promise<void> {
  const el = document.getElementById('reminder-diagnostic-status')!;
  try {
    const diagnostic = await sendUI<ReminderDiagnostic>({ kind: 'reminder_diagnostic' });
    el.textContent = describeReminderDiagnostic(diagnostic);
    el.dataset.tone = diagnostic.reason === 'ready' ? 'ok' : 'err';
    document.getElementById('reminders')!.textContent = diagnostic.lastReminderAt > 0
      ? new Date(diagnostic.lastReminderAt).toLocaleTimeString()
      : 'None';
  } catch (err) {
    el.textContent = `Diagnostic failed: ${(err as Error)?.message ?? err}`;
    el.dataset.tone = 'err';
  }
}

document.getElementById('test-notification')!.addEventListener('click', async () => {
  const button = document.getElementById('test-notification') as HTMLButtonElement;
  button.disabled = true;
  try {
    await sendUI({ kind: 'test_notification' });
    showSettingsStatus('Chrome notification requested', 'ok');
  } catch (err) {
    showSettingsStatus(`Notification failed: ${(err as Error)?.message ?? err}`, 'err');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('settings-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  try {
    const wantsOverlay = (f.fullscreenOverlay as HTMLInputElement).checked;
    let overlayAllowed = true;
    if (wantsOverlay) {
      overlayAllowed = await chrome.permissions.request({ origins: ['<all_urls>'] });
    } else {
      await chrome.permissions.remove({ origins: ['<all_urls>'] });
    }
    if (!overlayAllowed) (f.fullscreenOverlay as HTMLInputElement).checked = false;
    const saved = await sendUI<Settings>({
      kind: 'settings_set',
      patch: {
        threshold: {
          lowBpm: Number((f.lowBpm as HTMLInputElement).value),
          windowMinutes: Number((f.windowMinutes as HTMLInputElement).value),
          sustainMinutes: Number((f.sustainMinutes as HTMLInputElement).value)
        },
        cooldownMinutes: Number((f.cooldownMinutes as HTMLInputElement).value),
        reminderModes: {
          systemNotification: (f.systemNotification as HTMLInputElement).checked,
          fullscreenOverlay: wantsOverlay && overlayAllowed
        },
        audio: {
          rawBlinkSoundMuted: blinkSoundMuted
        }
      }
    });
    const suffix = wantsOverlay && !overlayAllowed ? '; overlay permission denied' : '';
    showSettingsStatus(`Saved (low ${saved.threshold.lowBpm} BPM, window ${saved.threshold.windowMinutes}m, sustain ${saved.threshold.sustainMinutes}m)${suffix}`, overlayAllowed ? 'ok' : 'err');
    await loadReminderDiagnostic();
  } catch (err) {
    showSettingsStatus(`Save failed: ${(err as Error)?.message ?? err}`, 'err');
  }
});

document.getElementById('export-csv')!.addEventListener('click', async () => {
  const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs: 0, toMs: Date.now() + 60_000 });
  const header = 'tsMinute,iso,blinks,faceVisibleMs,status,sessionId\n';
  const body = rows.map(r =>
    `${r.tsMinute},${new Date(r.tsMinute).toISOString()},${r.blinks},${r.faceVisibleMs},${r.status},${r.sessionId}`
  ).join('\n');
  downloadBlob(header + body, 'eye-blink.csv', 'text/csv');
});

document.getElementById('export-json')!.addEventListener('click', async () => {
  const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs: 0, toMs: Date.now() + 60_000 });
  downloadBlob(JSON.stringify(rows, null, 2), 'eye-blink.json', 'application/json');
});

function downloadBlob(content: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function updateSoundToggle(): void {
  soundToggle.textContent = blinkSoundMuted ? 'Sound muted' : 'Sound on';
  soundToggle.classList.toggle('muted', blinkSoundMuted);
  soundToggle.setAttribute('aria-pressed', String(!blinkSoundMuted));
}

async function saveSoundPreference(): Promise<void> {
  await sendUI({
    kind: 'settings_set',
    patch: { audio: { rawBlinkSoundMuted: blinkSoundMuted } }
  });
}

function playBlinkTick(): void {
  try {
    audioCtx = audioCtx ?? new AudioContext();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.035);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  } catch {
    // Browser audio can be unavailable until the page receives user activation.
  }
}

soundToggle.addEventListener('click', async () => {
  blinkSoundMuted = !blinkSoundMuted;
  updateSoundToggle();
  if (!blinkSoundMuted) {
    try {
      audioCtx = audioCtx ?? new AudioContext();
      await audioCtx.resume();
    } catch {
      // Keep the visual preference even if audio is not available yet.
    }
  }
  await saveSoundPreference();
});

(document.querySelector('#bpm-range-nav button[data-range="day"]') as HTMLElement).click();
(document.querySelector('#blink-range-nav button[data-blink-range="5m"]') as HTMLElement).classList.add('active');
updateSoundToggle();
loadSettingsForm();
loadReminderDiagnostic();

// Refresh the blink chart while the tab is visible. Polling is still needed for
// raw blinks (the worker only broadcasts on whole-minute commits), but a hidden
// tab has nothing to redraw, so the timer is torn down until it comes back.
const BLINK_POLL_MS = 5_000;
let pollHandle: number | null = null;

function startPolling(): void {
  if (pollHandle !== null) return;
  pollHandle = window.setInterval(loadBlinks, BLINK_POLL_MS);
}

function stopPolling(): void {
  if (pollHandle === null) return;
  window.clearInterval(pollHandle);
  pollHandle = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    void loadBlinks();
    startPolling();
  }
});
if (!document.hidden) startPolling();

// The worker commits a minute bucket on every tick; redraw the BPM chart then
// rather than polling the (potentially very large) minute range on a timer.
chrome.runtime.onMessage.addListener((msg: { from: string; payload: UIEvent }) => {
  if (msg.from !== 'sw_ui') return;
  if (document.hidden) return;
  if (msg.payload.kind === 'minute_committed') {
    void loadRange(currentBpmRange);
    void loadReminderDiagnostic();
  }
});
