"use client";

import { useRouter } from "next/navigation";
import { LanguageToggle, useLanguage } from "@/lib/i18n";
import { AgentNav } from "@/components/chat/AgentNav";
import { SessionList } from "@/components/chat/SessionList";
import { MessagePane } from "@/components/chat/MessagePane";
import { Composer } from "@/components/chat/Composer";
import { useChatController } from "@/hooks/use-chat-controller";
import { Button } from "@/components/ui/button";
import { Plus, ListTodo } from "lucide-react";

export default function CodeAgentPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const controller = useChatController();

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const value = controller.state.input.trim();
    if (!value) return;
    if (controller.authStatus === "unauthenticated") {
      window.location.assign("/auth/login");
      return;
    }

    let targetSessionId: string | null = controller.state.sessionId;
    if (!targetSessionId) {
      try {
        const res = await fetch("/api/code/sessions", { method: "POST", credentials: "include" });
        if (!res.ok) {
          controller.setError(t("error.createSession"));
          return;
        }
        const data = await res.json();
        if (!data.session_id) {
          controller.setError(t("error.createSession"));
          return;
        }
        targetSessionId = data.session_id;
        controller.dispatch({ type: "set_session_id", sessionId: targetSessionId });
        controller.dispatch({
          type: "upsert_session",
          toTop: true,
          session: {
            session_id: targetSessionId!,
            title: value.slice(0, 32),
            created_at: "",
            updated_at: "",
          },
        });
        controller.dispatch({ type: "set_session_messages", sessionId: targetSessionId!, messages: [] });
      } catch (err) {
        console.error("Failed to create code session:", err);
        controller.setError(t("error.createSession"));
        return;
      }
    }

    const baseMessages = controller.sessionMessagesMapRef.current[targetSessionId!] || [];
    const userMessage = { role: "user" as const, content: value };
    const messagesForRequest = [...baseMessages, userMessage];
    controller.dispatch({
      type: "set_session_messages",
      sessionId: targetSessionId!,
      messages: [...baseMessages, userMessage, { role: "assistant", content: "" }],
    });
    controller.dispatch({ type: "set_input", input: "" });

    const clientRequestId = crypto.randomUUID();
    const isCurrent = () => controller.state.sessionRunMap[targetSessionId!]?.requestId === clientRequestId;
    const finalize = (terminal: "success" | "error") => {
      if (!isCurrent()) return;
      controller.setSessionRunState(targetSessionId!, { running: false, phase: null, terminal, requestId: null });
    };

    const onEvent = (event: {
      type: string;
      phase?: string;
      elapsed_ms?: number;
      attempt?: number;
      max_attempts?: number;
      tool_name?: string;
      reason?: string;
      content?: string;
      message?: string;
    }) => {
      if (!isCurrent()) return;
      const toolName = event.tool_name || null;
      switch (event.type) {
        case "status":
          controller.setSessionRunState(targetSessionId!, {
            phase: event.phase as "thinking" | "tool_running" | "responding" | "retrying" | null,
            elapsedMs: event.elapsed_ms || 0,
            attempt: event.attempt || 1,
            maxAttempts: event.max_attempts || 1,
            toolName,
            reason: event.reason || null,
          });
          break;
        case "chunk":
          controller.appendAssistantContent(targetSessionId!, event.content || "");
          break;
        case "tool_call":
          controller.setSessionRunState(targetSessionId!, (prev) => ({
            ...prev,
            hasReceivedToolCall: true,
            toolName,
            activeTools: Array.isArray(prev.activeTools) && prev.activeTools && toolName && prev.activeTools.includes(toolName)
              ? prev.activeTools
              : [...(prev.activeTools as string[]), ...(toolName ? [toolName] : [])],
          }));
          break;
        case "done":
          finalize("success");
          void controller.refreshSessions();
          break;
        case "error":
          controller.appendAssistantContent(targetSessionId!, `\n\n[Error] ${event.message || t("error.connection")}`);
          finalize("error");
          break;
      }
    };

    let ws: WebSocket | null = null;
    try {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      ws = new WebSocket(`${proto}//${host}/ws/code`);

      ws.onopen = () => {
        ws!.send(JSON.stringify({
          session_id: targetSessionId!,
          messages: messagesForRequest,
          client_request_id: clientRequestId,
        }));
      };

      ws.onmessage = (evt) => {
        try {
          const event = JSON.parse(evt.data);
          onEvent(event);
          if (event.type === "done" || event.type === "error") {
            ws!.close(1000, "completed");
          }
        } catch {
          onEvent({ type: "chunk", content: evt.data });
        }
      };

      ws.onerror = () => {
        controller.appendAssistantContent(targetSessionId!, `\n\n[Error] ${t("error.network")}`);
        finalize("error");
      };

      ws.onclose = () => {
        if (!isCurrent()) return;
        const state = controller.state.sessionRunMap[targetSessionId!];
        if (state && state.running) {
          finalize("error");
        }
      };

      controller.wsByRequestRef.current.set(clientRequestId, {
        close: () => ws?.close(1000, "client_stop"),
        getReadyState: () => ws ? ws.readyState : 3,
      });
    } catch (err) {
      console.error("CodeAgent WS failed:", err);
      finalize("error");
    }
  };

  const sessionId = controller.state.sessionId;
  const messages = controller.sessionMessagesMapRef.current[sessionId || ""] || [];
  const currentRunState = controller.state.sessionRunMap[sessionId || ""] || { running: false, phase: null };
  const isLoading = !!currentRunState.running;
  const statusText = controller.statusText;
  const scrollRef = { current: null as HTMLDivElement | null };
  const inputRef = { current: null as HTMLTextAreaElement | null };
  const setInput = (input: string) => controller.dispatch({ type: "set_input", input });
  const uiError = controller.state.uiError;
  const dismissError = () => controller.setError(null);

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
        <AgentNav active="code" onNavigate={(path: string) => router.push(path)} />
        <Button variant="outline" className="justify-start gap-2 bg-white/90 border-[var(--hairline)] shadow-sm hover:bg-white mt-3 rounded-xl" onClick={controller.handleNewChat}>
          <Plus size={16} />
          {t("home.newChat")}
        </Button>
        <Button variant="outline" className="justify-start gap-2 bg-white/90 border-[var(--hairline)] shadow-sm hover:bg-white mt-2 rounded-xl" onClick={() => router.push("/code-agent/tasks")}>
          <ListTodo size={16} />
          {t("tasks.title")}
        </Button>
        <div className="mt-3 text-xs uppercase tracking-widest text-zinc-400 px-2">{t("home.recentActivities")}</div>
        <SessionList
          sessions={controller.state.sessions}
          currentSessionId={sessionId}
          editingSessionId={controller.state.editingSessionId}
          editingTitle={controller.state.editingTitle}
          deletingSessionId={controller.state.deletingSessionId}
          sessionRunMap={controller.state.sessionRunMap}
          onSwitchSession={controller.handleSwitchSession}
          onEditSessionTitle={controller.handleEditSessionTitle}
          onEditingTitleChange={controller.setEditingTitle}
          onSaveSessionTitle={(sid: string) => { void controller.saveInlineSessionTitle(sid); }}
          onCancelEditing={controller.cancelInlineSessionTitle}
          onRequestDelete={controller.requestDeleteSession}
          onCancelDelete={controller.cancelDeleteSession}
          onConfirmDelete={controller.confirmDeleteSession}
        />
        <div className="flex-1" />
        <div className="p-2 text-xs text-zinc-400 text-center tracking-tighter">v1.0.0 @ 2026</div>
      </aside>
      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
          <div className="text-sm font-semibold tracking-tight text-zinc-700">CodeAgent</div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => router.push("/code-agent/tasks")}>
              <ListTodo size={14} />
              {t("tasks.title")}
            </Button>
            <LanguageToggle />
          </div>
        </header>
        <MessagePane
          messages={messages}
          sessionId={sessionId}
          isLoading={isLoading}
          runState={currentRunState}
          statusText={statusText}
          scrollRef={scrollRef}
          authStatus={controller.authStatus}
          onLogin={() => { window.location.assign("/auth/login"); }}
        />
        <Composer
          input={controller.state.input}
          isLoading={isLoading}
          uploadingPdf={false}
          uploadedPapers={[]}
          inlineError={uiError}
          inputRef={inputRef}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onUploadPdf={() => {}}
          onStop={controller.handleStopGeneration}
          onRetry={() => { void controller.refreshSessions(); }}
          onDismissError={dismissError}
          unauthenticated={controller.authStatus === "unauthenticated"}
        />
      </main>
    </div>
  );
}
