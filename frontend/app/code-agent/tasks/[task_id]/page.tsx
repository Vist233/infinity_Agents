"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage, type TranslationKey } from "@/lib/i18n";
import { AgentNav } from "@/components/chat/AgentNav";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw, Download, PlayCircle, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import { useRouter, useParams } from "next/navigation";
import { getApiBase } from "@/lib/runtime-config";
import { getJson, cancelTask, downloadArtifact, taskEventStreamUrl } from "@/lib/api/tasks";

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

export default function TaskDetailPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const params = useParams();
  const taskId = params.task_id as string;

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelSuccess, setCancelSuccess] = useState(false);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const [liveEvents, setLiveEvents] = useState<TaskEvent[]>([]);
  const [sseConnected, setSseConnected] = useState(false);

  const loadDetail = async () => {
    setLoading(true);
    setError(null);
    try {
      const [taskData, evts, arts] = await Promise.all([
        getJson<TaskDetail>(`${getApiBase()}/api/tasks/${taskId}`),
        getJson<TaskEvent[] | { events?: TaskEvent[] }>(`${getApiBase()}/api/tasks/${taskId}/events`).catch(() => []),
        getJson<Artifact[]>(`${getApiBase()}/api/tasks/${taskId}/artifacts`).catch(() => []),
      ]);
      setTask(taskData);
      const evtList = Array.isArray(evts) ? evts : (evts?.events ?? []);
      setEvents(Array.isArray(evtList) ? evtList : []);
      setArtifacts(Array.isArray(arts) ? arts : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (taskId) loadDetail(); }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    try {
      // taskEventStreamUrl builds the correct same-origin URL (and carries
      // the optional api_key query param — EventSource cannot set headers).
      es = new EventSource(taskEventStreamUrl(taskId));
      es.onopen = () => {
        failures = 0;
        setSseConnected(true);
      };
      es.onerror = () => {
        setSseConnected(false);
        failures += 1;
        // A persistently failing stream (e.g. 404) would otherwise reconnect
        // forever and flood the console — fall back to polling after a few
        // attempts.
        if (failures >= 3 && es) {
          es.close();
          es = null;
          if (!timer) timer = setInterval(loadDetail, 3000);
        }
      };
      es.addEventListener("task_state", (e) => {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.status) setTask((prev) => prev ? { ...prev, status: data.status } : prev);
      });
      es.addEventListener("update", (e) => {
        const data = JSON.parse((e as MessageEvent).data);
        setLiveEvents((prev) => [...prev, { ...data, task_event_id: Date.now(), event_type: data.event_type || "update", created_at: new Date().toISOString() }]);
      });
      es.addEventListener("task_terminal", () => {
        es?.close();
        loadDetail();
      });
    } catch {
      timer = setInterval(loadDetail, 3000);
    }
    return () => {
      es?.close();
      if (timer) clearInterval(timer);
    };
  }, [taskId]);

  const handleCancel = async () => {
    if (!task) return;
    const confirmed = window.confirm(t("tasks.cancelConfirm"));
    if (!confirmed) return;
    setCancelling(true);
    setCancelSuccess(false);
    try {
      await cancelTask(taskId);
      setCancelSuccess(true);
      loadDetail();
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
      </aside>
      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push("/code-agent/tasks")}>
              <ArrowLeft size={16} />
            </Button>
            <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("tasks.detailTitle")}</div>
            {sseConnected && <span className="text-[10px] text-emerald-600 bg-emerald-50 rounded-full px-2 py-0.5">LIVE</span>}
          </div>
          <div className="flex gap-2">
            {task && !isTerminal && (
              <Button variant="destructive" size="sm" onClick={handleCancel} disabled={cancelling}>
                <XCircle size={14} className="mr-1" />
                {t("tasks.cancel")}
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={loadDetail} disabled={loading}>
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
                {artifacts.length === 0 ? (
                  <div className="rounded-2xl border border-[var(--hairline)] bg-white/80 px-4 py-8 text-center text-sm text-zinc-400">
                    {t("tasks.detailNoArtifacts")}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-[var(--hairline)] bg-white/80 overflow-hidden">
                    <table className="w-full text-sm">
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
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={() => { void downloadArtifact(a.artifact_id, `${a.name || "artifact"}.zip`); }}>
                                <Download size={14} />
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

              <section>
                <h2 className="text-sm font-semibold text-zinc-700 mb-2">{t("tasks.detailEvents")}</h2>
                {events.length === 0 && liveEvents.length === 0 ? (
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
                        {liveEvents.map((evt) => (
                          <div key={`live-${evt.task_event_id}`} className="flex items-start gap-3 text-xs">
                            <span className="font-mono text-emerald-500 whitespace-nowrap">LIVE</span>
                            <span className="font-medium text-zinc-700 bg-emerald-50 rounded px-1.5 py-0.5 whitespace-nowrap">{evt.event_type}</span>
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
