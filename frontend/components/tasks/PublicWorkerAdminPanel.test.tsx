import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n";
import { PublicWorkerAdminPanel } from "./PublicWorkerAdminPanel";

vi.mock("@/lib/api/tasks", () => ({
  createPublicWorker: vi.fn(),
  getPublicWorkerCredential: vi.fn(),
  getPublicWorkerPool: vi.fn(),
  revokePublicWorker: vi.fn(),
  rotatePublicWorkerCredential: vi.fn(),
}));

import {
  createPublicWorker,
  getPublicWorkerPool,
} from "@/lib/api/tasks";

function poolResponse(count: number) {
  return {
    pool: { pool_id: "public-default", kind: "public" as const, namespace: "infinity-public", worker_count: count },
    workers: Array.from({ length: count }, (_, index) => ({
      worker_id: `public-worker-${index + 1}`,
      namespace: "infinity-public",
      trust_level: "owner_trusted" as const,
      status: "active",
      presence: "never_seen" as const,
      credential_expires_at: null,
      last_seen_at: null,
      created_at: null,
      revoked_at: null,
      worker_kind: "public" as const,
      pool_id: "public-default",
    })),
  };
}

describe("PublicWorkerAdminPanel", () => {
  beforeEach(() => {
    window.localStorage.setItem("infinity-agents-language", "zh");
    vi.mocked(getPublicWorkerPool)
      .mockResolvedValueOnce(poolResponse(3))
      .mockResolvedValueOnce(poolResponse(4));
    vi.mocked(createPublicWorker).mockResolvedValue({
      worker_id: "public-worker-4",
      namespace: "infinity-public",
      trust_level: "owner_trusted",
      credential_expires_at: null,
      control_base_url: "https://infinity.zhangyvjing.com",
      worker_credential: "wc_test_4",
      persistent: true,
      one_time: false,
      worker_kind: "public",
      pool_id: "public-default",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the create action available after three existing Workers", async () => {
    const user = userEvent.setup();
    render(<LanguageProvider><PublicWorkerAdminPanel /></LanguageProvider>);

    await waitFor(() => expect(screen.getByText("公共 Worker 3")).toBeInTheDocument());
    const createButton = screen.getByRole("button", { name: "创建" });
    expect(createButton).toBeEnabled();

    await user.click(createButton);

    await waitFor(() => expect(createPublicWorker).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("公共 Worker 4")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "创建" })).toBeEnabled();
  });
});
