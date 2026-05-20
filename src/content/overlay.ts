(function injectOverlay() {
  const ID = '__ebd_overlay__';
  if (document.getElementById(ID)) return;
  const el = document.createElement('div');
  el.id = ID;
  el.style.cssText = `
    position:fixed; inset:0; z-index:2147483647; background:rgba(15,23,42,0.85);
    color:#f8fafc; display:flex; align-items:center; justify-content:center;
    font:18px/1.5 system-ui;
  `;
  el.innerHTML = `
    <div style="background:#1e293b;padding:32px;border-radius:12px;text-align:center;max-width:480px;">
      <h2 style="margin:0 0 12px 0;">Eyes need a break</h2>
      <p>Your blink rate has been low for a few minutes.</p>
      <p>Look at something <strong>20 feet away</strong> for <strong>20 seconds</strong>.</p>
      <button id="__ebd_close" style="padding:8px 16px;cursor:pointer;font-size:16px;margin-top:12px;">Dismiss</button>
    </div>
  `;
  document.documentElement.appendChild(el);
  const closeBtn = el.querySelector('#__ebd_close') as HTMLButtonElement;
  const autoClose = setTimeout(() => el.remove(), 20_000);
  closeBtn.addEventListener('click', () => { clearTimeout(autoClose); el.remove(); });
})();
