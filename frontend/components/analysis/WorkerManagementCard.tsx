"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Loader2, Plus, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import { issueWorkerEnrollment } from "@/lib/api/tasks";

/** Worker enrollment stays collapsed because most tasks use the shared pool. */
export function WorkerManagementCard() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [workerId, setWorkerId] = useState("");
  const [namespace, setNamespace] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"success" | "failed" | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!workerId.trim() || !namespace.trim()) {
      setError(t("workers.requireFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    setToken(null);
    setCopyState(null);
    try {
      const result = await issueWorkerEnrollment({ worker_id: workerId.trim(), namespace: namespace.trim() });
      setToken(result.credential);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const copyCredential = async () => {
    if (!token) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(token);
      setCopyState("success");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section className="rounded-2xl border border-[var(--hairline)] bg-white/80 p-4 shadow-sm">
      <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="flex items-center gap-2 text-sm font-semibold text-zinc-700"><Server size={16} className="text-zinc-500" />{t("workers.title")}</span>
        {open ? <ChevronDown size={16} className="text-zinc-400" /> : <ChevronRight size={16} className="text-zinc-400" />}
      </button>
      {!open ? <p className="mt-2 text-xs text-zinc-500">{t("workers.collapsedDescription")}</p> : (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-zinc-500">{t("workers.description")}</p>
          <label className="block text-xs font-medium text-zinc-600">
            {t("workers.workerId")}
            <input value={workerId} onChange={(event) => setWorkerId(event.target.value)} placeholder={t("workers.workerIdPlaceholder")} className="mt-1 w-full rounded-xl border border-[var(--hairline)] bg-white px-3 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-zinc-300" />
          </label>
          <label className="block text-xs font-medium text-zinc-600">
            {t("workers.namespace")}
            <input value={namespace} onChange={(event) => setNamespace(event.target.value)} placeholder={t("workers.namespacePlaceholder")} className="mt-1 w-full rounded-xl border border-[var(--hairline)] bg-white px-3 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-zinc-300" />
          </label>
          <Button className="w-full gap-2 rounded-xl" disabled={submitting} onClick={() => { void submit(); }}>
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {submitting ? t("workers.creating") : t("workers.create")}
          </Button>
          {token && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="font-semibold">{t("workers.tokenTitle")}</div>
              <div className="mt-2 break-all font-mono">{token}</div>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-amber-800 underline" onClick={() => { void copyCredential(); }}>
                <Copy size={12} />{t("workers.copy")}
              </button>
              {copyState === "success" && <div className="mt-1 text-emerald-700">{t("workers.copySuccess")}</div>}
              {copyState === "failed" && <div className="mt-1 text-red-700">{t("workers.copyFailed")}</div>}
            </div>
          )}
          {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
        </div>
      )}
    </section>
  );
}
