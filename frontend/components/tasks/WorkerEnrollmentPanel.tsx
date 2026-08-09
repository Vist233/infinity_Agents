"use client";

import { FormEvent, useEffect, useState } from "react";
import { Check, ChevronDown, Copy, KeyRound, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import {
  createWorkerEnrollment,
  listWorkerEnrollments,
  type WorkerEnrollmentResponse,
  type WorkerRegistration,
} from "@/lib/api/tasks";

function trustLabelKey(value: WorkerRegistration["trust_level"] | WorkerEnrollmentResponse["trust_level"]): string {
  if (value === "owner_trusted") return "tasks.enrollmentTrustOwner";
  if (value === "student_untrusted") return "tasks.enrollmentTrustStudent";
  return "tasks.enrollmentTrustInstitution";
}

export function WorkerEnrollmentPanel() {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const [namespace, setNamespace] = useState("infinity");
  const [result, setResult] = useState<WorkerEnrollmentResponse | null>(null);
  const [workers, setWorkers] = useState<WorkerRegistration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingWorkers, setLoadingWorkers] = useState(false);

  async function loadWorkers() {
    setLoadingWorkers(true);
    try {
      setWorkers(await listWorkerEnrollments());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingWorkers(false);
    }
  }

  useEffect(() => {
    if (!expanded) return;
    void loadWorkers();
  }, [expanded]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const response = await createWorkerEnrollment({ namespace: namespace.trim() });
      setResult(response);
      await loadWorkers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCredential() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.worker_credential);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section data-testid="worker-enrollment-panel" className="rounded-2xl border border-amber-200 bg-amber-50/70 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 p-5 text-left hover:bg-amber-100/40 transition-colors"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-testid="worker-enrollment-toggle"
      >
        <span className="flex items-start gap-3">
          <KeyRound size={18} className="mt-0.5 text-amber-700" />
          <span>
            <span className="block text-sm font-semibold text-amber-950">{t("tasks.enrollmentTitle")}</span>
            <span className="block text-xs text-amber-900/80 mt-1">{t("tasks.enrollmentDescription")}</span>
          </span>
        </span>
        <ChevronDown size={18} className={`shrink-0 text-amber-700 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="border-t border-amber-200 p-5 space-y-4">
          <form className="space-y-3" onSubmit={handleSubmit}>
            <label className="block space-y-1 text-xs text-zinc-700">
              <span>{t("tasks.enrollmentNamespace")}</span>
              <input
                value={namespace}
                onChange={(event) => setNamespace(event.target.value)}
                className="h-9 w-full rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:border-amber-400"
                required
                maxLength={120}
                data-testid="worker-enrollment-namespace"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="default" size="sm" disabled={submitting || !namespace.trim()} data-testid="worker-enrollment-submit">
                {submitting ? t("tasks.enrollmentIssuing") : t("tasks.enrollmentIssue")}
              </Button>
              <span className="text-xs text-amber-900/70">{t("tasks.enrollmentServerGuard")}</span>
            </div>
          </form>

          {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{t("tasks.enrollmentFailed")}: {error}</div>}

          {result && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2" data-testid="worker-enrollment-result">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-900"><Check size={15} />{t("tasks.enrollmentIssued")}</div>
              <p className="text-xs text-emerald-900/80">{t("tasks.enrollmentTokenHint")}</p>
              <div className="grid gap-1 text-xs text-emerald-950">
                <div><span className="font-medium">{t("tasks.enrollmentWorkerId")}:</span> <code>{result.worker_id}</code></div>
                <div><span className="font-medium">{t("tasks.enrollmentTrustLevel")}:</span> {t(trustLabelKey(result.trust_level) as never)}</div>
              </div>
              <div className="flex gap-2">
                <input readOnly value={result.worker_credential} aria-label={t("tasks.enrollmentTokenLabel")} className="min-w-0 flex-1 rounded-md border border-emerald-200 bg-white px-3 py-2 font-mono text-xs" />
                <Button type="button" variant="outline" size="sm" onClick={() => { void copyCredential(); }}>
                  <Copy size={14} />{copied ? t("tasks.enrollmentCopied") : t("tasks.enrollmentCopy")}
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-medium text-amber-950">
              <span className="flex items-center gap-1.5"><Server size={14} />{t("tasks.enrollmentExisting")}</span>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => { void loadWorkers(); }} disabled={loadingWorkers}>
                <RefreshCw size={13} className={loadingWorkers ? "animate-spin" : ""} />
              </Button>
            </div>
            {workers.length === 0 && !loadingWorkers && <div className="text-xs text-amber-900/70">{t("tasks.enrollmentNoExisting")}</div>}
            {workers.length > 0 && (
              <div className="space-y-1">
                {workers.map((worker) => (
                  <div key={`${worker.worker_id}:${worker.namespace}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200/80 bg-white/70 px-3 py-2 text-xs">
                    <span className="min-w-0 truncate font-mono text-zinc-700">{worker.worker_id}</span>
                    <span className="text-amber-900/80">{worker.namespace} · {t(trustLabelKey(worker.trust_level) as never)} · {worker.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
