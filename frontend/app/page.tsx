"use client";

import { useRouter } from "next/navigation";
import { LogIn, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SessionList } from "@/components/chat/SessionList";
import { MessagePane } from "@/components/chat/MessagePane";
import { Composer } from "@/components/chat/Composer";
import { useChatController } from "@/hooks/use-chat-controller";
import { redirectToLogin } from "@/lib/runtime-config";
import { useLanguage } from "@/lib/i18n";
import { MobileWorkspaceDrawer } from "@/components/workspace/MobileWorkspaceDrawer";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";

/**
 * Analysis is the canonical home page. Task creation cards are rendered by
 * the conversation when Analysis calls request_task_creation; they are not a
 * permanent page-level form.
 */
export default function ChatPage() {
  const router = useRouter();
  const controller = useChatController();
  const { t } = useLanguage();

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <WorkspaceSidebar active="analysis" onNavigate={(path) => router.push(path)} showVersion>
        <Button
          variant="outline"
          className="mt-3 shrink-0 justify-start gap-2 rounded-xl border-[var(--hairline)] bg-white/90 shadow-sm hover:bg-white"
          onClick={controller.handleNewChat}
        >
          <Plus size={16} />
          {t("home.newChat")}
        </Button>
        <div className="mt-3 shrink-0 px-2 text-xs uppercase tracking-widest text-zinc-400">{t("home.recentActivities")}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
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
        </div>
      </WorkspaceSidebar>

      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
          <div className="flex items-center gap-2">
            <MobileWorkspaceDrawer active="analysis" onNavigate={(path) => router.push(path)}>
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
                onSaveSessionTitle={(sessionId) => { void controller.saveInlineSessionTitle(sessionId); }}
                onCancelEditing={controller.cancelInlineSessionTitle}
                onRequestDelete={controller.requestDeleteSession}
                onCancelDelete={controller.cancelDeleteSession}
                onConfirmDelete={(session) => { void controller.confirmDeleteSession(session); }}
              />
            </MobileWorkspaceDrawer>
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
            <MessagePane
              messages={controller.messages}
              sessionId={controller.state.sessionId}
              isLoading={controller.isLoading}
              runState={controller.currentRunState}
              statusText={controller.statusText}
              scrollRef={controller.scrollRef}
              authStatus={controller.authStatus}
              onLogin={redirectToLogin}
              onTaskCreated={(confirmationId, taskId) => {
                void controller.handleTaskConfirmationCreated(confirmationId, taskId);
              }}
            />
          </div>
        </div>

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
          unauthenticated={controller.authStatus === "unauthenticated"}
        />
      </main>
    </div>
  );
}
