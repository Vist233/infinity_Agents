"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Database, FileWarning, LogIn, RefreshCw, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { DiscoveryChrome } from "@/components/discovery/DiscoveryChrome";
import { CollectionStatusBadge } from "@/components/data-collections/CollectionCard";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/api/auth";
import { deleteCollection, getCollection, listMatches, getPaper, type DiscoveryCollection, type DiscoveryMatch, type DiscoveryPaper } from "@/lib/api/discovery";
import { redirectToLogin } from "@/lib/runtime-config";
import { useLanguage } from "@/lib/i18n";

function collectionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/data-collections\/([^/]+)\/?$/);
  if (!match) return null;
  const value = decodeURIComponent(match[1]).trim();
  return value && value !== "preview" ? value : null;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function DetailAuth({ error }: { error?: string | null }) {
  const { t } = useLanguage();
  return <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">{error ? <p className="max-w-md text-sm text-red-600">{t("error.backendUnavailable")}: {error}</p> : <><div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm"><LogIn className="h-5 w-5 text-zinc-500" /></div><div className="space-y-2"><h2 className="text-2xl font-medium tracking-tight">{t("auth.signInTitle")}</h2><p className="max-w-md text-sm text-zinc-500">{t("auth.signInDescription")}</p></div></>}<Button type="button" className="gap-2 rounded-xl" onClick={error ? () => window.location.reload() : redirectToLogin}>{error ? t("composer.retry") : <><LogIn className="h-4 w-4" />{t("auth.signIn")}</>}</Button></div>;
}

