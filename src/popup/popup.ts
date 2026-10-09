import Chart from '@/lib/charts';
import type { DetectorStatus, UIEvent } from '@/lib/messages';
import type { MinuteRow } from '@/lib/db';
import { sendUI, errorMessage, recentBpm, statusView, chartColors } from '@/lib/ui';

const toggle = document.getElementById('toggle') as HTMLButtonElement;
const calibrate = document.getElementById('calibrate') as HTMLButtonElement;
const retry = document.getElementById('retry') as HTMLButtonElement;
const feedback = document.getElementById('feedback')!;
let current: DetectorStatus | null = null;
let chart: Chart<'line', ({ x: number; y: number | null })[]> | null = null;
let busy = false;
let refreshVersion = 0;

function showFeedback(text: string, error = false) {
  feedback.textContent = text;
  feedback.dataset.tone = error ? 'error' : 'neutral';
  feedback.hidden = !text;
}

function renderStatus(status: DetectorStatus) {
  current = status;
  const view = statusView(status);
  const state = document.getElementById('state')!;
  state.textContent = view.label;
  state.dataset.tone = view.tone;
  document.getElementById('status-detail')!.textContent = view.detail;
  toggle.textContent = busy ? 'Please wait…' : status.state === 'OFF' ? 'Start tracking' : 'Stop tracking';
  toggle.disabled = busy;
  calibrate.disabled = busy || status.state !== 'RUNNING' || status.calibration === 'running';
  calibrate.textContent = status.calibration === 'running' ? 'Calibrating…' : 'Calibrate';
}

async function refresh() {
  const version = ++refreshVersion;
  try {
    const [status, rows] = await Promise.all([
      sendUI<DetectorStatus>({ kind: 'status' }),
      sendUI<MinuteRow[]>({ kind: 'recent_minutes', sinceMs: Date.now() - 60 * 60_000 })
    ]);
    if (version !== refreshVersion) return;
    retry.hidden = true;
    renderStatus(status);
    document.getElementById('bpm')!.textContent = recentBpm(rows)?.toFixed(1) ?? '—';
    const data = rows.map(r => ({ x: r.tsMinute, y: r.status === 'ok' && r.faceVisibleMs > 0 ? r.blinks * 60_000 / r.faceVisibleMs : null }));
    document.getElementById('chart-empty')!.hidden = data.some(p => p.y !== null);
    const colors = chartColors();
    if (!chart) {
      chart = new Chart(document.getElementById('recent') as HTMLCanvasElement, {
        type: 'line',
        data: { datasets: [{ data, borderColor: colors.accent, backgroundColor: colors.fill, fill: true, tension: .25, pointRadius: 0, borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => new Date(items[0]!.parsed.x!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), label: ctx => `${ctx.parsed.y?.toFixed(1)} blinks / min` } } },
          scales: { x: { type: 'linear', display: false, min: Date.now() - 60 * 60_000, max: Date.now() }, y: { beginAtZero: true, display: false } }
        }
      });
    } else {
      chart.data.datasets[0]!.data = data;
      chart.options.scales!.x!.min = Date.now() - 60 * 60_000;
      chart.options.scales!.x!.max = Date.now();
      chart.update('none');
    }
  } catch (error) {
    if (version !== refreshVersion) return;
    showFeedback(errorMessage(error), true);
    document.getElementById('state')!.textContent = 'Connection unavailable';
    toggle.disabled = calibrate.disabled = true;
    retry.hidden = false;
  }
}

async function act(calibration = false) {
  if (busy || !current) return;
  busy = true;
  renderStatus(current);
  showFeedback('');
  try {
    const response = await sendUI<{ permissionRequired?: boolean; ok?: boolean }>(calibration ? { kind: 'recalibrate' } : { kind: 'toggle', on: current.state === 'OFF' });
    if (response.ok === false) throw new Error('Start tracking before calibrating.');
    if (response.permissionRequired) showFeedback('Camera setup opened in a new tab. Allow access there to begin.');
  } catch (error) { showFeedback(errorMessage(error), true); }
  finally { busy = false; await refresh(); }
}
toggle.addEventListener('click', () => void act());
calibrate.addEventListener('click', () => void act(true));
retry.addEventListener('click', () => { showFeedback(''); void refresh(); });
globalThis.chrome?.runtime?.onMessage.addListener((msg: { from: string; payload: UIEvent }) => {
  if (msg.from === 'sw_ui') void refresh();
});
void refresh();
