import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LanguageProvider } from "@/lib/i18n";
import ImageJudgePage from "../page";

// useRouter is not under test here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const WINDOWS_DOWNLOAD_URL =
  "https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-windows-x64.zip";
const LINUX_DOWNLOAD_URL =
  "https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-linux-amd64.deb";

function renderPage(userAgent?: string) {
  if (userAgent) {
    Object.defineProperty(window.navigator, "userAgent", {
      value: userAgent,
      configurable: true,
    });
  }
  return render(
    <LanguageProvider>
      <ImageJudgePage />
    </LanguageProvider>,
  );
}

describe("ImageJudge download page", () => {
  const originalUserAgent = window.navigator.userAgent;

  afterEach(() => {
    cleanup();
    Object.defineProperty(window.navigator, "userAgent", {
      value: originalUserAgent,
      configurable: true,
    });
  });

  it("offers one-click direct downloads for both platforms", () => {
    renderPage(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    );

    const winLink = screen.getByRole("link", { name: "Windows 下载" });
    const linuxLink = screen.getByRole("link", { name: "Linux 下载" });

    // Direct download links: point at the release asset itself (no GitHub UI page).
    expect(winLink.getAttribute("href")).toBe(WINDOWS_DOWNLOAD_URL);
    expect(linuxLink.getAttribute("href")).toBe(LINUX_DOWNLOAD_URL);
    // No target=_blank: clicking starts the download instead of navigating away.
    expect(winLink.getAttribute("target")).toBeNull();
    expect(linuxLink.getAttribute("target")).toBeNull();
  });

  it("shows install hints under each download card", () => {
    renderPage(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    );

    expect(
      screen.getByText(/双击 ImageJudge\.exe 即可运行/),
    ).toBeDefined();
    expect(
      screen.getByText(/sudo dpkg -i ImageJudge-linux-amd64\.deb/),
    ).toBeDefined();
  });

  it("marks the Windows card as recommended on Windows", () => {
    renderPage(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );

    expect(screen.getByText("推荐")).toBeDefined();
    // The recommended badge belongs to the Windows card.
    const winLink = screen.getByRole("link", { name: "Windows 下载" });
    expect(winLink.closest("div")?.textContent).toContain("推荐");
  });

  it("marks the Linux card as recommended and leads with it on Linux", () => {
    renderPage("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36");

    expect(screen.getByText("推荐")).toBeDefined();
    const linuxLink = screen.getByRole("link", { name: "Linux 下载" });
    expect(linuxLink.closest("div")?.textContent).toContain("推荐");

    // Linux card should be rendered first for Linux visitors.
    const links = screen.getAllByRole("link").map((el) => el.getAttribute("href"));
    expect(links.indexOf(LINUX_DOWNLOAD_URL)).toBeLessThan(
      links.indexOf(WINDOWS_DOWNLOAD_URL),
    );
  });

  it("keeps the release notes link pointing at the GitHub release page", () => {
    renderPage(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    );

    const releaseLinks = screen.getAllByRole("link", { name: "查看发行说明" });
    for (const link of releaseLinks) {
      expect(link.getAttribute("href")).toBe(
        "https://github.com/Vist233/infinity_Agents/releases/latest",
      );
    }
  });
});
