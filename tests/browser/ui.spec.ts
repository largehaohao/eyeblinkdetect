import { test, expect, type Page } from '@playwright/test';

async function mockExtension(page: Page, scenario = 'data') {
  await page.addInitScript(({ scenario }) => {
    const end = Math.floor(Date.now() / 60_000) * 60_000;
    const rows = Array.from({ length: 60 }, (_, i) => ({
      tsMinute: end - (60 - i) * 60_000, blinks: 12 + i % 9,
      faceVisibleMs: 60_000, status: 'ok', sessionId: 'fixture'
    }));
    const settings = {
      threshold: { lowBpm: 10, windowMinutes: 5, sustainMinutes: 3 },
      cooldownMinutes: 5, reminderModes: { systemNotification: true, fullscreenOverlay: false },
      audio: { rawBlinkSoundMuted: true }, ear: { closeThresh: 0.2, openThresh: 0.25, personalized: true }
    };
    let state = 'OFF';
    let rangeCalls = 0;
    (window as any).chrome = {
      permissions: { contains: async () => false, request: async () => false, remove: async () => true },
      runtime: {
        getURL: (p: string) => '/' + p,
        onMessage: { addListener: () => {}, removeListener: () => {} },
        sendMessage: async ({ payload: q }: any) => {
          if (scenario === 'error') throw new Error('Extension connection unavailable');
          if (q.kind === 'status') return { state, calibration: 'idle' };
          if (q.kind === 'toggle') {
            await new Promise(r => setTimeout(r, 150));
            state = q.on ? 'RUNNING' : 'OFF';
            return { state };
          }
          if (q.kind === 'settings_get') return settings;
          if (q.kind === 'settings_set') {
            Object.assign(settings, q.patch);
            return settings;
          }
          if (q.kind === 'range' || q.kind === 'recent_minutes') {
            if (scenario === 'empty') return [];
            if (scenario === 'stale') return rows.slice(0, 5);
            if (scenario === 'race' && q.kind === 'range') {
              const call = ++rangeCalls;
              await new Promise(r => setTimeout(r, call === 2 ? 350 : 10));
              return rows.map(r => ({ ...r, blinks: call === 2 ? 3 : 18 }));
            }
            return rows;
          }
          if (q.kind === 'blinks_range') return scenario === 'empty' ? [] :
            Array.from({ length: 32 }, (_, i) => ({ t: Date.now() - i * 4_000, sessionId: 'fixture' })).reverse();
          if (q.kind === 'reminder_diagnostic') return {
            state, lastReminderAt: 0, ...settings.threshold, ...settings.reminderModes,
            bucketCount: 5, validBucketCount: 5, averageBpm: 16,
            cooldownRemainingMs: 0, reason: 'window_average_not_low'
          };
          return { ok: true };
        }
      }
    };
    // Capture actual rendered Chart.js tick labels, not an isolated helper.
    (window as any).__canvasText = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args: [number, number, number?]) {
      (window as any).__canvasText.push(text);
      return fillText.call(this, text, ...args);
    };
  }, { scenario });
}

test('popup never presents an old record as the last five minutes', async ({ page }) => {
  await mockExtension(page, 'stale');
  await page.goto('/src/popup/popup.html');
  await expect(page.locator('#toggle')).toBeEnabled();
  await expect(page.locator('#bpm')).toHaveText('—');
});

test('trend axis renders the selected calendar dates', async ({ page }) => {
  await mockExtension(page);
  await page.goto('/src/dashboard/dashboard.html');
  await page.locator('[data-range="week"]').click();
  const expected = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  await expect.poll(() => page.evaluate(v => (window as any).__canvasText.includes(v), expected)).toBe(true);
});

test('latest range wins when responses arrive out of order', async ({ page }) => {
  await mockExtension(page, 'race');
  await page.goto('/src/dashboard/dashboard.html');
  await expect(page.locator('#avg')).toHaveText('18.0');
  await page.locator('[data-range="6h"]').click();
  await page.locator('[data-range="week"]').click();
  await page.waitForTimeout(500);
  await expect(page.locator('#avg')).toHaveText('18.0');
});

test('empty data offers a useful next step and exports no empty file', async ({ page }) => {
  await mockExtension(page, 'empty');
  await page.goto('/src/dashboard/dashboard.html');
  await expect(page.locator('#trend-empty')).toBeVisible();
  await expect(page.locator('#avg')).toHaveText('—');
  await page.locator('#export-csv').click();
  await expect(page.locator('#export-status')).toContainText('No history to export');
});

test('connection errors are visible and recoverable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockExtension(page, 'error');
  await page.goto('/src/dashboard/dashboard.html');
  await expect(page.locator('#page-error')).toBeVisible();
  await expect(page.locator('#toggle')).toBeDisabled();
  await expect(page.locator('#retry')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('popup controls lock during start and enable calibration once running', async ({ page }) => {
  await mockExtension(page);
  await page.goto('/src/popup/popup.html');
  await expect(page.locator('#calibrate')).toBeDisabled();
  await page.locator('#toggle').click();
  await expect(page.locator('#toggle')).toBeDisabled();
  await expect(page.locator('#toggle')).toHaveText('Stop tracking');
  await expect(page.locator('#calibrate')).toBeEnabled();
  await expect(page.locator('#state')).toHaveText('Tracking');
});

test('preferences validate, save and explain declined overlay permission', async ({ page }) => {
  await mockExtension(page);
  await page.goto('/src/dashboard/dashboard.html');
  await page.locator('[name=lowBpm]').fill('');
  await page.locator('#save-settings').click();
  expect(await page.locator('[name=lowBpm]').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  await page.locator('[name=lowBpm]').fill('12');
  await page.locator('[name=fullscreenOverlay]').check();
  await page.locator('#save-settings').click();
  await expect(page.locator('#settings-status')).toContainText('Website access was declined');
  await expect(page.locator('[name=fullscreenOverlay]')).not.toBeChecked();
});

test('CSV export downloads real records', async ({ page }) => {
  await mockExtension(page);
  await page.goto('/src/dashboard/dashboard.html');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^eye-blink-.*\.csv$/);
  await expect(page.locator('#export-status')).toContainText('60 minute records');
});

for (const width of [320, 375, 414, 768, 1440]) {
  test(`dashboard stays usable at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 980 });
    await mockExtension(page);
    await page.goto('/src/dashboard/dashboard.html');
    await expect(page.locator('#chart-updated')).toContainText('Updated');
    await expect(page.locator('[name=lowBpm]')).toHaveValue('10');
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {
      if (el.classList.contains('sr-only') || el.classList.contains('skip-link')) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.right > innerWidth + 1;
    }).map(el => el.id || el.tagName));
    expect(overflow).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`dashboard-${width}.png`), fullPage: true });
  });
}

test('popup and camera setup fit a narrow viewport', async ({ page }, testInfo) => {
  await mockExtension(page);
  // Chrome toolbar popups are capped at 600 CSS pixels tall.
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto('/src/popup/popup.html');
  await expect(page.locator('#toggle')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('popup.png') });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/src/permission/permission.html');
  await expect(page.locator('#grant')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('permission.png'), fullPage: true });
});

test('keyboard navigation has visible focus and range state', async ({ page }) => {
  await mockExtension(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/src/dashboard/dashboard.html');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.locator('[data-range="week"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-range="week"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-range="day"]')).toHaveAttribute('aria-pressed', 'false');
  const outline = await page.locator('[data-range="week"]').evaluate(el => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});
