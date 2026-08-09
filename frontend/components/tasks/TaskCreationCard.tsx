"use client";

import { useEffect, useRef, useState } from "react";
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

const METHOD_DOC_ACCEPT = ".html,.htm,.pdf,.md,.txt,.doc,.docx";
const DATASET_ACCEPT = ".zip";

interface PreparedInputs {
  project_id: string;
  task_spec_id: string;
  dataset_snapshot_id: string;
  method_source_id: string;
  title: string;
  methodFile: File;
  datasetFile: File;
}

interface TaskCreationCardProps {
  resetKey?: number;
  onCreated?: (taskId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `task-center-${crypto.randomUUID()}`;
  }
  return `task-center-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Direct task-center submission. It uses the same TaskSpec/Task function path as the Agent card. */
export function TaskCreationCard({ resetKey = 0, onCreated, onDirtyChange }: TaskCreationCardProps) {
  const { t } = useLanguage();
  const [title, setTitle] = useState("");
  const [methodFile, setMethodFile] = useState<File | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<PreparedInputs | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [titleEdited, setTitleEdited] = useState(false);
  const requestKeyRef = useRef(idempotencyKey());

  useEffect(() => {
    if (resetKey === 0) return;
    setTitle("");
    setMethodFile(null);
    setDatasetFile(null);
    setPrepared(null);
    setError(null);
    setCreatedTaskId(null);
    setTitleEdited(false);
    requestKeyRef.current = idempotencyKey();
    onDirtyChange?.(false);
  }, [onDirtyChange, resetKey]);

  function markDirty() {
    setCreatedTaskId(null);
    setError(null);
    onDirtyChange?.(true);
  }

  const submit = async () => {
    if (!methodFile || !datasetFile) {
      setError(t("tasks.requireBoth"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const taskTitle = title.trim() || methodFile.name.replace(/\.[^.]+$/, "");
      let inputs = prepared;
      const canReuse = inputs
        && inputs.title === taskTitle
        && inputs.methodFile === methodFile
        && inputs.datasetFile === datasetFile;
      if (!canReuse) {
        requestKeyRef.current = idempotencyKey();
        const project = await getDefaultProject();
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
        inputs = {
          project_id: project.project_id,
          task_spec_id: spec.task_spec_id,
          dataset_snapshot_id: dataset.dataset_snapshot_id,
          method_source_id: method.method_source_id,
          title: taskTitle,
          methodFile,
          datasetFile,
        };
        setPrepared(inputs);
      }
      if (!inputs) throw new Error("Task inputs were not prepared");
      const task = await createTask({
        project_id: inputs.project_id,
        task_spec_id: inputs.task_spec_id,
        dataset_snapshot_id: inputs.dataset_snapshot_id,
        title: inputs.title,
        method_source_id: inputs.method_source_id,
        idempotency_key: requestKeyRef.current,
        chat_confirmation_id: false,
        submission_source: "task_center",
        direct: true,
      });
      setCreatedTaskId(task.task_id);
      onDirtyChange?.(false);
      onCreated?.(task.task_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section data-testid="task-creation-card" className="rounded-2xl border border-blue-200 bg-blue-50/60 p-5 space-y-4">
      <div>
        <div className="text-sm font-semibold text-blue-950">{t("tasks.createCardTitle")}</div>
        <p className="text-xs text-blue-900/70 mt-1">{t("tasks.createCardDescription")}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 bg-white/60 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700"><FileSearch size={16} className="text-zinc-500" />{t("tasks.methodDoc")}</div>
          <div className="text-xs text-zinc-400">{t("tasks.methodDocHint")}</div>
          <input
            type="file"
            accept={METHOD_DOC_ACCEPT}
            disabled={submitting || Boolean(createdTaskId)}
            className="text-xs text-zinc-600"
            onChange={(event) => {
              const file = event.target.files?.[0] || null;
              setMethodFile(file);
              setPrepared(null);
              markDirty();
              if (file && !titleEdited) setTitle(file.name.replace(/\.[^.]+$/, ""));
            }}
          />
          {methodFile && <span className="text-xs text-emerald-600 truncate">{methodFile.name}</span>}
        </label>

        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 bg-white/60 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700"><FileArchive size={16} className="text-zinc-500" />{t("tasks.dataset")}</div>
          <div className="text-xs text-zinc-400">{t("tasks.datasetHint")}</div>
          <input
            type="file"
            accept={DATASET_ACCEPT}
            disabled={submitting || Boolean(createdTaskId)}
            className="text-xs text-zinc-600"
            onChange={(event) => {
              setDatasetFile(event.target.files?.[0] || null);
              setPrepared(null);
              markDirty();
            }}
          />
          {datasetFile && <span className="text-xs text-emerald-600 truncate">{datasetFile.name} ({(datasetFile.size / 1024 / 1024).toFixed(1)} MB)</span>}
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setTitleEdited(true);
            markDirty();
          }}
          disabled={submitting || Boolean(createdTaskId)}
          placeholder={t("tasks.taskTitlePlaceholder")}
          className="flex-1 rounded-xl border border-[var(--hairline)] bg-white/90 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
        />
        <Button className="gap-2 rounded-xl" disabled={Boolean(createdTaskId) || !methodFile || !datasetFile || submitting} onClick={() => { void submit(); }}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {submitting ? t("tasks.creating") : createdTaskId ? t("tasks.createSuccess") : t("tasks.create")}
        </Button>
      </div>

      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("tasks.createFailed").replace("{{message}}", error)}</div>}
      {createdTaskId && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{t("tasks.createSuccess")} <span className="font-mono text-xs">{createdTaskId}</span></div>}
    </section>
  );
}
