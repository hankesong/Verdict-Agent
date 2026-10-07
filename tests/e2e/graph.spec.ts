import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const source = JSON.parse(readFileSync("fixtures/graph/fallback.json", "utf8"));
const nodes = (page: Page, selector = "") => page.locator(`#ag-svg .ag-node${selector}`);

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("recorded replay steps, pauses, shows details and makes no execution request", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r.url());
  });
  await page.goto("/#activity");
  await expect(page.getByRole("heading", { name: "每一步，都看得见。" })).toBeVisible();
  await expect(page.locator("#ag-source")).toContainText("录制回放");
  await expect(page.locator("#ag-progress")).toHaveText("0 / 33 条事件");
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(nodes(page, "[data-phase=PROPOSAL]")).toHaveCount(1);
  await page.getByRole("button", { name: "播放回放" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "暂停回放" }).click();
  const progress = await page.locator("#ag-progress").textContent();
  await page.waitForTimeout(500);
  expect(await page.locator("#ag-progress").textContent()).toEqual(progress);
  await page.getByRole("button", { name: "跳到末尾" }).click();
  await expect(nodes(page, "[data-status=ADOPTED]")).toHaveCount(1);
  await expect(nodes(page, "[data-phase=VERIFICATION][data-status=FAIL]")).toHaveCount(2);
  await nodes(page, "[data-status=ADOPTED]").click();
  await expect(page.getByRole("complementary", { name: "动作详情" })).toBeVisible();
  await expect(page.getByText("录制引用 · 离线回放不访问证据库")).toBeVisible();
  await page.getByRole("button", { name: "执行前拦截" }).click();
  await page.getByRole("button", { name: "跳到末尾" }).click();
  await expect(nodes(page, "[data-status=BLOCK]")).toHaveCount(1);
  await expect(nodes(page, "[data-phase=EXECUTION]")).toHaveCount(0);
  await page.getByRole("button", { name: "重新播放" }).click();
  await expect(nodes(page, "[data-phase=PROPOSAL]")).toHaveCount(0);
  await page.getByRole("button", { name: "正常完成" }).click();
  await page.getByRole("button", { name: "跳到末尾" }).click();
  await expect(nodes(page, "[data-status=ADOPTED]")).toHaveCount(1);
  expect(posts).toEqual([]);
});

test("live graph follows the cursor, retries after a disconnection and refreshes without duplicate nodes", async ({ page }) => {
  let requests = 0,
    breakNext = true;
  await page.route("**/api/agent/runs/graph-e2e/graph?*", async (route) => {
    requests++;
    const after = Number(new URL(route.request().url()).searchParams.get("after"));
    if (after > 0 && breakNext) {
      breakNext = false;
      await route.abort();
      return;
    }
    const partial = requests === 1;
    await route.fulfill({
      json: {
        ...source.page,
        agentId: "graph-e2e",
        events: partial
          ? source.page.events.slice(0, 4).map((e: any) => ({ ...e, agentId: "graph-e2e" }))
          : source.page.events.filter((e: any) => e.sequence > after).map((e: any) => ({ ...e, agentId: "graph-e2e" })),
        nextCursor: partial ? 4 : source.page.nextCursor,
        hasMore: false,
        task: { ...source.page.task, ...(partial ? { status: "RUNNING", finishedAt: null, adoptedEvidenceId: null } : {}) },
      },
    });
  });
  await page.goto("/#activity?agent=graph-e2e");
  await expect(page.locator("#ag-alert")).toContainText("连接中断");
  await expect(nodes(page, "[data-status=ADOPTED]")).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator("#ag-alert")).toBeHidden();
  const count = await nodes(page).count();
  await page.reload();
  await expect(nodes(page, "[data-status=ADOPTED]")).toHaveCount(1);
  await expect(nodes(page)).toHaveCount(count);
  expect(requests).toBeGreaterThanOrEqual(3);
});

test("mobile graph keeps hostile labels inert and draws no particles under reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const bad = structuredClone(source.page);
  bad.agentId = "hostile";
  for (const e of bad.events) e.agentId = "hostile";
  for (const e of bad.events) if (e.serviceId) e.serviceId = "<img src=x onerror=window.graphInjected=1>";
  await page.route("**/api/agent/runs/hostile/graph?*", (route) => route.fulfill({ json: bad }));
  await page.goto("/#activity?agent=hostile");
  await expect(nodes(page, "[data-status=ADOPTED]")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(await page.evaluate(() => (window as any).graphInjected)).toBeUndefined();
  await expect(page.locator(".ag-particle")).toHaveCount(0);
  await nodes(page, "[data-status=ADOPTED]").click();
  await expect(page.getByRole("complementary", { name: "动作详情" })).toBeVisible();
  const screenshot = await page.screenshot({ fullPage: true });
  expect(screenshot.length).toBeGreaterThan(1000);
});
