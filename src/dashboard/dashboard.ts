import Chart from '@/lib/charts';
import type { DetectorStatus, UIEvent, ReminderDiagnostic } from '@/lib/messages';
import type { MinuteRow, BlinkRow } from '@/lib/db';
import type { Settings } from '@/lib/settings';
import { nextRawBlinkSoundState, type RawBlinkSoundState } from '@/lib/blink-sound';
import { BPM_RANGES, bpmTickLimit, formatBpmTick, downsample, type BpmRangeKey } from '@/lib/chart-range';
import { sendUI, errorMessage, averageBpm, chartColors, statusView, selectRange } from '@/lib/ui';

type Point = { x: number; y: number | null };
const el = (id: string) => document.getElementById(id)!;
const button = (id: string) => el(id) as HTMLButtonElement;
const colors = chartColors();
const BLINK_RANGES = { '1m': 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000, all: 'inherit' } as const;
const RANGE_LABELS: Record<BpmRangeKey, string> = {
  '10m': 'last 10 minutes', '30m': 'last 30 minutes', '1h': 'last hour',
  '6h': 'last 6 hours', '12h': 'last 12 hours', day: 'last 24 hours',
  week: 'last 7 days', month: 'last 30 days', all: 'all stored history'
};
let chart: Chart<'line', Point[]> | null = null;
let blinkChart: Chart<'scatter'> | null = null;
let currentBpmRange: BpmRangeKey = 'day';
let currentBlinkRange: keyof typeof BLINK_RANGES = '5m';
let outerRange = { fromMs: Date.now() - BPM_RANGES.day, toMs: Date.now() };
let rangeVersion = 0;
let blinkVersion = 0;
let rangeBusy = false;
let blinkPending = 0;
let status: DetectorStatus | null = null;
let controlBusy = false;
let soundMuted = true;
let audioCtx: AudioContext | null = null;
let soundState: RawBlinkSoundState = { initialized: false, lastSeenBlinkAt: null };

el('today').textContent = new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
Chart.defaults.font.family = getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim();
Chart.defaults.color = colors.muted;
Chart.defaults.font.size = 11;
Chart.defaults.animation = false;

function showError(error: unknown) {
  el('page-error-text').textContent = errorMessage(error);
  el('page-error').hidden = false;
}

function renderStatus() {
  if (!status) return;
  const view = statusView(status);
  el('session-status').textContent = view.label;
  el('session-status').dataset.tone = view.tone;
  el('session-detail').textContent = view.detail;
  button('toggle').disabled = controlBusy;
  button('toggle').textContent = controlBusy ? 'Please wait…' : status.state === 'OFF' ? 'Start tracking' : 'Stop tracking';
  button('calibrate').disabled = controlBusy || status.state !== 'RUNNING' || status.calibration === 'running';
  button('calibrate').textContent = status.calibration === 'running' ? 'Calibrating…' : 'Calibrate detection';
}

async function loadStatus() {
  try { status = await sendUI<DetectorStatus>({ kind: 'status' }); renderStatus(); }
  catch (error) {
    el('session-status').textContent = 'Connection unavailable';
    button('toggle').disabled = button('calibrate').disabled = true;
    showError(error);
  }
}

async function control(calibration = false) {
  if (!status || controlBusy) return;
  controlBusy = true;
  renderStatus();
  el('calibration-feedback').textContent = '';
  try {
    const response = await sendUI<{ ok?: boolean; permissionRequired?: boolean }>(calibration ? { kind: 'recalibrate' } : { kind: 'toggle', on: status.state === 'OFF' });
    if (response.ok === false) throw new Error('Start tracking before calibrating.');
    if (response.permissionRequired) el('calibration-feedback').textContent = 'Camera setup opened in a new tab. Allow access there to begin.';
  } catch (error) { showError(error); }
  finally { controlBusy = false; await Promise.all([loadStatus(), loadReminderDiagnostic()]); }
}
button('toggle').addEventListener('click', () => void control());
button('calibrate').addEventListener('click', () => void control(true));

