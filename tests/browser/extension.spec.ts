import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('production extension starts and stops with a synthetic camera', async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(join(tmpdir(), 'eye-blink-test-'));
  const extension = resolve('dist');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/src/dashboard/dashboard.html`);
    await expect(page.locator('#toggle')).toHaveText('Start tracking');
    await expect(page.locator('#page-error')).toBeHidden();
    const permissionPage = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await page.locator('#toggle').click();
    // Some Chrome versions still require the visible extension permission page.
    const permission = await Promise.race([
      permissionPage,
      page.locator('#toggle').filter({ hasText: 'Stop tracking' }).waitFor({ timeout: 3000 }).then(() => null).catch(() => null)
    ]);
    if (permission) {
      await permission.waitForLoadState();
      await permission.locator('#grant').click();
      await expect(permission.locator('#grant')).toHaveText('Start tracking');
      await permission.locator('#grant').click();
      await expect(permission.locator('#dashboard-link')).toBeVisible({ timeout: 20_000 });
    }
    await expect(page.locator('#toggle')).toHaveText('Stop tracking', { timeout: 25_000 });
    // The generated camera has no human face. Inference must report absence.
    await expect(page.locator('#session-status')).toHaveText('Away from camera', { timeout: 15_000 });
    await expect(page.locator('#page-error')).toBeHidden();
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveText('Start tracking');
    const cameraClosed = await worker.evaluate(async () => chrome.offscreen.hasDocument());
    expect(cameraClosed).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
