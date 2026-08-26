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
});

test("smoke routes render", async ({ page }) => {
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, body: "[]", contentType: "application/json" });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await expect(page.getByText("今天想让我帮你做什么？")).toBeVisible();
  await expect(page.getByText("导出 PDF")).toHaveCount(0);

  await page.goto("/task-center");
  await expect(page.getByTestId("task-creation-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "创建任务", exact: true })).toBeVisible();
  await expect(page.getByTestId("worker-enrollment-toggle")).toBeVisible();

  await page.goto("/image-judge");
  await expect(page.getByText("文件分析示例")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载最新版本" })).toBeVisible();
});

test("home page shows retry banner when sessions endpoint fails", async ({ page }) => {
  let allowRecovery = false;
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    if (!allowRecovery) {
      await route.fulfill({ status: 500, body: JSON.stringify({ detail: "boom" }), contentType: "application/json" });
      return;
    }
    await route.fulfill({ status: 200, body: "[]", contentType: "application/json" });
  });

  await page.goto("/");
  await expect(page.getByText(/^加载对话失败：/)).toBeVisible();
  allowRecovery = true;
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText(/^加载对话失败：/)).toHaveCount(0);
});

test("switches session and deletes selected session", async ({ page }) => {
  let sessions = [
    { session_id: "s1", title: "First", created_at: "", updated_at: "" },
    { session_id: "s2", title: "Second", created_at: "", updated_at: "" },
  ];

  await page.route(/\/api\/sessions(\/.*)?$/, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(sessions),
        contentType: "application/json",
      });
      return;
    }
    if (method === "DELETE") {
      const pathname = new URL(route.request().url()).pathname;
      const deletedId = pathname.split("/").filter(Boolean).pop();
      sessions = sessions.filter((item) => item.session_id !== deletedId);
      await route.fulfill({ status: 200, body: "{}", contentType: "application/json" });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/sessions/s1/messages", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify([{ role: "assistant", content: "hello from first" }]),
      contentType: "application/json",
    });
  });

  await page.route("**/api/sessions/s2/messages", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify([{ role: "assistant", content: "hello from second" }]),
      contentType: "application/json",
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Second" }).click();
  await expect(page.getByText("hello from second")).toBeVisible();

  await page.getByTestId("delete-session-s2").click();
  await page.getByTestId("confirm-delete-s2").click();
  await expect(page.getByTestId("session-row-s2")).toHaveCount(0);
});

