"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n";
import { AgentNav } from "@/components/chat/AgentNav";
import { MobileWorkspaceMenu } from "@/components/chat/MobileWorkspaceMenu";
import { WorkerEnrollmentPanel } from "@/components/tasks/WorkerEnrollmentPanel";
import { PublicWorkerAdminPanel } from "@/components/tasks/PublicWorkerAdminPanel";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ListTodo, RefreshCw } from "lucide-react";
import { listTasks, type TaskItem, type TaskStatus } from "@/lib/api/tasks";
import { WorkspaceUserFooter } from "@/components/chat/WorkspaceUserFooter";

const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "tasks.statusDraft",
  queued: "tasks.statusQueued",
  claimed: "tasks.statusClaimed",
  running: "tasks.statusRunning",
  succeeded: "tasks.statusSucceeded",
  failed: "tasks.statusFailed",
  cancelled: "tasks.statusCancelled",
  timeout: "tasks.statusTimeout",
};

interface TaskListProps {
  tasks: TaskItem[];
  loading: boolean;
  listError: string | null;
  emptyLabel: string;
  processingLabel: string;
  errorLabel: string;
  statusLabel: (status: TaskStatus) => string;
  onOpenTask: (taskId: string) => void;
}

function TaskList({
  tasks,
  loading,
  listError,
  emptyLabel,
  processingLabel,
  errorLabel,
  statusLabel,
  onOpenTask,
}: TaskListProps) {
  if (loading && tasks.length === 0) {
    return <div className="px-2 py-4 text-center text-xs text-zinc-400">{processingLabel}...</div>;
  }
  if (listError) {
    return <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-xs leading-5 text-red-700">{errorLabel}: {listError}</div>;
  }
  if (tasks.length === 0) {
    return <div className="rounded-xl border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-400">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-1">
      {tasks.map((task) => (
        <button
          key={task.task_id}
          type="button"
          className="w-full rounded-xl px-3 py-2 text-left transition-colors hover:bg-zinc-100"
          onClick={() => onOpenTask(task.task_id)}
        >
          <div className="truncate text-xs font-medium text-zinc-700">{task.title}</div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-zinc-400">
            <span className="truncate">{statusLabel(task.status)}</span>
            <span className="shrink-0">{task.attempt_count}/{task.max_attempts}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

/** Task Center owns task creation, worker enrollment, and task history. */
export default function CodeAgentPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);

  const loadTasks = useCallback(async () => {
    const requestId = ++requestSequenceRef.current;
    try {
      const items = await listTasks();
      if (requestId !== requestSequenceRef.current) return;
      setTasks(items);
      setListError(null);
    } catch (err) {
      if (requestId !== requestSequenceRef.current) return;
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestSequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    const timer = setInterval(() => { void loadTasks(); }, 5000);
    return () => clearInterval(timer);
  }, [loadTasks]);

  return (
    <div className="flex h-screen bg-transparent font-sans text-zinc-900">
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-[var(--hairline)] bg-[var(--surface-1)] p-3 backdrop-blur-xl md:flex print:hidden">
        <AgentNav active="tasks" onNavigate={(path: string) => router.push(path)} />
        <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          <div className="px-2 text-[11px] uppercase tracking-[0.2em] text-zinc-400">{t("tasks.title")}</div>
          <TaskList
            tasks={tasks}
            loading={loading}
            listError={listError}
            emptyLabel={t("tasks.empty")}
            processingLabel={t("run.processing")}
            errorLabel={t("tasks.listFailedToast")}
            statusLabel={(status) => t(STATUS_LABEL[status] as never)}
            onOpenTask={(taskId) => router.push(`/task-center/tasks/${taskId}`)}
          />
        </div>
        <WorkspaceUserFooter />
        <div className="p-2 text-center text-xs tracking-tighter text-zinc-400">v1.0.0 @ 2026</div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[var(--hairline)] bg-[var(--surface-1)] px-4 backdrop-blur-xl print:hidden">
          <div className="flex items-center gap-2">
            <MobileWorkspaceMenu
              active="tasks"
              taskItems={tasks.map((task) => ({
                task_id: task.task_id,
                title: task.title,
                statusLabel: t(STATUS_LABEL[task.status] as never),
              }))}
            />
            <ListTodo size={16} className="text-zinc-500" />
            <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("tasks.title")}</div>
          </div>
        </header>

        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-6xl p-4 md:p-6">
            <div className="space-y-6">
              <section className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-700">{t("tasks.confirmationOnlyTitle")}</div>
                  <p className="mt-1 text-xs text-zinc-500">{t("tasks.confirmationOnlyDescription")}</p>
                </div>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setLoading(true); void loadTasks(); }} disabled={loading}>
                  <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                  {t("tasks.refresh")}
                </Button>
              </section>

              <WorkerEnrollmentPanel />
              <PublicWorkerAdminPanel />
            </div>
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
