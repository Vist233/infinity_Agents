import { expect, test } from "@playwright/test";

test("smoke routes render", async ({ page }) => {
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, body: "[]", contentType: "application/json" });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ settings: { locale: "zh" } }),
      contentType: "application/json",
    });
  });

  await page.route("**/api/tasks*", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ tasks: [] }), contentType: "application/json" });
  });

  await page.goto("/");
  await expect(page.getByText("今天想让我帮你做什么？")).toBeVisible();

  await page.goto("/code-agent");
  await expect(page.getByTestId("task-creation-card")).toBeVisible();
  await expect(page.getByTestId("worker-enrollment-panel")).toBeVisible();
  await expect(page.getByTestId("new-task-button")).toBeVisible();
  await expect(page.getByTestId("worker-enrollment-namespace")).toHaveCount(0);

  await page.goto("/image-judge");
  await expect(page.getByRole("heading", { name: "叶片病斑等级示例" })).toBeVisible();
  await expect(page.getByTestId("reference-images-section")).toBeVisible();
  await expect(page.getByTestId("uploaded-images-section")).toBeVisible();
  await expect(page.getByRole("link", { name: /下载|发行说明/ })).toHaveCount(0);
  await page.getByTestId("image-example-sequence").click();
  await expect(page.getByRole("heading", { name: "图像序列检查示例" })).toBeVisible();
});

test("home page shows retry banner when sessions endpoint fails", async ({ page }) => {
  let callCount = 0;
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    callCount += 1;
    if (callCount === 1) {
      await route.fulfill({ status: 500, body: JSON.stringify({ detail: "boom" }), contentType: "application/json" });
      return;
    }
    await route.fulfill({ status: 200, body: "[]", contentType: "application/json" });
  });

  await page.goto("/");
  await expect(page.getByText(/^(加载对话失败：|Failed to load sessions:)/)).toBeVisible();
  await page.getByRole("button", { name: /重试|Retry/ }).click();
  await expect(page.getByText(/^(加载对话失败：|Failed to load sessions:)/)).toHaveCount(0);
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
