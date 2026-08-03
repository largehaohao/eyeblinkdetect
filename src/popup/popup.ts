import Chart from 'chart.js/auto';
import type { UIQuery, UIEvent } from '@/lib/messages';
import type { MinuteRow } from '@/lib/db';

async function sendUI<T>(q: UIQuery): Promise<T> {
  const response = await chrome.runtime.sendMessage({ from: 'ui', payload: q }) as T & { __error?: string };
  if (response && typeof response === 'object' && response.__error) throw new Error(response.__error);
  return response;
}

const toggle = document.getElementById('toggle') as HTMLButtonElement;
const calibrateBtn = document.getElementById('calibrate') as HTMLButtonElement;
const bpmEl = document.getElementById('bpm')!;
const stateEl = document.getElementById('state')!;
const canvas = document.getElementById('recent') as HTMLCanvasElement;

let chart: Chart | null = null;
let currentState: string = 'OFF';

async function refresh(): Promise<void> {
  const status = await sendUI<{ state: string }>({ kind: 'status' });
  currentState = status.state;
  stateEl.textContent = status.state;
  toggle.textContent = status.state === 'OFF' ? 'Start' : 'Stop';
  calibrateBtn.disabled = status.state !== 'RUNNING' && status.state !== 'ABSENT';

  const since = Date.now() - 60 * 60_000;
  const rows = await sendUI<MinuteRow[]>({ kind: 'recent_minutes', sinceMs: since });

  const recent = rows.slice(-5).filter(r => r.status === 'ok');
  if (recent.length > 0) {
    const blinks = recent.reduce((s, r) => s + r.blinks, 0);
    const minutes = recent.reduce((s, r) => s + r.faceVisibleMs, 0) / 60_000;
    bpmEl.textContent = minutes > 0 ? (blinks / minutes).toFixed(1) : '—';
  } else {
    bpmEl.textContent = '—';
  }

  const labels = rows.map(r => new Date(r.tsMinute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const data = rows.map(r => r.status === 'ok' ? r.blinks / (r.faceVisibleMs / 60_000) : null);

  if (!chart) {
    chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: '#14b8a6', backgroundColor: 'rgba(20, 184, 166, 0.16)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }] },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(148, 163, 184, 0.14)' }, ticks: { color: '#9ca3af' } },
          x: { display: false }
        }
      }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0]!.data = data as any;
    chart.update('none');
  }
}

toggle.addEventListener('click', async () => {
  const on = currentState === 'OFF';
  await sendUI({ kind: 'toggle', on });
  refresh();
});

calibrateBtn.addEventListener('click', async () => {
  await sendUI({ kind: 'recalibrate' });
});

chrome.runtime.onMessage.addListener((msg: { from: string; payload: UIEvent }) => {
  if (msg.from === 'sw_ui') refresh();
});

refresh();
