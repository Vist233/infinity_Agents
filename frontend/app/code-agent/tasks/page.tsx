"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { AgentNav } from "@/components/chat/AgentNav";
import { Button } from "@/components/ui/button";
import { LanguageToggle, useLanguage } from "@/lib/i18n";
import { cancelTask, getJson } from "@/lib/api/tasks";

type TaskStatus = "draft" | "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

interface TaskDetail {
  task_id: string;
  title: string;
  status: TaskStatus;
  attempt_count: number;
  max_attempts: number;
  error_message?: string | null;
  created_at: string;
  finished_at?: string | null;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "tasks.statusDraft", queued: "tasks.statusQueued", claimed: "tasks.statusClaimed",
  running: "tasks.statusRunning", succeeded: "tasks.statusSucceeded", failed: "tasks.statusFailed",
  cancelled: "tasks.statusCancelled", timeout: "tasks.statusTimeout",
};

export default function TaskDetailPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = async () => {
    if (!taskId) return;
    setLoading(true);
    setError(null);
    try {
      setTask(await getJson<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTaskId(new URLSearchParams(window.location.search).get("task_id"));
  }, []);

  useEffect(() => {
    void load();
    if (!taskId) return;
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [taskId]);

  const terminal = task ? ["succeeded", "failed", "cancelled", "timeout"].includes(task.status) : true;

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
        <AgentNav active="tasks" onNavigate={(path) => router.push(path)} />
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between bg-[var(--surface-1)] backdrop-blur-xl z-10">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push("/code-agent")}><ArrowLeft size={16} /></Button>
            <div className="text-sm font-semibold text-zinc-700">{t("tasks.detailTitle")}</div>
          </div>
          <div className="flex items-center gap-2"><LanguageToggle /><Button variant="outline" size="sm" onClick={() => { void load(); }} disabled={loading}><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></Button></div>
        </header>
        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          {!taskId && <div className="max-w-3xl mx-auto rounded-2xl border border-zinc-200 bg-white/80 p-6 text-sm text-zinc-500">{t("tasks.emptyDescription")}</div>}
          {loading && !task && taskId && <div className="max-w-3xl mx-auto py-16 text-center text-sm text-zinc-500">{t("run.processing")}...</div>}
          {error && !task && <div className="max-w-3xl mx-auto rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("tasks.loadFailedToast")}: {error}</div>}
          {task && <div className="max-w-3xl mx-auto space-y-5">
            <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-5 space-y-4">
              <div className="flex items-center gap-2"><CheckCircle2 size={17} className={task.status === "succeeded" ? "text-emerald-500" : "text-zinc-400"} /><h1 className="text-lg font-semibold">{task.title}</h1></div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div><div className="text-xs text-zinc-400">{t("tasks.detailStatus")}</div><div className="mt-1 font-medium">{t(STATUS_LABEL[task.status] as never)}</div></div>
                <div><div className="text-xs text-zinc-400">{t("tasks.detailAttempts")}</div><div className="mt-1 font-medium">{task.attempt_count}/{task.max_attempts}</div></div>
                <div><div className="text-xs text-zinc-400">{t("tasks.detailCreatedAt")}</div><div className="mt-1 text-xs">{new Date(task.created_at).toLocaleString()}</div></div>
                <div><div className="text-xs text-zinc-400">{t("tasks.id")}</div><div className="mt-1 font-mono text-xs break-all">{task.task_id}</div></div>
              </div>
              {task.error_message && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{task.error_message}</div>}
              {!terminal && <Button variant="destructive" size="sm" disabled={cancelling} onClick={() => { void (async () => { setCancelling(true); try { await cancelTask(task.task_id); await load(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setCancelling(false); } })(); }}><XCircle size={14} className="mr-1" />{t("tasks.cancel")}</Button>}
            </section>
          </div>}
        </div>
      </main>
    </div>
  );
}
