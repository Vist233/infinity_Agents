"use client";

import { useRouter } from "next/navigation";
import { ArrowDownToLine, Check, ExternalLink, FileImage, Microscope } from "lucide-react";
import { AgentNav } from "@/components/chat/AgentNav";
import { Button } from "@/components/ui/button";
import { LanguageToggle, useLanguage, type TranslationKey } from "@/lib/i18n";

const RELEASE_URL = "https://github.com/Vist233/infinity_Agents/releases/latest";

const steps: Array<[string, TranslationKey, TranslationKey]> = [
  ["1", "image.install", "image.installDescription"],
  ["2", "image.choose", "image.chooseDescription"],
  ["3", "image.rule", "image.ruleDescription"],
  ["4", "image.review", "image.reviewDescription"],
];

const resultKeys: TranslationKey[] = ["image.resultOrder", "image.resultRows", "image.localData"];

export default function ImageJudgePage() {
  const router = useRouter();
  const { t } = useLanguage();

  return (
    <div className="flex min-h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] shrink-0 bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl">
        <AgentNav active="image-judge" onNavigate={(path) => router.push(path)} />
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center justify-between px-4 bg-[var(--surface-1)] backdrop-blur-xl sticky top-0 z-10">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-700">
            <Microscope className="h-4 w-4" />
            ImageJudge
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Button asChild size="sm" className="rounded-xl">
              <a href={RELEASE_URL} target="_blank" rel="noreferrer" aria-label={t("image.download")}>
                <ArrowDownToLine className="h-4 w-4" />
                {t("image.download")}
              </a>
            </Button>
          </div>
        </header>

        <div className="max-w-5xl mx-auto px-5 py-10 md:px-8 md:py-14 space-y-8">
          <section className="rounded-3xl border border-zinc-200 bg-white/90 p-7 md:p-10 shadow-sm backdrop-blur">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600">
                <FileImage className="h-3.5 w-3.5" />
                {t("image.badge")}
              </div>
              <h1 className="mt-5 text-4xl font-semibold tracking-tight md:text-5xl">ImageJudge</h1>
              <p className="mt-4 text-lg leading-8 text-zinc-600">{t("image.description")}</p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button asChild size="lg" className="rounded-xl">
                  <a href={RELEASE_URL} target="_blank" rel="noreferrer" aria-label={t("image.download")}>
                    <ArrowDownToLine className="h-4 w-4" />
                    {t("image.download")}
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline" className="rounded-xl border-zinc-200">
                  <a href={RELEASE_URL} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    {t("image.releaseNotes")}
                  </a>
                </Button>
              </div>
              <p className="mt-3 text-xs text-zinc-400">{t("image.platforms")}</p>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-white/85 p-6 shadow-sm">
              <h2 className="text-base font-semibold">{t("image.forTitle")}</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-600">{t("image.forDescription")}</p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white/85 p-6 shadow-sm">
              <h2 className="text-base font-semibold">{t("image.getTitle")}</h2>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-zinc-600">
                {resultKeys.map((key) => (
                  <li key={key} className="flex items-start gap-2">
                    <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600" />
                    {t(key)}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="rounded-3xl border border-zinc-200 bg-white/90 p-7 md:p-8 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">{t("image.quickStart")}</h2>
                <p className="mt-2 text-sm text-zinc-500">{t("image.quickStartDescription")}</p>
              </div>
              <span className="text-xs uppercase tracking-[0.2em] text-zinc-400">{t("image.usage")}</span>
            </div>
            <div className="mt-7 grid gap-4 md:grid-cols-2">
              {steps.map(([number, titleKey, descriptionKey]) => (
                <div key={number} className="rounded-2xl border border-zinc-200 bg-zinc-50/80 p-5">
                  <div className="flex items-center gap-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">{number}</span>
                    <h3 className="font-medium">{t(titleKey)}</h3>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-zinc-600">{t(descriptionKey)}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
