"use client";

import { AlertCircle, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage, type TranslationKey } from "@/lib/i18n";
import type { PaperTaskRuntime } from "@/hooks/use-paper-progress";
import type { PaperResourceProgressStatus } from "@/lib/api/papers";
import { useState } from "react";

interface PaperProgressPanelProps {
  tasks: PaperTaskRuntime[];
  onResume: (task: PaperTaskRuntime) => Promise<void> | void;
}

function statusLabel(status: PaperResourceProgressStatus, t: ReturnType<typeof useLanguage>["t"]): string {
  const labels: Record<PaperResourceProgressStatus, TranslationKey> = {
    requested: "paper.statusRequested",
    downloading: "paper.statusDownloading",
    extracting: "paper.statusExtracting",
    uploading: "paper.statusUploading",
    ready: "paper.statusReady",
    failed: "paper.statusFailed",
    cancelled: "paper.statusCancelled",
  };
  return t(labels[status]);
}

function PaperProgressCard({ task, onResume }: { task: PaperTaskRuntime; onResume: PaperProgressPanelProps["onResume"] }) {
  const { t } = useLanguage();
  const [resumeError, setResumeError] = useState(false);
  const progress = task.progress;
  const status = progress?.resource.status;
  const readyForResume = progress !== null && status === "ready" && progress.resume.available && !task.resuming;

  const submitResume = async () => {
    setResumeError(false);
    try {
      await onResume(task);
    } catch {
      setResumeError(true);
    }
  };

  return (
    <article data-testid={`paper-task-${task.candidate.resourceId}`} className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-xl bg-white p-2 text-sky-700"><FileText size={17} /></div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-zinc-800">{progress?.resource.title || t("paper.untitled")}</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-600">{t("paper.taskDescription")}</p>
          </div>
        </div>
        <span data-testid={`paper-status-${task.candidate.resourceId}`} className="shrink-0 rounded-full border border-sky-200 bg-white px-2.5 py-1 text-xs font-medium text-sky-800">
          {status ? statusLabel(status, t) : t("paper.statusSyncing")}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
        <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-white px-2.5 py-1">
          <CheckCircle2 size={13} className="text-sky-700" />
          {t("paper.materializeAccepted")}
        </span>
        {progress && progress.resource.page_count !== null && progress.resource.image_count !== null && (
          <span>{t("paper.counts", { pages: progress.resource.page_count, images: progress.resource.image_count })}</span>
        )}
        {task.phase === "error" && <span className="inline-flex items-center gap-1 text-amber-700"><Loader2 size={13} className="animate-spin" />{t("paper.progressRetrying")}</span>}
      </div>

      {progress && status === "failed" && progress.resource.error?.message && (
        <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{progress.resource.error.message}</div>
      )}

      {progress && status === "ready" && progress.resume.available && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" className="rounded-xl" onClick={() => void submitResume()} disabled={!readyForResume}>
            {task.resuming ? <Loader2 size={14} className="animate-spin" /> : null}
            {task.resuming ? t("paper.resuming") : t("paper.resume")}
          </Button>
          {resumeError && <span role="alert" className="text-xs text-red-700">{t("paper.resumeFailed")}</span>}
        </div>
      )}

      {progress && status === "ready" && !progress.resume.available && (
        <p className="mt-3 text-xs text-zinc-600">{t("paper.readyNoResume")}</p>
      )}

      {progress && status === "failed" && !progress.resource.error?.message && (
        <div className="mt-3 inline-flex items-center gap-1 text-xs text-red-700"><AlertCircle size={13} />{t("paper.statusFailed")}</div>
      )}
    </article>
  );
}

export function PaperProgressPanel({ tasks, onResume }: PaperProgressPanelProps) {
  const visibleTasks = tasks.filter((task) => task.phase !== "absent" && task.phase !== "denied");
  if (visibleTasks.length === 0) return null;
  return (
    <section data-testid="paper-progress-panel" aria-label="Paper progress" className="space-y-3">
      {visibleTasks.map((task) => <PaperProgressCard key={task.candidate.resourceId} task={task} onResume={onResume} />)}
    </section>
  );
}
