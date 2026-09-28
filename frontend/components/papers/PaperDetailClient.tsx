"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpenText, CheckCircle2, FileWarning, LogIn, RefreshCw, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import MarkdownRenderer from "@/components/markdown-renderer";
import { DiscoveryChrome } from "@/components/discovery/DiscoveryChrome";
import { PaperStatusBadge } from "@/components/papers/PaperCard";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/api/auth";
import { deletePaper, getPaper, type DiscoveryPaper } from "@/lib/api/discovery";
import { redirectToLogin } from "@/lib/runtime-config";
import { useLanguage } from "@/lib/i18n";

function paperIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/papers\/([^/]+)\/?$/);
  if (!match) return null;
  const value = decodeURIComponent(match[1]).trim();
  return value && value !== "preview" ? value : null;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function DetailAuth({ error }: { error?: string | null }) {
  const { t } = useLanguage();
  return <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center"><div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm"><LogIn className="h-5 w-5 text-zinc-500" /></div><div className="space-y-2"><h2 className="text-2xl font-medium tracking-tight">{error ? t("error.backendUnavailable") : t("auth.signInTitle")}</h2><p className="max-w-md text-sm text-zinc-500">{error ?? t("auth.signInDescription")}</p></div><Button type="button" className="gap-2 rounded-xl" onClick={error ? () => window.location.reload() : redirectToLogin}>{error ? t("composer.retry") : <><LogIn className="h-4 w-4" />{t("auth.signIn")}</>}</Button></div>;
}

