import { Button } from "@/components/ui/button";
import { Loader2, MessageCircle, Pencil, Trash2, X } from "lucide-react";
import { DEFAULT_RUN_STATE, type SessionItem, type SessionRunState } from "@/lib/chat-state";
import { useLanguage } from "@/lib/i18n";

interface SessionListProps {
  sessions: SessionItem[];
  currentSessionId: string | null;
  editingSessionId: string | null;
  editingTitle: string;
  deletingSessionId: string | null;
  sessionRunMap: Record<string, SessionRunState>;
  onSwitchSession: (id: string) => void;
  onEditSessionTitle: (session: SessionItem) => void;
  onEditingTitleChange: (value: string) => void;
  onSaveSessionTitle: (sessionId: string) => void;
  onCancelEditing: () => void;
  onRequestDelete: (session: SessionItem) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (session: SessionItem) => void;
}

export function SessionList({
  sessions,
  currentSessionId,
  editingSessionId,
  editingTitle,
  deletingSessionId,
  sessionRunMap,
  onSwitchSession,
  onEditSessionTitle,
  onEditingTitleChange,
  onSaveSessionTitle,
  onCancelEditing,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: SessionListProps) {
  const { t } = useLanguage();
  return (
    <div className="mt-2 space-y-1 overflow-y-auto">
      {sessions.length === 0 ? (
        <div className="text-xs text-zinc-400 px-2 py-2">{t("session.noActivities")}</div>
      ) : (
        sessions.map((session) => {
          const rowRunState = sessionRunMap[session.session_id] || DEFAULT_RUN_STATE;
          const isSelected = session.session_id === currentSessionId;
          const isDeleting = deletingSessionId === session.session_id;
          return (
            <div
              key={session.session_id}
              data-testid={`session-row-${session.session_id}`}
              className={`group w-full flex items-center gap-2 px-2 py-2 rounded-xl transition-all ${
                isSelected ? "bg-zinc-900 text-zinc-50" : "text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900"
              }`}
            >
              <div className="relative shrink-0 h-4 w-4">
                <MessageCircle size={14} className={isSelected ? "text-zinc-200" : "text-zinc-500"} />
                {rowRunState.running ? (
                  <Loader2
                    className={`absolute -right-1 -top-1 h-3.5 w-3.5 animate-spin ${
                      isSelected ? "text-zinc-200" : "text-zinc-500"
                    }`}
                  />
                ) : rowRunState.unreadDone ? (
                  <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-sky-500" />
                ) : null}
              </div>

              {editingSessionId === session.session_id ? (
                <div className="flex-1">
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => onEditingTitleChange(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => onSaveSessionTitle(session.session_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onSaveSessionTitle(session.session_id);
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        onCancelEditing();
                      }
                    }}
                    className="w-full bg-white border border-zinc-300 rounded-lg px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                  />
                </div>
              ) : (
                <button
                  onClick={() => onSwitchSession(session.session_id)}
                  className="flex-1 text-left text-sm truncate disabled:opacity-50"
                  title={session.title}
                  disabled={editingSessionId === session.session_id}
                  data-workspace-drawer-dismiss="true"
                >
                  {session.title || t("session.untitled")}
                </button>
              )}

              {isDeleting ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`confirm-delete-${session.session_id}`}
                    className={isSelected ? "text-zinc-200 hover:bg-zinc-700" : "text-red-600 hover:bg-red-100"}
                    onClick={() => onConfirmDelete(session)}
                    aria-label={t("session.confirmDelete")}
                  >
                    {t("session.confirm")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid={`cancel-delete-${session.session_id}`}
                    className={isSelected ? "text-zinc-200 hover:bg-zinc-700" : "text-zinc-500 hover:bg-zinc-200"}
                    onClick={onCancelDelete}
                    aria-label={t("session.cancelDelete")}
                  >
                    <X size={14} />
                  </Button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => onEditSessionTitle(session)}
                    data-testid={`edit-session-${session.session_id}`}
                    className={`p-1 rounded-md transition-all duration-150 ${
                      editingSessionId === session.session_id ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    } ${isSelected ? "text-zinc-200 hover:bg-zinc-700" : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"}`}
                    aria-label={t("session.edit")}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => onRequestDelete(session)}
                    data-testid={`delete-session-${session.session_id}`}
                    className={`p-1 rounded-md transition-all duration-150 ${
                      editingSessionId === session.session_id ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    } ${isSelected ? "text-zinc-200 hover:bg-zinc-700" : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"}`}
                    aria-label={t("session.delete")}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
