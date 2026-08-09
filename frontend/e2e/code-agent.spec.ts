import { expect, test, type Page } from "@playwright/test";

const MOCK_TASKS = [
  {
    task_id: "task-1",
    task_spec_id: "spec-1",
    dataset_snapshot_id: "ds-1",
    project_id: "proj-1",
    title: "DESeq2 Differential Expression",
    status: "succeeded",
    attempt_count: 1,
    max_attempts: 3,
    created_at: "2026-08-07T01:00:00Z",
  },
  {
    task_id: "task-2",
    task_spec_id: "spec-2",
    dataset_snapshot_id: "ds-2",
    project_id: "proj-1",
    title: "Biopython Sequence Analysis",
    status: "running",
    attempt_count: 1,
    max_attempts: 3,
    created_at: "2026-08-07T02:00:00Z",
  },
];

async function mockTaskList(page: Page) {
  await mockSettings(page);
  await page.route("**/api/tasks?*", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ tasks: MOCK_TASKS }), contentType: "application/json" });
  });
  await page.route("**/api/tasks", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ tasks: MOCK_TASKS }), contentType: "application/json" });
  });
}

async function mockSettings(page: Page) {
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ settings: { locale: "zh" } }), contentType: "application/json" });
  });
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ status: 401, body: JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), contentType: "application/json" });
  });
}

test("Task Center shows direct creation, task list, and collapsed Workers", async ({ page }) => {
  await mockTaskList(page);
  await page.goto("/code-agent");

  await expect(page.getByTestId("task-creation-card")).toBeVisible();
  await expect(page.getByText("执行文档", { exact: true })).toBeVisible();
  await expect(page.getByText("数据集", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建任务" })).toBeVisible();
  await expect(page.getByRole("button", { name: /DESeq2 Differential Expression/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Biopython Sequence Analysis/ })).toBeVisible();
  await expect(page.getByText("成功")).toBeVisible();
  await expect(page.getByText("运行中")).toBeVisible();
  await expect(page.getByTestId("worker-enrollment-namespace")).toHaveCount(0);
});

test("Task Center opens the new-task draft from the left workspace", async ({ page }) => {
  await mockTaskList(page);
  await page.goto("/code-agent");
  await page.getByTestId("new-task-button").click();
  await expect(page.getByTestId("task-creation-card")).toBeVisible();
});

test("Task detail page loads through the task selected in the center", async ({ page }) => {
  await mockSettings(page);
  await page.route("**/api/tasks/task-1", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify(MOCK_TASKS[0]), contentType: "application/json" });
  });

  await page.goto("/code-agent/tasks/?task_id=task-1");
  await expect(page.getByRole("heading", { name: "DESeq2 Differential Expression" })).toBeVisible();
  await expect(page.getByText("成功")).toBeVisible();
});

test("Task detail page preserves a running task and exposes cancellation", async ({ page }) => {
  await mockSettings(page);
  await page.route("**/api/tasks/task-2", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify(MOCK_TASKS[1]), contentType: "application/json" });
  });

  await page.goto("/code-agent/tasks/?task_id=task-2");
  await expect(page.getByRole("heading", { name: "Biopython Sequence Analysis" })).toBeVisible();
  await expect(page.getByText("运行中")).toBeVisible();
  await expect(page.getByRole("button", { name: "取消" })).toBeVisible();
});
