import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CodeAgentPage from "../page";

/* ================================================================== */
/*  Mutable mock controller state                                      */
/* ================================================================== */
const mockControllerState = {
  input: "" as string,
  sessionId: null as string | null,
  sessions: [] as any[],
  sessionMessagesMap: {} as Record<string, any[]>,
  sessionRunMap: {} as Record<string, any>,
  uiError: null as string | null,
};

let mockAuthStatus: "checking" | "authenticated" | "unauthenticated" = "authenticated";

const dispatchCalls: any[] = [];
let wsByRequestRef = { current: new Map<string, any>() };

// Shared single instance so all assertions reference the same spies
const controllerInstance = {
  get state() {
    return mockControllerState;
  },
  get authStatus() {
    return mockAuthStatus;
  },
  get sessionId() {
    return mockControllerState.sessionId;
  },
  messages: [] as any[],
  currentRunState: { running: false, phase: null } as any,
  isLoading: false,
  statusText: "",
  scrollRef: { current: null },
  inputRef: { current: null },
  dispatch: vi.fn((action: any) => {
    dispatchCalls.push(action);
    if (action.type === "set_input") {
      mockControllerState.input = action.input;
    }
    if (action.type === "set_session_id") {
      mockControllerState.sessionId = action.sessionId;
    }
    if (action.type === "upsert_session") {
      mockControllerState.sessions = [action.session, ...mockControllerState.sessions];
    }
    if (action.type === "set_session_messages") {
      mockControllerState.sessionMessagesMap[action.sessionId] = action.messages;
    }
  }),
  setInput: vi.fn((input: string) => {
    mockControllerState.input = input;
  }),
  setError: vi.fn(),
  setSessionRunState: vi.fn(),
  appendAssistantContent: vi.fn(),
  setAssistantContent: vi.fn(),
  refreshSessions: vi.fn(),
  handleNewChat: vi.fn(),
  handleStopGeneration: vi.fn(),
  retryLoadSessions: vi.fn(),
  setEditingTitle: vi.fn(),
  dismissError: vi.fn(),
  handleSwitchSession: vi.fn(),
  handleEditSessionTitle: vi.fn(),
  cancelInlineSessionTitle: vi.fn(),
  saveInlineSessionTitle: vi.fn(),
  requestDeleteSession: vi.fn(),
  cancelDeleteSession: vi.fn(),
  confirmDeleteSession: vi.fn(),
  handleUploadPdf: vi.fn(),
  handleExportPdf: vi.fn(),
  get sessionMessagesMapRef() {
    return { current: mockControllerState.sessionMessagesMap };
  },
  get wsByRequestRef() {
    return wsByRequestRef;
  },
  uploadedPapers: [] as any[],
  uploadingPdf: false,
};

/* ================================================================== */
/*  Module-level captured onSubmit from Composer mock                  */
/* ================================================================== */
let capturedComposerOnSubmit: ((event?: React.FormEvent) => void) | null = null;

/* ================================================================== */
/*  WebSocket mock (class so `new WebSocket()` works)                  */
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
  dispatchCalls.length = 0;
  wsByRequestRef = { current: new Map() };
  wsInstances.length = 0;
  mockControllerState.input = "";
  mockControllerState.sessionId = null;
  mockControllerState.sessions = [];
  mockControllerState.sessionMessagesMap = {};
  Object.keys(mockControllerState.sessionRunMap).forEach((key) => {
    delete mockControllerState.sessionRunMap[key];
  });
  mockControllerState.uiError = null;
  mockAuthStatus = "authenticated";
  vi.clearAllMocks();
  capturedComposerOnSubmit = null;
};

/* ================================================================== */
/*  Mocks                                                              */
/* ================================================================== */

// Composer mock — captures onSubmit in outer module-level variable
vi.mock("@/components/chat/Composer", () => {
  const { useState } = require("react");

  const Composer = (props: any) => {
    const [localInput, setLocalInput] = useState(props.input || "");

    // Sync local state when parent prop changes
    useState(() => {
      if (props.input !== undefined && props.input !== localInput) {
        setLocalInput(props.input);
      }
    });

    // Write to outer-scope variable (capturedComposerOnSubmit)
    // eslint-disable-next-line no-global-assign
    capturedComposerOnSubmit = props.onSubmit;

    return (
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
    );
  };

  return { Composer };
});

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
        "error.createSession": "Failed to create session",
        "error.connection": "Connection error",
        "error.network": "Network error",
        "home.newChat": "New Chat",
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

