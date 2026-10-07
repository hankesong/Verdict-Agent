import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digest } from "@verdict/core";

// Reduced motion keeps the real state transitions but removes animation pacing.
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});
const attempt = (page: Page, service: string) => page.locator("#trk-tl .tl-item", { hasText: `· ${service}` });
async function connected(page: Page) {
  await expect(page.locator("#inst-primary")).toContainText("browser-one 已连接");
}

test("tracking: signed faults are rejected, the valid delivery is adopted, sealed and replayed on the second instance", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#track");
  await connected(page);
  await page.getByRole("button", { name: "替换后 PASS" }).click();
  await expect(page.locator("#trk-status")).toContainText("SUCCEEDED");
  await expect(attempt(page, "demo-wrong-block")).toContainText("FAIL");
  await expect(attempt(page, "demo-wrong-value")).toContainText("FAIL");
  await expect(attempt(page, "demo-valid")).toContainText("PASS");
  await expect(page.locator("#trk-tl .tl-item", { hasText: "证据封存" })).toBeVisible();
  await expect(page.locator("#trk-tl .tl-item", { hasText: "第二实例复验" })).toContainText("reportConsistent true");
  await expect(page.locator("#trk-tl .tl-item", { hasText: "链上锚定" })).toContainText("not_requested");
  await expect(page.locator("#trk-hash")).toHaveText(/^0x[0-9a-f]{64}$/);
  await expect(page.locator("#trk-bc .barcode span")).toHaveCount(64);
  await expect(page.locator("#api-log")).toContainText("/api/runs");
  expect(errors).toEqual([]);
});

test("tracking: all failures and budget exhaustion stop with different reasons and refresh restores the run", async ({ page }) => {
  await page.goto("/#track");
  await connected(page);
  await page.getByRole("button", { name: "全部 FAIL" }).click();
  await expect(page.locator("#trk-status")).toContainText("STOPPED");
  await expect(page.locator("#trk-tl")).toContainText("NO_ACCEPTABLE_DELIVERY");
  await expect(page.locator("#trk-hash")).toHaveText("— (accepted = null)");
  await page.getByRole("button", { name: "预算耗尽" }).click();
  await expect(page.locator("#trk-tl")).toContainText("BUDGET_EXHAUSTED");
  await expect(page.locator("#trk-tl .tl-head b", { hasText: /^attempt \d+ · / })).toHaveCount(1);
  const runId = new URL(page.url()).hash.split("run=")[1];
  expect(runId).toBeTruthy();
  await page.reload();
  await expect(page.locator("#trk-idv")).toHaveAttribute("title", runId);
  await expect(page.locator("#trk-tl")).toContainText("BUDGET_EXHAUSTED");
});

