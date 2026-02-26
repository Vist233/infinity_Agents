"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentNav } from "@/components/chat/AgentNav";
import { SessionList } from "@/components/chat/SessionList";
import { MessagePane } from "@/components/chat/MessagePane";
import { Composer } from "@/components/chat/Composer";
import { useChatController } from "@/hooks/use-chat-controller";

export default function ChatPage() {
  const router = useRouter();
  const controller = useChatController();

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
        <AgentNav onNavigate={(path) => router.push(path)} />
        <Button
          variant="outline"
          className="justify-start gap-2 bg-white/90 border-[var(--hairline)] shadow-sm hover:bg-white mt-3 rounded-xl"
          onClick={controller.handleNewChat}
        >
          <Plus size={16} />
          New Chat
        </Button>
        <div className="mt-3 text-xs uppercase tracking-widest text-zinc-400 px-2">Recent Activities</div>
        <SessionList
          sessions={controller.state.sessions}
          currentSessionId={controller.state.sessionId}
          editingSessionId={controller.state.editingSessionId}
          editingTitle={controller.state.editingTitle}
          deletingSessionId={controller.state.deletingSessionId}
          sessionRunMap={controller.state.sessionRunMap}
          onSwitchSession={controller.handleSwitchSession}
          onEditSessionTitle={controller.handleEditSessionTitle}
          onEditingTitleChange={controller.setEditingTitle}
          onSaveSessionTitle={(sessionId) => {
            void controller.saveInlineSessionTitle(sessionId);
          }}
          onCancelEditing={controller.cancelInlineSessionTitle}
          onRequestDelete={controller.requestDeleteSession}
          onCancelDelete={controller.cancelDeleteSession}
          onConfirmDelete={(session) => {
            void controller.confirmDeleteSession(session);
          }}
        />
        <div className="flex-1" />
        <div className="p-2 text-xs text-zinc-400 text-center tracking-tighter">v1.0.0 @ 2026</div>
      </aside>

      <main className="flex-1 flex flex-col relative">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
          <div className="text-sm font-semibold tracking-tight text-zinc-700">Paper Agent</div>
          <Button variant="outline" size="sm" className="text-zinc-600 hover:text-zinc-900" onClick={controller.handleExportPdf}>
            导出 PDF
          </Button>
        </header>

        <MessagePane
          messages={controller.messages}
          sessionId={controller.state.sessionId}
          isLoading={controller.isLoading}
          runState={controller.currentRunState}
          statusText={controller.statusText}
          scrollRef={controller.scrollRef}
        />

        <Composer
          input={controller.state.input}
          isLoading={controller.isLoading}
          uploadingPdf={controller.uploadingPdf}
          uploadedPapers={controller.uploadedPapers}
          inlineError={controller.state.uiError}
          inputRef={controller.inputRef}
          onInputChange={controller.setInput}
          onSubmit={(event) => {
            void controller.handleSubmit(event);
          }}
          onUploadPdf={(file) => {
            void controller.handleUploadPdf(file);
          }}
          onStop={controller.handleStopGeneration}
          onRetry={() => {
            void controller.retryLoadSessions();
          }}
          onDismissError={controller.dismissError}
        />
      </main>
    </div>
  );
}