vi.mock("@/components/chat/SessionList", () => ({
  SessionList: () => <div data-testid="session-list">SessionList</div>,
}));

vi.mock("@/components/chat/MessagePane", () => ({
  MessagePane: () => <div data-testid="message-pane">MessagePane</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="plus-icon">+</span>,
  ListTodo: () => <span data-testid="listtodo-icon">LT</span>,
  ArrowLeft: () => <span data-testid="arrowleft-icon">←</span>,
  RefreshCw: () => <span data-testid="refreshcw-icon">↻</span>,
  XCircle: () => <span data-testid="xcircle-icon">X</span>,
  Download: () => <span data-testid="download-icon">↓</span>,
  PlayCircle: () => <span data-testid="playcircle-icon">▶</span>,
  CheckCircle2: () => <span data-testid="checkcircle-icon">✓</span>,
  Clock: () => <span data-testid="clock-icon">🕐</span>,
  AlertTriangle: () => <span data-testid="alert-icon">⚠</span>,
}));

vi.mock("@/hooks/use-chat-controller", () => ({
  useChatController: () => controllerInstance,
}));

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */
const originalWebSocket = globalThis.WebSocket;

const renderPage = async () => {
  const result = render(<CodeAgentPage />);
  // Wait for React to mount the Composer so it captures onSubmit
  await act(async () => {});
  return result;
};

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

