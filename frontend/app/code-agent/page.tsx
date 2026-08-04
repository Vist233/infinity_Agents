"use client";

import { useRouter } from "next/navigation";
import { Copy, ExternalLink } from "lucide-react";
import { AgentNav } from "@/components/chat/AgentNav";
import { LanguageToggle, useLanguage } from "@/lib/i18n";

const guides = [
  ["code.guideCli", "https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started"],
  ["code.guideRepo", "https://github.com/openai/codex"],
  ["code.guideLogin", "https://help.openai.com/en/articles/11381614-codex-cli-and-sign-in-withgpt"],
] as const;

const commands = ["npm install -g @openai/codex", "brew install --cask codex", "codex --login", "codex"];

export default function CodeAgentPage() {
  const router = useRouter();
  const { t } = useLanguage();

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl">
        <AgentNav active="code" onNavigate={(path) => router.push(path)} />
      </aside>
      <main className="flex-1 overflow-y-auto">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 bg-[var(--surface-1)] backdrop-blur-xl">
          <div className="text-sm font-semibold tracking-tight text-zinc-700">CodeAgent</div>
          <LanguageToggle />
        </header>
        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="rounded-3xl border border-[var(--hairline)] bg-white/90 p-8 shadow-sm backdrop-blur">
            <h1 className="text-3xl font-semibold tracking-tight">{t("code.title")}</h1>
            <p className="text-zinc-500 mt-3 leading-7">{t("code.description")}</p>
            <div className="mt-8 grid gap-3">
              {guides.map(([title, href]) => (
                <a key={href} href={href} target="_blank" rel="noreferrer" className="rounded-2xl border border-zinc-200 p-4 hover:bg-zinc-50 transition-colors flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{t(title)}</span><ExternalLink className="h-4 w-4 text-zinc-400" />
                </a>
              ))}
            </div>
            <div className="mt-8 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 space-y-2">
              <h2 className="text-sm font-semibold">{t("code.quickInstall")}</h2>
              {commands.map((command) => (
                <div key={command} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3">
                  <code className="text-sm break-all">{command}</code>
                  <button aria-label={t("code.copy", { command })} onClick={() => void navigator.clipboard.writeText(command)} className="text-zinc-500 hover:text-zinc-900"><Copy className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
