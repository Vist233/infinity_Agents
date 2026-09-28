import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ user: { id: "user-1", email: "tester@example.com", name: "Tester" } }),
      contentType: "application/json",
    });
  });
  await page.route("**/api/admin/public-worker-pool", async (route) => {
    await route.fulfill({ status: 403, body: JSON.stringify({ error: "forbidden" }), contentType: "application/json" });
  });
  await page.route("**/api/tasks?limit=50", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ tasks: [] }), contentType: "application/json" });
  });
  await page.route("**/api/discovery/papers*", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ papers: [] }), contentType: "application/json" });
  });
});

test("root opens Task Center and exposes only the three product areas", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/task-center\/?$/);
  await expect(page.getByTestId("task-creation-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "任务执行中心", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "论文库", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Image Judge", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Analysis", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "数据集合", exact: true })).toHaveCount(0);
  await expect(page.getByText("今天想让我帮你做什么？", { exact: true })).toHaveCount(0);
});

test("legacy collection and download URLs enter a supported workspace", async ({ page }) => {
  await page.goto("/data-collections/");
  await expect(page).toHaveURL(/\/papers\/?$/);

  await page.goto("/downloads/");
  await expect(page).toHaveURL(/\/image-judge\/?$/);
  await expect(page.getByRole("button", { name: "下载最新版本", exact: true })).toBeVisible();
});

test("mobile workspace menu keeps Task, Papers, and ImageJudge without chat actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/task-center/");

  await page.getByRole("button", { name: "Open workspace menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace menu" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "任务执行中心", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "论文库", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Image Judge", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "新对话", exact: true })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "数据集合", exact: true })).toHaveCount(0);
});
