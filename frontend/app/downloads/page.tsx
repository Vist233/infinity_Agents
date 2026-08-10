"use client";

import { Apple, Download, ExternalLink, Monitor, Package, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { MobileWorkspaceDrawer } from "@/components/workspace/MobileWorkspaceDrawer";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { useLanguage } from "@/lib/i18n";

const RELEASES_URL = "https://github.com/Vist233/infinity_Agents/releases";

export default function DownloadsPage() {
  const router = useRouter();
  const { t } = useLanguage();

  return (
    <div className="flex h-screen min-h-0 bg-transparent font-sans text-zinc-900">
      <WorkspaceSidebar active="downloads" onNavigate={(path) => router.push(path)} />

      <main className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-[var(--hairline)] bg-[var(--surface-1)] px-4 backdrop-blur-xl">
          <MobileWorkspaceDrawer active="downloads" onNavigate={(path) => router.push(path)} />
          <Download className="h-4 w-4 text-zinc-500" />
          <div className="text-sm font-semibold tracking-tight text-zinc-700">{t("downloads.title")}</div>
        </header>

        <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-8" data-testid="downloads-page">
          <section className="rounded-3xl border border-zinc-200 bg-white/90 p-6 shadow-sm md:p-8">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-zinc-900 p-3 text-white"><Package className="h-6 w-6" /></div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{t("downloads.heading")}</h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-600">{t("downloads.description")}</p>
              </div>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-200 bg-white/90 p-5">
              <Monitor className="h-5 w-5 text-zinc-500" />
              <h2 className="mt-4 font-semibold">{t("downloads.windowsTitle")}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">{t("downloads.windowsDescription")}</p>
              <Button asChild className="mt-5 w-full gap-2" variant="outline">
                <a href={RELEASES_URL} target="_blank" rel="noreferrer"><Download className="h-4 w-4" />{t("downloads.openReleases")}</a>
              </Button>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-white/90 p-5">
              <Server className="h-5 w-5 text-zinc-500" />
              <h2 className="mt-4 font-semibold">{t("downloads.linuxTitle")}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">{t("downloads.linuxDescription")}</p>
              <Button asChild className="mt-5 w-full gap-2" variant="outline">
                <a href={RELEASES_URL} target="_blank" rel="noreferrer"><Download className="h-4 w-4" />{t("downloads.openReleases")}</a>
              </Button>
            </div>

            <div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/80 p-5">
              <Apple className="h-5 w-5 text-zinc-400" />
              <h2 className="mt-4 font-semibold text-zinc-700">{t("downloads.macTitle")}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">{t("downloads.macDescription")}</p>
            </div>
          </section>

          <section className="rounded-2xl border border-blue-100 bg-blue-50/70 p-5 text-sm leading-6 text-blue-900">
            <div className="flex items-center gap-2 font-medium"><ExternalLink className="h-4 w-4" />{t("downloads.releaseNoteTitle")}</div>
            <p className="mt-2">{t("downloads.releaseNote")}</p>
          </section>
        </div>
      </main>
    </div>
  );
}