async function loadRange(rangeKey: BpmRangeKey) {
  const version = ++rangeVersion;
  ++blinkVersion; // invalidate an inherited range already in flight
  currentBpmRange = rangeKey;
  rangeBusy = true;
  el('chart-updated').textContent = 'Loading activity…';
  const now = Date.now();
  const rangeMs = BPM_RANGES[rangeKey];
  const fromMs = rangeMs === 'all' ? 0 : now - rangeMs;
  try {
    const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs, toMs: now + 1 });
    if (version !== rangeVersion) return;
    outerRange = { fromMs: rangeMs === 'all' ? rows[0]?.tsMinute ?? now - BPM_RANGES.day : fromMs, toMs: now };
    render(rows);
    el('summary-range').textContent = `Over ${RANGE_LABELS[rangeKey] === 'all stored history' ? '' : 'the '}${RANGE_LABELS[rangeKey]}`;
    el('chart-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    rangeBusy = false;
    await loadBlinks();
  } catch (error) {
    if (version !== rangeVersion) return;
    el('chart-updated').textContent = 'Could not load this range';
    showError(error);
  } finally { if (version === rangeVersion) rangeBusy = false; }
}

function render(rows: MinuteRow[]) {
  const plotted = downsample(rows);
  const points: Point[] = [];
  const bucketSpan = Math.ceil(rows.length / 600) * 60_000;
  plotted.forEach((r, index) => {
    const previous = plotted[index - 1];
    if (previous && r.tsMinute - previous.tsMinute > Math.max(60_000, bucketSpan) * 1.5) points.push({ x: previous.tsMinute + 60_000, y: null });
    points.push({ x: r.tsMinute, y: r.status === 'ok' && r.faceVisibleMs > 0 ? r.blinks * 60_000 / r.faceVisibleMs : null });
  });
  el('trend-empty').hidden = points.some(p => p.y !== null);
  const xScale = {
    type: 'linear' as const, min: outerRange.fromMs, max: outerRange.toMs,
    grid: { display: false }, border: { display: false },
    ticks: { includeBounds: false, autoSkipPadding: 20, maxRotation: 0, maxTicksLimit: bpmTickLimit(currentBpmRange), callback: (v: string | number) => formatBpmTick(v, currentBpmRange) }
  };
  if (!chart) {
    chart = new Chart(el('main-chart') as HTMLCanvasElement, {
      type: 'line', data: { datasets: [{ label: 'Blinks / min', data: points, borderColor: colors.accent, backgroundColor: colors.fill, fill: true, pointRadius: 0, pointHitRadius: 12, tension: .2, borderWidth: 2, spanGaps: false }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        scales: { x: xScale, y: { beginAtZero: true, suggestedMax: 20, border: { display: false }, grid: { color: colors.grid }, ticks: { maxTicksLimit: 5 } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => new Date(items[0]!.parsed.x!).toLocaleString(), label: ctx => `${ctx.parsed.y?.toFixed(1)} blinks / min` } } }
      }
    });
  } else {
    chart.data.datasets[0]!.data = points;
    chart.options.scales!.x = xScale;
    chart.update('none');
  }
  const minutes = rows.reduce((sum, r) => sum + r.faceVisibleMs, 0) / 60_000;
  el('avg').textContent = averageBpm(rows)?.toFixed(1) ?? '—';
  el('tracked').textContent = minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`;
  el('total-blinks').textContent = rows.reduce((sum, r) => sum + r.blinks, 0).toLocaleString();
}

async function loadBlinks() {
  if (rangeBusy && currentBlinkRange === 'all') return;
  const version = ++blinkVersion;
  blinkPending++;
  const window = BLINK_RANGES[currentBlinkRange];
  const fromMs = window === 'inherit' ? outerRange.fromMs : Date.now() - window;
  const toMs = window === 'inherit' ? outerRange.toMs : Date.now();
  try {
    const blinks = await sendUI<BlinkRow[]>({ kind: 'blinks_range', fromMs, toMs: toMs + 1 });
    if (version !== blinkVersion) return;
    renderBlinks(blinks, fromMs, toMs);
    el('blink-error').textContent = '';
    const result = nextRawBlinkSoundState(blinks, soundState, soundMuted);
    soundState = result.state;
    if (result.play) playBlinkTick();
  } catch (error) { if (version === blinkVersion) el('blink-error').textContent = `Could not refresh blinks. ${errorMessage(error)}`; }
  finally { blinkPending--; }
}

function renderBlinks(blinks: BlinkRow[], fromMs: number, toMs: number) {
  // Bound canvas work for 'All in view'; the count below still includes every event.
  const stride = Math.max(1, Math.ceil(blinks.length / 1500));
  const points = blinks.filter((_, i) => i % stride === 0).map(b => ({ x: b.t, y: 1 }));
  const fmt = (v: string | number) => toMs - fromMs <= 15 * 60_000
    ? new Date(Number(v)).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })
    : toMs - fromMs < 24 * 60 * 60_000 ? formatBpmTick(v, 'day') : formatBpmTick(v, 'week');
  const xScale = { type: 'linear' as const, min: fromMs, max: toMs, border: { display: false }, grid: { color: colors.grid }, ticks: { includeBounds: false, autoSkipPadding: 20, callback: fmt, maxRotation: 0, maxTicksLimit: 7 } };
  if (!blinkChart) {
    blinkChart = new Chart(el('blink-chart') as HTMLCanvasElement, {
      type: 'scatter', data: { datasets: [{ data: points, pointRadius: 3, pointHoverRadius: 5, backgroundColor: colors.accent, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: xScale, y: { display: false, min: 0, max: 2 } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `Blink at ${new Date(ctx.parsed.x!).toLocaleTimeString()}` } } } }
    });
  } else {
    blinkChart.data.datasets[0]!.data = points;
    blinkChart.options.scales!.x = xScale;
    blinkChart.update('none');
  }
  el('blink-count').textContent = blinks.length
    ? `${blinks.length.toLocaleString()} blinks in view${stride > 1 ? ' · dots sampled for clarity' : ''} · latest at ${new Date(blinks[blinks.length - 1]!.t).toLocaleTimeString()}`
    : 'No blinks in this window. Start tracking or choose a wider range.';
}

document.querySelectorAll<HTMLButtonElement>('#bpm-range-nav button').forEach(btn => btn.addEventListener('click', () => {
  selectRange('#bpm-range-nav', btn);
  void loadRange(btn.dataset.range as BpmRangeKey);
}));
document.querySelectorAll<HTMLButtonElement>('#blink-range-nav button').forEach(btn => btn.addEventListener('click', () => {
  selectRange('#blink-range-nav', btn);
  currentBlinkRange = btn.dataset.blinkRange as keyof typeof BLINK_RANGES;
  void loadBlinks();
}));

const form = el('settings-form') as HTMLFormElement;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
let settingsLoaded = false;
let formRevision = 0;
async function loadSettingsForm() {
  try {
    const [s, allowed] = await Promise.all([sendUI<Settings>({ kind: 'settings_get' }), chrome.permissions.contains({ origins: ['<all_urls>'] })]);
    for (const name of ['lowBpm', 'windowMinutes', 'sustainMinutes'] as const) field(name).value = String(s.threshold[name]);
    field('cooldownMinutes').value = String(s.cooldownMinutes);
    field('systemNotification').checked = s.reminderModes.systemNotification;
    field('fullscreenOverlay').checked = s.reminderModes.fullscreenOverlay && allowed;
    soundMuted = s.audio.rawBlinkSoundMuted;
    updateSoundToggle();
    (el('settings-fields') as HTMLFieldSetElement).disabled = false;
    button('sound-toggle').disabled = false;
    settingsLoaded = true;
  } catch (error) { showError(error); }
}
function settingsStatus(text: string, tone: 'ok' | 'err' | 'neutral') {
  el('settings-status').textContent = text;
  el('settings-status').dataset.tone = tone;
}
form.addEventListener('input', () => { formRevision++; settingsStatus('Unsaved changes', 'neutral'); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity() || button('save-settings').disabled) return;
  button('save-settings').disabled = true;
  button('save-settings').textContent = 'Saving…';
  const wantsOverlay = field('fullscreenOverlay').checked;
  const revision = formRevision;
  const patch = {
    threshold: { lowBpm: field('lowBpm').valueAsNumber, windowMinutes: field('windowMinutes').valueAsNumber, sustainMinutes: field('sustainMinutes').valueAsNumber },
    cooldownMinutes: field('cooldownMinutes').valueAsNumber,
    reminderModes: { systemNotification: field('systemNotification').checked, fullscreenOverlay: wantsOverlay }
  };
  try {
    const allowed = !wantsOverlay || await chrome.permissions.request({ origins: ['<all_urls>'] });
    patch.reminderModes.fullscreenOverlay = wantsOverlay && allowed;
    await sendUI<Settings>({ kind: 'settings_set', patch });
    if (!wantsOverlay) await chrome.permissions.remove({ origins: ['<all_urls>'] });
    if (!allowed && revision === formRevision) field('fullscreenOverlay').checked = false;
    if (revision !== formRevision) settingsStatus('Earlier changes saved. You have unsaved edits.', 'neutral');
    else settingsStatus(allowed ? 'Preferences saved' : 'Saved. Website access was declined; overlay remains off.', allowed ? 'ok' : 'err');
    await loadReminderDiagnostic();
  } catch (error) { settingsStatus(`Could not save. ${errorMessage(error)}`, 'err'); }
  finally { button('save-settings').disabled = false; button('save-settings').textContent = 'Save preferences'; }
});

async function loadReminderDiagnostic() {
  try {
    const d = await sendUI<ReminderDiagnostic>({ kind: 'reminder_diagnostic' });
    let text: string;
    if (d.state === 'OFF') text = 'Start tracking to enable reminders.';
    else if (d.state === 'PAUSED') text = 'Reminders are paused while your computer is idle or locked.';
    else if (d.state === 'ABSENT') text = 'Waiting for your face to return to the camera.';
    else if (!d.systemNotification && !d.fullscreenOverlay) text = 'Both delivery options are off. Enable one to receive reminders.';
    else if (d.reason === 'ready') text = 'Your rate is below the threshold. A reminder is due.';
    else if (d.reason === 'cooldown') text = `Next reminder available in ${Math.ceil(d.cooldownRemainingMs / 60_000)} min.`;
    else if (d.reason === 'insufficient_window' || d.reason === 'insufficient_sustain') text = `Collecting activity: ${d.bucketCount} of ${Math.max(d.windowMinutes, d.sustainMinutes)} minutes.`;
    else if (d.reason === 'no_valid_minutes' || d.reason === 'no_valid_sustain') text = 'Keep your face visible for at least 30 seconds per minute for a valid reading.';
    else text = `No reminder needed. ${d.averageBpm === null ? '' : `Recent average: ${d.averageBpm.toFixed(1)} BPM. `}Your threshold is ${d.lowBpm} BPM.`;
    el('reminder-diagnostic-status').textContent = text;
    el('reminder-diagnostic-status').dataset.tone = 'neutral';
    el('reminders').textContent = d.lastReminderAt > 0 ? new Date(d.lastReminderAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'None yet';
  } catch (error) { el('reminder-diagnostic-status').textContent = `Status unavailable. ${errorMessage(error)}`; }
}
button('test-notification').addEventListener('click', async () => {
  button('test-notification').disabled = true;
  try { await sendUI({ kind: 'test_notification' }); settingsStatus('Notification requested. Check your desktop notification settings if it does not appear.', 'ok'); }
  catch (error) { settingsStatus(`Notification failed. ${errorMessage(error)}`, 'err'); }
  finally { button('test-notification').disabled = false; }
});

function updateSoundToggle() {
  button('sound-toggle').textContent = soundMuted ? 'Sound muted' : 'Sound on';
  button('sound-toggle').setAttribute('aria-pressed', String(!soundMuted));
}
function playBlinkTick() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.exponentialRampToValueAtTime(1320, now + .035);
  gain.gain.setValueAtTime(.0001, now);
  gain.gain.exponentialRampToValueAtTime(.08, now + .008);
  gain.gain.exponentialRampToValueAtTime(.0001, now + .08);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  osc.start(now); osc.stop(now + .09);
}
button('sound-toggle').addEventListener('click', async () => {
  const previous = soundMuted;
  soundMuted = !soundMuted;
  updateSoundToggle();
  button('sound-toggle').disabled = true;
  try {
    if (!soundMuted) { audioCtx ??= new AudioContext(); await audioCtx.resume(); }
    await sendUI({ kind: 'settings_set', patch: { audio: { rawBlinkSoundMuted: soundMuted } } });
  } catch (error) { soundMuted = previous; updateSoundToggle(); showError(error); }
  finally { button('sound-toggle').disabled = false; }
});
// Saved sound-on preferences still require a user gesture in this tab.
window.addEventListener('pointerdown', () => {
  if (!soundMuted) { audioCtx ??= new AudioContext(); void audioCtx.resume().catch(() => {}); }
}, { once: true });

for (const format of ['csv', 'json'] as const) button(`export-${format}`).addEventListener('click', async () => {
  button('export-csv').disabled = button('export-json').disabled = true;
  el('export-status').textContent = 'Preparing your history…';
  try {
    const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs: 0, toMs: Date.now() + 60_000 });
    if (!rows.length) { el('export-status').textContent = 'No history to export yet. Start a session first.'; return; }
    const content = format === 'json' ? JSON.stringify(rows, null, 2) :
      'tsMinute,iso,blinks,faceVisibleMs,status,sessionId\n' + rows.map(r => [r.tsMinute, new Date(r.tsMinute).toISOString(), r.blinks, r.faceVisibleMs, r.status, r.sessionId].map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `eye-blink-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.append(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    el('export-status').textContent = `Downloaded ${rows.length.toLocaleString()} minute records.`;
  } catch (error) { el('export-status').textContent = `Export failed. ${errorMessage(error)}`; }
  finally { button('export-csv').disabled = button('export-json').disabled = false; }
});

