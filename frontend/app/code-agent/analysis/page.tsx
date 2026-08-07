"use client";

import { useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AgentNav } from "@/components/chat/AgentNav";
import { Composer } from "@/components/chat/Composer";
import { useLanguage } from "@/lib/i18n";
import { ArrowLeft, Upload, SendHorizontal, CheckCircle2, XCircle, FileJson } from "lucide-react";

type AnalysisEvent =
  | { type: "status"; phase: string; elapsed_ms: number; attempt: number; max_attempts: number; tool_name?: string }
  | { type: "chunk"; content: string }
  | { type: "task_spec_draft"; task_spec: Record<string, unknown>; validation_errors: string[] }
  | { type: "done"; token_info?: { prompt: number; response: number; total: number } }
  | { type: "error"; message: string };

export default function AnalysisPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [input, setInput] = useState("");
  const [events, setEvents] = useState<AnalysisEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [taskSpecDraft, setTaskSpecDraft] = useState<Record<string, unknown> | null>(null);
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [taskResult, setTaskResult] = useState<{ taskId: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close(1000, "component_unmount");
        wsRef.current = null;
      }
    };
  }, []);

  const appendEvent = (event: AnalysisEvent) => {
    setEvents((prev) => [...prev, event]);
    if (event.type === "task_spec_draft") {
      setTaskSpecDraft(event.task_spec);
    }
  };

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;

    setError(null);
    setTaskResult(null);
    setTaskSpecDraft(null);
    setEvents([]);
    setIsStreaming(true);
    setInput("");

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const ws = new WebSocket(`${proto}//${host}/ws/analysis`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          session_id: `analysis-${Date.now()}`,
          messages: [{ role: "user", content: text }],
        }),
      );
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as AnalysisEvent;
        appendEvent(data);
        if (data.type === "done" || data.type === "error") {
          ws.close(1000, "completed");
        }
      } catch {
        appendEvent({ type: "chunk", content: evt.data });
      }
    };

    ws.onerror = () => {
      setError(t("error.network"));
      setIsStreaming(false);
    };

    ws.onclose = () => {
      setIsStreaming(false);
      wsRef.current = null;
    };
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setDatasetFile(file);
    if (file) {
      setDatasetId(null);
      setTaskResult(null);
    }
  };

  const handleCreateTask = async () => {
    if (!taskSpecDraft) {
      setError(t("analysis.noDraft"));
      return;
    }
    if (!datasetFile) {
      setError(t("analysis.noDataset"));
      return;
    }

    setError(null);
    try {
      const specRes = await fetch("/api/task-specs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "proj-1",
          title: (taskSpecDraft.research_question as string) || "Analysis Task",
          analysis_type: taskSpecDraft.analysis_type || "generic",
          research_question: taskSpecDraft.research_question || "",
          spec_json: taskSpecDraft.spec_json || {},
        }),
      });
      if (!specRes.ok) throw new Error(`Failed to create TaskSpec (${specRes.status})`);
      const specData = await specRes.json();
      const taskSpecId = specData.task_spec_id;

      const fileHash = datasetFile
        ? await (async () => {
            const buf = await crypto.subtle.digest("SHA-256", await datasetFile.arrayBuffer());
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
          })()
        : "";

      // Upload dataset file first
      const uploadForm = new FormData();
      uploadForm.append("file", datasetFile);
      const uploadRes = await fetch("/api/dataset-snapshots/upload", {
        method: "POST",
        body: uploadForm,
      });
      if (!uploadRes.ok) throw new Error(`Failed to upload dataset (${uploadRes.status})`);
      const uploadData = await uploadRes.json();
      const storedPath = uploadData.stored_path;
      const uploadedHash = uploadData.file_hash_sha256;

      const datasetRes = await fetch("/api/dataset-snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "proj-1",
          task_spec_id: taskSpecId,
          original_filename: datasetFile.name,
          stored_path: storedPath,
          file_hash_sha256: uploadedHash || fileHash || undefined,
          validation_passed: true,
        }),
      });
      if (!datasetRes.ok) throw new Error(`Failed to create dataset snapshot (${datasetRes.status})`);
      const datasetData = await datasetRes.json();
      const datasetSnapshotId = datasetData.dataset_snapshot_id;
      setDatasetId(datasetSnapshotId);

      const taskRes = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "proj-1",
          task_spec_id: taskSpecId,
          dataset_snapshot_id: datasetSnapshotId,
          title: (taskSpecDraft.research_question as string) || "Analysis Task",
        }),
      });
      if (!taskRes.ok) throw new Error(`Failed to create task (${taskRes.status})`);
      const taskData = await taskRes.json();
      setTaskResult({ taskId: taskData.task_id, status: taskData.status });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const canCreateTask = !!taskSpecDraft && !!datasetFile && !taskResult;

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
        <AgentNav active="code" onNavigate={(path) => router.push(path)} />
      </aside>
      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push("/code-agent")}>
              <ArrowLeft size={16} />
            </Button>
            <div className="text-sm font-semibold tracking-tight text-zinc-700">Analysis Agent</div>
          </div>
        </header>

        <ScrollArea className="flex-1">
          <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
            <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-5 space-y-4">
              <div className="flex items-center gap-2">
                <FileJson size={18} className="text-zinc-600" />
                <h1 className="text-lg font-semibold">Analysis Agent</h1>
              </div>
              <p className="text-sm text-zinc-600">
                Describe your research goal and upload a dataset to generate a TaskSpec and queue an analysis task.
              </p>
            </section>

            <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-5 space-y-4">
              <div className="text-sm font-semibold text-zinc-700">Research Goal</div>
              <Composer
                input={input}
                isLoading={isStreaming}
                uploadingPdf={false}
                uploadedPapers={[]}
                inlineError={error}
                inputRef={{ current: null }}
                onInputChange={setInput}
                onSubmit={handleSubmit}
                onUploadPdf={() => {}}
                onStop={() => {
                  if (wsRef.current) wsRef.current.close(1000, "client_stop");
                }}
                onRetry={() => {}}
                onDismissError={() => setError(null)}
                unauthenticated={false}
              />
            </section>

            <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-5 space-y-4">
              <div className="text-sm font-semibold text-zinc-700">Dataset</div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="file"
                  className="text-sm text-zinc-600 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-zinc-100 file:text-zinc-700 hover:file:bg-zinc-200"
                  onChange={handleFileChange}
                />
                {datasetFile && (
                  <span className="text-xs text-zinc-500">{datasetFile.name} ({(datasetFile.size / 1024).toFixed(1)} KB)</span>
                )}
              </label>
              <Button
                variant="default"
                size="sm"
                className="gap-2"
                disabled={!canCreateTask}
                onClick={handleCreateTask}
              >
                <Upload size={14} />
                Create Task
              </Button>
              {taskResult && (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  <CheckCircle2 size={16} />
                  Task created: {taskResult.taskId} ({taskResult.status})
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => router.push(`/code-agent/tasks/${taskResult.taskId}`)}
                  >
                    View
                  </Button>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-5 space-y-4">
              <div className="text-sm font-semibold text-zinc-700">Agent Output</div>
              {events.length === 0 && !isStreaming && (
                <div className="text-sm text-zinc-400">No output yet. Send a research goal to start.</div>
              )}
              <ScrollArea className="h-[400px]">
                <div className="space-y-3">
                  {events.map((event, idx) => (
                    <div key={idx} className="rounded-xl border border-[var(--hairline)] p-3 text-sm">
                      <div className="text-xs text-zinc-400 mb-1">
                        {event.type}
                        {event.type === "status" && ` · ${event.phase}`}
                      </div>
                      {event.type === "chunk" && (
                        <pre className="whitespace-pre-wrap text-zinc-700">{event.content}</pre>
                      )}
                      {event.type === "task_spec_draft" && (
                        <pre className="whitespace-pre-wrap text-emerald-700 bg-emerald-50/50 rounded-lg p-3 overflow-auto">
                          {JSON.stringify(event.task_spec, null, 2)}
                          {event.validation_errors && event.validation_errors.length > 0 && (
                            <div className="mt-2 text-red-600">
                              Validation errors: {event.validation_errors.join(", ")}
                            </div>
                          )}
                        </pre>
                      )}
                      {event.type === "status" && (
                        <div className="text-xs text-zinc-500">
                          elapsed={event.elapsed_ms}ms attempt={event.attempt}/{event.max_attempts}
                        </div>
                      )}
                      {event.type === "error" && (
                        <div className="text-red-700">{event.message}</div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </section>
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
