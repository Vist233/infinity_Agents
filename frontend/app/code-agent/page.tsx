"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskCreationCard } from "@/components/tasks/TaskCreationCard";
import { TaskListPanel } from "@/components/tasks/TaskListPanel";
import { WorkerEnrollmentPanel } from "@/components/tasks/WorkerEnrollmentPanel";
import { MobileWorkspaceDrawer } from "@/components/workspace/MobileWorkspaceDrawer";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { ListTodo } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { listTasks, type TaskItem } from "@/lib/api/tasks";

/** Task execution center: task context on the left, task actions on the right. */
export default function CodeAgentPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [draftDirty, setDraftDirty] = useState(false);

  const loadTasks = useCallback(async () => {
    try {
      const items = await listTasks();
      setTasks(items);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    const timer = setInterval(() => { void loadTasks(); }, 5000);
    return () => clearInterval(timer);
  }, [loadTasks]);

  const formatDate = useMemo(
    () => (iso: string) => {
      if (!iso) return "-";
      try { return new Date(iso).toLocaleString(); } catch { return iso; }
    },
    [],
  );

  const startNewTask = useCallback(() => {
    if (draftDirty && typeof window !== "undefined" && !window.confirm(t("tasks.discardDraft"))) return;
    setDraftDirty(false);
    setDraftKey((value) => value + 1);
  }, [draftDirty, t]);

  const refreshTasks = useCallback(() => {
    setLoading(true);
    void loadTasks();
  }, [loadTasks]);

  return (
    <div className="flex h-screen min-h-0 bg-transparent font-sans text-zinc-900">
      <WorkspaceSidebar active="tasks" onNavigate={(path: string) => router.push(path)} showVersion>
        <div className="mt-4 min-h-0 flex-1 border-t border-[var(--hairline)] pt-4">
          <TaskListPanel
            tasks={tasks}
            loading={loading}
            error={listError}
            onNewTask={startNewTask}
            onRetry={refreshTasks}
            onSelect={(task) => router.push(`/code-agent/tasks/?task_id=${encodeURIComponent(task.task_id)}`)}
            formatDate={formatDate}
          />
        </div>
      </WorkspaceSidebar>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[var(--hairline)] bg-[var(--surface-1)] px-4 backdrop-blur-xl print:hidden">
          <div className="flex items-center gap-2">
            <MobileWorkspaceDrawer active="tasks" onNavigate={(path) => router.push(path)}>
              <TaskListPanel
                tasks={tasks}
                loading={loading}
                error={listError}
                onNewTask={startNewTask}
                onRetry={refreshTasks}
                onSelect={(task) => router.push(`/code-agent/tasks/?task_id=${encodeURIComponent(task.task_id)}`)}
                formatDate={formatDate}
              />
            </MobileWorkspaceDrawer>
            <ListTodo size={16} className="text-zinc-500" />
            <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("tasks.title")}</div>
          </div>
        </header>

        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
            <TaskCreationCard
              resetKey={draftKey}
              onDirtyChange={setDraftDirty}
              onCreated={() => { void loadTasks(); }}
            />
            <WorkerEnrollmentPanel />
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
