"use client";

import { useState } from "react";
import { CheckCircle2, FileArchive, FileSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import { submitTaskBundle } from "@/lib/api/tasks";

interface TaskConfirmationCardProps {
  onCreated?: (taskId: string) => void;
}

const METHOD_DOC_ACCEPT = ".html,.htm,.pdf,.md,.txt,.doc,.docx";
const DATASET_ACCEPT = ".zip";

/** The only browser entry point that can submit a formal Coding Task. */
export function TaskConfirmationCard({ onCreated }: TaskConfirmationCardProps) {
  const { t } = useLanguage();
  const [title, setTitle] = useState("");
  const [methodFile, setMethodFile] = useState<File | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  // Keep the operation identity stable across a network failure and retry.
  // Changing any input starts a new logical submission instead.
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const submit = async () => {
    if (!methodFile || !datasetFile) {
      setError(t("tasks.requireBoth"));
      return;
    }
    setSubmitting(true);
    setError(null);
    setCreatedTaskId(null);
    const submissionKey = idempotencyKey || (
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    if (!idempotencyKey) setIdempotencyKey(submissionKey);
    try {
      const taskTitle = title.trim() || methodFile.name.replace(/\.[^.]+$/, "");
      const task = await submitTaskBundle({
        methodFile,
        datasetFile,
        title: taskTitle,
        idempotencyKey: submissionKey,
      });
      setCreatedTaskId(task.task_id);
      onCreated?.(task.task_id);
      setTitle("");
      setMethodFile(null);
      setDatasetFile(null);
      setIdempotencyKey(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-5 space-y-4">
      <div>
        <div className="text-sm font-semibold text-zinc-700">{t("tasks.confirmationTitle")}</div>
        <p className="text-xs text-zinc-500 mt-1">{t("tasks.confirmationDescription")}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            <FileSearch size={16} className="text-zinc-500" />
            {t("tasks.methodDoc")}
          </div>
          <div className="text-xs text-zinc-400">{t("tasks.methodDocHint")}</div>
          <input type="file" accept={METHOD_DOC_ACCEPT} disabled={submitting} className="text-xs text-zinc-600" onChange={(event) => { setMethodFile(event.target.files?.[0] || null); setIdempotencyKey(null); }} />
          {methodFile && <span className="text-xs text-emerald-600 truncate">{methodFile.name}</span>}
        </label>

        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            <FileArchive size={16} className="text-zinc-500" />
            {t("tasks.dataset")}
          </div>
          <div className="text-xs text-zinc-400">{t("tasks.datasetHint")}</div>
          <input type="file" accept={DATASET_ACCEPT} disabled={submitting} className="text-xs text-zinc-600" onChange={(event) => { setDatasetFile(event.target.files?.[0] || null); setIdempotencyKey(null); }} />
          {datasetFile && <span className="text-xs text-emerald-600 truncate">{datasetFile.name} ({(datasetFile.size / 1024 / 1024).toFixed(1)} MB)</span>}
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="text" value={title} disabled={submitting} onChange={(event) => { setTitle(event.target.value); setIdempotencyKey(null); }} placeholder={t("tasks.taskTitlePlaceholder")} className="flex-1 rounded-xl border border-[var(--hairline)] bg-white/90 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-300" />
        <Button className="gap-2 rounded-xl" disabled={!methodFile || !datasetFile || submitting} onClick={() => { void submit(); }}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {submitting ? t("tasks.creating") : t("tasks.confirmAndSubmit")}
        </Button>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("tasks.createFailed").replace("{{message}}", error)}</div>}
      {createdTaskId && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{t("tasks.createSuccess")}</div>}
    </section>
  );
}