test("shows a durable tool trace while running and after reload", async ({ page }) => {
  const sessions = [{ session_id: "s1", title: "Paper chat", created_at: "", updated_at: "" }];
  const history = {
    messages: [{ role: "user", content: "find a paper" }, { role: "assistant", content: "Found it." }],
    events: [
      {
        session_id: "s1",
        event_id: 2,
        turn_id: "client:turn-1",
        event_type: "tool_call",
        tool_call_id: "call-1",
        tool_name: "search_paper",
        status: "pending",
        summary: "",
        arguments_summary: '{"query":"attention"}',
      },
      {
        session_id: "s1",
        event_id: 3,
        turn_id: "client:turn-1",
        event_type: "tool_result",
        tool_call_id: "call-1",
        tool_name: "search_paper",
        status: "succeeded",
        summary: "{\"count\":1}",
      },
    ],
    legacy_text_only: false,
  };

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, body: JSON.stringify(sessions), contentType: "application/json" });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/sessions/s1/messages", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify(history), contentType: "application/json" });
  });
  await page.route("**/api/chat", async (route) => {
    const body = [
      { type: "status", phase: "tool_running", correlation_id: "client:live-1", elapsed_ms: 1, attempt: 1, max_attempts: 1, tool_name: "search_paper" },
      { type: "tool_call", correlation_id: "client:live-1", tool_call_id: "call-live", tool_name: "search_paper", status: "processing", arguments_summary: '{"query":"attention"}' },
      { type: "tool_result", correlation_id: "client:live-1", tool_call_id: "call-live", tool_name: "search_paper", status: "succeeded", summary: '{"count":1}' },
      { type: "chunk", content: "Found it." },
      { type: "done" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    await route.fulfill({ status: 200, body, contentType: "text/event-stream" });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Paper chat" }).click();
  await expect(page.getByTestId("tool-timeline")).toBeVisible();
  await expect(page.getByTestId("tool-trace-call-1")).toContainText("search_paper");
  await expect(page.getByTestId("tool-trace-call-1")).toContainText("succeeded");

  const composer = page.locator("textarea");
  await composer.fill("find another paper");
  await composer.press("Enter");
  await expect(page.getByTestId("tool-trace-call-live")).toBeVisible();
  await expect(page.getByTestId("tool-trace-call-live")).toContainText("succeeded");

  await page.reload();
  await page.getByRole("button", { name: "Paper chat" }).click();
  await expect(page.getByTestId("tool-trace-call-1")).toContainText("succeeded");
  await expect(page.getByText("paper/s1")).toHaveCount(0);
});

test("keeps task confirmation visible and cancellable after a tool call", async ({ page }) => {
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        body: JSON.stringify([{ session_id: "s1", title: "Task chat", created_at: "", updated_at: "" }]),
        contentType: "application/json",
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/sessions/s1/messages", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ messages: [], events: [], legacy_text_only: false }), contentType: "application/json" });
  });
  await page.route("**/api/chat/task-confirmation/cancel", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ status: "cancelled" }), contentType: "application/json" });
  });
  await page.route("**/api/chat", async (route) => {
    const body = [
      { type: "tool_call", correlation_id: "client:task-1", tool_call_id: "task-call-1", tool_name: "request_task_creation", status: "processing", arguments_summary: "{}" },
      {
        type: "task_confirmation",
        confirmation_id: "confirmation-1",
        tool_name: "request_task_creation",
        title: "Background analysis",
        analysis_type: "generic",
        research_question: "Run the analysis",
        method_document_name: "execution.md",
        method_document_content: "# Execute",
        dataset_name: "data.zip",
      },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    await route.fulfill({ status: 200, body, contentType: "text/event-stream" });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Task chat" }).click();
  await page.locator("textarea").fill("create a background analysis task");
  await page.locator("textarea").press("Enter");
  await expect(page.getByText("待确认的分析任务", { exact: true })).toBeVisible();
  await expect(page.getByText("Run the analysis", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消草案" }).last().click();
  await expect(page.getByText("待确认的分析任务", { exact: true })).toHaveCount(0);
});

test("mobile drawer keeps workspace-specific actions available", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({ status: 200, body: "[]", contentType: "application/json" });
  });
  await page.route("**/api/tasks*", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ tasks: [{ task_id: "mobile-task", title: "移动端任务", status: "running", attempt_count: 1, max_attempts: 3, created_at: "", updated_at: "" }] }),
      contentType: "application/json",
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace menu" }).click();
  const workspaceMenu = page.getByRole("dialog", { name: "Workspace menu" });
  await expect(workspaceMenu.getByRole("button", { name: "新对话" })).toBeVisible();
  await expect(workspaceMenu.getByText("最近对话", { exact: true })).toBeVisible();
  await expect(workspaceMenu.getByText("暂无对话", { exact: true })).toBeVisible();
  await workspaceMenu.getByRole("button", { name: "新对话" }).click();
  await expect(workspaceMenu).toBeHidden();

  await page.getByRole("button", { name: "Open workspace menu" }).click();

  await page.getByRole("button", { name: "Image Judge", exact: true }).click();
  await expect(page).toHaveURL(/\/image-judge\/?$/);
  await page.getByRole("button", { name: "Open workspace menu" }).click();
  const imageJudgeMenu = page.getByRole("dialog", { name: "Workspace menu" });
  await expect(imageJudgeMenu.getByText("文件分析示例", { exact: true })).toBeVisible();
  await expect(imageJudgeMenu.getByRole("button", { name: "下载最新版本" })).toBeVisible();
  await expect(imageJudgeMenu.getByText("叶片病斑等级示例", { exact: true })).toBeVisible();

  await page.goto("/task-center");
  await expect(page.getByRole("button", { name: "Open workspace menu" })).toBeVisible();
  await page.getByRole("button", { name: "Open workspace menu" }).click();
  const taskMenu = page.getByRole("dialog", { name: "Workspace menu" });
  await expect(taskMenu.getByText("移动端任务", { exact: true })).toBeVisible();
});
