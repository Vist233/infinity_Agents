import { expect, test } from "@playwright/test";

test("smoke routes render", async ({ page }) => {
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, body: "[]", contentType: "application/json" });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await expect(page.getByText("How can I help you today?")).toBeVisible();

  await page.goto("/code-agent");
  await expect(page.getByText("CodeAgent 安装教程")).toBeVisible();

  await page.goto("/image-judge");
  await expect(page.getByRole("heading", { name: "ImageJudge" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download latest release" }).first()).toBeVisible();
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
  await expect(page.getByText(/^会话加载失败：/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/^会话加载失败：/)).toHaveCount(0);
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
