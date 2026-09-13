"use client";

import Link from "next/link";
import { ArrowUpRight, BookOpenText, CheckCircle2, Clock3, FileWarning, Loader2 } from "lucide-react";
import { useLanguage, type TranslationKey } from "@/lib/i18n";
import type { DiscoveryPaper, PaperStatus } from "@/lib/api/discovery";

const STATUS_LABEL: Record<PaperStatus, TranslationKey> = {
  requested: "papers.statusRequested",
  processing: "papers.statusProcessing",
  profiled: "papers.statusProfiled",
  failed: "papers.statusFailed",
  deleted: "papers.statusFailed",
};

const STATUS_STYLE: Record<PaperStatus, string> = {
  requested: "bg-zinc-100 text-zinc-600",
  processing: "bg-blue-100 text-blue-700",
  profiled: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  deleted: "bg-zinc-100 text-zinc-500",
};

function StatusIcon({ status }: { status: PaperStatus }) {
  if (status === "processing") return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (status === "profiled") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "failed") return <FileWarning className="h-3.5 w-3.5" />;
  if (status === "requested") return <Clock3 className="h-3.5 w-3.5" />;
  return <FileWarning className="h-3.5 w-3.5" />;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

export function PaperCard({ paper }: { paper: DiscoveryPaper }) {
  const { t } = useLanguage();
  const profile = paper.profile;
  const tags = profile?.display_tags ?? [];
  const moduleCount = profile?.analysis_modules.length ?? 0;
  return (
    <Link
      href={`/papers/${encodeURIComponent(paper.paper_id)}/`}
      className="group block rounded-3xl border border-zinc-200 bg-white/90 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md"
      aria-label={`${t("papers.open")}: ${paper.title}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-500"><BookOpenText className="h-5 w-5" /></div>
          <div className="min-w-0">
            <h2 className="line-clamp-2 text-base font-semibold tracking-tight text-zinc-900 group-hover:text-blue-700">{paper.title}</h2>
            <p className="mt-1 line-clamp-1 text-xs text-zinc-500">
              {paper.authors.length ? paper.authors.join(" · ") : t("papers.authors")}
              {paper.venue ? ` · ${paper.venue}` : ""}
              {paper.year ? ` · ${paper.year}` : ""}
            </p>
          </div>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-zinc-300 transition-colors group-hover:text-blue-600" />
      </div>

      {tags.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {tags.slice(0, 12).map((tag) => <span key={tag} className="rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-600">{tag}</span>)}
        </div>
      ) : <div className="mt-5 text-xs text-zinc-400">{paper.status === "profiled" ? t("papers.noProfile") : t("papers.loading")}</div>}

      <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${STATUS_STYLE[paper.status]}`}>
          <StatusIcon status={paper.status} />{t(STATUS_LABEL[paper.status])}
        </span>
        {paper.status === "profiled" ? <span>{moduleCount} {t("papers.modules")}</span> : null}
        <span className="ml-auto">{formatDate(paper.updated_at)}</span>
      </div>
    </Link>
  );
}

export function PaperStatusBadge({ status }: { status: PaperStatus }) {
  const { t } = useLanguage();
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[status]}`}><StatusIcon status={status} />{t(STATUS_LABEL[status])}</span>;
}
