"use client";

import { useRouter } from "next/navigation";
import { LogIn, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentNav } from "@/components/chat/AgentNav";
import { SessionList } from "@/components/chat/SessionList";
import { MessagePane } from "@/components/chat/MessagePane";
import { Composer } from "@/components/chat/Composer";
import { useChatController } from "@/hooks/use-chat-controller";
import { redirectToLogin } from "@/lib/runtime-config";
import { useLanguage } from "@/lib/i18n";
import { TaskConfirmationCard } from "@/components/analysis/TaskConfirmationCard";
import { MobileWorkspaceMenu } from "@/components/chat/MobileWorkspaceMenu";
import { WorkspaceUserFooter } from "@/components/chat/WorkspaceUserFooter";

/** Workspace for the Analysis Agent conversation. */
export function ChatWorkspace() {
  const router = useRouter();
  const controller = useChatController();
  const { t } = useLanguage();
  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
        <AgentNav active="analysis" onNavigate={(path) => router.push(path)} />
        <Button
          variant="outline"
          className="justify-start gap-2 bg-white/90 border-[var(--hairline)] shadow-sm hover:bg-white mt-3 rounded-xl"
          onClick={controller.handleNewChat}
        >
          <Plus size={16} />
          {t("home.newChat")}
        </Button>
        <div className="mt-3 text-xs uppercase tracking-widest text-zinc-400 px-2">{t("home.recentActivities")}</div>
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
        <WorkspaceUserFooter />
        <div className="p-2 text-xs text-zinc-400 text-center tracking-tighter">v1.0.0 @ 2026</div>
      </aside>

      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
          <div className="flex items-center gap-2">
            <MobileWorkspaceMenu
              active="analysis"
              sessions={controller.state.sessions}
              currentSessionId={controller.state.sessionId}
              editingSessionId={controller.state.editingSessionId}
              editingTitle={controller.state.editingTitle}
              deletingSessionId={controller.state.deletingSessionId}
              sessionRunMap={controller.state.sessionRunMap}
              onNewChat={controller.handleNewChat}
              onSwitchSession={controller.handleSwitchSession}
              onEditSessionTitle={controller.handleEditSessionTitle}
              onEditingTitleChange={controller.setEditingTitle}
              onSaveSessionTitle={(sessionId) => { void controller.saveInlineSessionTitle(sessionId); }}
              onCancelEditing={controller.cancelInlineSessionTitle}
              onRequestDelete={controller.requestDeleteSession}
              onCancelDelete={controller.cancelDeleteSession}
              onConfirmDelete={(session) => { void controller.confirmDeleteSession(session); }}
            />
            <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("nav.analysis")}</div>
          </div>
          <div className="flex items-center gap-2">
            {controller.authStatus === "unauthenticated" ? (
              <Button size="sm" className="gap-2" onClick={redirectToLogin}>
                <LogIn size={15} />
                {t("home.signInRegister")}
              </Button>
            ) : null}
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-5xl mx-auto w-full p-4 md:p-6 space-y-4">
            {controller.taskConfirmationRequested && (
              <TaskConfirmationCard onCreated={() => {
                controller.clearTaskConfirmation();
                void controller.retryLoadSessions();
              }} />
            )}
            <MessagePane
              messages={controller.messages}
              sessionId={controller.state.sessionId}
              isLoading={controller.isLoading}
              runState={controller.currentRunState}
              statusText={controller.statusText}
              scrollRef={controller.scrollRef}
              authStatus={controller.authStatus}
              onLogin={redirectToLogin}
            />
          </div>
        </div>

        <Composer
          input={controller.state.input}
          isLoading={controller.isLoading}
          inlineError={controller.state.uiError}
          inputRef={controller.inputRef}
          onInputChange={controller.setInput}
          onSubmit={(event) => {
            void controller.handleSubmit(event);
          }}
          onStop={controller.handleStopGeneration}
          onRetry={() => {
            void controller.retryLoadSessions();
          }}
          onDismissError={controller.dismissError}
          unauthenticated={controller.authStatus === "unauthenticated"}
        />
      </main>
    </div>
  );
}
