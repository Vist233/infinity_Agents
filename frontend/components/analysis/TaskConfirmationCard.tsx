"use client";

import { useState } from "react";
import { CheckCircle2, FileArchive, FileSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
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

  const submit = async () => {
    if (!methodFile || !datasetFile) {
      setError(t("tasks.requireBoth"));
      return;
    }
    setSubmitting(true);
    setError(null);
    setCreatedTaskId(null);
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
        idempotency_key: crypto.randomUUID(),
      });
      setCreatedTaskId(task.task_id);
      onCreated?.(task.task_id);
      setTitle("");
      setMethodFile(null);
      setDatasetFile(null);
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
          <input type="file" accept={METHOD_DOC_ACCEPT} className="text-xs text-zinc-600" onChange={(event) => setMethodFile(event.target.files?.[0] || null)} />
          {methodFile && <span className="text-xs text-emerald-600 truncate">{methodFile.name}</span>}
        </label>

        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            <FileArchive size={16} className="text-zinc-500" />
            {t("tasks.dataset")}
          </div>
          <div className="text-xs text-zinc-400">{t("tasks.datasetHint")}</div>
          <input type="file" accept={DATASET_ACCEPT} className="text-xs text-zinc-600" onChange={(event) => setDatasetFile(event.target.files?.[0] || null)} />
          {datasetFile && <span className="text-xs text-emerald-600 truncate">{datasetFile.name} ({(datasetFile.size / 1024 / 1024).toFixed(1)} MB)</span>}
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("tasks.taskTitlePlaceholder")} className="flex-1 rounded-xl border border-[var(--hairline)] bg-white/90 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-300" />
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
