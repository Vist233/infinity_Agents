import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, cleanup, within } from "@testing-library/react";
import { LanguageProvider } from "@/lib/i18n";
import ImageJudgePage from "../page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api/auth", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "tester@example.com", name: "Tester" }),
  logout: vi.fn(),
}));

function renderPage() {
  return render(
    <LanguageProvider>
      <ImageJudgePage />
    </LanguageProvider>,
  );
}

describe("ImageJudge file-analysis workspace", () => {
  afterEach(() => cleanup());

  it("replaces the Analysis list with clickable examples and shows the run instance", async () => {
    await act(async () => { renderPage(); });

    expect(screen.getByTestId("image-example-list")).toBeDefined();
    expect(screen.getByTestId("image-example-leaf-spots")).toBeDefined();
    expect(screen.getByTestId("image-example-sequence")).toBeDefined();
    expect(screen.getByTestId("reference-images-section")).toBeDefined();
    expect(screen.getByTestId("uploaded-images-section")).toBeDefined();
    expect(screen.getByAltText("参考叶片")).toBeDefined();
    expect(screen.getByAltText("上传叶片一")).toBeDefined();
    expect(screen.getByText("PASS")).toBeDefined();
    expect(screen.getByText("REVIEW")).toBeDefined();
  });

  it("switches the right-side run instance when an example tab is selected", async () => {
    await act(async () => { renderPage(); });

    await act(async () => { fireEvent.click(screen.getByTestId("image-example-sequence")); });

    expect(screen.getByRole("heading", { name: "图像序列检查示例" })).toBeDefined();
    expect(screen.getByAltText("序列参考图")).toBeDefined();
    expect(screen.getByAltText("上传序列一")).toBeDefined();
  });

  it("does not render the removed release-download controls", async () => {
    await act(async () => { renderPage(); });

    expect(screen.queryByRole("link", { name: /下载/ })).toBeNull();
    expect(screen.queryByText(/下载最新版本|发行说明|导出 PDF/)).toBeNull();
  });

  it("opens the same example list from the mobile workspace menu", async () => {
    await act(async () => { renderPage(); });

    await act(async () => { fireEvent.click(screen.getByTestId("mobile-workspace-menu")); });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("image-example-list")).toBeDefined();
    expect(within(dialog).getByTestId("image-example-sequence")).toBeDefined();
  });
});
