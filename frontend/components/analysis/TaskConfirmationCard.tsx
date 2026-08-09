"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, FileArchive, FileSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import type { TaskConfirmation } from "@/lib/chat-state";
import {
  createDatasetSnapshot,
  createTask,
  createTaskSpec,
  freezeTaskSpec,
  getDefaultProject,
  uploadDataset,
  uploadMethodSource,
} from "@/lib/api/tasks";

interface TaskConfirmationCardProps {
  confirmation: TaskConfirmation;
  onCreated?: (confirmationId: string, taskId: string, title: string) => void;
}

const METHOD_DOC_ACCEPT = ".html,.htm,.pdf,.md,.txt,.doc,.docx";
const DATASET_ACCEPT = ".zip";

/** An inline form emitted by Analysis' request_task_creation tool. */
export function TaskConfirmationCard({ confirmation, onCreated }: TaskConfirmationCardProps) {
  const { t } = useLanguage();
  const [title, setTitle] = useState(confirmation.title);
  const [methodFile, setMethodFile] = useState<File | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(confirmation.error || null);

  useEffect(() => {
    setTitle(confirmation.title);
    setError(confirmation.error || null);
  }, [confirmation.error, confirmation.title]);

  const submit = async () => {
    if (!methodFile || !datasetFile) {
      setError(t("tasks.requireBoth"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const project = await getDefaultProject();
      const taskTitle = title.trim() || datasetFile.name.replace(/\.zip$/i, "");
      const spec = await createTaskSpec({
        project_id: project.project_id,
        title: taskTitle,
        analysis_type: "generic",
      });
      await freezeTaskSpec(spec.task_spec_id);
      const method = await uploadMethodSource(methodFile);
      const upload = await uploadDataset(datasetFile, project.project_id);
      const dataset = await createDatasetSnapshot({
        project_id: project.project_id,
        task_spec_id: spec.task_spec_id,
        original_filename: datasetFile.name,
        resource_id: upload.resource_id,
        file_hash_sha256: upload.file_hash_sha256,
        validation_passed: true,
      });
      const task = await createTask({
        project_id: project.project_id,
        task_spec_id: spec.task_spec_id,
        dataset_snapshot_id: dataset.dataset_snapshot_id,
        title: taskTitle,
        method_source_id: method.method_source_id,
        // Keep retries for this inline confirmation on the same server-side
        // idempotency key; a flaky upload or response must not create a second
        // queued Task for the same card.
        idempotency_key: confirmation.confirmation_id,
        chat_confirmation_id: confirmation.confirmation_id,
      });
      onCreated?.(confirmation.confirmation_id, task.task_id, taskTitle);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitted = confirmation.status === "submitted";

  return (
    <section className="mt-4 rounded-2xl border border-blue-200 bg-blue-50/60 p-5 space-y-4" data-testid={`task-confirmation-${confirmation.confirmation_id}`}>
      <div>
        <div className="text-sm font-semibold text-blue-950">{t("tasks.confirmationTitle")}</div>
        <p className="text-xs text-blue-900/70 mt-1">{t("tasks.confirmationDescription")}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            <FileSearch size={16} className="text-zinc-500" />
            {t("tasks.methodDoc")}
          </div>
          <div className="text-xs text-zinc-400">{t("tasks.methodDocHint")}</div>
          <input type="file" accept={METHOD_DOC_ACCEPT} disabled={submitted || submitting} className="text-xs text-zinc-600" onChange={(event) => setMethodFile(event.target.files?.[0] || null)} />
          {methodFile && <span className="text-xs text-emerald-600 truncate">{methodFile.name}</span>}
          {!methodFile && confirmation.method_document_name && <span className="text-xs text-blue-700 truncate">{confirmation.method_document_name}</span>}
        </label>

        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            <FileArchive size={16} className="text-zinc-500" />
            {t("tasks.dataset")}
          </div>
          <div className="text-xs text-zinc-400">{t("tasks.datasetHint")}</div>
          <input type="file" accept={DATASET_ACCEPT} disabled={submitted || submitting} className="text-xs text-zinc-600" onChange={(event) => setDatasetFile(event.target.files?.[0] || null)} />
          {datasetFile && <span className="text-xs text-emerald-600 truncate">{datasetFile.name} ({(datasetFile.size / 1024 / 1024).toFixed(1)} MB)</span>}
          {!datasetFile && confirmation.dataset_name && <span className="text-xs text-blue-700 truncate">{confirmation.dataset_name}</span>}
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} disabled={submitted || submitting} placeholder={t("tasks.taskTitlePlaceholder")} className="flex-1 rounded-xl border border-[var(--hairline)] bg-white/90 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-300" />
        <Button className="gap-2 rounded-xl" disabled={submitted || !methodFile || !datasetFile || submitting} onClick={() => { void submit(); }}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {submitting ? t("tasks.creating") : submitted ? t("tasks.createSuccess") : t("tasks.confirmAndSubmit")}
        </Button>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("tasks.createFailed").replace("{{message}}", error)}</div>}
      {submitted && confirmation.task_id && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{t("tasks.createSuccess")} <span className="font-mono text-xs">{confirmation.task_id}</span></div>}
    </section>
  );
}