async function refreshAll() { await Promise.all([loadStatus(), loadRange(currentBpmRange), loadReminderDiagnostic()]); }
button('retry').addEventListener('click', () => {
  el('page-error').hidden = true;
  void refreshAll();
  if (!settingsLoaded) void loadSettingsForm();
});
let poll: number | null = null;
function startPolling() { if (poll === null) poll = window.setInterval(() => { if (!blinkPending) void loadBlinks(); }, 5000); }
function stopPolling() { if (poll !== null) window.clearInterval(poll); poll = null; }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else { void refreshAll(); startPolling(); }
});
globalThis.chrome?.runtime?.onMessage.addListener((msg: { from: string; payload: UIEvent }) => {
  if (msg.from !== 'sw_ui' || document.hidden) return;
  if (msg.payload.kind === 'minute_committed') { if (!rangeBusy) void loadRange(currentBpmRange); void loadReminderDiagnostic(); }
  else { void loadStatus(); void loadReminderDiagnostic(); }
});
window.addEventListener('pagehide', () => { stopPolling(); chart?.destroy(); blinkChart?.destroy(); void audioCtx?.close(); });
const navLinks = document.querySelectorAll<HTMLAnchorElement>('.app-nav a');
function updateNav() { navLinks.forEach(link => { if (link.hash === (location.hash || '#overview')) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); }); }
window.addEventListener('hashchange', updateNav);
updateNav();
void loadSettingsForm();
void refreshAll();
if (!document.hidden) startPolling();
