"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpenText, LogIn, RefreshCw, Upload } from "lucide-react";
import { DiscoveryChrome } from "@/components/discovery/DiscoveryChrome";
import { PaperCard, PaperStatusBadge } from "@/components/papers/PaperCard";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/api/auth";
import { listPapers, uploadPaper, type DiscoveryPaper } from "@/lib/api/discovery";
import { redirectToLogin } from "@/lib/runtime-config";
import { useLanguage } from "@/lib/i18n";

type AuthStatus = "checking" | "authenticated" | "unauthenticated" | "error";

function AuthPrompt({ error }: { error?: string | null }) {
  const { t } = useLanguage();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      {error ? <p className="max-w-md text-sm text-red-600">{t("error.backendUnavailable")}: {error}</p> : <>
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm"><LogIn className="h-5 w-5 text-zinc-500" /></div>
        <div className="space-y-2"><h2 className="text-2xl font-medium tracking-tight">{t("auth.signInTitle")}</h2><p className="max-w-md text-sm text-zinc-500">{t("auth.signInDescription")}</p></div>
      </>}
      <Button type="button" className="gap-2 rounded-xl" onClick={error ? () => window.location.reload() : redirectToLogin}>{error ? t("composer.retry") : <><LogIn className="h-4 w-4" />{t("auth.signIn")}</>}</Button>
    </div>
  );
}

function Sidebar({ papers, onUpload }: { papers: DiscoveryPaper[]; onUpload: () => void }) {
  const { t } = useLanguage();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Button type="button" className="w-full justify-start gap-2 rounded-xl" onClick={onUpload}><Upload className="h-4 w-4" />{t("papers.upload")}</Button>
      <div className="mt-5 px-2 text-[11px] uppercase tracking-[0.2em] text-zinc-400">{t("papers.title")}</div>
      <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {papers.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-400">{t("papers.empty")}</div> : papers.map((paper) => (
          <a key={paper.paper_id} href={`/papers/${encodeURIComponent(paper.paper_id)}/`} className="block rounded-xl px-3 py-2 text-left hover:bg-zinc-100">
            <div className="truncate text-xs font-medium text-zinc-700">{paper.title}</div>
            <div className="mt-1"><PaperStatusBadge status={paper.status} /></div>
          </a>
        ))}
      </div>
    </div>
  );
}

export default function PapersWorkspace() {
  const { t } = useLanguage();
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadSectionRef = useRef<HTMLElement>(null);
  const [papers, setPapers] = useState<DiscoveryPaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [authError, setAuthError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadPapers = useCallback(async (silent = false) => {
    const requestId = ++requestSequence.current;
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const result = await listPapers();
      if (requestId !== requestSequence.current) return;
      setPapers(result);
      setError(null);
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getCurrentUser().then((user) => {
      if (cancelled) return;
      if (!user) { setAuthStatus("unauthenticated"); setLoading(false); return; }
      setAuthStatus("authenticated");
      void loadPapers();
    }).catch((reason) => {
      if (cancelled) return;
      setAuthStatus("error");
      setAuthError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [loadPapers]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !papers.some((paper) => paper.status === "requested" || paper.status === "processing")) return;
    const timer = setInterval(() => { void loadPapers(true); }, 5000);
    return () => clearInterval(timer);
  }, [authStatus, loadPapers, papers]);

  const chooseFile = (file: File | null) => {
    setSelectedFile(file);
    setUploadError(null);
    if (file && !title.trim()) setTitle(file.name.replace(/\.pdf$/i, ""));
  };

  const submitUpload = async () => {
    if (!selectedFile) { uploadRef.current?.click(); return; }
    setUploading(true);
    setUploadError(null);
    try {
      const paper = await uploadPaper(selectedFile, title);
      setPapers((current) => [paper, ...current.filter((item) => item.paper_id !== paper.paper_id)]);
      setSelectedFile(null);
      setTitle("");
      if (uploadRef.current) uploadRef.current.value = "";
      void loadPapers(true);
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUploading(false);
    }
  };

  const scrollToUpload = () => uploadSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <DiscoveryChrome active="papers" title={t("papers.title")} icon={BookOpenText} sidebar={authStatus === "authenticated" ? <Sidebar papers={papers} onUpload={scrollToUpload} /> : undefined} actions={authStatus === "authenticated" ? <Button type="button" variant="outline" size="sm" className="gap-1.5 rounded-xl" onClick={() => { void loadPapers(true); }} disabled={refreshing}><RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />{t("tasks.refresh")}</Button> : null}>
      {authStatus === "checking" ? <div className="flex min-h-[60vh] items-center justify-center text-sm text-zinc-500">{t("papers.loading")}</div> : authStatus === "unauthenticated" ? <AuthPrompt /> : authStatus === "error" ? <AuthPrompt error={authError} /> : (
        <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
          <div><h1 className="text-2xl font-semibold tracking-tight">{t("papers.title")}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{t("papers.subtitle")}</p></div>
          <section ref={uploadSectionRef} className="scroll-mt-20 rounded-3xl border border-blue-200 bg-blue-50/60 p-5 shadow-sm md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-base font-semibold text-blue-950">{t("papers.upload")}</h2><p className="mt-1 text-xs leading-5 text-blue-900/70">{t("papers.uploadHint")}</p></div><BookOpenText className="h-5 w-5 text-blue-600" /></div>
            <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-center">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl border border-dashed border-blue-300 bg-white/80 px-3 py-3 text-sm text-zinc-600 hover:border-blue-400"><Upload className="h-4 w-4 shrink-0 text-blue-600" /><span className="min-w-0 truncate">{selectedFile?.name ?? t("papers.chooseFile")}</span><input ref={uploadRef} type="file" accept="application/pdf,.pdf" className="sr-only" disabled={uploading} onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} /></label>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("papers.titlePlaceholder")} disabled={uploading} className="rounded-xl border border-blue-200 bg-white/90 px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-200 md:w-64" />
              <Button type="button" className="gap-2 rounded-xl" onClick={() => { void submitUpload(); }} disabled={uploading}>{uploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{uploading ? t("papers.uploading") : t("papers.upload")}</Button>
            </div>
            {uploadError ? <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("papers.uploadFailed", { message: uploadError })}</div> : null}
          </section>

          {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("papers.loadFailed", { message: error })}</div> : null}
          {loading && papers.length === 0 ? <div className="py-16 text-center text-sm text-zinc-500">{t("papers.loading")}</div> : papers.length === 0 ? <div className="rounded-3xl border border-dashed border-zinc-300 bg-white/60 px-6 py-16 text-center"><BookOpenText className="mx-auto h-8 w-8 text-zinc-300" /><h2 className="mt-4 text-base font-semibold text-zinc-700">{t("papers.empty")}</h2><p className="mt-2 text-sm text-zinc-500">{t("papers.emptyDescription")}</p></div> : <div className="grid gap-5 md:grid-cols-2">{papers.map((paper) => <PaperCard key={paper.paper_id} paper={paper} />)}</div>}
        </div>
      )}
    </DiscoveryChrome>
  );
}