describe("CodeAgentPage", () => {
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
    capturedComposerOnSubmit = null;
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
    expect(screen.getByText("CodeAgent")).toBeTruthy();
    expect(screen.getByTestId("composer-form")).toBeTruthy();
    expect(screen.getByTestId("message-pane")).toBeTruthy();
    expect(screen.getByTestId("session-list")).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  2. handleSubmit — empty input does not submit                  */
  /* -------------------------------------------------------------- */
  it("does not submit when input is empty", async () => {
    await renderPage();
    mockControllerState.input = "";

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    expect(dispatchCalls).toHaveLength(0);
    expect(wsInstances).toHaveLength(0);
  });

  /* -------------------------------------------------------------- */
  /*  3. handleSubmit — creates session via POST /api/code/sessions   */
  /* -------------------------------------------------------------- */
  it("creates a session and opens WebSocket for non-empty input", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ session_id: "s1" }),
      } as Response)
    );
    // @ts-ignore
    global.fetch = mockFetch;

    await renderPage();
    mockControllerState.input = "hello world";
    mockControllerState.sessionId = null;

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/code/sessions", {
      method: "POST",
      credentials: "include",
    });

    const types = dispatchCalls.map((a) => a.type);
    expect(types).toContain("set_session_id");
    expect(types).toContain("upsert_session");
    expect(types).toContain("set_session_messages");

    expect(wsInstances).toHaveLength(1);
  });

  it("shows error when session creation fails", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
      } as Response)
    );
    // @ts-ignore
    global.fetch = mockFetch;

    await renderPage();
    mockControllerState.input = "hello";
    mockControllerState.sessionId = null;

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    expect(controllerInstance.setError).toHaveBeenCalledWith("Failed to create session");
    expect(wsInstances).toHaveLength(0);
  });

  it("shows error when session creation throws", async () => {
    const mockFetch = vi.fn(() => Promise.reject(new Error("network down")));
    // @ts-ignore
    global.fetch = mockFetch;

    await renderPage();
    mockControllerState.input = "hello";
    mockControllerState.sessionId = null;

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    expect(controllerInstance.setError).toHaveBeenCalledWith("Failed to create session");
    expect(wsInstances).toHaveLength(0);
  });

  /* -------------------------------------------------------------- */
  /*  4. WebSocket — verify connection params and initial payload    */
  /* -------------------------------------------------------------- */
  it("connects WebSocket to /ws/code and sends correct JSON payload", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ session_id: "s1" }),
      } as Response)
    );
    // @ts-ignore
    global.fetch = mockFetch;

    await renderPage();
    mockControllerState.input = "test message";
    mockControllerState.sessionId = null;

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    expect(wsInstances).toHaveLength(1);
    const ws = wsInstances[0];
    const expectedProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    expect(ws.url).toBe(`${expectedProto}//${window.location.host}/ws/code`);

    await act(async () => {
      ws.onopen?.();
    });

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sentPayload = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(sentPayload.session_id).toBe("s1");
    expect(sentPayload.messages).toEqual([
      { role: "user", content: "test message" },
    ]);
    expect(sentPayload.client_request_id).toBe("test-uuid-1234");
  });

  /* -------------------------------------------------------------- */
  /*  5. Event handling — status                                     */
  /* -------------------------------------------------------------- */
  it("handles status event and updates run state", async () => {
    await renderPage();
    // Pre-populate an existing session + run state so handleSubmit skips fetch
    // and isCurrent() inside onEvent returns true.
    mockControllerState.input = "msg";
    mockControllerState.sessionId = "s1";
    mockControllerState.sessionRunMap["s1"] = { running: true, requestId: "test-uuid-1234" };
    mockControllerState.sessionMessagesMap["s1"] = [];

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "status", phase: "thinking", elapsed_ms: 100, attempt: 1, max_attempts: 2, tool_name: "search", reason: null }) });
    });

    expect(controllerInstance.setSessionRunState).toHaveBeenCalledWith("s1", {
      phase: "thinking",
      elapsedMs: 100,
      attempt: 1,
      maxAttempts: 2,
      toolName: "search",
      reason: null,
    });
  });

  /* -------------------------------------------------------------- */
  /*  6. Event handling — chunk                                      */
  /* -------------------------------------------------------------- */
  it("handles chunk event and appends assistant content", async () => {
    await renderPage();
    mockControllerState.input = "msg";
    mockControllerState.sessionId = "s1";
    mockControllerState.sessionRunMap["s1"] = { running: true, requestId: "test-uuid-1234" };
    mockControllerState.sessionMessagesMap["s1"] = [];

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "chunk", content: "Hello " }) });
    });

    expect(controllerInstance.appendAssistantContent).toHaveBeenCalledWith("s1", "Hello ");
  });

  /* -------------------------------------------------------------- */
  /*  7. Event handling — tool_call                                  */
  /* -------------------------------------------------------------- */
  it("handles tool_call event and updates run state with tool info", async () => {
    await renderPage();
    mockControllerState.input = "msg";
    mockControllerState.sessionId = "s1";
    mockControllerState.sessionRunMap["s1"] = { running: true, requestId: "test-uuid-1234" };
    mockControllerState.sessionMessagesMap["s1"] = [];

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "tool_call", tool_name: "bash" }) });
    });

    const toolCallArg = controllerInstance.setSessionRunState.mock.calls.find(
      (call: any) => typeof call[1] === "function"
    );
    expect(toolCallArg).toBeTruthy();

    const prev = { running: true, phase: "thinking", activeTools: [] as string[] };
    const next = toolCallArg![1](prev);
    expect(next.hasReceivedToolCall).toBe(true);
    expect(next.toolName).toBe("bash");
    expect(next.activeTools).toEqual(["bash"]);
  });

  /* -------------------------------------------------------------- */
  /*  8. Event handling — done                                       */
  /* -------------------------------------------------------------- */
  it("handles done event, finalizes run state, refreshes sessions, and closes WebSocket", async () => {
    await renderPage();
    mockControllerState.input = "msg";
    mockControllerState.sessionId = "s1";
    mockControllerState.sessionRunMap["s1"] = { running: true, requestId: "test-uuid-1234" };
    mockControllerState.sessionMessagesMap["s1"] = [];

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "done" }) });
    });

    expect(controllerInstance.setSessionRunState).toHaveBeenCalledWith("s1", {
      running: false,
      phase: null,
      requestId: null,
      terminal: "success",
    });
    expect(controllerInstance.refreshSessions).toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1000, "completed");
  });

  /* -------------------------------------------------------------- */
  /*  9. Event handling — error                                      */
  /* -------------------------------------------------------------- */
  it("handles error event, appends error content, and finalizes", async () => {
    await renderPage();
    mockControllerState.input = "msg";
    mockControllerState.sessionId = "s1";
    mockControllerState.sessionRunMap["s1"] = { running: true, requestId: "test-uuid-1234" };
    mockControllerState.sessionMessagesMap["s1"] = [];

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "error", message: "boom" }) });
    });

    expect(controllerInstance.appendAssistantContent).toHaveBeenCalledWith(
      "s1",
      "\n\n[Error] boom"
    );
    expect(controllerInstance.setSessionRunState).toHaveBeenCalledWith("s1", {
      running: false,
      phase: null,
      requestId: null,
      terminal: "error",
    });
    expect(ws.close).toHaveBeenCalledWith(1000, "completed");
  });

  /* -------------------------------------------------------------- */
  /*  10. WebSocket onerror                                          */
  /* -------------------------------------------------------------- */
  it("handles WebSocket onerror and appends network error", async () => {
    await renderPage();
    mockControllerState.input = "msg";
    mockControllerState.sessionId = "s1";
    mockControllerState.sessionRunMap["s1"] = { running: true, requestId: "test-uuid-1234" };
    mockControllerState.sessionMessagesMap["s1"] = [];

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    await act(async () => {
      ws.onerror?.();
    });

    expect(controllerInstance.appendAssistantContent).toHaveBeenCalledWith(
      "s1",
      "\n\n[Error] Network error"
    );
    expect(controllerInstance.setSessionRunState).toHaveBeenCalledWith("s1", {
      running: false,
      phase: null,
      requestId: null,
      terminal: "error",
    });
  });

  /* -------------------------------------------------------------- */
  /*  11. WebSocket onclose while still running → finalize error     */
  /* -------------------------------------------------------------- */
  it("finalizes with error when WebSocket closes while still running", async () => {
    await renderPage();
    mockControllerState.input = "msg";
    mockControllerState.sessionId = "s1";
    mockControllerState.sessionRunMap["s1"] = { running: true, requestId: "test-uuid-1234" };
    mockControllerState.sessionMessagesMap["s1"] = [];

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    await act(async () => {
      ws.onclose?.();
    });

    expect(controllerInstance.setSessionRunState).toHaveBeenCalledWith("s1", {
      running: false,
      phase: null,
      requestId: null,
      terminal: "error",
    });
  });

  /* -------------------------------------------------------------- */
  /*  12. Unauthenticated redirect                                   */
  /* -------------------------------------------------------------- */
  it("redirects to login when unauthenticated", async () => {
    mockAuthStatus = "unauthenticated";
    const originalLocation = window.location;
    const assignSpy = vi.fn();
    delete (window as any).location;
    (window as any).location = { ...originalLocation, assign: assignSpy };

    await renderPage();
    mockControllerState.input = "hello";

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    expect(assignSpy).toHaveBeenCalledWith("/auth/login");

    (window as any).location = originalLocation;
    mockAuthStatus = "authenticated";
  });

  /* -------------------------------------------------------------- */
  /*  13. Cleanup — WebSocket closed on unmount                      */
  /* -------------------------------------------------------------- */
  it("closes WebSocket handles on unmount", async () => {
    const { unmount } = await renderPage();
    mockControllerState.input = "msg";
    mockControllerState.sessionId = null;

    await act(async () => {
      capturedComposerOnSubmit?.();
    });

    const ws = wsInstances[0];
    await act(async () => {
      ws.onopen?.();
    });

    expect(wsByRequestRef.current.size).toBe(1);
    const handle = Array.from(wsByRequestRef.current.values())[0] as any;
    expect(handle.close).toBeDefined();

    // Simulate what the real controller's useEffect cleanup would do:
    // isSocketOpen checks getReadyState() === 1
    ws.readyState = 1;
    handle.close(1000, "component_unmount");

    // The handle's close() forwards to ws.close(1000, "client_stop")
    expect(ws.close).toHaveBeenCalledWith(1000, "client_stop");
  });

  /* -------------------------------------------------------------- */
  /*  14. User event flow — type then submit via form                */
  /* -------------------------------------------------------------- */
  it("submits message when user types and submits via form", async () => {
    const user = userEvent.setup();
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ session_id: "s1" }),
      } as Response)
    );
    // @ts-ignore
    global.fetch = mockFetch;

    await renderPage();
    mockControllerState.input = "";
    mockControllerState.sessionId = null;

    const input = screen.getByTestId("composer-input");
    const form = screen.getByTestId("composer-form");

    await user.type(input, "hello from test");

    expect(mockControllerState.input).toBe("hello from test");

    await user.click(form.querySelector("button[type='submit']")!);

    expect(mockFetch).toHaveBeenCalled();
    expect(wsInstances.length).toBeGreaterThanOrEqual(1);
  });
});
