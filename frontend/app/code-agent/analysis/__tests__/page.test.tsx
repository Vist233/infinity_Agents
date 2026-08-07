import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AnalysisPage from "../page";

/* ================================================================== */
/*  WebSocket mock                                                     */
/* ================================================================== */
const wsInstances: Array<{
  url: string;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null;
  onmessage: ((evt: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}> = [];

class MockWebSocket {
  url: string;
  readyState = 0;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.send = vi.fn();
    this.close = vi.fn();
    wsInstances.push(this);
  }
}

/* ================================================================== */
/*  Reset helpers                                                      */
/* ================================================================== */
const resetAll = () => {
  wsInstances.length = 0;
  vi.clearAllMocks();
};

/* ================================================================== */
/*  Mocks                                                              */
/* ================================================================== */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/i18n", () => ({
  useLanguage: () => ({
    language: "zh",
    t: (key: string, ..._args: any[]) => {
      const map: Record<string, string> = {
        "error.network": "Network connection failed",
        "error.createSession": "Failed to create a session. Try again.",
        "error.connection": "Connection error",
        "analysis.noOutput": "No output yet. Send a research goal to start.",
      };
      return map[key] || key;
    },
  }),
  LanguageToggle: () => <div data-testid="language-toggle">LanguageToggle</div>,
}));

vi.mock("@/components/chat/AgentNav", () => ({
  AgentNav: ({ onNavigate }: any) => (
    <div data-testid="agent-nav" onClick={() => onNavigate?.("/chat")}>AgentNav</div>
  ),
}));

vi.mock("@/components/chat/Composer", () => {
  const { useState } = require("react");

  const Composer = (props: any) => {
    const [localInput, setLocalInput] = useState(props.input || "");

    useState(() => {
      if (props.input !== undefined && props.input !== localInput) {
        setLocalInput(props.input);
      }
    });

    return (
      <div>
        {props.inlineError && (
          <div data-testid="composer-error" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {props.inlineError}
          </div>
        )}
        <form
          data-testid="composer-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmit?.(e);
          }}
        >
          <input
            data-testid="composer-input"
            value={localInput}
            onChange={(e) => {
              const val = e.target.value;
              setLocalInput(val);
              props.onInputChange?.(val);
            }}
          />
          <button type="submit">Send</button>
          <button
            type="button"
            onClick={props.onStop}
            data-testid="composer-stop"
          >
            Stop
          </button>
        </form>
      </div>
    );
  };

  return { Composer };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...props }: any) => (
    <div data-testid="scroll-area" {...props}>{children}</div>
  ),
}));

vi.mock("lucide-react", () => ({
  ArrowLeft: () => <span data-testid="arrowleft-icon">←</span>,
  FileJson: () => <span data-testid="filejson-icon">FJ</span>,
  Upload: () => <span data-testid="upload-icon">↑</span>,
  SendHorizontal: () => <span data-testid="send-icon">→</span>,
  CheckCircle2: () => <span data-testid="checkcircle-icon">✓</span>,
  XCircle: () => <span data-testid="xcircle-icon">X</span>,
}));

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */
const originalWebSocket = globalThis.WebSocket;

const renderPage = async () => {
  const result = render(<AnalysisPage />);
  await act(async () => {});
  return result;
};

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

