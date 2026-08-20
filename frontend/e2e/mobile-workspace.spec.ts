import { expect, test } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test("mobile Task Center opens the workspace drawer with tasks and account actions", async ({ page }) => {
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
    await route.fulfill({
      status: 200,
      body: JSON.stringify({
        tasks: [{
          task_id: "task-1",
          task_spec_id: "spec-1",
          dataset_snapshot_id: "dataset-1",
          project_id: "project-1",
          title: "Case 2 sequence analysis",
          status: "running",
          attempt_count: 1,
          max_attempts: 3,
          created_at: "2026-08-20T08:00:00Z",
        }],
      }),
      contentType: "application/json",
    });
  });

  await page.goto("/task-center");
  const openMenu = page.getByRole("button", { name: "Open workspace menu" });
  await expect(openMenu).toBeVisible();
  await openMenu.click();

  const drawer = page.getByRole("dialog", { name: "Workspace menu" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Case 2 sequence analysis")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "新建任务", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();

  await drawer.getByRole("button", { name: "新建任务", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId("task-creation-card")).toBeVisible();
});
