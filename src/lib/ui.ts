import type { DetectorStatus, UIQuery } from './messages';
import type { MinuteRow } from './db';

export async function sendUI<T>(payload: UIQuery): Promise<T> {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    throw new Error('Open this page from the installed Eye Blink Detector extension.');
  }
  const response = await chrome.runtime.sendMessage({ from: 'ui', payload });
  if (response === undefined) throw new Error('The extension did not respond. Reload it and try again.');
  if (response?.__error) throw new Error(response.__error);
  return response as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function averageBpm(rows: MinuteRow[]): number | null {
  const valid = rows.filter(r => r.status === 'ok' && r.faceVisibleMs > 0);
  const duration = valid.reduce((sum, r) => sum + r.faceVisibleMs, 0);
  return duration ? valid.reduce((sum, r) => sum + r.blinks, 0) * 60_000 / duration : null;
}

/** Use the last five completed calendar minutes, never the last five records. */
export function recentBpm(rows: MinuteRow[], now = Date.now()): number | null {
  const end = Math.floor(now / 60_000) * 60_000;
  return averageBpm(rows.filter(r => r.tsMinute >= end - 5 * 60_000 && r.tsMinute < end));
}

export function statusView(status: DetectorStatus): { label: string; detail: string; tone: string } {
  if (status.state === 'OFF') return {
    label: status.lastError ? 'Needs attention' : 'Not tracking',
    detail: status.lastError ? `Detection stopped. ${status.lastError}` : 'Start a session to see your blink rhythm. Your camera stays on this device.',
    tone: status.lastError ? 'error' : 'neutral'
  };
  if (status.state === 'PAUSED') return { label: 'Paused', detail: 'Your computer is idle or locked. Tracking resumes when you return.', tone: 'neutral' };
  if (status.state === 'ABSENT') return { label: 'Away from camera', detail: 'Face the camera to resume counting. Time away is excluded from your blink rate.', tone: 'neutral' };
  if (status.calibration === 'running') return { label: 'Calibrating', detail: 'Look at the screen and blink naturally. Keep your face visible for about 10 seconds.', tone: 'active' };
  if (status.calibration === 'failed') return { label: 'Tracking · calibration needed', detail: status.calibrationMessage ?? 'Try calibrating again in good light.', tone: 'error' };
  return { label: 'Tracking', detail: status.calibration === 'done' ? status.calibrationMessage ?? 'Calibration complete.' : 'Blink naturally. Your rate updates after each completed minute.', tone: 'active' };
}

export function chartColors() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return { accent: token('--color-accent'), fill: token('--color-chart-fill'), muted: token('--color-muted'), grid: token('--color-line'), secondary: token('--color-chart-secondary') };
}

export function selectRange(container: string, selected: HTMLButtonElement): void {
  document.querySelectorAll<HTMLButtonElement>(`${container} button`).forEach(button => {
    const active = button === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