describe("AnalysisPage", () => {
  beforeEach(() => {
    resetAll();
    // @ts-ignore
    globalThis.WebSocket = MockWebSocket;
    // @ts-ignore
    window.WebSocket = MockWebSocket;
    if (!globalThis.crypto) {
      // @ts-ignore
      globalThis.crypto = {} as any;
    }
    // @ts-ignore
    globalThis.crypto.randomUUID = vi.fn(() => "test-uuid-1234");
  });

  afterEach(() => {
    cleanup();
    // @ts-ignore
    globalThis.WebSocket = originalWebSocket as any;
    // @ts-ignore
    window.WebSocket = originalWebSocket as any;
    vi.restoreAllMocks();
  });

  /* -------------------------------------------------------------- */
  /*  1. Component renders without crashing                           */
  /* -------------------------------------------------------------- */
  it("renders without crashing", async () => {
    await renderPage();
    expect(document.body).toBeTruthy();
  });

  it("renders main structural elements", async () => {
    await renderPage();
    expect(screen.getAllByText("Analysis Agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("composer-form")).toBeTruthy();
    expect(screen.getByTestId("agent-nav")).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  2. Empty input does not submit                                 */
  /* -------------------------------------------------------------- */
  it("does not submit when input is empty", async () => {
    await renderPage();
    const form = screen.getByTestId("composer-form");

    await userEvent.click(form.querySelector("button[type='submit']")!);

    expect(wsInstances).toHaveLength(0);
  });

  /* -------------------------------------------------------------- */
  /*  3. Submits research goal and connects WebSocket                */
  /* -------------------------------------------------------------- */
  it("connects WebSocket to /ws/analysis and sends payload", async () => {
    await renderPage();
    const input = screen.getByTestId("composer-input");

    await userEvent.type(input, "case2 biopython");

    const form = screen.getByTestId("composer-form");
    await userEvent.click(form.querySelector("button[type='submit']")!);

    expect(wsInstances).toHaveLength(1);
    const ws = wsInstances[0];
    const expectedProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    expect(ws.url).toBe(`${expectedProto}//${window.location.host}/ws/analysis`);

    await act(async () => {
      ws.onopen?.();
    });

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sentPayload = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(sentPayload.session_id).toBeTruthy();
    expect(sentPayload.messages).toEqual([
      { role: "user", content: "case2 biopython" },
    ]);
  });

  /* -------------------------------------------------------------- */
  /*  4. Handles status and chunk events                             */
  /* -------------------------------------------------------------- */
  it("handles status and chunk events from Analysis Agent", async () => {
    await renderPage();
    const input = screen.getByTestId("composer-input");

    await userEvent.type(input, "case2 biopython");
    const form = screen.getByTestId("composer-form");
    await userEvent.click(form.querySelector("button[type='submit']")!);

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "status", phase: "thinking", elapsed_ms: 100, attempt: 1, max_attempts: 1, tool_name: "analysis_agent" }) });
    });

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "chunk", content: "Hello\n" }) });
    });

    expect(screen.getByText("Hello")).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  5. Handles task_spec_draft event                               */
  /* -------------------------------------------------------------- */
  it("handles task_spec_draft event and renders JSON", async () => {
    await renderPage();
    const input = screen.getByTestId("composer-input");

    await userEvent.type(input, "case3 scanpy single cell");
    const form = screen.getByTestId("composer-form");
    await userEvent.click(form.querySelector("button[type='submit']")!);

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    const taskSpec = {
      schema_version: "1.0",
      domain: "bioinformatics",
      analysis_type: "scanpy",
      research_question: "Single cell analysis",
      spec_json: { deliverables: [] },
    };

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "task_spec_draft", task_spec: taskSpec, validation_errors: [] }) });
    });

    expect(screen.getByText(/"schema_version"/)).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  6. Dataset file input updates state                            */
  /* -------------------------------------------------------------- */
  it("dataset file input records selected file", async () => {
    await renderPage();
    const file = new File(["a,b,c\n1,2,3"], "data.csv", { type: "text/csv" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, file);

    expect(screen.getByText(/data\.csv/)).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  7. Create Task button is disabled without draft or file        */
  /* -------------------------------------------------------------- */
  it("disables Create Task button when no draft or dataset is selected", async () => {
    await renderPage();
    const createButton = screen.getByRole("button", { name: /Create Task/i });
    expect(createButton.hasAttribute("disabled")).toBe(true);
  });

  /* -------------------------------------------------------------- */
  /*  8. WebSocket error shows network error                         */
  /* -------------------------------------------------------------- */
  it("shows network error when WebSocket errors", async () => {
    await renderPage();
    const input = screen.getByTestId("composer-input");

    await userEvent.type(input, "case1");
    const form = screen.getByTestId("composer-form");
    await userEvent.click(form.querySelector("button[type='submit']")!);

    const ws = wsInstances[0];
    await act(async () => {
      ws.onerror?.();
    });

    expect(screen.getByTestId("composer-error")).toHaveTextContent("Network connection failed");
  });

  /* -------------------------------------------------------------- */
  /*  9. Stops generation via Composer stop button                   */
  /* -------------------------------------------------------------- */
  it("stops generation when stop is clicked", async () => {
    await renderPage();
    const input = screen.getByTestId("composer-input");

    await userEvent.type(input, "case1");
    const form = screen.getByTestId("composer-form");
    await userEvent.click(form.querySelector("button[type='submit']")!);

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    expect(ws.close).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByTestId("composer-stop").click();
    });

    expect(ws.close).toHaveBeenCalledWith(1000, "client_stop");
  });
});
