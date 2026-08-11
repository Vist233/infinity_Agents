import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/lib/i18n";
import ImageJudgePage from "../page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const WINDOWS_DOWNLOAD_URL = "https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-windows-x64.zip";
const MAC_DOWNLOAD_URL = "https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-macos.zip";
const LINUX_DOWNLOAD_URL = "https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-linux-amd64.deb";

function renderPage() {
  window.localStorage.setItem("infinity-agents-language", "zh");
  return render(<LanguageProvider><ImageJudgePage /></LanguageProvider>);
}

describe("ImageJudge example workspace", () => {
  afterEach(() => cleanup());

  it("shows examples and the reference/uploaded image workflow", () => {
    renderPage();
    expect(screen.getByText("文件分析示例")).toBeDefined();
    expect(screen.getAllByText("叶片病斑等级示例").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getAllByRole("button", { name: /叶片病斑等级示例/ })[0]);
    expect(screen.getByText("参考图片")).toBeDefined();
    expect(screen.getByText("上传的图片")).toBeDefined();
    expect(screen.getByText("图片介绍")).toBeDefined();
    expect(screen.getByText("判定类别")).toBeDefined();
  });

  it("switches the active example from the left workspace", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /图像序列检查示例/ }));
    expect(screen.getByRole("heading", { name: "图像序列检查示例" })).toBeDefined();
  });

  it("opens the ImageJudge download panel by default", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "macOS 下载" }).getAttribute("href")).toBe(MAC_DOWNLOAD_URL);
    const winLink = screen.getByRole("link", { name: "Windows 下载" });
    const linuxLink = screen.getByRole("link", { name: "Linux 下载" });
    expect(winLink.getAttribute("href")).toBe(WINDOWS_DOWNLOAD_URL);
    expect(linuxLink.getAttribute("href")).toBe(LINUX_DOWNLOAD_URL);
    expect(screen.getByRole("link", { name: "查看发行说明" }).getAttribute("href")).toBe("https://github.com/Vist233/infinity_Agents/releases/latest");
    expect(screen.queryByText("参考图片")).toBeNull();
  });

  it("runs an explicit local preview demo without presenting a fake judgment", async () => {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: /叶片病斑等级示例/ })[0]);
    const inputs = document.querySelectorAll('input[type="file"]');
    const reference = new File(["reference"], "reference.png", { type: "image/png" });
    const target = new File(["target"], "target.png", { type: "image/png" });

    fireEvent.change(inputs[0], { target: { files: [reference] } });
    fireEvent.change(inputs[1], { target: { files: [target] } });
    expect(screen.getByText("两张图片已准备好，可以运行本地演示。")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "运行本地演示" }));
    expect(screen.getByText("正在验证本地图片输入…")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText(/本地演示完成：已读取两张图片/)).toBeDefined();
    });
    expect(screen.queryByText("上传图片后，这里显示判断结果。")).toBeNull();
  });
});