test("register: a submitted task is tracked; the same requestId reuses the run and changed input gets 409", async ({ page }) => {
  await page.goto("/#register");
  await expect(page.locator("#rg-fields")).toBeEnabled();
  await page.getByRole("button", { name: "仅正常服务" }).click();
  await page.getByRole("button", { name: "提交并追踪 →" }).click();
  await expect(page).toHaveURL(/#track\?run=/);
  await expect(page.locator("#trk-status")).toContainText("SUCCEEDED");
  const runId = new URL(page.url()).hash.split("run=")[1];
  await page.goto("/#register");
  await page.getByRole("button", { name: "原样重放同一请求" }).click();
  await expect(page.locator(".idem-log")).toContainText("duplicate:true");
  await expect(page.locator(".idem-log")).toContainText("与首次相同");
  await page.getByRole("button", { name: "同一 requestId 改 maxAttempts" }).click();
  await expect(page.locator(".idem-log li").first()).toContainText("409");
  expect(await page.locator(".idem-log").textContent()).not.toContain("返回了新的 runId");
  expect(runId).toBeTruthy();
});

test("register: a lost create response is retried with the same requestId and does not duplicate the task", async ({ page }) => {
  await page.goto("/#register");
  await expect(page.locator("#rg-fields")).toBeEnabled();
  await page.getByRole("button", { name: "仅正常服务" }).click();
  let originalId: string | undefined;
  let runId: string | undefined;
  await page.route(
    "**/api/runs",
    async (route) => {
      originalId = route.request().postDataJSON().task.requestId;
      const response = await route.fetch();
      runId = (await response.json()).runId;
      await route.abort();
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "提交并追踪 →" }).click();
  await expect(page.getByRole("button", { name: "重试同一请求" })).toBeVisible();
  const repeated = page.waitForRequest((req) => req.url().endsWith("/api/runs") && req.method() === "POST");
  await page.getByRole("button", { name: "重试同一请求" }).click();
  expect((await repeated).postDataJSON().task.requestId).toBe(originalId);
  await expect(page).toHaveURL(new RegExp(`#track\\?run=${runId}`));
  await expect(page.locator("#trk-status")).toContainText("SUCCEEDED");
});

test("evidence label: original bytes download unchanged and a check pointer locates the field in the bundle", async ({ page, request }) => {
  await page.goto("/#track");
  await connected(page);
  await page.getByRole("button", { name: "替换后 PASS" }).click();
  await expect(page.locator("#trk-status")).toContainText("SUCCEEDED");
  await page.getByRole("button", { name: "打开证据标签 ↗" }).click();
  await expect(page).toHaveURL(/#evidence\?evidenceId=0x/);
  const id = new URL(page.url()).hash.split("evidenceId=")[1];
  await expect(page.locator("#station-evidence .label-hash")).toHaveText(id);
  await expect(page.locator("#ev-uri")).toHaveText(`verdict:ev?v=1.0.0&alg=keccak256-jcs&h=${id}`);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载原始证据 ↓" }).click();
  const bytes = readFileSync((await (await downloading).path())!, "utf8");
  expect(digest(JSON.parse(bytes))).toBe(id);
  expect(bytes).toBe(await (await request.get(`http://127.0.0.1:3101/api/evidence/${id}/bundle`)).text());
  const balance = page.locator("#station-evidence .check", { has: page.locator("code", { hasText: /^field-balance$/ }) });
  await balance.locator("summary").click();
  await balance.locator(".pointer").first().click();
  await expect(page.locator("#drawer")).toBeVisible();
  await expect(page.locator("#doc-hint")).toContainText("已定位");
  await expect(page.locator("#doc-view .hl")).toHaveCount(1);
});

test("independent replay of a rejected delivery reorders candidates; a tampered copy is refused on import", async ({ page }) => {
  await page.goto("/#track");
  await connected(page);
  await page.getByRole("button", { name: "全部 FAIL" }).click();
  await expect(page.locator("#trk-status")).toContainText("STOPPED");
  await attempt(page, "demo-wrong-block").getByRole("button", { name: "查看证据 ↗" }).click();
  await expect(page.locator("#station-evidence .label-hash")).toBeVisible();
  await page.getByRole("button", { name: "去独立复验 →" }).click();
  await expect(page).toHaveURL(/#replay\?evidenceId=0x/);
  await page.getByRole("button", { name: "第二实例独立复验 →" }).click();
  await expect(page.locator("#rp-result .stamp")).toHaveText("REPORT CONSISTENT");
  await expect(page.locator("#rp-result")).toContainText("FAIL");
  await expect(page.locator("#rp-result")).toContainText("VERIFIED");
  const lists = page.locator(".compare ol");
  await expect(lists).toHaveCount(2);
  expect(await lists.nth(0).locator("li").allTextContents()).not.toEqual(await lists.nth(1).locator("li").allTextContents());
  await page.getByRole("button", { name: "修改副本并导入第二实例" }).click();
  await expect(page.locator("#rp-tamper .stamp")).toHaveText("HTTP 422 · ARTIFACT_MISMATCH");
  await expect(page.locator("#rp-tamper")).toContainText("#/delivery/response/values/balance");
});

test("mobile layout, unavailable backend and dev-server private-file boundary", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await connected(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "候选与观测" }).click();
  await expect(page.getByRole("heading", { name: "demo-valid", exact: true })).toBeVisible();
  await page.route("**/api/meta", (route) => route.abort());
  await page.getByRole("button", { name: "重新连接后端" }).click();
  await expect(page.locator("#notice")).toContainText("无法连接");
  await page.getByRole("button", { name: "任务登记" }).click();
  await expect(page.getByRole("button", { name: "提交并追踪 →" })).toBeDisabled();
  // Use an existing, harmless private fixture; do not depend on a user's dev:init.
  const local = resolve(".local");
  mkdirSync(local, { recursive: true });
  const directory = mkdtempSync(join(local, "web-private-"));
  try {
    const path = join(directory, "sentinel.json");
    writeFileSync(path, JSON.stringify({ privateFixture: true }));
    const blocked = await request.get("/@fs/" + path.replaceAll("\\", "/"));
    expect(blocked.status()).toBe(403);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("interrupted polling resumes the same run without creating a new one", async ({ page }) => {
  await page.goto("/#track");
  await connected(page);
  let creates = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/runs")) creates++;
  });
  await page.route("**/api/runs/*", (route) => route.abort(), { times: 1 });
  await page.getByRole("button", { name: "全部 FAIL" }).click();
  await expect(page.locator("[data-trk-notice]")).toContainText("查询中断");
  await expect(page.getByRole("button", { name: "继续查询同一运行" })).toBeVisible();
  await page.getByRole("button", { name: "重新连接后端" }).click();
  await expect(page.locator("#trk-status")).toContainText("STOPPED");
  expect(creates).toBe(1);
});

test("PI direct submission runs real tools without a draft and restores on refresh", async ({ page, request }) => {
  test.setTimeout(90000);
  const meta = await (await request.get("http://127.0.0.1:3101/api/meta")).json();
  await page.goto("/#agent");
  await connected(page);
  await page.locator("#pi-prompt").fill(`核验 ${meta.capabilities[0].accounts[0]} 在固定检查点 ${meta.contexts[0].trustedBlock.blockHash} 的账户状态。`);
  await page.getByRole("button", { name: /运行 Agent/ }).click();
  // Multi-step PI + independent Guard + real signers may take the full 30s fixture budget.
  await expect(page.locator("#pi-status")).toHaveText("COMPLETED", { timeout: 35000 });
  await expect(page.locator("#pi-run-card")).toContainText("已通过本次验收");
  await expect(page.locator("#pi-progress")).toContainText("TEST_TRANSPORT");
  await expect(page.locator("#pi-progress")).toContainText("start_task");
  await expect(page.locator("#pi-progress")).toContainText("request_verified_state");
  await expect(page.locator("#pi-progress")).toContainText("查看请求耗时");
  await expect(page.locator("#pi-progress")).toContainText("模型费用 未知");
  await expect(page.locator("#pi-bound")).toContainText(meta.capabilities[0].accounts[0]);
  await expect(page.locator(".mini-attempts li")).toHaveCount(3);
  await page.reload();
  await expect(page.locator("#pi-status")).toHaveText("COMPLETED", { timeout: 35000 });
  await expect(page.locator("#pi-run-card")).toContainText("已通过本次验收");
});

test("PI incomplete task stops without data; a new complete task runs directly", async ({ page, request }) => {
  test.setTimeout(90000);
  const meta = await (await request.get("http://127.0.0.1:3101/api/meta")).json();
  await page.goto("/#agent");
  await connected(page);
  await page.locator("#pi-prompt").fill("帮我检查最新账户状态");
  await page.getByRole("button", { name: /运行 Agent/ }).click();
  await expect(page.locator("#pi-status")).toHaveText("STOPPED", { timeout: 35000 });
  await expect(page.locator("#pi-progress")).toContainText("请提供明确账户和固定区块");
  await expect(page.locator("#pi-run-card .accepted")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /运行 Agent/ })).toBeEnabled();
  await page.locator("#pi-prompt").fill(`核验 ${meta.capabilities[0].accounts[0]} 在固定检查点 ${meta.contexts[0].trustedBlock.blockHash}`);
  await page.getByRole("button", { name: /运行 Agent/ }).click();
  await expect(page.locator("#pi-status")).toHaveText("COMPLETED", { timeout: 35000 });
  await expect(page.locator("#pi-run-card")).toContainText("已通过本次验收");
});
