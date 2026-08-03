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
  listSessionUploadedPapers,
  listSessions,
  updateSessionTitle,
  uploadSessionPaper,
  type UploadedPaperItem,
} from "@/lib/api/sessions";
import { getApiBase, redirectToLogin } from "@/lib/runtime-config";
import { startChatStream, toFriendlyChatError, type ChatDoneEvent, type ChatEvent, type ChatStreamHandle } from "@/lib/ws/chat-stream";

const isSocketOpen = (socket?: ChatStreamHandle | null) => {
  if (!socket) return false;
  return socket.getReadyState() === 1;
};

const toTokenInfo = (payload?: ChatDoneEvent["token_info"]) => ({
  prompt: Number(payload?.prompt) || 0,
  response: Number(payload?.response) || 0,
  total: Number(payload?.total) || 0,
});

export function useChatController() {
  const apiBase = useMemo(() => getApiBase(), []);
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT_STATE);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsByRequestRef = useRef<Map<string, ChatStreamHandle>>(new Map());
  const runningRequestBySessionRef = useRef<Map<string, string>>(new Map());
  const requestStartedAtRef = useRef<Map<string, number>>(new Map());
  const loadedSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionMessagesMapRef = useRef<Record<string, Message[]>>({});
  const sessionLoadPromiseRef = useRef<Map<string, Promise<Message[]>>>(new Map());
  const sessionsRef = useRef<SessionItem[]>([]);
  const [uploadedPapersMap, setUploadedPapersMap] = useState<Record<string, UploadedPaperItem[]>>({});
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");

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

  const loadUploadedPapers = useCallback(async (targetSessionId: string): Promise<UploadedPaperItem[]> => {
    try {
      const papers = await listSessionUploadedPapers(apiBase, targetSessionId);
      setUploadedPapersMap((prev) => ({ ...prev, [targetSessionId]: papers }));
      return papers;
    } catch (error) {
      console.error("Failed to load uploaded papers", error);
      setUploadedPapersMap((prev) => ({ ...prev, [targetSessionId]: prev[targetSessionId] || [] }));
      return [];
    }
  }, [apiBase]);

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
      const message = error instanceof Error ? error.message : "无法连接后端服务";
      dispatch({ type: "set_error", error: `会话加载失败：${message}` });
      dispatch({ type: "set_sessions", sessions: [] });
      toast.error("会话加载失败，请检查后端是否启动。");
      return null;
    }
  }, [apiBase]);

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
      const message = error instanceof Error ? error.message : "未知错误";
      setError(`消息加载失败：${message}`);
      toast.error("消息加载失败，请重试。");
    });
    void loadUploadedPapers(sessionId);
  }, [sessionId, ensureSessionMessagesLoaded, loadUploadedPapers, setError]);

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
          title: "New chat",
          created_at: "",
          updated_at: "",
        },
      });
      dispatch({ type: "set_session_messages", sessionId: createdSessionId, messages: [] });
      dispatch({ type: "set_session_run_state", sessionId: createdSessionId, runState: DEFAULT_RUN_STATE });
      setUploadedPapersMap((prev) => ({ ...prev, [createdSessionId]: [] }));
      loadedSessionIdsRef.current.add(createdSessionId);
      return createdSessionId;
    } catch (error) {
      console.error("Failed to create session", error);
      return null;
    }
  }, [apiBase, state.sessionId]);

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
    dispatch({ type: "reset_new_chat" });
  }, []);

  const handleSwitchSession = useCallback(
    (id: string) => {
      if (state.editingSessionId) return;
      setSessionRunState(id, { unreadDone: false });
      dispatch({ type: "set_session_id", sessionId: id });
      dispatch({ type: "set_deleting_session", sessionId: null });
      void loadUploadedPapers(id);
    },
    [loadUploadedPapers, setSessionRunState, state.editingSessionId],
  );

  const handleEditSessionTitle = useCallback((session: SessionItem) => {
    dispatch({ type: "set_editing_session", sessionId: session.session_id, title: session.title || "Untitled" });
  }, []);

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
        toast.error("会话标题更新失败。");
      }
    },
    [apiBase, refreshSessions, state.editingTitle],
  );

  const requestDeleteSession = useCallback(
    (session: SessionItem) => {
      const runState = state.sessionRunMap[session.session_id] || DEFAULT_RUN_STATE;
      if (runState.running) {
        toast.info("该会话正在处理，请先停止后再删除。");
        return;
      }
      dispatch({ type: "set_deleting_session", sessionId: session.session_id });
    },
    [state.sessionRunMap],
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
        toast.error("删除会话失败。");
      }
    },
    [apiBase, refreshSessions],
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
          setError("创建会话失败，请重试。");
          toast.error("创建会话失败，请重试。");
          return;
        }
      }

      const runningRequest = runningRequestBySessionRef.current.get(targetSessionId);
      if (runningRequest) {
        toast.info("该会话仍在处理中，请等待或先停止。");
        return;
      }

      if (!loadedSessionIdsRef.current.has(targetSessionId)) {
        try {
          await ensureSessionMessagesLoaded(targetSessionId);
        } catch (error) {
          console.error("Failed to load conversation history before send", error);
          setError("加载历史消息失败，请重试。");
          toast.error("加载历史消息失败，请重试。");
          return;
        }
      }

      const userMessage: Message = { role: "user", content: value };
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
      requestStartedAtRef.current.set(targetSessionId, Date.now());
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
          requestStartedAtRef.current.delete(targetSessionId!);
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
          const friendly = toFriendlyChatError(eventPayload.message || "连接出错");
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
              accumulatedResponse ? "\n\n[Error] 网络连接失败" : "[Error] 网络连接失败",
            );
            finalize("error");
            toast.error("网络连接失败。");
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
    ],
  );

  const handleStopGeneration = useCallback(() => {
    if (!state.sessionId) return;
    const requestId = runningRequestBySessionRef.current.get(state.sessionId);
    if (!requestId) return;
    // A submit click can be delivered again by touchpads / accessibility
    // drivers after React has already swapped the send icon for stop.  Do not
    // let that duplicate event instantly abort the request the user just sent.
    const startedAt = requestStartedAtRef.current.get(state.sessionId) ?? 0;
    if (Date.now() - startedAt < 700) return;
    const ws = wsByRequestRef.current.get(requestId);
    if (isSocketOpen(ws)) {
      ws?.close(1000, "client_stop");
    }
    runningRequestBySessionRef.current.delete(state.sessionId);
    requestStartedAtRef.current.delete(state.sessionId);
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
        if (next[idx].role === "assistant" && !next[idx].content.includes("[已手动中断]")) {
          next[idx] = { ...next[idx], content: `${next[idx].content}\n\n[已手动中断]` };
        }
        return next;
      },
    });
  }, [setSessionRunState, state.sessionId]);

  const handleUploadPdf = useCallback(async (file: File) => {
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      toast.error("仅支持上传 PDF 文件。");
      return;
    }

    let targetSessionId = state.sessionId;
    if (!targetSessionId) {
      targetSessionId = await createSessionIfNeeded();
      if (!targetSessionId) {
        toast.error("创建会话失败，无法上传论文。");
        return;
      }
    }

    setUploadingPdf(true);
    try {
      const uploaded = await uploadSessionPaper(apiBase, targetSessionId, file);
      setUploadedPapersMap((prev) => {
        const current = prev[targetSessionId!] || [];
        const deduped = [uploaded, ...current.filter((item) => item.paper_id !== uploaded.paper_id)];
        return { ...prev, [targetSessionId!]: deduped };
      });
      dispatch({
        type: "update_session_messages",
        sessionId: targetSessionId,
        updater: (current) => [
          ...current,
          {
            role: "assistant",
            content:
              `已上传论文 **${uploaded.original_filename}**。\n` +
              `引用: \`uploaded://${uploaded.paper_id}\`，可直接让我基于该论文生成操作手册。`,
          },
        ],
      });
      loadedSessionIdsRef.current.add(targetSessionId);
      toast.success(`上传完成：${uploaded.original_filename}`);
    } catch (error) {
      console.error("Failed to upload pdf", error);
      const message = error instanceof Error ? error.message : "未知错误";
      toast.error(`上传失败：${message}`);
    } finally {
      setUploadingPdf(false);
    }
  }, [apiBase, createSessionIfNeeded, state.sessionId]);

  const handleExportPdf = useCallback(() => {
    if (typeof window === "undefined") return;
    window.print();
  }, []);

  const statusText = useMemo(() => {
    const seconds = Math.max(0, Math.floor(currentRunState.elapsedMs / 1000));
    const attemptText = currentRunState.maxAttempts > 1 ? ` · ${currentRunState.attempt}/${currentRunState.maxAttempts}` : "";
    if (currentRunState.phase === "tool_running") {
      const tool = currentRunState.toolName || currentRunState.activeTools[currentRunState.activeTools.length - 1] || "tool";
      return `Running ${tool} (${seconds}s)${attemptText}`;
    }
    if (currentRunState.phase === "retrying") {
      const reason = currentRunState.reason === "first_chunk_timeout" ? "first chunk timeout" : "processing";
      return `Retrying (${reason})${attemptText}`;
    }
    if (currentRunState.phase === "responding") {
      return `Generating response (${seconds}s)${attemptText}`;
    }
    const suffix = currentRunState.hasReceivedToolCall && !currentRunState.hasReceivedChunk ? " · tool triggered" : "";
    return `Thinking (${seconds}s)${attemptText}${suffix}`;
  }, [currentRunState]);

  const uploadedPapers = useMemo(() => {
    if (!state.sessionId) return [];
    return uploadedPapersMap[state.sessionId] || [];
  }, [state.sessionId, uploadedPapersMap]);

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
    handleUploadPdf,
    handleExportPdf,
    uploadedPapers,
    uploadingPdf,
    authStatus,
  };
}
