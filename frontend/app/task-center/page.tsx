"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n";
import { AgentNav } from "@/components/workspace/AgentNav";
import { MobileWorkspaceMenu } from "@/components/workspace/MobileWorkspaceMenu";
import { TaskCreationCard } from "@/components/tasks/TaskCreationCard";
import { TaskListPanel } from "@/components/tasks/TaskListPanel";
import { WorkerEnrollmentPanel } from "@/components/tasks/WorkerEnrollmentPanel";
import { PublicWorkerAdminPanel } from "@/components/tasks/PublicWorkerAdminPanel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ListTodo } from "lucide-react";
import { listTasks, type TaskItem, type TaskStatus } from "@/lib/api/tasks";
import { WorkspaceUserFooter } from "@/components/workspace/WorkspaceUserFooter";

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

/** Task Center owns task creation, worker enrollment, and task history. */
export default function TaskCenterPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [creationResetKey, setCreationResetKey] = useState(0);
  const authStatus = "authenticated" as const;
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
  }, [loadTasks]);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    const timer = setInterval(() => { void loadTasks(); }, 5000);
    return () => clearInterval(timer);
  }, [authStatus, loadTasks]);

  const formatDate = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
  };

  const handleNewTask = () => {
    setSelectedTaskId(null);
    setCreationResetKey((value) => value + 1);
  };

  const handleCreated = (taskId: string) => {
    void loadTasks();
    router.push(`/task-center/tasks/${taskId}`);
  };

  return (
    <div className="flex h-screen bg-transparent font-sans text-zinc-900">
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-[var(--hairline)] bg-[var(--surface-1)] p-3 backdrop-blur-xl md:flex print:hidden">
        <AgentNav active="tasks" onNavigate={(path: string) => router.push(path)} />
        <div className="mt-4 min-h-0 flex-1 pr-1">
          <TaskListPanel
            tasks={tasks}
            loading={loading}
            error={listError}
            selectedTaskId={selectedTaskId}
            onNewTask={handleNewTask}
            onRetry={() => { setLoading(true); void loadTasks(); }}
            onSelect={(task) => {
              setSelectedTaskId(task.task_id);
              router.push(`/task-center/tasks/${task.task_id}`);
            }}
            formatDate={formatDate}
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
              onNewTask={handleNewTask}
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
              <TaskCreationCard resetKey={creationResetKey} onCreated={handleCreated} />
              <WorkerEnrollmentPanel />
              <PublicWorkerAdminPanel />
            </div>
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
