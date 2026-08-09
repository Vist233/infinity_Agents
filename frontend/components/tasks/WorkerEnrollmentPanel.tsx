"use client";

import { FormEvent, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import {
  createWorkerEnrollment,
  type WorkerEnrollmentResponse,
} from "@/lib/api/tasks";

const TRUST_LEVELS = [
  { value: "owner_trusted", labelKey: "tasks.enrollmentTrustOwner" },
  { value: "institution_trusted", labelKey: "tasks.enrollmentTrustInstitution" },
  { value: "student_untrusted", labelKey: "tasks.enrollmentTrustStudent" },
] as const;

export function WorkerEnrollmentPanel() {
  const { t } = useLanguage();
  const [workerId, setWorkerId] = useState("mac-worker-local");
  const [namespace, setNamespace] = useState("infinity");
  const [trustLevel, setTrustLevel] = useState<WorkerEnrollmentResponse["trust_level"]>("owner_trusted");
  const [ttlSeconds, setTtlSeconds] = useState("600");
  const [result, setResult] = useState<WorkerEnrollmentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const response = await createWorkerEnrollment({
        worker_id: workerId.trim(),
        namespace: namespace.trim(),
        trust_level: trustLevel,
        ttl_seconds: Number(ttlSeconds),
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToken() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.enrollment_token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section data-testid="worker-enrollment-panel" className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <KeyRound size={18} className="mt-0.5 text-amber-700" />
        <div>
          <div className="text-sm font-semibold text-amber-950">{t("tasks.enrollmentTitle")}</div>
          <p className="text-xs text-amber-900/80 mt-1">{t("tasks.enrollmentDescription")}</p>
        </div>
      </div>

      <form className="grid gap-3 md:grid-cols-2" onSubmit={handleSubmit}>
        <label className="space-y-1 text-xs text-zinc-700">
          <span>{t("tasks.enrollmentWorkerId")}</span>
          <input
            value={workerId}
            onChange={(event) => setWorkerId(event.target.value)}
            className="h-9 w-full rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:border-amber-400"
            required
            maxLength={120}
            data-testid="worker-enrollment-worker-id"
          />
        </label>
        <label className="space-y-1 text-xs text-zinc-700">
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
        <label className="space-y-1 text-xs text-zinc-700">
          <span>{t("tasks.enrollmentTrustLevel")}</span>
          <select
            value={trustLevel}
            onChange={(event) => setTrustLevel(event.target.value as WorkerEnrollmentResponse["trust_level"])}
            className="h-9 w-full rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:border-amber-400"
            data-testid="worker-enrollment-trust-level"
          >
            {TRUST_LEVELS.map((level) => <option key={level.value} value={level.value}>{t(level.labelKey as never)}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-zinc-700">
          <span>{t("tasks.enrollmentTtl")}</span>
          <input
            type="number"
            min={30}
            max={3600}
            value={ttlSeconds}
            onChange={(event) => setTtlSeconds(event.target.value)}
            className="h-9 w-full rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:border-amber-400"
            required
            data-testid="worker-enrollment-ttl"
          />
        </label>
        <div className="md:col-span-2 flex items-center gap-3">
          <Button type="submit" variant="default" size="sm" disabled={submitting || !workerId.trim() || !namespace.trim()} data-testid="worker-enrollment-submit">
            {submitting ? t("tasks.enrollmentIssuing") : t("tasks.enrollmentIssue")}
          </Button>
          <span className="text-xs text-amber-900/70">{t("tasks.enrollmentServerGuard")}</span>
        </div>
      </form>

      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{t("tasks.enrollmentFailed")}: {error}</div>}

      {result && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2" data-testid="worker-enrollment-result">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-900"><Check size={15} />{t("tasks.enrollmentIssued")}</div>
          <p className="text-xs text-emerald-900/80">{t("tasks.enrollmentTokenHint", { expiresAt: new Date(result.expires_at).toLocaleString() })}</p>
          <div className="flex gap-2">
            <input readOnly value={result.enrollment_token} aria-label={t("tasks.enrollmentTokenLabel")} className="min-w-0 flex-1 rounded-md border border-emerald-200 bg-white px-3 py-2 font-mono text-xs" />
            <Button type="button" variant="outline" size="sm" onClick={() => { void copyToken(); }}>
              <Copy size={14} />{copied ? t("tasks.enrollmentCopied") : t("tasks.enrollmentCopy")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
