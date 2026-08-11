"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  chatReducer,
  DEFAULT_RUN_STATE,
  deriveSessionTitle,
  getMessagesForSession,
  getRunStateForSession,
  INITIAL_CHAT_STATE,
  isDefaultSessionTitle,
  type Message,
  type SessionItem,
  type SessionRunState,
  type TerminalState,
} from "@/lib/chat-state";
import {
  createSession,
  deleteSession,
  listSessionMessages,
  listSessions,
  updateSessionTitle,
} from "@/lib/api/sessions";
import { getApiBase, redirectToLogin } from "@/lib/runtime-config";
import { startChatStream, toFriendlyChatError, type ChatDoneEvent, type ChatEvent, type ChatStreamHandle } from "@/lib/ws/chat-stream";
import { useLanguage } from "@/lib/i18n";

const isSocketOpen = (socket?: ChatStreamHandle | null) => {
  if (!socket) return false;
  return socket.getReadyState() === 1;
};

const toTokenInfo = (payload?: ChatDoneEvent["token_info"]) => ({
  prompt: Number(payload?.prompt) || 0,
  response: Number(payload?.response) || 0,
  total: Number(payload?.total) || 0,
});

const TASK_CONFIRMATION_TOOLS = new Set([
  "create_task",
  "create_analysis_task",
  "request_task_confirmation",
  "submit_task_bundle",
]);

