"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, Server, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import {
  createPublicWorker,
  getPublicWorkerCredential,
  getPublicWorkerPool,
  revokePublicWorker,
  rotatePublicWorkerCredential,
  type PublicWorkerPoolResponse,
  type WorkerRegistration,
} from "@/lib/api/tasks";

function statusKey(worker: WorkerRegistration): string {
  if (worker.status === "revoked") return "tasks.publicWorkersRevoked";
  if (worker.presence === "online") return "tasks.publicWorkersOnline";
  if (worker.presence === "never_seen") return "tasks.publicWorkersNeverSeen";
  return "tasks.publicWorkersOffline";
}

function statusClass(worker: WorkerRegistration): string {
  if (worker.status === "revoked") return "bg-zinc-100 text-zinc-600";
  if (worker.presence === "online") return "bg-emerald-100 text-emerald-700";
  return "bg-amber-100 text-amber-700";
}

type CredentialResponse = { worker_id: string; worker_credential: string };

/** Superuser-only management for the platform-owned public execution pool. */
export function PublicWorkerAdminPanel() {
  const { t } = useLanguage();
  const [pool, setPool] = useState<PublicWorkerPoolResponse | null>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const loadPool = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getPublicWorkerPool();
      setPool(response);
      setVisible(true);
      setError(null);
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 401 || status === 403) {
        setVisible(false);
        setPool(null);
        return;
      }
      setVisible(true);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  // Probe the server-side admin route without rendering a public management
  // card to ordinary users, including during the initial request.
  if (!visible) return null;

  async function provisionTwo() {
    if (!pool) return;
    const missing = Math.max(0, 2 - pool.workers.filter((worker) => worker.status !== "revoked").length);
    if (missing === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const created: CredentialResponse[] = [];
      for (let index = 0; index < missing; index += 1) {
        created.push(await createPublicWorker());
      }
      setCredentials((current) => ({
        ...current,
        ...Object.fromEntries(created.map((item) => [item.worker_id, item.worker_credential])),
      }));
      await loadPool();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCredential(workerId: string) {
    setError(null);
    try {
      let credential = credentials[workerId];
      if (!credential) {
        const response = await getPublicWorkerCredential(workerId);
        credential = response.worker_credential;
      }
      await navigator.clipboard.writeText(credential);
      setCredentials((current) => ({ ...current, [workerId]: "" }));
      setCopied(workerId);
      window.setTimeout(() => setCopied((current) => current === workerId ? null : current), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function rotateCredential(workerId: string) {
    if (!window.confirm(t("tasks.publicWorkersRotateConfirm"))) return;
    setError(null);
    try {
      const response = await rotatePublicWorkerCredential(workerId);
      setCredentials((current) => ({ ...current, [workerId]: response.worker_credential }));
      await loadPool();
    } catch (err) {
      setError(t("tasks.publicWorkersRotateFailed", { message: err instanceof Error ? err.message : String(err) }));
    }
  }

  async function revokeWorker(workerId: string) {
    if (!window.confirm(t("tasks.publicWorkersRevokeConfirm"))) return;
    setError(null);
    try {
      await revokePublicWorker(workerId);
      setCredentials((current) => {
        const next = { ...current };
        delete next[workerId];
        return next;
      });
      await loadPool();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const activeCount = pool?.workers.filter((worker) => worker.status !== "revoked").length ?? 0;
  const activeWorkers = pool?.workers.filter((worker) => worker.status !== "revoked") ?? [];

  return (
    <section data-testid="public-worker-admin-panel" className="rounded-2xl border border-violet-200 bg-violet-50/70 overflow-hidden">
      <div className="flex items-center justify-between gap-3 p-5">
        <div className="flex items-start gap-3">
          <Server size={18} className="mt-0.5 text-violet-700" />
          <div>
            <div className="text-sm font-semibold text-violet-950">{t("tasks.publicWorkersTitle")}</div>
            <p className="mt-1 text-xs leading-5 text-violet-900/75">{t("tasks.publicWorkersDescription")}</p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-violet-800" onClick={() => { void loadPool(); }} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {loading && !pool && <div className="border-t border-violet-200 px-5 py-4 text-xs text-violet-900/70">{t("tasks.publicWorkersLoading")}</div>}
      {error && <div role="alert" className="mx-5 mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      {pool && (
        <div className="border-t border-violet-200 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-violet-950">
            <div className="space-y-1">
              <div><span className="font-medium">{t("tasks.publicWorkersPool")}:</span> <code>{pool.pool.pool_id}</code></div>
              <div><span className="font-medium">{t("tasks.publicWorkersNamespace")}:</span> <code>{pool.pool.namespace}</code></div>
              <div><span className="font-medium">{t("tasks.publicWorkersCount")}:</span> {activeCount}</div>
            </div>
            <Button type="button" size="sm" className="gap-2" onClick={() => { void provisionTwo(); }} disabled={submitting || activeCount >= 2}>
              <KeyRound size={14} />
              {submitting ? t("tasks.publicWorkersProvisioning") : activeCount >= 2 ? t("tasks.publicWorkersReady") : t("tasks.publicWorkersProvisionTwo")}
            </Button>
          </div>

          <div className="space-y-2">
            {pool.workers.map((worker) => {
              const credentialReady = Boolean(credentials[worker.worker_id]);
              const slotIndex = activeWorkers.findIndex((item) => item.worker_id === worker.worker_id);
              return (
                <div key={`${worker.worker_id}:${worker.namespace}`} className="rounded-xl border border-violet-200/80 bg-white/70 px-3 py-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-zinc-700">
                        {slotIndex >= 0 && <span className="mr-2 font-medium text-violet-800">{t("tasks.publicWorkersSlot", { slot: String.fromCharCode(65 + slotIndex) })}</span>}
                        <code>{worker.worker_id}</code>
                      </div>
                      <div className="mt-1 text-violet-900/70">{worker.namespace} · {worker.status === "revoked" ? t("tasks.publicWorkersRevoked") : t("tasks.publicWorkersActive")}</div>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 font-medium ${statusClass(worker)}`}>{t(statusKey(worker) as never)}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {credentialReady && <span className="min-w-0 flex-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 font-mono text-[10px] text-emerald-800">{credentials[worker.worker_id]}</span>}
                    <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]" onClick={() => { void copyCredential(worker.worker_id); }}>
                      {copied === worker.worker_id ? <Check size={12} /> : <Copy size={12} />}
                      {copied === worker.worker_id ? t("tasks.publicWorkersCopied") : t("tasks.publicWorkersCopyCredential")}
                    </Button>
                    {worker.status !== "revoked" && <Button type="button" variant="ghost" size="sm" className="h-7 text-[11px] text-violet-800" onClick={() => { void rotateCredential(worker.worker_id); }}>
                      {t("tasks.publicWorkersRotate")}
                    </Button>}
                    {worker.status !== "revoked" && <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-[11px] text-red-700" onClick={() => { void revokeWorker(worker.worker_id); }}>
                      <ShieldAlert size={12} />
                      {t("tasks.publicWorkersRevoke")}
                    </Button>}
                  </div>
                  {credentialReady && <div className="mt-2 text-[10px] text-emerald-700">{t("tasks.publicWorkersCredentialReady")}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
