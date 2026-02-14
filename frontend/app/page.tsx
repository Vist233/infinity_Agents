"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SendHorizontal, Square, User, Bot, Plus, Pencil, Terminal, FileText, Microscope, MessageCircle, Trash2, Loader2 } from "lucide-react";
import MarkdownRenderer from "@/components/markdown-renderer";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface SessionItem {
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

type RunPhase = "thinking" | "tool_running" | "responding" | "retrying";
type TerminalState = "success" | "error" | "stopped";

interface SessionRunState {
  running: boolean;
  phase: RunPhase | null;
  toolName: string | null;
  unreadDone: boolean;
  terminal: TerminalState | null;
  requestId: string | null;
  elapsedMs: number;
  attempt: number;
  maxAttempts: number;
  reason: string | null;
  hasReceivedChunk: boolean;
  hasReceivedToolCall: boolean;
  activeTools: string[];
  tokenInfo: { prompt: number; response: number; total: number } | null;
}

const DEFAULT_RUN_STATE: SessionRunState = {
  running: false,
  phase: null,
  toolName: null,
  unreadDone: false,
  terminal: null,
  requestId: null,
  elapsedMs: 0,
  attempt: 1,
  maxAttempts: 2,
  reason: null,
  hasReceivedChunk: false,
  hasReceivedToolCall: false,
  activeTools: [],
  tokenInfo: null,
};

export default function ChatPage() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsByRequestRef = useRef<Map<string, WebSocket>>(new Map());
  const runningRequestBySessionRef = useRef<Map<string, string>>(new Map());
  const loadedSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionMessagesMapRef = useRef<Record<string, Message[]>>({});
  const sessionLoadPromiseRef = useRef<Map<string, Promise<Message[]>>>(new Map());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionMessagesMap, setSessionMessagesMap] = useState<Record<string, Message[]>>({});
  const [sessionRunMap, setSessionRunMap] = useState<Record<string, SessionRunState>>({});
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const API_BASE = "http://localhost:8008";
  const WS_BASE = API_BASE.replace(/^http/, "ws");
  const messages = useMemo(() => (sessionId ? (sessionMessagesMap[sessionId] || []) : []), [sessionId, sessionMessagesMap]);
  const currentRunState = sessionId ? (sessionRunMap[sessionId] || DEFAULT_RUN_STATE) : DEFAULT_RUN_STATE;
  const isLoading = currentRunState.running;

  useEffect(() => {
    if (scrollRef.current) {
      const scrollContainer = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
      }
    }
  }, [messages]);

  useEffect(() => {
    sessionMessagesMapRef.current = sessionMessagesMap;
  }, [sessionMessagesMap]);

  useEffect(() => {
    const wsByRequest = wsByRequestRef.current;
    const runningRequestBySession = runningRequestBySessionRef.current;
    const sessionLoadPromises = sessionLoadPromiseRef.current;
    return () => {
      wsByRequest.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, "component_unmount");
        }
      });
      wsByRequest.clear();
      runningRequestBySession.clear();
      sessionLoadPromises.clear();
    };
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/sessions`);
        const data = await res.json();
        if (Array.isArray(data)) {
          setSessions(data);
        } else {
          setSessions([]);
        }
      } catch (e) {
        console.error("Failed to load sessions", e);
        setSessions([]);
      }
      setSessionId(null);
    };
    init();
  }, []);

  const ensureSessionMessagesLoaded = useCallback(async (targetSessionId: string): Promise<Message[]> => {
    if (loadedSessionIdsRef.current.has(targetSessionId)) {
      return sessionMessagesMapRef.current[targetSessionId] || [];
    }

    const inFlight = sessionLoadPromiseRef.current.get(targetSessionId);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const res = await fetch(`${API_BASE}/api/sessions/${targetSessionId}/messages`);
      if (!res.ok) {
        throw new Error(`Failed to load session messages: ${res.status}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error("Invalid messages payload");
      }
      const mapped: Message[] = data
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      let merged = mapped;
      setSessionMessagesMap((prev) => {
        const existing = prev[targetSessionId] || [];
        const shouldKeepExisting = runningRequestBySessionRef.current.has(targetSessionId) && existing.length > 0;
        if (shouldKeepExisting) {
          merged = existing;
          return prev;
        }
        merged = mapped;
        return { ...prev, [targetSessionId]: mapped };
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
  }, [API_BASE]);

  useEffect(() => {
    if (!sessionId) return;
    setSessionRunMap((prev) => ({
      ...prev,
      [sessionId]: {
        ...(prev[sessionId] || DEFAULT_RUN_STATE),
        unreadDone: false,
      },
    }));
    void ensureSessionMessagesLoaded(sessionId).catch((e) => {
      console.error("Failed to load messages", e);
    });
  }, [sessionId, ensureSessionMessagesLoaded]);

  const refreshSessions = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setSessions(data);
        return data as SessionItem[];
      }
    } catch (e) {
      console.error("Failed to refresh sessions", e);
    }
    return null;
  };

  const deriveSessionTitle = (rawInput: string) => {
    const normalized = rawInput.replace(/\s+/g, " ").trim();
    if (!normalized) return "新对话";
    return normalized.length > 32 ? `${normalized.slice(0, 32)}...` : normalized;
  };

  const isDefaultSessionTitle = (title?: string | null) => {
    const t = (title || "").trim().toLowerCase();
    return !t || t === "new chat" || t === "untitled" || t === "新对话";
  };

  const maybeRenameSessionFromFirstInput = async (firstInput: string, targetSessionId?: string | null) => {
    const targetId = targetSessionId ?? sessionId;
    if (!targetId) return;
    const nextTitle = deriveSessionTitle(firstInput);
    setSessions((prev) => prev.map((s) => (s.session_id === targetId ? { ...s, title: nextTitle } : s)));

    const current = sessions.find((s) => s.session_id === targetId);
    const isDefaultTitle = !current || isDefaultSessionTitle(current.title);
    if (!isDefaultTitle) return;

    try {
      const res = await fetch(`${API_BASE}/api/sessions/${targetId}/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: nextTitle }),
      });
      if (!res.ok) return;
      setSessions((prev) => prev.map((s) => (s.session_id === targetId ? { ...s, title: nextTitle } : s)));
    } catch (e) {
      console.error("Failed to auto-rename session", e);
    }
  };

  const setSessionRunState = (
    targetSessionId: string,
    updater: Partial<SessionRunState> | ((prev: SessionRunState) => SessionRunState),
  ) => {
    setSessionRunMap((prev) => {
      const current = prev[targetSessionId] || DEFAULT_RUN_STATE;
      const next = typeof updater === "function"
        ? updater(current)
        : { ...current, ...updater };
      return { ...prev, [targetSessionId]: next };
    });
  };

  const setAssistantContent = (targetSessionId: string, content: string) => {
    setSessionMessagesMap((prev) => {
      const current = [...(prev[targetSessionId] || [])];
      if (current.length === 0 || current[current.length - 1].role !== "assistant") {
        current.push({ role: "assistant", content });
      } else {
        current[current.length - 1] = { ...current[current.length - 1], content };
      }
      return { ...prev, [targetSessionId]: current };
    });
  };

  const appendAssistantContent = (targetSessionId: string, suffix: string) => {
    setSessionMessagesMap((prev) => {
      const current = [...(prev[targetSessionId] || [])];
      if (current.length === 0 || current[current.length - 1].role !== "assistant") {
        current.push({ role: "assistant", content: suffix });
      } else {
        const original = current[current.length - 1].content || "";
        current[current.length - 1] = { ...current[current.length - 1], content: `${original}${suffix}` };
      }
      return { ...prev, [targetSessionId]: current };
    });
  };

  const enterBlankState = () => {
    setSessionId(null);
    setInput("");
  };

  const createSessionIfNeeded = async () => {
    if (sessionId) return sessionId;
    try {
      const res = await fetch(`${API_BASE}/api/sessions`, { method: "POST" });
      if (!res.ok) {
        return null;
      }
      const data = await res.json();
      const createdSessionId = typeof data.session_id === "string" ? data.session_id : null;
      if (!createdSessionId) return null;

      setSessionId(createdSessionId);
      setSessions((prev) => {
        if (prev.some((s) => s.session_id === createdSessionId)) return prev;
        return [
          {
            session_id: createdSessionId,
            title: "New chat",
            created_at: "",
            updated_at: "",
          },
          ...prev,
        ];
      });
      setSessionMessagesMap((prev) => ({ ...prev, [createdSessionId]: prev[createdSessionId] || [] }));
      setSessionRunState(createdSessionId, DEFAULT_RUN_STATE);
      loadedSessionIdsRef.current.add(createdSessionId);
      return createdSessionId;
    } catch (e) {
      console.error("Failed to create session", e);
      return null;
    }
  };

  const handleNewChat = () => {
    enterBlankState();
  };

  const handleSwitchSession = (id: string) => {
    if (editingSessionId) return;
    setSessionRunState(id, { unreadDone: false });
    setSessionId(id);
  };

  const handleEditSessionTitle = (session: SessionItem) => {
    setEditingSessionId(session.session_id);
    setEditingTitle(session.title || "Untitled");
  };

  const saveInlineSessionTitle = async (targetSessionId: string) => {
    const trimmed = editingTitle.trim();
    const current = sessions.find((s) => s.session_id === targetSessionId);
    if (!trimmed || trimmed === (current?.title || "")) {
      setEditingSessionId(null);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${targetSessionId}/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        console.error("Failed to update session title");
        return;
      }
      setSessions((prev) => prev.map((s) => (s.session_id === targetSessionId ? { ...s, title: trimmed } : s)));
      setEditingSessionId(null);
      await refreshSessions();
    } catch (e) {
      console.error("Failed to update session title", e);
    }
  };

  const handleDeleteSession = async (session: SessionItem) => {
    const runState = sessionRunMap[session.session_id] || DEFAULT_RUN_STATE;
    if (runState.running) {
      window.alert("This conversation is still processing. Stop it before deleting.");
      return;
    }
    const title = session.title || "Untitled";
    const confirmed = window.confirm(`Delete session "${title}"? This cannot be undone.`);
    if (!confirmed) return;

    try {
      const res = await fetch(`${API_BASE}/api/sessions/${session.session_id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        console.error("Failed to delete session");
        return;
      }
      await refreshSessions();
      loadedSessionIdsRef.current.delete(session.session_id);
      sessionLoadPromiseRef.current.delete(session.session_id);
      setSessionMessagesMap((prev) => {
        const next = { ...prev };
        delete next[session.session_id];
        return next;
      });
      setSessionRunMap((prev) => {
        const next = { ...prev };
        delete next[session.session_id];
        return next;
      });
      if (session.session_id === sessionId) {
        setSessionId(null);
      }
    } catch (e) {
      console.error("Failed to delete session", e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    let targetSessionId = sessionId;
    if (!targetSessionId) {
      targetSessionId = await createSessionIfNeeded();
      if (!targetSessionId) {
        window.alert("Failed to create session. Please retry.");
        return;
      }
    }

    const runningRequest = runningRequestBySessionRef.current.get(targetSessionId);
    if (runningRequest) {
      window.alert("This conversation is still processing. Please wait or stop it first.");
      return;
    }

    if (!loadedSessionIdsRef.current.has(targetSessionId)) {
      try {
        await ensureSessionMessagesLoaded(targetSessionId);
      } catch (e) {
        console.error("Failed to load conversation history before send", e);
        window.alert("Failed to load conversation history. Please retry.");
        return;
      }
    }

    const userMsg: Message = { role: "user", content: input };
    const baseMessages = sessionMessagesMapRef.current[targetSessionId] || [];
    const messagesForRequest = [...baseMessages, userMsg];
    const messagesForUI = [...baseMessages, userMsg, { role: "assistant", content: "" } as Message];
    setSessionMessagesMap((prev) => ({ ...prev, [targetSessionId as string]: messagesForUI }));
    loadedSessionIdsRef.current.add(targetSessionId);
    setInput("");

    const clientRequestId = (typeof crypto !== "undefined" && "randomUUID" in crypto)
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
      void maybeRenameSessionFromFirstInput(userMsg.content, targetSessionId);
    }

    try {
      let accumulatedResponse = "";
      let completed = false;
      const ws = new WebSocket(`${WS_BASE}/ws/chat`);
      wsByRequestRef.current.set(clientRequestId, ws);
      const isCurrentRequest = () => runningRequestBySessionRef.current.get(targetSessionId) === clientRequestId;

      const finalize = (terminal: TerminalState, tokenInfo?: { prompt: number; response: number; total: number } | null) => {
        if (completed) return;
        completed = true;
        if (isCurrentRequest()) {
          runningRequestBySessionRef.current.delete(targetSessionId as string);
        }
        wsByRequestRef.current.delete(clientRequestId);
        setSessionRunState(targetSessionId as string, (prev) => ({
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

      ws.onopen = () => {
        ws.send(JSON.stringify({
          session_id: targetSessionId,
          messages: messagesForRequest,
          retry_attempt: 0,
          client_request_id: clientRequestId,
        }));
      };

      ws.onmessage = (event) => {
        if (!isCurrentRequest()) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "status") {
            const phase = (typeof payload.phase === "string" ? payload.phase : "thinking") as RunPhase;
            const elapsed = Number(payload.elapsed_ms);
            const attempt = Number(payload.attempt);
            const maxAttempts = Number(payload.max_attempts);
            setSessionRunState(targetSessionId as string, (prev) => ({
              ...prev,
              phase,
              elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : prev.elapsedMs,
              attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : prev.attempt,
              maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : prev.maxAttempts,
              toolName: typeof payload.tool_name === "string" ? payload.tool_name : prev.toolName,
              reason: typeof payload.reason === "string" ? payload.reason : prev.reason,
            }));
            return;
          }

          if (payload.type === "chunk") {
            const content = typeof payload.content === "string" ? payload.content : "";
            accumulatedResponse += content;
            setAssistantContent(targetSessionId as string, accumulatedResponse);
            setSessionRunState(targetSessionId as string, { hasReceivedChunk: true });
            return;
          }

          if (payload.type === "tool_call") {
            const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
            if (!toolName) return;
            setSessionRunState(targetSessionId as string, (prev) => ({
              ...prev,
              hasReceivedToolCall: true,
              toolName,
              activeTools: prev.activeTools.includes(toolName) ? prev.activeTools : [...prev.activeTools, toolName],
            }));
            return;
          }

          if (payload.type === "done") {
            const info = payload.token_info || {};
            const tokenInfo = {
              prompt: Number(info.prompt) || 0,
              response: Number(info.response) || 0,
              total: Number(info.total) || 0,
            };
            finalize("success", tokenInfo);
            void refreshSessions();
            ws.close();
            return;
          }

          if (payload.type === "error") {
            const message = typeof payload.message === "string" ? payload.message : "连接出错";
            const friendlyMessage = message.includes("paper_not_authorized_for_session")
              ? "该论文不在当前会话可访问范围，请先使用 search_paper 检索后再读。"
              : message;
            appendAssistantContent(targetSessionId as string, accumulatedResponse ? `\n\n[Error] ${friendlyMessage}` : `[Error] ${friendlyMessage}`);
            finalize("error");
            ws.close();
          }
        } catch {
          const text = typeof event.data === "string" ? event.data : "";
          if (!text) return;
          accumulatedResponse += text;
          setAssistantContent(targetSessionId as string, accumulatedResponse);
        }
      };

      ws.onerror = () => {
        if (!isCurrentRequest()) return;
        appendAssistantContent(targetSessionId as string, accumulatedResponse ? "\n\n[Error] WebSocket 连接失败" : "[Error] WebSocket 连接失败");
        finalize("error");
      };

      ws.onclose = () => {
        if (completed) return;
        if (!isCurrentRequest()) return;
        finalize("error");
      };
    } catch (error) {
      console.error("Failed to chat via websocket:", error);
      setSessionRunState(targetSessionId, { running: false, unreadDone: true, terminal: "error", requestId: null });
      runningRequestBySessionRef.current.delete(targetSessionId);
    }
  };

  const handleStopGeneration = () => {
    if (!sessionId) return;
    const requestId = runningRequestBySessionRef.current.get(sessionId);
    if (!requestId) return;
    const ws = wsByRequestRef.current.get(requestId);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, "client_stop");
    }
    runningRequestBySessionRef.current.delete(sessionId);
    wsByRequestRef.current.delete(requestId);
    setSessionRunState(sessionId, (prev) => ({
      ...prev,
      running: false,
      phase: null,
      toolName: null,
      unreadDone: true,
      terminal: "stopped",
      requestId: null,
      activeTools: [],
    }));
    setSessionMessagesMap((prev) => {
      const current = [...(prev[sessionId] || [])];
      if (current.length === 0) return prev;
      const idx = current.length - 1;
      if (current[idx].role === "assistant" && !current[idx].content.includes("[已手动中断]")) {
        current[idx] = { ...current[idx], content: `${current[idx].content}\n\n[已手动中断]` };
      }
      return { ...prev, [sessionId]: current };
    });
  };

  const getStatusText = () => {
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
  };

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      {/* 侧边栏 - 极简点缀 */}
      <div className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl">
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 px-2">Agents</div>
          <div className="space-y-1">
            <button
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-xl text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900 transition-all duration-150"
              title="CodeAgent"
              onClick={() => router.push("/code-agent")}
            >
              <Terminal size={16} />
              <span className="truncate">CodeAgent</span>
            </button>
            <button
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-xl bg-zinc-900 text-zinc-50 shadow-sm"
              title="PaperAgent"
              onClick={() => router.push("/")}
            >
              <FileText size={16} />
              <span className="truncate">PaperAgent</span>
            </button>
            <button
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-xl text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900 transition-all duration-150"
              title="TraitRecognize"
              onClick={() => router.push("/trait-agent")}
            >
              <Microscope size={16} />
              <span className="truncate">TraitRecognize</span>
            </button>
          </div>
        </div>
        <Button
          variant="outline"
          className="justify-start gap-2 bg-white/90 border-[var(--hairline)] shadow-sm hover:bg-white mt-3 rounded-xl"
          onClick={handleNewChat}
        >
          <Plus size={16} />
          New Chat
        </Button>
        <div className="mt-3 text-xs uppercase tracking-widest text-zinc-400 px-2">Recent Activities</div>
        <div className="mt-2 space-y-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="text-xs text-zinc-400 px-2 py-2">No activities</div>
          ) : (
            sessions.map((s) => {
              const rowRunState = sessionRunMap[s.session_id] || DEFAULT_RUN_STATE;
              const isSelected = s.session_id === sessionId;
              return (
                <div
                  key={s.session_id}
                  className={`group w-full flex items-center gap-2 px-2 py-2 rounded-xl transition-all ${isSelected
                    ? "bg-zinc-900 text-zinc-50"
                    : "text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900"
                    }`}
                >
                  <div className="relative shrink-0 h-4 w-4">
                    <MessageCircle size={14} className={isSelected ? "text-zinc-200" : "text-zinc-500"} />
                    {rowRunState.running ? (
                      <Loader2 className={`absolute -right-1 -top-1 h-3.5 w-3.5 animate-spin ${isSelected ? "text-zinc-200" : "text-zinc-500"}`} />
                    ) : rowRunState.unreadDone ? (
                      <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-sky-500" />
                    ) : null}
                  </div>
                  {editingSessionId === s.session_id ? (
                    <div className="flex-1">
                      <input
                        autoFocus
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => saveInlineSessionTitle(s.session_id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveInlineSessionTitle(s.session_id);
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingSessionId(null);
                          }
                        }}
                        className="w-full bg-white border border-zinc-300 rounded-lg px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => handleSwitchSession(s.session_id)}
                      className="flex-1 text-left text-sm truncate disabled:opacity-50"
                      title={s.title}
                      disabled={editingSessionId === s.session_id}
                    >
                      {s.title || "Untitled"}
                    </button>
                  )}
                  <button
                    onClick={() => handleEditSessionTitle(s)}
                    className={`p-1 rounded-md transition-all duration-150 ${editingSessionId === s.session_id ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"} ${isSelected
                      ? "text-zinc-200 hover:bg-zinc-700"
                      : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                      }`}
                    aria-label="Edit session title"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => handleDeleteSession(s)}
                    className={`p-1 rounded-md transition-all duration-150 ${editingSessionId === s.session_id ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"} ${isSelected
                      ? "text-zinc-200 hover:bg-zinc-700"
                      : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                      }`}
                    aria-label="Delete session"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex-1" />
        <div className="p-2 text-xs text-zinc-400 text-center tracking-tighter">
          v1.0.0 @ 2026
        </div>
      </div>

      {/* 主对话区 */}
      <main className="flex-1 flex flex-col relative">
        {/* Top Bar */}
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10">
          <div className="text-sm font-semibold tracking-tight text-zinc-700">Paper Agent</div>
          <Button variant="ghost" size="sm" className="text-zinc-500 hover:text-zinc-900">Share</Button>
        </header>

        <ScrollArea className="flex-1 overflow-y-auto" ref={scrollRef}>
          <div className="max-w-3xl mx-auto w-full px-4 pt-10 pb-32">
            {messages.length === 0 ? (
              // 初始欢迎状态
              <div className="h-[60vh] flex flex-col items-center justify-center space-y-4">
                <div className="w-12 h-12 rounded-full border border-zinc-200 flex items-center justify-center shadow-sm">
                  <Bot size={24} />
                </div>
                <h2 className="text-2xl font-medium tracking-tight">How can I help you today?</h2>
              </div>
            ) : (
              // 消息列表
              <div className="space-y-8">
                {messages.map((m, i) => (
                  <div key={i} className={`flex gap-4 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`flex w-full max-w-3xl gap-4 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                      <Avatar className={`h-8 w-8 shrink-0 border ${m.role === 'user' ? 'border-zinc-300' : 'border-zinc-200 bg-zinc-900 text-white'}`}>
                        <AvatarFallback className="bg-transparent">
                          {m.role === "user" ? <User size={16} /> : <Bot size={16} className="text-zinc-100" />}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col gap-1.5 grow">
                        <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">
                          {m.role === "user" ? "You" : "Assistant"}
                        </span>
                        <div className={`text-[15px] leading-7 ${m.role === "user" ? "text-zinc-700 whitespace-pre-wrap" : "text-zinc-900"}`}>
                          {m.role === "assistant" ? (
                            isLoading && i === messages.length - 1 ? (
                              <div className="whitespace-pre-wrap">{m.content}</div>
                            ) : (
                              <MarkdownRenderer content={m.content} sessionId={sessionId} />
                            )
                          ) : (
                            m.content
                          )}
                          {/* Typing cursor while streaming */}
          {isLoading && i === messages.length - 1 && (
                            <>
                              <span className="inline-block w-1.5 h-4 bg-zinc-900 animate-pulse ml-1 align-middle" />
                              <span className="ml-2 text-[11px] text-zinc-400">{getStatusText()}</span>
                            </>
                          )}

                          {isLoading && i === messages.length - 1 && currentRunState.activeTools.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {currentRunState.activeTools.map((tool) => (
                                <span
                                  key={tool}
                                  className="inline-flex items-center rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-600"
                                >
                                  Running: {tool}
                                </span>
                              ))}
                            </div>
                          )}

                          {/* When done, show token info */}
                          {currentRunState.terminal === "success" && i === messages.length - 1 && currentRunState.tokenInfo && process.env.NODE_ENV !== "production" && (
                            <div className="text-xs text-zinc-400 mt-1">Done · Tokens: prompt {currentRunState.tokenInfo.prompt} · resp {currentRunState.tokenInfo.response} · total {currentRunState.tokenInfo.total}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* 固定底部的输入框 */}
        <div className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-white via-white/95 to-transparent pt-10">
          <div className="max-w-3xl mx-auto px-4 pb-8">
            <form onSubmit={handleSubmit} className="relative group">
              <div className="relative flex items-center">
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.currentTarget.style.height = "auto";
                    e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 220)}px`;
                  }}
                  onKeyDown={(e) => {
                    // Avoid sending on Enter while IME composition (e.g. Chinese pinyin) is active.
                    if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) {
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  placeholder="Message Infinity..."
                  className="w-full bg-white/95 border border-[var(--hairline-strong)] rounded-2xl py-4 pl-4 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] transition-all duration-150 ease-[var(--easing-standard)] resize-none shadow-sm"
                />
                <Button
                  type={isLoading ? "button" : "submit"}
                  size="icon"
                  disabled={!isLoading && !input.trim()}
                  onClick={isLoading ? handleStopGeneration : undefined}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-xl transition-all duration-150 ease-[var(--easing-standard)] active:scale-95 ${isLoading ? "!bg-zinc-900 hover:!bg-zinc-800" : "!bg-zinc-700 hover:!bg-zinc-900"} disabled:!bg-zinc-200`}
                >
                  {isLoading ? (
                    <Square className="h-4 w-4 text-white" />
                  ) : (
                    <SendHorizontal className="h-4 w-4 text-white" />
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-center text-zinc-400 mt-3">
                AI can make mistakes. Check important info.
              </p>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