export default function PaperDetailClient() {
  const { t } = useLanguage();
  const router = useRouter();
  const params = useParams();
  const paramPaperId = typeof params.paperId === "string" ? params.paperId : null;
  const paperId = useMemo(() => typeof window !== "undefined" ? paperIdFromPath(window.location.pathname) ?? (paramPaperId && paramPaperId !== "preview" ? paramPaperId : null) : paramPaperId && paramPaperId !== "preview" ? paramPaperId : null, [paramPaperId]);
  const [paper, setPaper] = useState<DiscoveryPaper | null>(null);
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated" | "error">("checking");
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!paperId) { setLoading(false); return; }
    if (!silent) setLoading(true);
    try {
      const next = await getPaper(paperId);
      setPaper(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [paperId]);

  useEffect(() => {
    let cancelled = false;
    void getCurrentUser().then((user) => {
      if (cancelled) return;
      if (!user) { setAuthStatus("unauthenticated"); setLoading(false); return; }
      setAuthStatus("authenticated");
      void load();
    }).catch((reason) => {
      if (cancelled) return;
      setAuthStatus("error");
      setAuthError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [load]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !paper || (paper.status !== "requested" && paper.status !== "processing")) return;
    const timer = setInterval(() => { void load(true); }, 5000);
    return () => clearInterval(timer);
  }, [authStatus, load, paper]);

  const handleDelete = async () => {
    if (!paper || paper.visibility !== "private" || !window.confirm(t("papers.deleteConfirm"))) return;
    setDeleting(true);
    try { await deletePaper(paper.paper_id); router.push("/papers/"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setDeleting(false); }
  };

  const profile = paper?.profile;
  return (
    <DiscoveryChrome active="papers" title={t("papers.detailTitle")} icon={BookOpenText} actions={authStatus === "authenticated" ? <><Button type="button" variant="ghost" size="sm" className="gap-1.5 rounded-xl" onClick={() => router.push("/papers/")}><ArrowLeft className="h-3.5 w-3.5" />{t("papers.back")}</Button><Button type="button" variant="outline" size="sm" className="gap-1.5 rounded-xl" onClick={() => { void load(); }} disabled={loading}><RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />{t("tasks.refresh")}</Button>{paper?.visibility === "private" ? <Button type="button" variant="ghost" size="sm" className="gap-1.5 rounded-xl text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => { void handleDelete(); }} disabled={deleting}><Trash2 className="h-3.5 w-3.5" />{t("papers.delete")}</Button> : null}</> : null}>
      {authStatus === "checking" ? <div className="flex min-h-[60vh] items-center justify-center text-sm text-zinc-500">{t("papers.loading")}</div> : authStatus === "unauthenticated" ? <DetailAuth /> : authStatus === "error" ? <DetailAuth error={authError} /> : loading && !paper ? <div className="flex min-h-[60vh] items-center justify-center text-sm text-zinc-500">{t("papers.loading")}</div> : error && !paper ? <div className="mx-auto max-w-3xl p-6"><div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("papers.loadDetailFailed", { message: error })}</div></div> : paper ? (
        <div className="mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[210px_minmax(0,1fr)] md:p-6">
          <nav className="hidden h-fit space-y-1 rounded-2xl border border-zinc-200 bg-white/70 p-2 md:block" aria-label={t("papers.detailTitle")}>
            {["overview", "question", "data", "analysis", "results", "evidence"].map((id) => <a key={id} href={`#${id}`} className="block rounded-xl px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100">{t((id === "overview" ? "papers.overview" : id === "question" ? "papers.researchQuestion" : id === "data" ? "papers.dataRequirements" : id === "analysis" ? "papers.analysisModules" : id === "results" ? "papers.expectedResults" : "papers.evidence") as never)}</a>)}
          </nav>
          <article className="min-w-0 space-y-5">
            <section id="overview" className="scroll-mt-20 rounded-3xl border border-zinc-200 bg-white/90 p-5 shadow-sm md:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><PaperStatusBadge status={paper.status} />{paper.spam_status !== "pending" ? <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">{paper.spam_status}</span> : null}</div><h1 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-900 md:text-3xl">{paper.title}</h1><p className="mt-3 text-sm text-zinc-500">{paper.authors.length ? paper.authors.join(" · ") : t("papers.authors")}{paper.venue ? ` · ${paper.venue}` : ""}{paper.year ? ` · ${paper.year}` : ""}</p></div><BookOpenText className="h-7 w-7 shrink-0 text-zinc-300" /></div>
              <div className="mt-6 grid gap-3 text-xs text-zinc-500 sm:grid-cols-3"><div className="rounded-xl bg-zinc-50 p-3"><div>{t("papers.profileVersion")}</div><div className="mt-1 font-medium text-zinc-700">{paper.profile_version ?? "—"}</div></div><div className="rounded-xl bg-zinc-50 p-3"><div>{t("papers.source")}</div><div className="mt-1 font-medium text-zinc-700">{paper.visibility}</div></div><div className="rounded-xl bg-zinc-50 p-3"><div>{t("papers.year")}</div><div className="mt-1 font-medium text-zinc-700">{paper.year ?? "—"}</div></div></div>
              {error ? <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
            </section>

            <section id="question" className="scroll-mt-20 rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><h2 className="text-base font-semibold">{t("papers.researchQuestion")}</h2><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-600">{profile?.research_question || profile?.paper.research_question || t("papers.noProfile")}</p>{profile?.main_claims.length ? <div className="mt-5 space-y-2"><div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">Claims</div>{profile.main_claims.map((claim) => <div key={claim} className="rounded-xl bg-zinc-50 px-3 py-2 text-sm text-zinc-600">{claim}</div>)}</div> : null}</section>

            <section id="data" className="scroll-mt-20 rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><h2 className="text-base font-semibold">{t("papers.dataRequirements")}</h2>{profile?.required_capabilities.length ? <div className="mt-3 flex flex-wrap gap-2">{profile.required_capabilities.map((item) => <span key={item} className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700">{item}</span>)}</div> : <p className="mt-3 text-sm text-zinc-500">{t("papers.noRequirements")}</p>}</section>

            <section id="analysis" className="scroll-mt-20 space-y-3"><div className="flex items-center gap-2"><h2 className="text-base font-semibold">{t("papers.analysisModules")}</h2>{profile ? <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-500">{profile.analysis_modules.length}</span> : null}</div>{profile?.analysis_modules.length ? profile.analysis_modules.map((module, index) => <div key={module.analysis_id} className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><div className="flex items-start gap-3"><div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-xs font-semibold text-white">{index + 1}</div><div className="min-w-0"><h3 className="font-semibold text-zinc-800">{module.name}</h3><p className="mt-2 text-sm leading-6 text-zinc-600">{module.goal || t("papers.noProfile")}</p></div></div><div className="mt-4 grid gap-4 text-xs sm:grid-cols-2"><div><div className="font-semibold uppercase tracking-[0.14em] text-zinc-400">Required</div><div className="mt-2 flex flex-wrap gap-2">{module.required_capabilities.length ? module.required_capabilities.map((item) => <span key={item} className="rounded-full bg-blue-50 px-2.5 py-1 text-blue-700">{item}</span>) : <span className="text-zinc-400">—</span>}</div></div><div><div className="font-semibold uppercase tracking-[0.14em] text-zinc-400">{t("papers.expectedResults")}</div><ul className="mt-2 list-disc space-y-1 pl-4 text-zinc-600">{module.expected_outputs.length ? module.expected_outputs.map((item) => <li key={item}>{item}</li>) : <li>—</li>}</ul></div></div></div>) : <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center text-sm text-zinc-500">{paper.status === "failed" ? <FileWarning className="mx-auto mb-2 h-6 w-6 text-red-400" /> : <RefreshCw className="mx-auto mb-2 h-6 w-6 text-zinc-300" />}{t("papers.noProfile")}</div>}</section>

            <section id="results" className="scroll-mt-20 rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><h2 className="text-base font-semibold">{t("papers.expectedResults")}</h2>{profile?.expected_outputs.length ? <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-zinc-600">{profile.expected_outputs.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="mt-3 text-sm text-zinc-500">{t("papers.noResults")}</p>}</section>

            <section id="evidence" className="scroll-mt-20 rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><h2 className="text-base font-semibold">{t("papers.evidence")}</h2>{profile?.evidence.length ? <div className="mt-3 space-y-2">{profile.evidence.map((item, index) => <div key={`${item.page ?? "x"}-${item.section ?? "x"}-${index}`} className="rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-3 text-sm text-zinc-600"><div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-600" /><span>{item.section ?? "Unsectioned evidence"}</span>{item.page ? <span className="text-xs text-zinc-400">· p. {item.page}</span> : null}</div>{item.quote ? <p className="mt-2 text-xs leading-5 text-zinc-500">“{item.quote}”</p> : null}</div>)}</div> : <p className="mt-3 text-sm text-zinc-500">{t("papers.noEvidence")}</p>}</section>

            {paper.overview ? <section className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><MarkdownRenderer content={paper.overview} /></section> : null}
            <p className="text-right text-xs text-zinc-400">{formatDate(paper.updated_at)}</p>
          </article>
        </div>
      ) : null}
    </DiscoveryChrome>
  );
}
