import { test, expect } from '@playwright/test';
const api = 'http://127.0.0.1:3101';
const secret = 'TEST_BROWSER_SETTINGS_KEY';

test('settings entry saves independent models and never persists or returns the API key in the browser', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#wallet');
  await page.getByRole('button', { name: '模型设置' }).click();
  await expect(page.getByRole('heading', { name: '模型设置', exact: true })).toBeVisible();
  await expect(page.locator('#agent-save')).toBeEnabled();
  const original = await (await request.get(api + '/api/settings/models')).json();
  await page.locator('#guard-modelId').fill('independent-reviewer-draft');
  await page.locator('#agent-modelId').fill('custom-actor');
  await page.locator('#agent-apiKey').fill(secret);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/settings/models/agent'));
  await page.locator('#agent-save').click();
  const saved = await (await response).json(); expect(JSON.stringify(saved)).not.toContain(secret);
  await expect(page.locator('#agent-save-state')).toHaveText('已保存并生效');
  await expect(page.locator('#agent-apiKey')).toHaveValue('');
  await expect(page.locator('#guard-modelId')).toHaveValue('independent-reviewer-draft');
  expect(saved.guard.modelId).toBe(original.guard.modelId);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret);
  await page.reload();
  await expect(page.locator('#agent-modelId')).toHaveValue('custom-actor');
  await expect(page.locator('#agent-apiKey')).toHaveValue('');
  await expect(page.locator('#guard-modelId')).toHaveValue(original.guard.modelId);
  await page.screenshot({ path: '.local/frontend-qa/model-settings-desktop.png', fullPage: true });
  await page.locator('#agent-baseURL').fill('https://example.com/v1');
  await expect(page.locator('#agent-apiKey')).toHaveAttribute('required', '');
  await expect(page.locator('#agent-key-hint')).toContainText('地址已更改');
  expect(errors).toEqual([]);
  await request.post(api + '/api/settings/models/agent', { data: { revision: saved.revision, profile: { baseURL: original.agent.baseURL, modelId: original.agent.modelId, compatibility: original.agent.compatibility, requestTimeoutMs: original.agent.requestTimeoutMs, outputTokens: original.agent.outputTokens } } });
});

test('mobile settings clear unsaved keys when leaving; failed saves never show success', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#wallet');
  await page.getByRole('button', { name: '切换侧栏' }).click();
  await page.getByRole('button', { name: '模型设置' }).click();
  await expect(page.locator('#agent-save')).toBeEnabled();
  await page.locator('#agent-modelId').fill('unsaved-model');
  await page.locator('#agent-apiKey').fill(secret);
  await page.route('**/api/settings/models/agent', route => route.fulfill({ status: 409, json: { error: 'MODEL_SETTINGS_BUSY' } }));
  await page.locator('#agent-save').click();
  await expect(page.locator('#agent-error')).toContainText('等待签名');
  await expect(page.locator('#agent-save-state')).toHaveText('尚未保存');
  await expect(page.locator('#agent-apiKey')).toHaveValue('');
  await page.locator('#agent-apiKey').fill(secret);
  await page.getByRole('button', { name: '切换侧栏' }).click();
  await page.locator('#new-transfer').click();
  await expect(page.locator('#sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#agent-apiKey')).toHaveValue('');
  await page.goto('/#settings');
  await expect(page.locator('#agent-save')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/frontend-qa/model-settings-mobile.png', fullPage: true });
});

test('unavailable settings API disables saving with an actionable state', async ({ page }) => {
  await page.route('**/api/settings/models', route => route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } }));
  await page.goto('/#settings');
  await expect(page.locator('#models-notice')).toContainText('不支持模型设置');
  await expect(page.locator('#agent-save')).toBeDisabled();
  await expect(page.locator('#guard-save')).toBeDisabled();
});
