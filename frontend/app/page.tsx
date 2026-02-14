"use client";

import React, { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SendHorizontal, Square, User, Bot, Plus, Pencil, Terminal, FileText, Microscope, MessageCircle, Trash2 } from "lucide-react";
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

export default function ChatPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [assistantDone, setAssistantDone] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<{ prompt: number, response: number, total: number } | null>(null);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [streamChunkCount, setStreamChunkCount] = useState(0);
  const [statusPhase, setStatusPhase] = useState<string | null>(null);
  const [statusElapsedMs, setStatusElapsedMs] = useState(0);
  const [statusAttempt, setStatusAttempt] = useState(1);
  const [statusMaxAttempts, setStatusMaxAttempts] = useState(2);
  const [statusToolName, setStatusToolName] = useState<string | null>(null);
  const [statusReason, setStatusReason] = useState<string | null>(null);
  const [hasReceivedChunk, setHasReceivedChunk] = useState(false);
  const [hasReceivedToolCall, setHasReceivedToolCall] = useState(false);
  const [receivedStatusEvent, setReceivedStatusEvent] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const userStoppedRef = useRef(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const API_BASE = "http://localhost:8008";
  const WS_BASE = API_BASE.replace(/^http/, "ws");

  useEffect(() => {
    if (scrollRef.current) {
      const scrollContainer = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
      }
    }
  }, [messages]);

  useEffect(() => {
    return () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/sessions`);
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setSessions(data);
          setSessionId(data[0].session_id);
          return;
        }
      } catch (e) {
        console.error("Failed to load sessions", e);
      }

      try {
        const res = await fetch(`${API_BASE}/api/sessions`, { method: "POST" });
        const data = await res.json();
        setSessionId(data.session_id);
        setSessions([
          {
            session_id: data.session_id,
            title: "New chat",
            created_at: "",
            updated_at: "",
          },
        ]);
      } catch (e) {
        console.error("Failed to init session", e);
      }
    };
    init();
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    setAssistantDone(false);
    setTokenInfo(null);
    setStatusPhase(null);
    setStatusElapsedMs(0);
    setStatusAttempt(1);
    setStatusMaxAttempts(2);
    setStatusToolName(null);
    setStatusReason(null);
    setHasReceivedChunk(false);
    setHasReceivedToolCall(false);
    setReceivedStatusEvent(false);
    setMessages([]);
    const loadMessages = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`);
        const data = await res.json();
        if (Array.isArray(data)) {
          const mapped: Message[] = data
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content }));
          setMessages(mapped);
        }
      } catch (e) {
        console.error("Failed to load messages", e);
      }
    };
    loadMessages();
  }, [sessionId]);

  useEffect(() => {
    if (!isLoading) return;
    const timer = window.setInterval(() => {
      if (receivedStatusEvent) return;
      setStatusPhase((prev) => prev ?? "thinking");
      setStatusElapsedMs((prev) => prev + 1000);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isLoading, receivedStatusEvent]);

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

  const maybeRenameSessionFromFirstInput = async (firstInput: string) => {
    if (!sessionId) return;
    const current = sessions.find((s) => s.session_id === sessionId);
    const isDefaultTitle = isDefaultSessionTitle(current?.title);
    if (!isDefaultTitle) return;

    const nextTitle = deriveSessionTitle(firstInput);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: nextTitle }),
      });
      if (!res.ok) return;
      setSessions((prev) => prev.map((s) => (s.session_id === sessionId ? { ...s, title: nextTitle } : s)));
    } catch (e) {
      console.error("Failed to auto-rename session", e);
    }
  };

  const handleNewChat = async () => {
    const currentSession = sessions.find((s) => s.session_id === sessionId);
    const isAlreadyFreshChat = Boolean(sessionId) && messages.length === 0 && isDefaultSessionTitle(currentSession?.title);
    if (isAlreadyFreshChat) return;

    try {
      const res = await fetch(`${API_BASE}/api/sessions`, { method: "POST" });
      const data = await res.json();
      setSessionId(data.session_id);
      setMessages([]);
      await refreshSessions();
    } catch (e) {
      console.error("Failed to create new session", e);
    }
  };

  const handleSwitchSession = (id: string) => {
    if (isLoading || editingSessionId) return;
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
    if (isLoading) return;
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
      const updated = await refreshSessions();
      if (session.session_id === sessionId) {
        if (updated && updated.length > 0) {
          setSessionId(updated[0].session_id);
        } else {
          await handleNewChat();
        }
      }
    } catch (e) {
      console.error("Failed to delete session", e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading || !sessionId) return;

    const userMsg: Message = { role: "user", content: input };
    const messagesForRequest = [...messages, userMsg];
    const messagesForUI = [...messages, userMsg, { role: "assistant", content: "" } as Message];
    setMessages(messagesForUI);
    setInput("");
    setIsLoading(true);
    setAssistantDone(false);
    setTokenInfo(null);
    setActiveTools([]);
    setStreamChunkCount(0);
    setStatusPhase("thinking");
    setStatusElapsedMs(0);
    setStatusAttempt(1);
    setStatusMaxAttempts(2);
    setStatusToolName(null);
    setStatusReason(null);
    setHasReceivedChunk(false);
    setHasReceivedToolCall(false);
    setReceivedStatusEvent(false);
    if (messages.length === 0) {
      void maybeRenameSessionFromFirstInput(userMsg.content);
    }

    try {
      await new Promise<void>((resolve) => {
        let accumulatedResponse = "";
        let doneReceived = false;
        const clientRequestId = (typeof crypto !== "undefined" && "randomUUID" in crypto)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const ws = new WebSocket(`${WS_BASE}/ws/chat`);
        wsRef.current = ws;
        userStoppedRef.current = false;

        ws.onopen = () => {
          ws.send(JSON.stringify({
            session_id: sessionId,
            messages: messagesForRequest,
            retry_attempt: 0,
            client_request_id: clientRequestId,
          }));
        };

        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === "status") {
              setReceivedStatusEvent(true);
              const phase = typeof payload.phase === "string" ? payload.phase : "thinking";
              const elapsed = Number(payload.elapsed_ms);
              const attempt = Number(payload.attempt);
              const maxAttempts = Number(payload.max_attempts);
              setStatusPhase(phase);
              setStatusElapsedMs(Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0);
              setStatusAttempt(Number.isFinite(attempt) && attempt > 0 ? attempt : 1);
              setStatusMaxAttempts(Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 2);
              setStatusToolName(typeof payload.tool_name === "string" ? payload.tool_name : null);
              setStatusReason(typeof payload.reason === "string" ? payload.reason : null);
              return;
            }

            if (payload.type === "chunk") {
              const content = typeof payload.content === "string" ? payload.content : "";
              accumulatedResponse += content;
              setStreamChunkCount((n) => n + 1);
              setHasReceivedChunk(true);
              setMessages((prev) => {
                const newMsgs = [...prev];
                newMsgs[newMsgs.length - 1].content = accumulatedResponse;
                return newMsgs;
              });
              return;
            }

            if (payload.type === "tool_call") {
              const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
              if (!toolName) return;
              setHasReceivedToolCall(true);
              setStatusToolName(toolName);
              setActiveTools((prev) => (prev.includes(toolName) ? prev : [...prev, toolName]));
              return;
            }

            if (payload.type === "done") {
              const info = payload.token_info || {};
              const prompt = Number(info.prompt) || 0;
              const responseTokens = Number(info.response) || 0;
              const total = Number(info.total) || 0;
              setTokenInfo({ prompt, response: responseTokens, total });
              setIsLoading(false);
              setAssistantDone(true);
              doneReceived = true;
              setActiveTools([]);
              setStatusPhase("responding");
              ws.close();
              return;
            }

            if (payload.type === "error") {
              const message = typeof payload.message === "string" ? payload.message : "连接出错";
              const friendlyMessage = message.includes("paper_not_authorized_for_session")
                ? "该论文不在当前会话可访问范围，请先使用 search_paper 检索后再读。"
                : message;
              setMessages((prev) => {
                const newMsgs = [...prev];
                const current = newMsgs[newMsgs.length - 1].content || "";
                newMsgs[newMsgs.length - 1].content = current ? `${current}\n\n[Error] ${friendlyMessage}` : `[Error] ${friendlyMessage}`;
                return newMsgs;
              });
              setIsLoading(false);
              doneReceived = true;
              setActiveTools([]);
              setStatusPhase(null);
              ws.close();
            }
          } catch {
            const text = typeof event.data === "string" ? event.data : "";
            if (!text) return;
            accumulatedResponse += text;
            setMessages((prev) => {
              const newMsgs = [...prev];
              newMsgs[newMsgs.length - 1].content = accumulatedResponse;
              return newMsgs;
            });
          }
        };

        ws.onerror = () => {
          if (userStoppedRef.current) {
            resolve();
            return;
          }
          setIsLoading(false);
          setActiveTools([]);
          setStatusPhase(null);
          setMessages((prev) => {
            const newMsgs = [...prev];
            const current = newMsgs[newMsgs.length - 1].content || "";
            newMsgs[newMsgs.length - 1].content = current
              ? `${current}\n\n[Error] WebSocket 连接失败`
              : "[Error] WebSocket 连接失败";
            return newMsgs;
          });
          resolve();
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (!doneReceived) {
            setIsLoading(false);
          }
          if (!doneReceived) {
            setActiveTools([]);
            setStatusPhase(null);
          }
          resolve();
        };
      });
      await refreshSessions();
    } catch (error) {
      console.error("Failed to chat via websocket:", error);
      setIsLoading(false);
    }
  };

  const handleStopGeneration = () => {
    userStoppedRef.current = true;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close(1000, "client_stop");
    }
    setIsLoading(false);
    setAssistantDone(true);
    setActiveTools([]);
    setStatusPhase(null);
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const idx = next.length - 1;
      if (next[idx].role === "assistant" && !next[idx].content.includes("[已手动中断]")) {
        next[idx].content = `${next[idx].content}\n\n[已手动中断]`;
      }
      return next;
    });
  };

  const getStatusText = () => {
    const seconds = Math.max(0, Math.floor(statusElapsedMs / 1000));
    const attemptText = statusMaxAttempts > 1 ? ` · ${statusAttempt}/${statusMaxAttempts}` : "";
    if (statusPhase === "tool_running") {
      const tool = statusToolName || activeTools[activeTools.length - 1] || "工具";
      return `正在调用 ${tool}（${seconds}s）${attemptText}`;
    }
    if (statusPhase === "retrying") {
      const reason = statusReason === "first_chunk_timeout" ? "首包超时" : "处理中";
      return `自动重试中（${reason}）${attemptText}`;
    }
    if (statusPhase === "responding") {
      return `正在生成回复（${seconds}s）${attemptText}`;
    }
    const suffix = hasReceivedToolCall && !hasReceivedChunk ? " · 已触发工具" : "";
    return `正在思考（${seconds}s）${attemptText}${suffix}`;
  };

  return (
    <div className="flex h-screen bg-zinc-100 text-zinc-900 font-sans">
      {/* 侧边栏 - 极简点缀 */}
      <div className="w-[260px] bg-white/90 border-r border-zinc-200 hidden md:flex flex-col p-3 backdrop-blur-sm">
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 px-2">Agents</div>
          <div className="space-y-1">
            <button
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
              title="CodeAgent"
              onClick={() => router.push("/code-agent")}
            >
              <Terminal size={16} />
              <span className="truncate">CodeAgent</span>
            </button>
            <button
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg bg-zinc-200 text-zinc-900"
              title="PaperAgent"
              onClick={() => router.push("/")}
            >
              <FileText size={16} />
              <span className="truncate">PaperAgent</span>
            </button>
            <button
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
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
          className="justify-start gap-2 bg-white border-zinc-200 shadow-sm hover:bg-zinc-100 mt-3"
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
            sessions.map((s) => (
              <div
                key={s.session_id}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg transition-colors ${s.session_id === sessionId
                  ? "bg-zinc-200 text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                  }`}
              >
                <MessageCircle size={14} className="shrink-0" />
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
                      className="w-full bg-white border border-zinc-300 rounded px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-zinc-400"
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
                  className={`p-1 rounded-md transition-colors ${s.session_id === sessionId
                    ? "text-zinc-700 hover:bg-zinc-300"
                    : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                    }`}
                  aria-label="Edit session title"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => handleDeleteSession(s)}
                  className={`p-1 rounded-md transition-colors ${s.session_id === sessionId
                    ? "text-zinc-700 hover:bg-zinc-300"
                    : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                    }`}
                  aria-label="Delete session"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
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
        <header className="h-14 border-b border-zinc-200/70 flex items-center px-4 justify-between sticky top-0 bg-white/80 backdrop-blur-md z-10">
          <div className="text-sm font-semibold tracking-tight text-zinc-600">Paper Agent</div>
          <Button variant="ghost" size="sm" className="text-zinc-500">Share</Button>
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
                              <span className="ml-2 text-[11px] text-zinc-400">{getStatusText()} · chunks {streamChunkCount}</span>
                            </>
                          )}

                          {isLoading && i === messages.length - 1 && activeTools.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {activeTools.map((tool) => (
                                <span
                                  key={tool}
                                  className="inline-flex items-center rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-600"
                                >
                                  正在调用: {tool}
                                </span>
                              ))}
                            </div>
                          )}

                          {/* When done, show token info */}
                          {assistantDone && i === messages.length - 1 && tokenInfo && (
                            <div className="text-xs text-zinc-400 mt-1">已完成 · Tokens: prompt {tokenInfo.prompt} · resp {tokenInfo.response} · total {tokenInfo.total}</div>
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
        <div className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-white via-white to-transparent pt-10">
          <div className="max-w-3xl mx-auto px-4 pb-8">
            <form onSubmit={handleSubmit} className="relative group">
              <div className="relative flex items-center">
                <textarea
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
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
                  className="w-full bg-white border border-zinc-200 rounded-2xl py-4 pl-4 pr-12 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-300 transition-all resize-none shadow-sm"
                />
                <Button
                  type={isLoading ? "button" : "submit"}
                  size="icon"
                  disabled={!isLoading && !input.trim()}
                  onClick={isLoading ? handleStopGeneration : undefined}
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-xl !bg-zinc-700 hover:!bg-black disabled:!bg-zinc-200 transition-all duration-300 hover:scale-110 active:scale-95"
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
