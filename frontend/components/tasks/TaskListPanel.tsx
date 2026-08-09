"use client";

import { ListTodo, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import type { TaskItem, TaskStatus } from "@/lib/api/tasks";

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

interface TaskListPanelProps {
  tasks: TaskItem[];
  loading: boolean;
  error: string | null;
  onNewTask: () => void;
  onRetry: () => void;
  onSelect: (task: TaskItem) => void;
  formatDate: (iso: string) => string;
}

export function TaskListPanel({ tasks, loading, error, onNewTask, onRetry, onSelect, formatDate }: TaskListPanelProps) {
  const { t } = useLanguage();
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="task-list-panel">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">
          <ListTodo size={14} className="shrink-0" />
          <span className="truncate">{t("tasks.subtitle")}</span>
        </div>
        <Button type="button" size="sm" className="h-8 shrink-0 gap-1.5 rounded-lg px-2.5" onClick={onNewTask} data-testid="new-task-button">
          <Plus size={14} />
          <span>{t("tasks.newTask")}</span>
        </Button>
      </div>

      <div className="mt-2 flex items-center justify-end">
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-zinc-500" onClick={onRetry} disabled={loading}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          {t("composer.retry")}
        </Button>
      </div>

      {error && <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs leading-5 text-red-700">{t("tasks.listFailed").replace("{{message}}", error)}</div>}

      <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {!loading && tasks.length === 0 && !error && (
          <div className="flex min-h-24 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-200 px-3 py-5 text-center">
            <ListTodo size={24} className="mb-2 text-zinc-300" />
            <p className="text-xs text-zinc-500">{t("tasks.noTasksYet")}</p>
          </div>
        )}
        {loading && tasks.length === 0 && <div className="px-2 py-3 text-xs text-zinc-400">{t("run.processing")}…</div>}
        {tasks.map((task) => (
          <button
            type="button"
            key={task.task_id}
            className="w-full rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:border-[var(--hairline)] hover:bg-white/80"
            onClick={() => onSelect(task)}
            title={task.title}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-zinc-700">{task.title}</span>
              <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[task.status] || "bg-zinc-200 text-zinc-600"}`}>
                {t(STATUS_LABEL[task.status] as never)}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">{formatDate(task.created_at)} · {task.attempt_count}/{task.max_attempts}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
