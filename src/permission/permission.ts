import { sendUI, errorMessage } from '@/lib/ui';
const btn = document.getElementById('grant') as HTMLButtonElement;
const status = document.getElementById('status')!;
let granted = false;

btn.addEventListener('click', async () => {
  btn.disabled = true;
  status.dataset.tone = 'neutral';
  try {
    if (!granted) {
      status.textContent = 'Waiting for camera permission…';
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(track => track.stop());
      granted = true;
      btn.textContent = 'Start tracking';
      status.textContent = 'Camera access is ready. Start tracking when you’re ready; the camera stays off until then.';
      status.dataset.tone = 'ok';
    } else {
      status.textContent = 'Starting detection…';
      const response = await sendUI<{ permissionRequired?: boolean }>({ kind: 'toggle', on: true });
      if (response.permissionRequired) throw new Error('Camera access is not available yet. Check Chrome’s site settings.');
      status.textContent = 'Tracking has started. You can open your dashboard or close this tab.';
      status.dataset.tone = 'ok';
      btn.hidden = true;
      document.getElementById('dashboard-link')!.hidden = false;
    }
  } catch (error) {
    status.textContent = `Could not ${granted ? 'start tracking' : 'access the camera'}. ${errorMessage(error)} Check camera access in Chrome and try again.`;
    status.dataset.tone = 'err';
  } finally { btn.disabled = false; }
});
