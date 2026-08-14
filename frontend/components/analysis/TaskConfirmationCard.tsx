"use client";

import { useState } from "react";
import { CheckCircle2, FileArchive, FileSearch, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import { cancelTaskDraft, confirmTaskDraft, uploadDataset, type TaskDraft } from "@/lib/api/tasks";

interface TaskConfirmationCardProps {
  draft: TaskDraft;
  onCreated?: (result: { taskId: string; status: string; duplicate?: boolean; eventType: "task_confirmed" }) => void;
  onCancelled?: () => void;
}

const MAX_TASK_INPUT_BYTES = 25 * 1024 * 1024;

function fileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Dynamic Agent To-Do card, rendered only after a real task-draft event. */
export function TaskConfirmationCard({ draft, onCreated, onCancelled }: TaskConfirmationCardProps) {
  const { t } = useLanguage();
  const [title, setTitle] = useState(draft.title);
  const [methodFile, setMethodFile] = useState<File | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      let datasetResourceId = draft.dataset.resource_id || undefined;
      if (datasetFile) {
        if (datasetFile.size > MAX_TASK_INPUT_BYTES) throw new Error("每个文件不能超过 25 MB");
        if (!draft.project_id) throw new Error("任务项目不可用，请重新生成任务草案");
        const uploaded = await uploadDataset(datasetFile, draft.project_id, draft.session_id);
        datasetResourceId = uploaded.resource_id;
      }
      if (!datasetResourceId) throw new Error("请先补充数据集");

      let methodContent: string | undefined;
      if (methodFile) {
        if (methodFile.size > MAX_TASK_INPUT_BYTES) throw new Error("每个文件不能超过 25 MB");
        methodContent = await methodFile.text();
        if (!methodContent.trim()) throw new Error("执行文档不能为空");
      }
      const result = await confirmTaskDraft({
        draftId: draft.draft_id,
        idempotencyKey: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        datasetResourceId,
        methodContent,
        title: title.trim() || draft.title,
      });
      onCreated?.({
        taskId: result.task_id,
        status: result.status,
        duplicate: result.duplicate,
        eventType: result.event_type === "task_confirmed" ? result.event_type : "task_confirmed",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      await cancelTaskDraft(draft.draft_id);
      onCancelled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const hasDataset = Boolean(draft.dataset.resource_id || datasetFile);
  const handleMethodFile = (file: File | undefined, input: HTMLInputElement) => {
    if (!file) {
      setMethodFile(null);
      return;
    }
    if (file.size > MAX_TASK_INPUT_BYTES) {
      input.value = "";
      setMethodFile(null);
      setError("每个文件不能超过 25 MB");
      return;
    }
    setError(null);
    setMethodFile(file);
  };
  const handleDatasetFile = (file: File | undefined, input: HTMLInputElement) => {
    if (!file) {
      setDatasetFile(null);
      return;
    }
    if (file.size > MAX_TASK_INPUT_BYTES) {
      input.value = "";
      setDatasetFile(null);
      setError("每个文件不能超过 25 MB");
      return;
    }
    setError(null);
    setDatasetFile(file);
  };

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/80 p-5 space-y-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-800">{t("tasks.todoTitle")}</div>
          <p className="mt-1 text-xs leading-5 text-zinc-600">{draft.goal_summary || t("tasks.todoDescription")}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={() => void cancel()} disabled={submitting || cancelling} aria-label={t("tasks.cancelDraft")}>
          <X size={16} />
        </Button>
      </div>

      <input type="text" value={title} disabled={submitting || cancelling} onChange={(event) => setTitle(event.target.value)} className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300" placeholder={t("tasks.taskTitlePlaceholder")} />

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-amber-300 bg-white/80 p-4 cursor-pointer">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700"><FileSearch size={16} />{t("tasks.methodDoc")}</div>
          {draft.method ? <>
            <div className="text-xs text-zinc-500">{draft.method.filename} · {fileSize(draft.method.size_bytes)}</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-2 text-[11px] leading-5 text-zinc-600">{draft.method.preview}</pre>
          </> : <div className="rounded-lg bg-amber-50 px-2 py-3 text-xs text-amber-700">等待执行文档</div>}
          <span className="text-xs text-amber-700">{methodFile ? `替换为 ${methodFile.name}` : "点击替换执行文档（可选）"}</span>
          <input
            type="file"
            accept=".md,.txt"
            disabled={submitting || cancelling}
            className="text-xs"
            onChange={(event) => handleMethodFile(event.target.files?.[0], event.currentTarget)}
          />
        </label>

        <label className="flex flex-col gap-2 rounded-xl border border-dashed border-amber-300 bg-white/80 p-4 cursor-pointer">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700"><FileArchive size={16} />{t("tasks.dataset")}</div>
          {draft.dataset.resource_id ? <div className="text-xs text-emerald-700">{draft.dataset.filename || "已关联数据集"} · {draft.dataset.size_bytes ? fileSize(draft.dataset.size_bytes) : ""}</div> : <div className="text-xs text-amber-700">{t("tasks.todoDatasetMissing")}</div>}
          <span className="text-xs text-amber-700">{datasetFile ? `使用 ${datasetFile.name}` : "选择 ZIP 数据集（每个文件 ≤ 25 MB）"}</span>
          <input
            type="file"
            accept=".zip"
            disabled={submitting || cancelling}
            className="text-xs"
            onChange={(event) => handleDatasetFile(event.target.files?.[0], event.currentTarget)}
          />
        </label>
      </div>

      {draft.missing_inputs.length > 0 && !hasDataset && <div className="rounded-xl border border-amber-200 bg-white/70 px-3 py-2 text-xs text-amber-800">{t("tasks.todoMissing")}: {draft.missing_inputs.join("、")}</div>}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => void cancel()} disabled={submitting || cancelling}>{t("tasks.cancelDraft")}</Button>
        <Button type="button" className="gap-2 rounded-xl" onClick={() => void submit()} disabled={submitting || cancelling || !hasDataset || !draft.method && !methodFile}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {submitting ? t("tasks.creating") : t("tasks.todoConfirm")}
        </Button>
      </div>
    </section>
  );
}
