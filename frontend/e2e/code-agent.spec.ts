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
});

test("Task Center shows task history and direct creation form", async ({ page }) => {
  await page.route("**/api/tasks*", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ tasks: MOCK_TASKS }),
      contentType: "application/json",
    });
  });

  await page.goto("/task-center");
  await expect(page.getByTestId("task-creation-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "创建任务", exact: true })).toBeVisible();
  await expect(page.getByTestId("worker-enrollment-toggle")).toBeVisible();
  // Task list
  await expect(page.getByText("DESeq2 Differential Expression")).toBeVisible();
  await expect(page.getByText("Biopython Sequence Analysis")).toBeVisible();
  await expect(page.getByText("成功", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("运行中", { exact: true }).first()).toBeVisible();
});

test("unauthenticated Task Center shows only sign-in actions", async ({ page }) => {
  await page.unroute("**/api/me");
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ status: 401, body: JSON.stringify({ detail: "Authentication required" }), contentType: "application/json" });
  });
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));

  await page.goto("/task-center");
  await expect(page.getByRole("button", { name: "登录 / 注册", exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "退出登录", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("task-list-panel")).toHaveCount(0);
  await expect(page.getByTestId("task-creation-card")).toHaveCount(0);
  expect(requestedUrls.some((url) => url.includes("/api/tasks/preview"))).toBe(false);
});

test("Task Center submits files directly without a preview call", async ({ page }) => {
  let taskCreateBody: Record<string, unknown> | null = null;
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));

  await page.route("**/api/tasks", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, body: JSON.stringify({ tasks: MOCK_TASKS }), contentType: "application/json" });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/tasks/direct", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    taskCreateBody = request.postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, body: JSON.stringify({ task_id: "task-created", status: "queued" }), contentType: "application/json" });
  });
  await page.route("**/api/projects/default", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ project_id: "proj-1", name: "Default Project" }), contentType: "application/json" });
  });
  await page.route("**/api/task-specs", async (route) => {
    await route.fulfill({ status: 201, body: JSON.stringify({ task_spec_id: "spec-created", revision: 1, status: "draft" }), contentType: "application/json" });
  });
  await page.route("**/api/task-specs/spec-created/freeze", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ task_spec_id: "spec-created", status: "frozen", frozen: true }), contentType: "application/json" });
  });
  await page.route("**/api/method-sources/upload", async (route) => {
    await route.fulfill({ status: 201, body: JSON.stringify({ method_source_id: "method-created", original_filename: "case-2.md", file_size_bytes: 16 }), contentType: "application/json" });
  });
  await page.route("**/api/dataset-snapshots/upload", async (route) => {
    await route.fulfill({ status: 201, body: JSON.stringify({ resource_id: "resource-created", logical_name: "case-2.zip", file_hash_sha256: "hash", file_size_bytes: 16, original_filename: "case-2.zip" }), contentType: "application/json" });
  });
  await page.route("**/api/dataset-snapshots", async (route) => {
    await route.fulfill({ status: 201, body: JSON.stringify({ dataset_snapshot_id: "snapshot-created" }), contentType: "application/json" });
  });
  await page.route("**/api/tasks/task-created", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ ...MOCK_TASKS[1], task_id: "task-created", title: "case-2" }), contentType: "application/json" });
  });
  await page.route("**/api/tasks/task-created/events", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify([]), contentType: "application/json" });
  });
  await page.route("**/api/tasks/task-created/artifacts", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify([]), contentType: "application/json" });
  });

  await page.goto("/task-center");
  const fileInputs = page.locator('input[type="file"]');
  await fileInputs.nth(0).setInputFiles({ name: "case-2.md", mimeType: "text/markdown", buffer: Buffer.from("# Case 2 method") });
  await fileInputs.nth(1).setInputFiles({ name: "case-2.zip", mimeType: "application/zip", buffer: Buffer.from("fake zip fixture") });
  await page.getByRole("button", { name: "创建任务", exact: true }).click();

  await expect(page).toHaveURL(/\/task-center\/tasks\/task-created\/?$/);
  expect(taskCreateBody).toMatchObject({
    agent_confirmation: false,
    submission_source: "task_center",
    chat_confirmation_id: false,
    project_id: "proj-1",
    task_spec_id: "spec-created",
    dataset_snapshot_id: "snapshot-created",
  });
  expect(requestedUrls.some((url) => url.includes("/api/tasks/preview"))).toBe(false);
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
  await expect(page.getByTestId("task-creation-card")).toBeVisible();
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
