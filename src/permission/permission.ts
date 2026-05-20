const btn = document.getElementById('grant') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.textContent = 'Requesting...';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach(t => t.stop());
    statusEl.textContent = '✓ Camera access granted. You can close this tab and start blink detection from the extension popup.';
    statusEl.className = 'status ok';
  } catch (e) {
    statusEl.textContent = `✗ ${(e as Error).message}. Please retry or check your browser's camera settings.`;
    statusEl.className = 'status err';
    btn.disabled = false;
  }
});