export default function CollectionDetailClient() {
  const { t } = useLanguage();
  const router = useRouter();
  const params = useParams();
  const paramCollectionId = typeof params.collectionId === "string" ? params.collectionId : null;
  const collectionId = useMemo(() => typeof window !== "undefined" ? collectionIdFromPath(window.location.pathname) ?? (paramCollectionId && paramCollectionId !== "preview" ? paramCollectionId : null) : paramCollectionId && paramCollectionId !== "preview" ? paramCollectionId : null, [paramCollectionId]);
  const [collection, setCollection] = useState<DiscoveryCollection | null>(null);
  const [matches, setMatches] = useState<DiscoveryMatch[]>([]);
  const [papers, setPapers] = useState<Record<string, DiscoveryPaper>>({});
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated" | "error">("checking");
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!collectionId) { setLoading(false); return; }
    if (!silent) setLoading(true);
    try {
      const next = await getCollection(collectionId);
      setCollection(next);
      const allMatches = await listMatches();
      const relevant = allMatches.filter((match) => match.collection_id === collectionId);
      setMatches(relevant);
      const loadedPapers = await Promise.allSettled(relevant.slice(0, 32).map((match) => getPaper(match.paper_id)));
      const byId: Record<string, DiscoveryPaper> = {};
      loadedPapers.forEach((result) => { if (result.status === "fulfilled") byId[result.value.paper_id] = result.value; });
      setPapers(byId);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { if (!silent) setLoading(false); }
  }, [collectionId]);

  useEffect(() => {
    let cancelled = false;
    void getCurrentUser().then((user) => {
      if (cancelled) return;
      if (!user) { setAuthStatus("unauthenticated"); setLoading(false); return; }
      setAuthStatus("authenticated");
      void load();
    }).catch((reason) => {
      if (cancelled) return;
      setAuthStatus("error"); setAuthError(reason instanceof Error ? reason.message : String(reason)); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [load]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !collection || (collection.status !== "uploaded" && collection.status !== "inspecting")) return;
    const timer = setInterval(() => { void load(true); }, 5000);
    return () => clearInterval(timer);
  }, [authStatus, collection, load]);

  const handleDelete = async () => {
    if (!collection || !window.confirm(t("collections.deleteConfirm"))) return;
    setDeleting(true);
    try { await deleteCollection(collection.collection_id); router.push("/data-collections/"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setDeleting(false); }
  };

  const profile = collection?.profile;
  const capabilityEntries = profile ? Object.entries(profile.capabilities).sort(([left], [right]) => left.localeCompare(right)) : [];
  return <DiscoveryChrome active="collections" title={t("collections.detailTitle")} icon={Database} actions={authStatus === "authenticated" ? <><Button type="button" variant="ghost" size="sm" className="gap-1.5 rounded-xl" onClick={() => router.push("/data-collections/")}><ArrowLeft className="h-3.5 w-3.5" />{t("collections.back")}</Button><Button type="button" variant="outline" size="sm" className="gap-1.5 rounded-xl" onClick={() => { void load(); }} disabled={loading}><RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />{t("tasks.refresh")}</Button><Button type="button" variant="ghost" size="sm" className="gap-1.5 rounded-xl text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => { void handleDelete(); }} disabled={deleting}><Trash2 className="h-3.5 w-3.5" />{t("collections.delete")}</Button></> : null}>
    {authStatus === "checking" ? <div className="flex min-h-[60vh] items-center justify-center text-sm text-zinc-500">{t("collections.loading")}</div> : authStatus === "unauthenticated" ? <DetailAuth /> : authStatus === "error" ? <DetailAuth error={authError} /> : loading && !collection ? <div className="flex min-h-[60vh] items-center justify-center text-sm text-zinc-500">{t("collections.loading")}</div> : error && !collection ? <div className="mx-auto max-w-3xl p-6"><div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("collections.loadDetailFailed", { message: error })}</div></div> : collection ? <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
      <section id="overview" className="rounded-3xl border border-zinc-200 bg-white/90 p-5 shadow-sm md:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><CollectionStatusBadge status={collection.status} /><h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">{collection.name}</h1><p className="mt-2 text-sm text-zinc-500">{collection.source_filename} · {collection.source_content_type}</p></div><Database className="h-8 w-8 shrink-0 text-blue-200" /></div>{error ? <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}<div className="mt-6 grid gap-3 text-xs text-zinc-500 sm:grid-cols-4"><div className="rounded-xl bg-zinc-50 p-3"><div>{t("collections.size")}</div><div className="mt-1 font-medium text-zinc-700">{formatBytes(collection.source_size_bytes)}</div></div><div className="rounded-xl bg-zinc-50 p-3"><div>{t("collections.domain")}</div><div className="mt-1 font-medium text-zinc-700">{profile?.domain_hint ?? "—"}</div></div><div className="rounded-xl bg-zinc-50 p-3"><div>{t("collections.target")}</div><div className="mt-1 font-medium text-zinc-700">{profile?.semantic_fields.target ?? "—"}</div></div><div className="rounded-xl bg-zinc-50 p-3"><div>{t("collections.profileVersion")}</div><div className="mt-1 font-medium text-zinc-700">{collection.profile_version ?? "—"}</div></div></div></section>

      <section id="files" className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><h2 className="text-base font-semibold">{t("collections.filesSection")}</h2>{profile?.files.length ? <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="border-b border-zinc-100 text-xs text-zinc-400"><tr><th className="pb-2 pr-4 font-medium">{t("collections.file")}</th><th className="pb-2 pr-4 font-medium">{t("collections.type")}</th><th className="pb-2 pr-4 font-medium">{t("collections.size")}</th><th className="pb-2 pr-4 font-medium">{t("collections.rows")}</th><th className="pb-2 font-medium">{t("collections.columns")}</th></tr></thead><tbody>{profile.files.map((file) => <tr key={file.path} className="border-b border-zinc-50 last:border-0"><td className="py-3 pr-4 font-medium text-zinc-700">{file.path}</td><td className="py-3 pr-4 text-zinc-500">{file.format}</td><td className="py-3 pr-4 text-zinc-500">{formatBytes(file.size_bytes)}</td><td className="py-3 pr-4 text-zinc-500">{file.rows ?? "—"}</td><td className="py-3 text-zinc-500">{file.columns ?? "—"}</td></tr>)}</tbody></table></div> : <p className="mt-3 text-sm text-zinc-500">{t("collections.noProfile")}</p>}</section>

      <section id="schema" className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><h2 className="text-base font-semibold">{t("collections.schema")}</h2>{profile?.files.filter((file) => file.column_names.length > 0).map((file) => <div key={file.path} className="mt-4"><div className="text-xs font-semibold text-zinc-500">{file.path}</div><div className="mt-2 flex flex-wrap gap-2">{file.column_names.slice(0, 100).map((name) => <span key={name} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">{name}<span className="ml-1 text-zinc-400">{file.data_types[name] ?? "unknown"}</span></span>)}</div></div>)}{!profile?.files.some((file) => file.column_names.length > 0) ? <p className="mt-3 text-sm text-zinc-500">{t("collections.noProfile")}</p> : null}</section>

      <div className="grid gap-5 lg:grid-cols-2"><section id="capabilities" className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><h2 className="text-base font-semibold">{t("collections.capabilities")}</h2>{capabilityEntries.length ? <div className="mt-4 grid gap-2 sm:grid-cols-2">{capabilityEntries.map(([key, value]) => <div key={key} className="flex items-center justify-between gap-3 rounded-xl bg-zinc-50 px-3 py-2 text-xs"><span className="truncate text-zinc-600">{key}</span><span className="inline-flex shrink-0 items-center gap-1 font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />{typeof value === "boolean" ? value ? "yes" : "no" : String(value)}</span></div>)}</div> : <p className="mt-3 text-sm text-zinc-500">{t("collections.noProfile")}</p>}</section><section id="quality" className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><h2 className="text-base font-semibold">{t("collections.quality")}</h2>{profile?.files.length ? <div className="mt-4 space-y-3">{profile.files.map((file) => <div key={file.path} className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-zinc-600">{file.path}</span><span className="font-medium text-zinc-700">{file.missing_ratio == null ? "—" : `${(file.missing_ratio * 100).toFixed(1)}%`}</span></div>)}</div> : <p className="mt-3 text-sm text-zinc-500">{t("collections.noProfile")}</p>}</section></div>

      <section id="matches" className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm"><div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{t("collections.matchedPapers")}</h2><span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-500">{matches.length}</span></div>{matches.length ? <div className="mt-4 grid gap-3 md:grid-cols-2">{matches.map((match) => <div key={match.match_id} className="rounded-xl border border-zinc-100 bg-zinc-50 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-zinc-700">{papers[match.paper_id]?.title ?? match.paper_id}</h3><p className="mt-1 text-xs text-zinc-400">{t("collections.matchStatus")}: {match.status}</p></div><span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">{t("collections.matchCoverage")} {(match.coverage_ratio * 100).toFixed(0)}%</span></div>{papers[match.paper_id] ? <a className="mt-3 inline-block text-xs font-medium text-blue-700 hover:underline" href={`/papers/${encodeURIComponent(match.paper_id)}/`}>{t("collections.viewPaper")}</a> : null}{match.created_task_id ? <a className="mt-3 ml-3 inline-block text-xs font-medium text-blue-700 hover:underline" href={`/task-center/tasks/${encodeURIComponent(match.created_task_id)}/`}>Task {match.created_task_id}</a> : null}</div>)}</div> : <div className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-zinc-200 px-4 py-8 text-center"><FileWarning className="h-6 w-6 text-zinc-300" /><p className="mt-2 text-sm text-zinc-500">{t("collections.noMatches")}</p></div>}</section>
      <p className="text-right text-xs text-zinc-400">{formatDate(collection.updated_at)}</p>
    </div> : null}
  </DiscoveryChrome>;
}
