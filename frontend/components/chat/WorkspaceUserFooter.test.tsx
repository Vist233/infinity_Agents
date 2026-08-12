import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n";
import { WorkspaceUserFooter } from "./WorkspaceUserFooter";

vi.mock("@/lib/api/auth", () => ({
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
}));

import { getCurrentUser } from "@/lib/api/auth";

describe("WorkspaceUserFooter", () => {
  beforeEach(() => {
    window.localStorage.setItem("infinity-agents-language", "zh");
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      name: "User One",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the authenticated account instead of the signed-out state", async () => {
    render(<LanguageProvider><WorkspaceUserFooter /></LanguageProvider>);

    await waitFor(() => expect(screen.getByText("User One")).toBeInTheDocument());
    expect(screen.queryByText("未登录")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  });

  it("renders nothing for an unauthenticated account", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null);

    render(<LanguageProvider><WorkspaceUserFooter /></LanguageProvider>);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("未登录")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });
});
