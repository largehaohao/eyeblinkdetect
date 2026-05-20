import Chart from 'chart.js/auto';
import type { UIQuery } from '@/lib/messages';
import type { MinuteRow } from '@/lib/db';
import type { Settings } from '@/lib/settings';

function sendUI<T>(q: UIQuery): Promise<T> {
  return chrome.runtime.sendMessage({ from: 'ui', payload: q }) as Promise<T>;
}

const RANGES = {
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
  all: Number.MAX_SAFE_INTEGER
} as const;

let chart: Chart | null = null;

async function loadRange(rangeKey: keyof typeof RANGES): Promise<void> {
  const fromMs = rangeKey === 'all' ? 0 : Date.now() - RANGES[rangeKey];
  const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs, toMs: Date.now() + 60_000 });
  render(rows);
}

function render(rows: MinuteRow[]): void {
  const labels = rows.map(r => new Date(r.tsMinute).toLocaleString());
  const bpm = rows.map(r => r.status === 'ok' ? r.blinks / (r.faceVisibleMs / 60_000) : null);

  if (!chart) {
    chart = new Chart(document.getElementById('main-chart') as HTMLCanvasElement, {
      type: 'line',
      data: { labels, datasets: [{ label: 'BPM', data: bpm as any, borderColor: '#2563eb', pointRadius: 0, tension: 0.2 }] },
      options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0]!.data = bpm as any;
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

document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadRange((btn as HTMLElement).dataset.range as keyof typeof RANGES);
  });
});

async function loadSettingsForm(): Promise<void> {
  const s = await sendUI<Settings>({ kind: 'settings_get' });
  const f = document.getElementById('settings-form') as HTMLFormElement;
  (f.lowBpm as HTMLInputElement).value = String(s.threshold.lowBpm);
  (f.windowMinutes as HTMLInputElement).value = String(s.threshold.windowMinutes);
  (f.sustainMinutes as HTMLInputElement).value = String(s.threshold.sustainMinutes);
  (f.cooldownMinutes as HTMLInputElement).value = String(s.cooldownMinutes);
  (f.systemNotification as HTMLInputElement).checked = s.reminderModes.systemNotification;
  (f.fullscreenOverlay as HTMLInputElement).checked = s.reminderModes.fullscreenOverlay;
}

document.getElementById('settings-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  await sendUI({
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
        fullscreenOverlay: (f.fullscreenOverlay as HTMLInputElement).checked
      }
    }
  });
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

(document.querySelector('nav button[data-range="day"]') as HTMLElement).click();
loadSettingsForm();
