"use client";

import Link from "next/link";
import { ArrowUpRight, CheckCircle2, Database, FileWarning, Loader2 } from "lucide-react";
import { useLanguage, type TranslationKey } from "@/lib/i18n";
import type { CollectionStatus, DiscoveryCollection } from "@/lib/api/discovery";

const STATUS_LABEL: Record<CollectionStatus, TranslationKey> = {
  uploaded: "collections.statusUploaded",
  inspecting: "collections.statusInspecting",
  ready: "collections.statusReady",
  failed: "collections.statusFailed",
  deleted: "collections.statusFailed",
};

const STATUS_STYLE: Record<CollectionStatus, string> = {
  uploaded: "bg-zinc-100 text-zinc-600",
  inspecting: "bg-blue-100 text-blue-700",
  ready: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  deleted: "bg-zinc-100 text-zinc-500",
};

function StatusIcon({ status }: { status: CollectionStatus }) {
  if (status === "inspecting") return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (status === "ready") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "failed") return <FileWarning className="h-3.5 w-3.5" />;
  return <Database className="h-3.5 w-3.5" />;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function profileStats(collection: DiscoveryCollection): { files: number; samples: string; features: string } {
  const profile = collection.profile;
  const sampleCount = profile?.capabilities.sample_count;
  const featureCount = profile?.capabilities.feature_count;
  return {
    files: profile?.files.length ?? 0,
    samples: typeof sampleCount === "number" ? sampleCount.toLocaleString() : "—",
    features: typeof featureCount === "number" ? featureCount.toLocaleString() : "—",
  };
}

export function CollectionCard({ collection }: { collection: DiscoveryCollection }) {
  const { t } = useLanguage();
  const stats = profileStats(collection);
  const tags = collection.profile?.display_tags ?? [];
  return (
    <Link
      href={`/data-collections/${encodeURIComponent(collection.collection_id)}/`}
      className="group block rounded-3xl border border-zinc-200 bg-white/90 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md"
      aria-label={`${t("collections.open")}: ${collection.name}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><Database className="h-5 w-5" /></div>
          <div className="min-w-0">
            <h2 className="line-clamp-2 text-base font-semibold tracking-tight text-zinc-900 group-hover:text-blue-700">{collection.name}</h2>
            <p className="mt-1 line-clamp-1 text-xs text-zinc-500">{collection.source_filename} · {collection.source_content_type}</p>
          </div>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-zinc-300 transition-colors group-hover:text-blue-600" />
      </div>

      {tags.length > 0 ? <div className="mt-5 flex flex-wrap gap-2">{tags.slice(0, 12).map((tag) => <span key={tag} className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">{tag}</span>)}</div> : <div className="mt-5 text-xs text-zinc-400">{collection.status === "ready" ? t("collections.noProfile") : t("collections.loading")}</div>}

      <div className="mt-5 grid grid-cols-3 gap-2 border-t border-zinc-100 pt-4 text-xs text-zinc-500">
        <div><div className="font-semibold text-zinc-700">{stats.files}</div><div>{t("collections.files")}</div></div>
        <div><div className="font-semibold text-zinc-700">{stats.samples}</div><div>{t("collections.samples")}</div></div>
        <div><div className="font-semibold text-zinc-700">{stats.features}</div><div>{t("collections.features")}</div></div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${STATUS_STYLE[collection.status]}`}><StatusIcon status={collection.status} />{t(STATUS_LABEL[collection.status])}</span>
        <span className="ml-auto text-zinc-400">{formatDate(collection.updated_at)}</span>
      </div>
    </Link>
  );
}

export function CollectionStatusBadge({ status }: { status: CollectionStatus }) {
  const { t } = useLanguage();
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[status]}`}><StatusIcon status={status} />{t(STATUS_LABEL[status])}</span>;
}
