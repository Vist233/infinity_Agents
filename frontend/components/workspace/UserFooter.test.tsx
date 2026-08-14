import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n";
import { UserFooter } from "./UserFooter";

vi.mock("@/lib/api/auth", () => ({
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
}));

import { getCurrentUser } from "@/lib/api/auth";

describe("UserFooter", () => {
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

  it("renders the account controls for an authenticated user", async () => {
    render(<LanguageProvider><UserFooter /></LanguageProvider>);

    await waitFor(() => expect(screen.getByText("User One")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  });

  it("renders nothing for a signed-out user", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null);
    const { container } = render(<LanguageProvider><UserFooter /></LanguageProvider>);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("未登录")).not.toBeInTheDocument();
  });
});
