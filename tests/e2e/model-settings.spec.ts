import { test, expect } from '@playwright/test';
const api = 'http://127.0.0.1:3101';
const secret = 'TEST_BROWSER_SETTINGS_KEY';

test('settings offers only the reviewer, saves it without changing the actor or storing browser secrets', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#wallet');
  await page.getByRole('button', { name: '模型设置' }).click();
  await expect(page.getByRole('heading', { name: '模型设置', exact: true })).toBeVisible();
  await expect(page.locator('#model-agent')).toHaveCount(0);
  await expect(page.locator('.model-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '审查 Agent', exact: true })).toBeVisible();
  await expect(page.locator('#guard-save')).toBeEnabled();
  const original = await (await request.get(api + '/api/settings/models')).json();
  await page.locator('#guard-modelId').fill('custom-reviewer');
  await page.locator('#guard-apiKey').fill(secret);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/settings/models/guard'));
  await page.locator('#guard-save').click();
  const saved = await (await response).json(); expect(JSON.stringify(saved)).not.toContain(secret);
  await expect(page.locator('#guard-save-state')).toHaveText('已保存并生效');
  await expect(page.locator('#guard-apiKey')).toHaveValue('');
  expect(saved.agent).toEqual(original.agent);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret);
  await page.reload();
  await expect(page.locator('#guard-modelId')).toHaveValue('custom-reviewer');
  await expect(page.locator('#guard-apiKey')).toHaveValue('');
  await page.screenshot({ path: '.local/frontend-qa/model-settings-desktop.png', fullPage: true });
  await page.locator('#guard-baseURL').fill('https://example.com/v1');
  await expect(page.locator('#guard-apiKey')).toHaveAttribute('required', '');
  await expect(page.locator('#guard-key-hint')).toContainText('地址已更改');
  expect(errors).toEqual([]);
  await request.post(api + '/api/settings/models/guard', { data: { revision: saved.revision, profile: { baseURL: original.guard.baseURL, modelId: original.guard.modelId, compatibility: original.guard.compatibility, requestTimeoutMs: original.guard.requestTimeoutMs, outputTokens: original.guard.outputTokens } } });
});

test('mobile settings clear unsaved keys when leaving; failed saves never show success', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#wallet');
  await page.getByRole('button', { name: '切换侧栏' }).click();
  await page.getByRole('button', { name: '模型设置' }).click();
  await expect(page.locator('#guard-save')).toBeEnabled();
  await page.locator('#guard-modelId').fill('unsaved-model');
  await page.locator('#guard-apiKey').fill(secret);
  await page.route('**/api/settings/models/guard', route => route.fulfill({ status: 409, json: { error: 'MODEL_SETTINGS_BUSY' } }));
  await page.locator('#guard-save').click();
  await expect(page.locator('#guard-error')).toContainText('等待签名');
  await expect(page.locator('#guard-save-state')).toHaveText('尚未保存');
  await expect(page.locator('#guard-apiKey')).toHaveValue('');
  await page.locator('#guard-apiKey').fill(secret);
  await page.getByRole('button', { name: '切换侧栏' }).click();
  await page.locator('#new-transfer').click();
  await expect(page.locator('#sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#guard-apiKey')).toHaveValue('');
  await page.goto('/#settings');
  await expect(page.locator('#guard-save')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/frontend-qa/model-settings-mobile.png', fullPage: true });
});

test('unavailable settings API disables saving with an actionable state', async ({ page }) => {
  await page.route('**/api/settings/models', route => route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } }));
  await page.goto('/#settings');
  await expect(page.locator('#models-notice')).toContainText('不支持模型设置');
  await expect(page.locator('#guard-save')).toBeDisabled();
  await expect(page.locator('#model-agent')).toHaveCount(0);
});
