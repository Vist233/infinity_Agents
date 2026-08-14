"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n";
import { AgentNav } from "@/components/chat/AgentNav";
import { MobileWorkspaceMenu } from "@/components/chat/MobileWorkspaceMenu";
import { TaskCreationCard } from "@/components/tasks/TaskCreationCard";
import { TaskListPanel } from "@/components/tasks/TaskListPanel";
import { WorkerEnrollmentPanel } from "@/components/tasks/WorkerEnrollmentPanel";
import { PublicWorkerAdminPanel } from "@/components/tasks/PublicWorkerAdminPanel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ListTodo, LogIn } from "lucide-react";
import { listTasks, type TaskItem, type TaskStatus } from "@/lib/api/tasks";
import { WorkspaceUserFooter } from "@/components/chat/WorkspaceUserFooter";
import { getCurrentUser } from "@/lib/api/auth";
import { redirectToLogin } from "@/lib/runtime-config";

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
export default function CodeAgentPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [creationResetKey, setCreationResetKey] = useState(0);
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated" | "error">("checking");
  const [authError, setAuthError] = useState<string | null>(null);
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
    let cancelled = false;
    void getCurrentUser()
      .then((user) => {
        if (cancelled) return;
        if (!user) {
          setAuthStatus("unauthenticated");
          setAuthError(null);
          setTasks([]);
          setLoading(false);
          return;
        }
        setAuthStatus("authenticated");
        setAuthError(null);
        void loadTasks();
      })
      .catch((error) => {
        if (!cancelled) {
          setAuthStatus("error");
          setAuthError(error instanceof Error ? error.message : t("error.backendUnavailable"));
          setTasks([]);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [loadTasks, t]);

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
        {authStatus === "authenticated" && <div className="mt-4 min-h-0 flex-1 pr-1">
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
        </div>}
        {authStatus === "authenticated" && <WorkspaceUserFooter />}
        <div className="p-2 text-center text-xs tracking-tighter text-zinc-400">v1.0.0 @ 2026</div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[var(--hairline)] bg-[var(--surface-1)] px-4 backdrop-blur-xl print:hidden">
          <div className="flex items-center gap-2">
            <MobileWorkspaceMenu
              active="tasks"
              onNewTask={authStatus === "authenticated" ? handleNewTask : undefined}
              taskItems={authStatus === "authenticated" ? tasks.map((task) => ({
                task_id: task.task_id,
                title: task.title,
                statusLabel: t(STATUS_LABEL[task.status] as never),
              })) : undefined}
            />
            <ListTodo size={16} className="text-zinc-500" />
            <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("tasks.title")}</div>
          </div>
          {authStatus === "unauthenticated" && <Button type="button" size="sm" className="gap-2" onClick={redirectToLogin}>
            <LogIn size={15} />
            {t("home.signInRegister")}
          </Button>}
        </header>

        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-6xl p-4 md:p-6">
            {authStatus === "authenticated" ? <div className="space-y-6">
              <TaskCreationCard resetKey={creationResetKey} onCreated={handleCreated} />
              <WorkerEnrollmentPanel />
              <PublicWorkerAdminPanel />
            </div> : authStatus === "unauthenticated" ? <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm"><LogIn size={20} className="text-zinc-500" /></div>
              <div className="space-y-2">
                <h2 className="text-2xl font-medium tracking-tight">{t("auth.signInTitle")}</h2>
                <p className="max-w-md text-sm text-zinc-500">{t("auth.signInDescription")}</p>
              </div>
              <Button type="button" className="gap-2 rounded-xl" onClick={redirectToLogin}>
                <LogIn size={16} />
                {t("auth.signIn")}
              </Button>
            </div> : authStatus === "error" ? <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
              <p className="max-w-md text-sm text-red-600">{t("error.backendUnavailable")}: {authError}</p>
              <Button type="button" variant="outline" onClick={() => window.location.reload()}>{t("composer.retry")}</Button>
            </div> : null}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
