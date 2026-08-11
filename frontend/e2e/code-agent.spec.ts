import { expect, test } from "@playwright/test";

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
    result_artifact_id: null,
    error_message: null,
    created_by: null,
    created_at: "2026-08-07T01:00:00Z",
    updated_at: "2026-08-07T01:30:00Z",
    finished_at: "2026-08-07T01:30:00Z",
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
    result_artifact_id: null,
    error_message: null,
    created_by: null,
    created_at: "2026-08-07T02:00:00Z",
    updated_at: "2026-08-07T02:05:00Z",
    finished_at: null,
  },
];

const MOCK_EVENTS = [
  {
    task_event_id: 1,
    event_type: "task_state",
    event_data: { status: "queued", attempt_count: 0 },
    created_at: "2026-08-07T01:00:00Z",
  },
  {
    task_event_id: 2,
    event_type: "task_state",
    event_data: { status: "claimed", attempt_count: 1 },
    created_at: "2026-08-07T01:01:00Z",
  },
  {
    task_event_id: 3,
    event_type: "task_state",
    event_data: { status: "running", attempt_count: 1 },
    created_at: "2026-08-07T01:02:00Z",
  },
];

const MOCK_ARTIFACTS = [
  {
    artifact_id: "artifact-task-1",
    name: "result.zip",
    kind: "result_archive",
    storage_path: "/tmp/task-outputs/task-1/result.zip",
    file_size_bytes: 102400,
    checksum_sha256: "abc123def456",
    created_at: "2026-08-07T01:30:00Z",
  },
];

test("Task Center shows the new-task form and task list", async ({ page }) => {
  await page.route("**/api/tasks*", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ tasks: MOCK_TASKS }),
      contentType: "application/json",
    });
  });

  await page.goto("/task-center");
  await expect(page.getByText("执行文档", { exact: true })).toBeVisible();
  await expect(page.getByText("数据集", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并提交" })).toBeVisible();
  await expect(page.getByText("添加 Worker")).toBeVisible();
  // Task list
  await expect(page.getByText("DESeq2 Differential Expression")).toBeVisible();
  await expect(page.getByText("Biopython Sequence Analysis")).toBeVisible();
  await expect(page.getByText("成功", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("运行中", { exact: true }).first()).toBeVisible();
});

test("legacy /code-agent/tasks index redirects to Task Center", async ({ page }) => {
  await page.route("**/api/tasks*", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ tasks: MOCK_TASKS }),
      contentType: "application/json",
    });
  });

  await page.goto("/code-agent/tasks");
  await expect(page).toHaveURL(/\/task-center\/?$/);
  await expect(page.getByRole("button", { name: "确认并提交" })).toBeVisible();
});

test("legacy task detail route loads with events and artifacts", async ({ page }) => {
  await page.route("**/api/tasks?limit=50", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ tasks: MOCK_TASKS }), contentType: "application/json" });
  });
  await page.route("**/api/tasks/task-1", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify(MOCK_TASKS[0]),
      contentType: "application/json",
    });
  });

  await page.route("**/api/tasks/task-1/events", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify(MOCK_EVENTS),
      contentType: "application/json",
    });
  });

  await page.route("**/api/tasks/task-1/artifacts", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify(MOCK_ARTIFACTS),
      contentType: "application/json",
    });
  });

  await page.goto("/task-center/tasks/task-1");
  await expect(page.getByRole("heading", { name: "DESeq2 Differential Expression" })).toBeVisible();
  await expect(page.getByRole("main").getByText("成功", { exact: true })).toBeVisible();
  await expect(page.getByText("result.zip")).toBeVisible();
  await expect(page.getByText("task_state").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Biopython Sequence Analysis" })).toBeVisible();
});

test("Task detail page shows task information correctly", async ({ page }) => {
  await page.route("**/api/tasks?limit=50", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ tasks: MOCK_TASKS }), contentType: "application/json" });
  });
  await page.route("**/api/tasks/task-2", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify(MOCK_TASKS[1]),
      contentType: "application/json",
    });
  });

  await page.route("**/api/tasks/task-2/events", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify(MOCK_EVENTS),
      contentType: "application/json",
    });
  });

  await page.route("**/api/tasks/task-2/artifacts", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify([]),
      contentType: "application/json",
    });
  });

  await page.goto("/task-center/tasks/task-2");
  await expect(page.getByRole("heading", { name: "Biopython Sequence Analysis" })).toBeVisible();
  await expect(page.getByRole("main").getByText("运行中", { exact: true })).toBeVisible();
  await expect(page.getByText("1").first()).toBeVisible();
});
