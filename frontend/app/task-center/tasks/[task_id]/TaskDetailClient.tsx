"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage, type TranslationKey } from "@/lib/i18n";
import { AgentNav } from "@/components/workspace/AgentNav";
import { MobileWorkspaceMenu } from "@/components/workspace/MobileWorkspaceMenu";
import { WorkspaceUserFooter } from "@/components/workspace/WorkspaceUserFooter";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw, Download, PlayCircle, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import { useRouter, useParams } from "next/navigation";
import { getApiBase } from "@/lib/runtime-config";
import { artifactDownloadUrl, getJson, cancelTask, listTasks, type TaskItem } from "@/lib/api/tasks";

type TaskStatus = "draft" | "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

interface TaskDetail {
  task_id: string;
  task_spec_id: string;
  dataset_snapshot_id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  active_attempt_id: number | null;
  attempt_count: number;
  max_attempts: number;
  result_artifact_id: string | null;
  error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
interface TaskEvent {
  task_event_id: number;
  event_type: string;
  event_data: Record<string, unknown>;
  created_at: string;
}

interface Artifact {
  artifact_id: string;
  name: string;
  kind: string;
  file_size_bytes: number | null;
  checksum_sha256: string | null;
  created_at: string;
}

const STATUS_ICONS: Record<TaskStatus, React.ReactNode> = {
  draft: <Clock size={16} className="text-zinc-500" />,
  queued: <PlayCircle size={16} className="text-blue-500" />,
  claimed: <PlayCircle size={16} className="text-purple-500" />,
  running: <RefreshCw size={16} className="text-amber-500 animate-spin" />,
  succeeded: <CheckCircle2 size={16} className="text-emerald-500" />,
  failed: <XCircle size={16} className="text-red-500" />,
  cancelled: <XCircle size={16} className="text-zinc-500" />,
  timeout: <AlertTriangle size={16} className="text-orange-500" />,
};

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

const STATUS_LABELS: Record<TaskStatus, TranslationKey> = {
  draft: "tasks.statusDraft",
  queued: "tasks.statusQueued",
  claimed: "tasks.statusClaimed",
  running: "tasks.statusRunning",
  succeeded: "tasks.statusSucceeded",
  failed: "tasks.statusFailed",
  cancelled: "tasks.statusCancelled",
  timeout: "tasks.statusTimeout",
};

function formatDate(iso: string | null) {
  if (!iso) return "-";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function taskIdFromBrowserPath(pathname: string): string | null {
  const match = pathname.match(/^\/task-center\/tasks\/([^/]+)\/?$/);
  if (!match) return null;
  const candidate = decodeURIComponent(match[1]).trim();
  return candidate && candidate !== "preview" ? candidate : null;
}

export default function TaskDetailPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const params = useParams();
  const paramTaskId = typeof params.task_id === "string" ? params.task_id : null;
  // Next static export hydrates a deterministic `preview` shell. The live
  // browser URL is the source of truth for the actual task identifier.
  const taskId = useMemo(() => {
    if (typeof window !== "undefined") {
      const fromPath = taskIdFromBrowserPath(window.location.pathname);
      if (fromPath) return fromPath;
    }
    return paramTaskId && paramTaskId !== "preview" ? paramTaskId : null;
  }, [paramTaskId]);

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelSuccess, setCancelSuccess] = useState(false);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const [taskList, setTaskList] = useState<TaskItem[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [taskListError, setTaskListError] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const detailInFlightRef = useRef<{ taskId: string | null; promise: Promise<void> } | null>(null);

  const loadDetail = useCallback((silent = false): Promise<void> => {
    const current = detailInFlightRef.current;
    if (current?.taskId === taskId) return current.promise;
    const requestId = ++detailRequestRef.current;
    if (!silent) setLoading(true);
    setError(null);
    setEventsError(null);
    setArtifactsError(null);
    setTaskListError(null);
    const promise = (async () => {
      try {
      const taskData = await getJson<TaskDetail>(`${getApiBase()}/api/tasks/${taskId}`);
      const [eventsResult, artifactsResult, taskListResult] = await Promise.allSettled([
        getJson<TaskEvent[] | { events?: TaskEvent[] }>(`${getApiBase()}/api/tasks/${taskId}/events`),
        getJson<Artifact[]>(`${getApiBase()}/api/tasks/${taskId}/artifacts`),
        listTasks(50),
      ]);
      if (requestId !== detailRequestRef.current) return;
      setTask(taskData);
      if (eventsResult.status === "fulfilled") {
        const evtList = Array.isArray(eventsResult.value) ? eventsResult.value : (eventsResult.value?.events ?? []);
        setEvents(Array.isArray(evtList) ? evtList : []);
      } else {
        setEvents([]);
        setEventsError(eventsResult.reason instanceof Error ? eventsResult.reason.message : String(eventsResult.reason));
      }
      if (artifactsResult.status === "fulfilled") {
        setArtifacts(Array.isArray(artifactsResult.value) ? artifactsResult.value : []);
      } else {
        setArtifacts([]);
        setArtifactsError(artifactsResult.reason instanceof Error ? artifactsResult.reason.message : String(artifactsResult.reason));
      }
      if (taskListResult.status === "fulfilled") {
        setTaskList(taskListResult.value);
      } else {
        setTaskList([]);
        setTaskListError(taskListResult.reason instanceof Error ? taskListResult.reason.message : String(taskListResult.reason));
      }
      } catch (err) {
        if (requestId !== detailRequestRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (requestId === detailRequestRef.current && !silent) setLoading(false);
      }
    })();
    detailInFlightRef.current = { taskId, promise };
    void promise.finally(() => {
      if (detailInFlightRef.current?.promise === promise) detailInFlightRef.current = null;
    });
    return promise;
  }, [taskId]);



  useEffect(() => {
    if (taskId) void loadDetail();
  }, [taskId, loadDetail]);

  useEffect(() => {
    setCancelSuccess(false);
  }, [taskId]);

  const currentTaskStatus = task?.status;

  useEffect(() => {
    if (!taskId) return;
    if (currentTaskStatus && ["succeeded", "failed", "cancelled", "timeout"].includes(currentTaskStatus)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollAfterPreviousCompletes = async () => {
      await loadDetail(true);
      if (!cancelled) timer = setTimeout(() => { void pollAfterPreviousCompletes(); }, 3000);
    };
    timer = setTimeout(() => { void pollAfterPreviousCompletes(); }, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, currentTaskStatus, loadDetail]);

  const handleCancel = async () => {
    if (!task || !taskId) return;
    const confirmed = window.confirm(t("tasks.cancelConfirm"));
    if (!confirmed) return;
    setCancelling(true);
    setCancelSuccess(false);
    try {
      await cancelTask(taskId);
      setCancelSuccess(true);
      void loadDetail(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const terminalStatuses = useMemo(() => ["succeeded", "failed", "cancelled", "timeout"], []);
  const isTerminal = task ? terminalStatuses.includes(task.status) : true;

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
        <AgentNav active="tasks" onNavigate={(path) => router.push(path)} />
        <Button variant="outline" className="mt-3 w-full justify-start gap-2 rounded-xl" onClick={() => router.push("/task-center/")}>
          <PlayCircle size={16} />
          {t("tasks.newTask")}
        </Button>
        <div className="mt-3 px-2 text-xs font-semibold uppercase tracking-widest text-zinc-400">{t("tasks.title")}</div>
        <ScrollArea className="mt-2 min-h-0 flex-1">
          <div className="space-y-1 pr-1">
            {taskList.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-400">
                {taskListError ? `${t("tasks.loadFailedToast")}: ${taskListError}` : t("tasks.empty")}
              </div>
            ) : taskList.map((item) => (
              <button
                key={item.task_id}
                type="button"
                onClick={() => router.push(`/task-center/tasks/${item.task_id}`)}
                className={`w-full rounded-xl px-3 py-2 text-left transition-colors ${item.task_id === taskId ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}
              >
                <div className="truncate text-xs font-medium">{item.title}</div>
                <div className={`mt-1 text-[10px] ${item.task_id === taskId ? "text-zinc-300" : "text-zinc-400"}`}>{t(STATUS_LABELS[item.status])}</div>
              </button>
            ))}
          </div>
        </ScrollArea>
        <WorkspaceUserFooter />
        <div className="p-2 text-center text-xs tracking-tighter text-zinc-400">v1.0.0 @ 2026</div>
      </aside>
      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
            <div className="flex items-center gap-2">
              <MobileWorkspaceMenu
                active="tasks"
                activeTaskId={taskId ?? undefined}
                taskItems={taskList.map((item) => ({
                  task_id: item.task_id,
                  title: item.title,
                  statusLabel: t(STATUS_LABELS[item.status]),
                }))}
                onNewTask={() => router.push("/task-center/")}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push("/task-center/")}>
                <ArrowLeft size={16} />
              </Button>
            <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("tasks.detailTitle")}</div>
          </div>
          <div className="flex gap-2">
            {task && !isTerminal && (
              <Button variant="destructive" size="sm" onClick={handleCancel} disabled={cancelling}>
                <XCircle size={14} className="mr-1" />
                {t("tasks.cancel")}
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { void loadDetail(); }} disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              {t("composer.retry")}
            </Button>
          </div>
        </header>

        <ScrollArea className="flex-1">
          {cancelSuccess && (
            <div className="mx-4 mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {t("tasks.cancelSuccess")}
            </div>
          )}

          {loading && !task ? (
            <div className="flex items-center justify-center h-40 text-sm text-zinc-500">{t("run.processing")}...</div>
          ) : error && !task ? (
            <div className="m-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {t("tasks.loadFailedToast")}: {error}
            </div>
          ) : task ? (
            <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
              <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-5 space-y-4">
                <div className="flex items-center gap-2">
                  {STATUS_ICONS[task.status]}
                  <h1 className="text-lg font-semibold">{task.title}</h1>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-xs text-zinc-400">{t("tasks.detailStatus")}</div>
                    <div className="mt-0.5">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[task.status]}`}>
                        {t(STATUS_LABELS[task.status])}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">{t("tasks.detailAttempts")}</div>
                    <div className="mt-0.5 text-sm font-medium">{task.attempt_count}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">{t("tasks.detailMaxAttempts")}</div>
                    <div className="mt-0.5 text-sm font-medium">{task.max_attempts}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">{t("tasks.detailCreatedAt")}</div>
                    <div className="mt-0.5 text-sm font-medium">{formatDate(task.created_at)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">{t("tasks.detailFinishedAt")}</div>
                    <div className="mt-0.5 text-sm font-medium">{formatDate(task.finished_at)}</div>
                  </div>
                  <div className="col-span-2 md:col-span-3">
                    <div className="text-xs text-zinc-400">{t("tasks.id")}</div>
                    <div className="mt-0.5 font-mono text-xs text-zinc-600 break-all">{task.task_id}</div>
                  </div>
                </div>
                {task.error_message && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    <div className="text-xs font-medium mb-1">{t("tasks.detailError")}</div>
                    {task.error_message}
                  </div>
                )}
              </section>

              <section>
                <h2 className="text-sm font-semibold text-zinc-700 mb-2">{t("tasks.detailArtifacts")}</h2>
                {artifactsError && (
                  <div className="mb-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                    {t("tasks.loadArtifactsFailed").replace("{{message}}", artifactsError)}
                  </div>
                )}
                {artifacts.length === 0 ? (
                  <div className="rounded-2xl border border-[var(--hairline)] bg-white/80 px-4 py-8 text-center text-sm text-zinc-400">
                    {t("tasks.detailNoArtifacts")}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-[var(--hairline)] bg-white/80 overflow-x-auto">
                    <table className="min-w-[680px] w-full text-sm">
                      <thead>
                        <tr className="border-b border-[var(--hairline)] bg-zinc-50/60 text-left">
                          <th className="px-4 py-3 font-medium text-zinc-500">{t("tasks.titleColumn")}</th>
                          <th className="px-4 py-3 font-medium text-zinc-500">Size</th>
                          <th className="px-4 py-3 font-medium text-zinc-500">SHA256</th>
                          <th className="px-4 py-3 font-medium text-zinc-500">{t("tasks.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {artifacts.map((a) => (
                          <tr key={a.artifact_id} className="border-b border-[var(--hairline)] last:border-b-0 hover:bg-zinc-50/60">
                            <td className="px-4 py-3">
                              <div className="text-sm font-medium">{a.name}</div>
                              <div className="text-xs text-zinc-400 mt-0.5">{a.kind}</div>
                            </td>
                            <td className="px-4 py-3 text-xs text-zinc-600">{formatBytes(a.file_size_bytes)}</td>
                            <td className="px-4 py-3 font-mono text-xs text-zinc-500">{a.checksum_sha256 ? a.checksum_sha256.slice(0, 12) + "..." : "-"}</td>
                            <td className="px-4 py-3">
                              <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1">
                                <a href={artifactDownloadUrl(a.artifact_id)} download>
                                  <Download size={14} />
                                  {t("tasks.view")}
                                </a>
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section>
                <h2 className="text-sm font-semibold text-zinc-700 mb-2">{t("tasks.detailEvents")}</h2>
                {eventsError && (
                  <div className="mb-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                    {t("tasks.loadEventsFailed").replace("{{message}}", eventsError)}
                  </div>
                )}
                {events.length === 0 ? (
                  <div className="rounded-2xl border border-[var(--hairline)] bg-white/80 px-4 py-8 text-center text-sm text-zinc-400">
                    {t("tasks.detailNoEvents")}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-[var(--hairline)] bg-white/80 overflow-hidden">
                    <ScrollArea className="h-[300px]">
                      <div className="p-4 space-y-2">
                        {events.map((evt) => (
                          <div key={evt.task_event_id} className="flex items-start gap-3 text-xs">
                            <span className="font-mono text-zinc-400 whitespace-nowrap">{formatDate(evt.created_at)}</span>
                            <span className="font-medium text-zinc-700 bg-zinc-100 rounded px-1.5 py-0.5 whitespace-nowrap">{evt.event_type}</span>
                            <pre className="text-zinc-600 flex-1 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(evt.event_data)}</pre>
                          </div>
                        ))}
                        <div ref={eventsEndRef} />
                      </div>
                    </ScrollArea>
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </ScrollArea>
      </main>
    </div>
  );
}
