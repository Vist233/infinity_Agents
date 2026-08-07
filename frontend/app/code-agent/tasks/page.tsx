"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { AgentNav } from "@/components/chat/AgentNav";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowLeft, ListTodo, Plus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

type TaskStatus = "draft" | "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

interface Task {
  task_id: string;
  title: string;
  status: TaskStatus;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  draft: "bg-zinc-200 text-zinc-600",
  queued: "bg-blue-100 text-blue-700",
  claimed: "bg-purple-100 text-purple-700",
  running: "bg-amber-100 text-amber-700",
  succeeded: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-zinc-200 text-zinc-500",
  timeout: "bg-orange-100 text-orange-700",
};

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

export default function TasksPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTasks(); }, []);

  const formatDate = (iso: string) => {
    if (!iso) return "-";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
        <AgentNav active="tasks" onNavigate={(path) => router.push(path)} />
      </aside>
      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push("/code-agent")}>
              <ArrowLeft size={16} />
            </Button>
            <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("tasks.title")}</div>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={loadTasks} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            {t("composer.retry")}
          </Button>
        </header>

        <ScrollArea className="flex-1">
          <div className="max-w-4xl mx-auto p-4 md:p-6">
            <p className="text-sm text-zinc-500 mb-4">{t("tasks.subtitle")}</p>

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-4">
                {t("tasks.listFailedToast")}: {error}
              </div>
            )}

            {!loading && tasks.length === 0 && !error && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <ListTodo size={36} className="text-zinc-300 mb-3" />
                <p className="text-sm text-zinc-500">{t("tasks.empty")}</p>
                <p className="text-xs text-zinc-400 mt-1">{t("tasks.emptyDescription")}</p>
              </div>
            )}

            <div className="rounded-2xl border border-[var(--hairline)] bg-white/80 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--hairline)] bg-zinc-50/60 text-left">
                    <th className="px-4 py-3 font-medium text-zinc-500">{t("tasks.id")}</th>
                    <th className="px-4 py-3 font-medium text-zinc-500">{t("tasks.titleColumn")}</th>
                    <th className="px-4 py-3 font-medium text-zinc-500">{t("tasks.status")}</th>
                    <th className="px-4 py-3 font-medium text-zinc-500">{t("tasks.attempts")}</th>
                    <th className="px-4 py-3 font-medium text-zinc-500">{t("tasks.createdAt")}</th>
                    <th className="px-4 py-3 font-medium text-zinc-500">{t("tasks.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.task_id} className="border-b border-[var(--hairline)] last:border-b-0 hover:bg-zinc-50/60 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-zinc-500 max-w-[140px] truncate">{task.task_id}</td>
                      <td className="px-4 py-3 text-sm font-medium">{task.title}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[task.status] || "bg-zinc-200 text-zinc-600"}`}>
                          {t(STATUS_LABEL[task.status] as any)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-600">
                        {task.attempt_count}/{task.max_attempts}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap">{formatDate(task.created_at)}</td>
                      <td className="px-4 py-3">
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => router.push(`/code-agent/tasks/${task.task_id}`)}>
                          {t("tasks.view")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
