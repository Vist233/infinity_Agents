"use client";

import { ExternalLink, Laptop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";

/**
 * Static cloud pages are an entry point for the local product, not a proxy to
 * a user's laptop. The optional URL is a top-level navigation target and is
 * intentionally not used as an implicit cross-origin API base.
 */
export function LocalRuntimeNotice() {
  const { t } = useLanguage();
  // A top-level localhost navigation is safe from an HTTPS page and gives the
  // user an actionable default. Deployments may override it for a local app
  // served on another port or hostname.
  const localAppUrl = process.env.NEXT_PUBLIC_LOCAL_APP_URL?.trim() || "http://localhost:3000/task-center/";

  return (
    <section className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm">
        <Laptop className="h-5 w-5 text-zinc-500" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-medium tracking-tight">{t("localRuntime.title")}</h1>
        <p className="max-w-xl text-sm leading-6 text-zinc-500">{t("localRuntime.description")}</p>
      </div>
      <Button asChild className="gap-2 rounded-xl">
        <a href={localAppUrl}>
          <ExternalLink className="h-4 w-4" />
          {t("localRuntime.open")}
        </a>
      </Button>
    </section>
  );
}
