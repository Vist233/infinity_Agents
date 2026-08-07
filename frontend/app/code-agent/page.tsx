"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LanguageToggle, useLanguage } from "@/lib/i18n";
import { AgentNav } from "@/components/chat/AgentNav";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  FileSearch,
  FileArchive,
  ListTodo,
  Loader2,
  RefreshCw,
  UploadCloud,
  CheckCircle2,
} from "lucide-react";
import {
  createDatasetSnapshot,
  createTask,
  createTaskSpec,
  getDefaultProject,
  listTasks,
  uploadDataset,
  uploadMethodSource,
  type TaskItem,
  type TaskStatus,
} from "@/lib/api/tasks";

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

const METHOD_DOC_ACCEPT = ".html,.htm,.pdf,.md,.txt,.doc,.docx";
const DATASET_ACCEPT = ".zip";

export default function CodeAgentPage() {
  const router = useRouter();
  const { t } = useLanguage();

  const [title, setTitle] = useState("");
  const [methodFile, setMethodFile] = useState<File | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const items = await listTasks();
      setTasks(items);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    // Keep statuses fresh while the page is open.
    const timer = setInterval(() => { void loadTasks(); }, 5000);
    return () => clearInterval(timer);
  }, [loadTasks]);

  const canCreate = !!methodFile && !!datasetFile && !creating;

  const handleCreate = async () => {
    if (!methodFile || !datasetFile) {
      setCreateError(t("tasks.requireBoth"));
      return;
    }
    setCreating(true);
    setCreateError(null);
    setCreatedTaskId(null);
    try {
      const project = await getDefaultProject();
      const taskTitle = title.trim() || datasetFile.name.replace(/\.zip$/i, "");
      const spec = await createTaskSpec({
        project_id: project.project_id,
        title: taskTitle,
        analysis_type: "generic",
      });
      const method = await uploadMethodSource(methodFile);
      const upload = await uploadDataset(datasetFile);
      const dataset = await createDatasetSnapshot({
        project_id: project.project_id,
        task_spec_id: spec.task_spec_id,
        original_filename: datasetFile.name,
        stored_path: upload.stored_path,
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
      setTitle("");
      setMethodFile(null);
      setDatasetFile(null);
      void loadTasks();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const formatDate = useMemo(
    () => (iso: string) => {
      if (!iso) return "-";
      try {
        return new Date(iso).toLocaleString();
      } catch {
        return iso;
      }
    },
    [],
  );

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
        <AgentNav active="code" onNavigate={(path: string) => router.push(path)} />
        <div className="flex-1" />
        <div className="p-2 text-xs text-zinc-400 text-center tracking-tighter">v1.0.0 @ 2026</div>
      </aside>

      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
          <div className="flex items-center gap-2">
            <ListTodo size={16} className="text-zinc-500" />
            <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("tasks.title")}</div>
          </div>
          <LanguageToggle />
        </header>

        <ScrollArea className="flex-1">
          <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
            {/* New task card: upload an execution document + a dataset ZIP. */}
            <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-5 space-y-4">
              <div className="text-sm font-semibold text-zinc-700">{t("tasks.newTask")}</div>
              <p className="text-xs text-zinc-500">{t("tasks.newTaskDescription")}</p>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
                    <FileSearch size={16} className="text-zinc-500" />
                    {t("tasks.methodDoc")}
                  </div>
                  <div className="text-xs text-zinc-400">{t("tasks.methodDocHint")}</div>
                  <input
                    type="file"
                    accept={METHOD_DOC_ACCEPT}
                    className="text-xs text-zinc-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-zinc-100 file:text-zinc-700 hover:file:bg-zinc-200"
                    onChange={(e) => setMethodFile(e.target.files?.[0] || null)}
                  />
                  {methodFile && (
                    <span className="text-xs text-emerald-600 truncate">{methodFile.name}</span>
                  )}
                </label>

                <label className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-4 cursor-pointer hover:border-zinc-400 transition-colors">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
                    <FileArchive size={16} className="text-zinc-500" />
                    {t("tasks.dataset")}
                  </div>
                  <div className="text-xs text-zinc-400">{t("tasks.datasetHint")}</div>
                  <input
                    type="file"
                    accept={DATASET_ACCEPT}
                    className="text-xs text-zinc-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-zinc-100 file:text-zinc-700 hover:file:bg-zinc-200"
                    onChange={(e) => setDatasetFile(e.target.files?.[0] || null)}
                  />
                  {datasetFile && (
                    <span className="text-xs text-emerald-600 truncate">
                      {datasetFile.name} ({(datasetFile.size / 1024 / 1024).toFixed(1)} MB)
                    </span>
                  )}
                </label>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("tasks.taskTitlePlaceholder")}
                  className="flex-1 rounded-xl border border-[var(--hairline)] bg-white/90 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
                />
                <Button className="gap-2 rounded-xl" disabled={!canCreate} onClick={() => { void handleCreate(); }}>
                  {creating ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
                  {creating ? t("tasks.creating") : t("tasks.create")}
                </Button>
              </div>

              {createError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {t("tasks.createFailed").replace("{{message}}", createError)}
                </div>
              )}
              {createdTaskId && (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  <CheckCircle2 size={16} />
                  {t("tasks.createSuccess")}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => router.push(`/code-agent/tasks/${createdTaskId}`)}
                  >
                    {t("tasks.view")}
                  </Button>
                </div>
              )}
            </section>

            {/* Task list */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-700">{t("tasks.subtitle")}</div>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setLoading(true); void loadTasks(); }} disabled={loading}>
                  <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                  {t("composer.retry")}
                </Button>
              </div>

              {listError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {t("tasks.listFailedToast")}: {listError}
                </div>
              )}

              {!loading && tasks.length === 0 && !listError && (
                <div className="flex flex-col items-center justify-center py-16 text-center rounded-2xl border border-dashed border-zinc-200 bg-white/60">
                  <ListTodo size={36} className="text-zinc-300 mb-3" />
                  <p className="text-sm text-zinc-500">{t("tasks.empty")}</p>
                  <p className="text-xs text-zinc-400 mt-1">{t("tasks.emptyDescription")}</p>
                </div>
              )}

              {tasks.length > 0 && (
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
                              {t(STATUS_LABEL[task.status] as never)}
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
              )}
            </section>
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