export function useChatController() {
  const { language, t } = useLanguage();
  const apiBase = useMemo(() => getApiBase(), []);
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT_STATE);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsByRequestRef = useRef<Map<string, ChatStreamHandle>>(new Map());
  const runningRequestBySessionRef = useRef<Map<string, string>>(new Map());
  const loadedSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionMessagesMapRef = useRef<Record<string, Message[]>>({});
  const sessionLoadPromiseRef = useRef<Map<string, Promise<Message[]>>>(new Map());
  const sessionsRef = useRef<SessionItem[]>([]);
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [taskConfirmationRequested, setTaskConfirmationRequested] = useState(false);

  const sessionId = state.sessionId;
  const messages = useMemo(() => getMessagesForSession(state, sessionId), [state, sessionId]);
  const currentRunState = useMemo(() => getRunStateForSession(state, sessionId), [state, sessionId]);
  const isLoading = currentRunState.running;

  useEffect(() => {
    sessionMessagesMapRef.current = state.sessionMessagesMap;
  }, [state.sessionMessagesMap]);

  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    if (scrollRef.current) {
      const scrollContainer = scrollRef.current.querySelector("[data-radix-scroll-area-viewport]");
      if (scrollContainer) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
      }
    }
  }, [messages]);

  useEffect(() => {
    const wsByRequest = wsByRequestRef.current;
    const runningRequestBySession = runningRequestBySessionRef.current;
    const sessionLoadPromises = sessionLoadPromiseRef.current;
    return () => {
      wsByRequest.forEach((ws) => {
        if (isSocketOpen(ws)) {
          ws.close(1000, "component_unmount");
        }
      });
      wsByRequest.clear();
      runningRequestBySession.clear();
      sessionLoadPromises.clear();
    };
  }, []);

  const setError = useCallback((error: string | null) => {
    dispatch({ type: "set_error", error });
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await listSessions(apiBase);
      dispatch({ type: "set_sessions", sessions: data });
      dispatch({ type: "set_error", error: null });
      setAuthStatus("authenticated");
      return data;
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        dispatch({ type: "set_sessions", sessions: [] });
        dispatch({ type: "set_error", error: null });
        setAuthStatus("unauthenticated");
        return null;
      }
      const message = error instanceof Error ? error.message : t("error.backendUnavailable");
      dispatch({ type: "set_error", error: t("error.loadSessions", { message }) });
      dispatch({ type: "set_sessions", sessions: [] });
      toast.error(t("error.loadSessionsToast"));
      return null;
    }
  }, [apiBase, t]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const ensureSessionMessagesLoaded = useCallback(async (targetSessionId: string): Promise<Message[]> => {
    if (loadedSessionIdsRef.current.has(targetSessionId)) {
      return sessionMessagesMapRef.current[targetSessionId] || [];
    }

    const inFlight = sessionLoadPromiseRef.current.get(targetSessionId);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const mapped = await listSessionMessages(apiBase, targetSessionId);
      let merged = mapped;
      dispatch({
        type: "update_session_messages",
        sessionId: targetSessionId,
        updater: (existing) => {
          const shouldKeepExisting = runningRequestBySessionRef.current.has(targetSessionId) && existing.length > 0;
          if (shouldKeepExisting) {
            merged = existing;
            return existing;
          }
          merged = mapped;
          return mapped;
        },
      });
      loadedSessionIdsRef.current.add(targetSessionId);
      return merged;
    })();

    sessionLoadPromiseRef.current.set(targetSessionId, promise);
    try {
      return await promise;
    } finally {
      sessionLoadPromiseRef.current.delete(targetSessionId);
    }
  }, [apiBase]);

  useEffect(() => {
    if (!sessionId) return;
    dispatch({
      type: "update_session_run_state",
      sessionId,
      updater: (prev) => ({ ...prev, unreadDone: false }),
    });
    void ensureSessionMessagesLoaded(sessionId).catch((error) => {
      console.error("Failed to load messages", error);
      const message = error instanceof Error ? error.message : t("error.network");
      setError(t("error.loadMessages", { message }));
      toast.error(t("error.loadMessagesToast"));
    });
  }, [sessionId, ensureSessionMessagesLoaded, setError, t]);

  const refreshSessions = useCallback(async () => {
    try {
      const data = await listSessions(apiBase);
      dispatch({ type: "set_sessions", sessions: data });
      return data;
    } catch (error) {
      console.error("Failed to refresh sessions", error);
      return null;
    }
  }, [apiBase]);

  const setSessionRunState = useCallback(
    (targetSessionId: string, updater: Partial<SessionRunState> | ((prev: SessionRunState) => SessionRunState)) => {
      if (typeof updater === "function") {
        dispatch({ type: "update_session_run_state", sessionId: targetSessionId, updater });
        return;
      }
      dispatch({ type: "patch_session_run_state", sessionId: targetSessionId, patch: updater });
    },
    [],
  );

  const setAssistantContent = useCallback((targetSessionId: string, content: string) => {
    dispatch({
      type: "update_session_messages",
      sessionId: targetSessionId,
      updater: (current) => {
        const next = [...current];
        if (next.length === 0 || next[next.length - 1].role !== "assistant") {
          next.push({ role: "assistant", content });
        } else {
          next[next.length - 1] = { ...next[next.length - 1], content };
        }
        return next;
      },
    });
  }, []);

  const appendAssistantContent = useCallback((targetSessionId: string, suffix: string) => {
    dispatch({
      type: "update_session_messages",
      sessionId: targetSessionId,
      updater: (current) => {
        const next = [...current];
        if (next.length === 0 || next[next.length - 1].role !== "assistant") {
          next.push({ role: "assistant", content: suffix });
        } else {
          const original = next[next.length - 1].content || "";
          next[next.length - 1] = { ...next[next.length - 1], content: `${original}${suffix}` };
        }
        return next;
      },
    });
  }, []);

  const createSessionIfNeeded = useCallback(async () => {
    if (state.sessionId) return state.sessionId;
    try {
      const data = await createSession(apiBase);
      const createdSessionId = typeof data.session_id === "string" ? data.session_id : null;
      if (!createdSessionId) return null;

      dispatch({ type: "set_session_id", sessionId: createdSessionId });
      dispatch({
        type: "upsert_session",
        toTop: true,
        session: {
          session_id: createdSessionId,
          title: language === "zh" ? "新对话" : "New chat",
          created_at: "",
          updated_at: "",
        },
      });
      dispatch({ type: "set_session_messages", sessionId: createdSessionId, messages: [] });
      dispatch({ type: "set_session_run_state", sessionId: createdSessionId, runState: DEFAULT_RUN_STATE });
      loadedSessionIdsRef.current.add(createdSessionId);
      return createdSessionId;
    } catch (error) {
      console.error("Failed to create session", error);
      return null;
    }
  }, [apiBase, language, state.sessionId]);

  const maybeRenameSessionFromFirstInput = useCallback(
    async (firstInput: string, targetSessionId?: string | null) => {
      const targetId = targetSessionId ?? state.sessionId;
      if (!targetId) return;
      const nextTitle = deriveSessionTitle(firstInput);
      dispatch({
        type: "set_sessions",
        sessions: sessionsRef.current.map((session) =>
          session.session_id === targetId ? { ...session, title: nextTitle } : session,
        ),
      });

      const current = sessionsRef.current.find((session) => session.session_id === targetId);
      const shouldSkip = current && !isDefaultSessionTitle(current.title);
      if (shouldSkip) return;

      try {
        await updateSessionTitle(apiBase, targetId, nextTitle);
        dispatch({
          type: "set_sessions",
          sessions: sessionsRef.current.map((session) =>
            session.session_id === targetId ? { ...session, title: nextTitle } : session,
          ),
        });
      } catch (error) {
        console.error("Failed to auto-rename session", error);
      }
    },
    [apiBase, state.sessionId],
  );

  const handleNewChat = useCallback(() => {
    setTaskConfirmationRequested(false);
    dispatch({ type: "reset_new_chat" });
  }, []);

  const handleSwitchSession = useCallback(
    (id: string) => {
      if (state.editingSessionId) return;
      setTaskConfirmationRequested(false);
      setSessionRunState(id, { unreadDone: false });
      dispatch({ type: "set_session_id", sessionId: id });
      dispatch({ type: "set_deleting_session", sessionId: null });
    },
    [setSessionRunState, state.editingSessionId],
  );

  const handleEditSessionTitle = useCallback((session: SessionItem) => {
    dispatch({ type: "set_editing_session", sessionId: session.session_id, title: session.title || t("session.untitled") });
  }, [t]);

  const cancelInlineSessionTitle = useCallback(() => {
    dispatch({ type: "set_editing_session", sessionId: null, title: "" });
  }, []);

  const saveInlineSessionTitle = useCallback(
    async (targetSessionId: string) => {
      const trimmed = state.editingTitle.trim();
      const current = sessionsRef.current.find((session) => session.session_id === targetSessionId);
      if (!trimmed || trimmed === (current?.title || "")) {
        dispatch({ type: "set_editing_session", sessionId: null, title: "" });
        return;
      }
      try {
        await updateSessionTitle(apiBase, targetSessionId, trimmed);
        dispatch({
          type: "set_sessions",
          sessions: sessionsRef.current.map((session) =>
            session.session_id === targetSessionId ? { ...session, title: trimmed } : session,
          ),
        });
        dispatch({ type: "set_editing_session", sessionId: null, title: "" });
        await refreshSessions();
      } catch (error) {
        console.error("Failed to update session title", error);
        toast.error(t("error.updateTitle"));
      }
    },
    [apiBase, refreshSessions, state.editingTitle, t],
  );

  const requestDeleteSession = useCallback(
    (session: SessionItem) => {
      const runState = state.sessionRunMap[session.session_id] || DEFAULT_RUN_STATE;
      if (runState.running) {
        toast.info(t("error.runningDelete"));
        return;
      }
      dispatch({ type: "set_deleting_session", sessionId: session.session_id });
    },
    [state.sessionRunMap, t],
  );

  const cancelDeleteSession = useCallback(() => {
    dispatch({ type: "set_deleting_session", sessionId: null });
  }, []);

  const confirmDeleteSession = useCallback(
    async (session: SessionItem) => {
      try {
        await deleteSession(apiBase, session.session_id);
        await refreshSessions();
        loadedSessionIdsRef.current.delete(session.session_id);
        sessionLoadPromiseRef.current.delete(session.session_id);
        dispatch({ type: "remove_session", sessionId: session.session_id });
        dispatch({ type: "set_deleting_session", sessionId: null });
      } catch (error) {
        console.error("Failed to delete session", error);
        toast.error(t("error.deleteSession"));
      }
    },
    [apiBase, refreshSessions, t],
  );

  const handleSubmit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const value = state.input.trim();
      if (!value) return;

      if (authStatus === "unauthenticated") {
        redirectToLogin();
        return;
      }

      let targetSessionId = state.sessionId;
      if (!targetSessionId) {
        targetSessionId = await createSessionIfNeeded();
        if (!targetSessionId) {
          setError(t("error.createSession"));
          toast.error(t("error.createSession"));
          return;
        }
      }

      const runningRequest = runningRequestBySessionRef.current.get(targetSessionId);
      if (runningRequest) {
        toast.info(t("error.runningWait"));
        return;
      }

      if (!loadedSessionIdsRef.current.has(targetSessionId)) {
        try {
          await ensureSessionMessagesLoaded(targetSessionId);
        } catch (error) {
          console.error("Failed to load conversation history before send", error);
          setError(t("error.loadHistory"));
          toast.error(t("error.loadHistory"));
          return;
        }
      }

      const userMessage: Message = { role: "user", content: value };
      setTaskConfirmationRequested(false);
      const baseMessages = sessionMessagesMapRef.current[targetSessionId] || [];
      const messagesForRequest = [...baseMessages, userMessage];
      dispatch({
        type: "set_session_messages",
        sessionId: targetSessionId,
        messages: [...baseMessages, userMessage, { role: "assistant", content: "" }],
      });
      loadedSessionIdsRef.current.add(targetSessionId);
      dispatch({ type: "set_input", input: "" });

      const clientRequestId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      runningRequestBySessionRef.current.set(targetSessionId, clientRequestId);
      setSessionRunState(targetSessionId, {
        running: true,
        phase: "thinking",
        toolName: null,
        unreadDone: false,
        terminal: null,
        requestId: clientRequestId,
        elapsedMs: 0,
        attempt: 1,
        maxAttempts: 2,
        reason: null,
        hasReceivedChunk: false,
        hasReceivedToolCall: false,
        activeTools: [],
        tokenInfo: null,
      });

      if (baseMessages.length === 0) {
        void maybeRenameSessionFromFirstInput(userMessage.content, targetSessionId);
      }

      let accumulatedResponse = "";
      let completed = false;
      const isCurrentRequest = () => runningRequestBySessionRef.current.get(targetSessionId!) === clientRequestId;
      const finalize = (terminal: TerminalState, tokenInfo?: { prompt: number; response: number; total: number } | null) => {
        if (completed) return;
        completed = true;
        if (isCurrentRequest()) {
          runningRequestBySessionRef.current.delete(targetSessionId!);
        }
        wsByRequestRef.current.delete(clientRequestId);
        setSessionRunState(targetSessionId!, (prev) => ({
          ...prev,
          running: false,
          phase: null,
          toolName: null,
          unreadDone: true,
          terminal,
          requestId: null,
          activeTools: [],
          tokenInfo: tokenInfo ?? prev.tokenInfo,
        }));
      };

      const onEvent = (eventPayload: ChatEvent) => {
        if (!isCurrentRequest()) return;
        if (eventPayload.type === "status") {
          setSessionRunState(targetSessionId!, (prev) => ({
            ...prev,
            phase: eventPayload.phase,
            elapsedMs: Number.isFinite(eventPayload.elapsed_ms) && eventPayload.elapsed_ms >= 0
              ? eventPayload.elapsed_ms
              : prev.elapsedMs,
            attempt: Number.isFinite(eventPayload.attempt) && eventPayload.attempt > 0 ? eventPayload.attempt : prev.attempt,
            maxAttempts: Number.isFinite(eventPayload.max_attempts) && eventPayload.max_attempts > 0
              ? eventPayload.max_attempts
              : prev.maxAttempts,
            toolName: eventPayload.tool_name ?? prev.toolName,
            reason: eventPayload.reason ?? prev.reason,
          }));
          return;
        }
        if (eventPayload.type === "chunk") {
          accumulatedResponse += eventPayload.content;
          setAssistantContent(targetSessionId!, accumulatedResponse);
          setSessionRunState(targetSessionId!, { hasReceivedChunk: true });
          return;
        }
        if (eventPayload.type === "tool_call") {
          const toolName = eventPayload.tool_name;
          if (!toolName) return;
          if (TASK_CONFIRMATION_TOOLS.has(toolName)) setTaskConfirmationRequested(true);
          setSessionRunState(targetSessionId!, (prev) => ({
            ...prev,
            hasReceivedToolCall: true,
            toolName,
            activeTools: prev.activeTools.includes(toolName) ? prev.activeTools : [...prev.activeTools, toolName],
          }));
          return;
        }
        if (eventPayload.type === "done") {
          finalize("success", toTokenInfo(eventPayload.token_info));
          void refreshSessions();
          wsByRequestRef.current.get(clientRequestId)?.close(1000, "completed");
          return;
        }
        if (eventPayload.type === "error") {
          const friendly = toFriendlyChatError(eventPayload.message || t("error.connection"), language);
          appendAssistantContent(
            targetSessionId!,
            accumulatedResponse ? `\n\n[Error] ${friendly}` : `[Error] ${friendly}`,
          );
          finalize("error");
          wsByRequestRef.current.get(clientRequestId)?.close(1000, "error");
        }
      };

      try {
        const stream = startChatStream({
          apiBase,
          payload: {
            session_id: targetSessionId,
            messages: messagesForRequest,
            retry_attempt: 0,
            client_request_id: clientRequestId,
          },
          onEvent,
          onSocketError: () => {
            if (!isCurrentRequest()) return;
            appendAssistantContent(
              targetSessionId!,
              accumulatedResponse ? `\n\n[Error] ${t("error.network")}` : `[Error] ${t("error.network")}`,
            );
            finalize("error");
            toast.error(t("error.networkToast"));
          },
          onClose: () => {
            if (!isCurrentRequest() || completed) return;
            finalize("error");
          },
        });
        wsByRequestRef.current.set(clientRequestId, stream);
      } catch (error) {
        console.error("Failed to chat via websocket:", error);
        setSessionRunState(targetSessionId, {
          running: false,
          unreadDone: true,
          terminal: "error",
          requestId: null,
        });
        runningRequestBySessionRef.current.delete(targetSessionId);
      }
    },
    [
      appendAssistantContent,
      apiBase,
      createSessionIfNeeded,
      ensureSessionMessagesLoaded,
      maybeRenameSessionFromFirstInput,
      refreshSessions,
      setAssistantContent,
      setError,
      setSessionRunState,
      state.input,
      state.sessionId,
      authStatus,
      language,
      t,
    ],
  );

  const handleStopGeneration = useCallback(() => {
    if (!state.sessionId) return;
    const requestId = runningRequestBySessionRef.current.get(state.sessionId);
    if (!requestId) return;
    const ws = wsByRequestRef.current.get(requestId);
    if (isSocketOpen(ws)) {
      ws?.close(1000, "client_stop");
    }
    runningRequestBySessionRef.current.delete(state.sessionId);
    wsByRequestRef.current.delete(requestId);
    setSessionRunState(state.sessionId, (prev) => ({
      ...prev,
      running: false,
      phase: null,
      toolName: null,
      unreadDone: true,
      terminal: "stopped",
      requestId: null,
      activeTools: [],
    }));
    dispatch({
      type: "update_session_messages",
      sessionId: state.sessionId,
      updater: (current) => {
        const next = [...current];
        if (next.length === 0) return current;
        const idx = next.length - 1;
        if (next[idx].role === "assistant" && !next[idx].content.includes("[Stopped by user]")) {
          next[idx] = { ...next[idx], content: `${next[idx].content}\n\n[Stopped by user]` };
        }
        return next;
      },
    });
  }, [setSessionRunState, state.sessionId]);

  const statusText = useMemo(() => {
    const seconds = Math.max(0, Math.floor(currentRunState.elapsedMs / 1000));
    const attemptText = currentRunState.maxAttempts > 1 ? ` · ${currentRunState.attempt}/${currentRunState.maxAttempts}` : "";
    if (currentRunState.phase === "tool_running") {
      const tool = currentRunState.toolName || currentRunState.activeTools[currentRunState.activeTools.length - 1] || t("run.tool");
      return language === "zh"
        ? `运行中：${tool}（${seconds} 秒）${attemptText}`
        : t("run.running", { tool }) + ` (${seconds}s)${attemptText}`;
    }
    if (currentRunState.phase === "retrying") {
      const reason = currentRunState.reason === "first_chunk_timeout" ? t("run.firstChunkTimeout") : t("run.processing");
      return t("run.retrying", { reason, attempt: attemptText });
    }
    if (currentRunState.phase === "responding") {
      return t("run.generating", { seconds, attempt: attemptText });
    }
    const suffix = currentRunState.hasReceivedToolCall && !currentRunState.hasReceivedChunk ? t("run.toolTriggered") : "";
    return t("run.thinking", { seconds, attempt: attemptText, suffix });
  }, [currentRunState, language, t]);

  return {
    apiBase,
    state,
    messages,
    currentRunState,
    isLoading,
    statusText,
    scrollRef,
    inputRef,
    setInput: (input: string) => dispatch({ type: "set_input", input }),
    setEditingTitle: (title: string) => dispatch({ type: "set_editing_title", title }),
    dismissError: () => setError(null),
    retryLoadSessions: loadSessions,
    handleNewChat,
    handleSwitchSession,
    handleEditSessionTitle,
    cancelInlineSessionTitle,
    saveInlineSessionTitle,
    requestDeleteSession,
    cancelDeleteSession,
    confirmDeleteSession,
    handleSubmit,
    handleStopGeneration,
    taskConfirmationRequested,
    clearTaskConfirmation: () => setTaskConfirmationRequested(false),
    authStatus,
    setError,
    appendAssistantContent,
    sessionMessagesMapRef,
    wsByRequestRef,
    dispatch,
    setSessionRunState,
    refreshSessions,
  };
}
