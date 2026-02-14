"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Terminal, FileText, Microscope, ExternalLink, Copy } from "lucide-react";

const OFFICIAL_TUTORIALS = [
  {
    title: "OpenAI 帮助中心：Codex CLI Getting Started",
    href: "https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started",
    note: "最完整的新手安装与模式说明（Suggest/Auto Edit/Full Auto）。",
  },
  {
    title: "GitHub：openai/codex 官方仓库",
    href: "https://github.com/openai/codex",
    note: "Quickstart、发行版二进制下载、CLI 说明都在这里。",
  },
  {
    title: "OpenAI 帮助中心：Codex CLI 与 ChatGPT 登录",
    href: "https://help.openai.com/en/articles/11381614-codex-cli-and-sign-in-withgpt",
    note: "说明 `codex --login`，免手动复制 API Key 的流程。",
  },
];

const INSTALL_SNIPPETS = [
  { label: "npm 安装", code: "npm install -g @openai/codex" },
  { label: "Homebrew 安装 (macOS)", code: "brew install --cask codex" },
  { label: "启动并登录", code: "codex --login" },
  { label: "直接启动", code: "codex" },
];

export default function CodeAgentPage() {
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.error("Failed to copy command", e);
    }
  };

  return (
    <div className="flex h-screen bg-zinc-100 text-zinc-900 font-sans">
      <aside className="w-[260px] bg-white/90 border-r border-zinc-200 hidden md:flex flex-col p-3 backdrop-blur-sm">
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 px-2">Agents</div>
          <div className="space-y-1">
            <Link
              href="/code-agent"
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg bg-zinc-200 text-zinc-900"
            >
              <Terminal size={16} />
              <span className="truncate">CodeAgent</span>
            </Link>
            <Link
              href="/"
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
            >
              <FileText size={16} />
              <span className="truncate">PaperAgent</span>
            </Link>
            <Link
              href="/trait-agent"
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
            >
              <Microscope size={16} />
              <span className="truncate">TraitRecognize</span>
            </Link>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col">
        <header className="h-14 border-b border-zinc-200/70 flex items-center px-4 justify-between bg-white/80 backdrop-blur-md">
          <div className="text-sm font-semibold tracking-tight text-zinc-600">Code Agent</div>
        </header>

        <div className="flex-1 flex items-center justify-center px-6">
          <div className="w-full max-w-4xl rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">CodeAgent 安装教程</h1>
            <p className="text-zinc-500 mt-3 leading-7">
              已检索并整理官方教程，按下面步骤可在本机完成 Codex 安装与登录。
            </p>

            <div className="mt-8 grid gap-3">
              {OFFICIAL_TUTORIALS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-2xl border border-zinc-200 p-4 hover:bg-zinc-50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-zinc-900">{item.title}</div>
                    <ExternalLink className="h-4 w-4 text-zinc-400 shrink-0" />
                  </div>
                  <div className="text-xs text-zinc-500 mt-1.5">{item.note}</div>
                </a>
              ))}
            </div>

            <div className="mt-8 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
              <h2 className="text-sm font-semibold text-zinc-800">快速安装命令</h2>
              <div className="mt-3 space-y-2">
                {INSTALL_SNIPPETS.map((item) => (
                  <div key={item.label} className="rounded-xl border border-zinc-200 bg-white p-3">
                    <div className="text-xs text-zinc-500 mb-1">{item.label}</div>
                    <div className="flex items-center justify-between gap-3">
                      <code className="text-sm text-zinc-900 break-all">{item.code}</code>
                      <button
                        onClick={() => copyText(item.code)}
                        className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        复制
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </main>
    </div>
  );
}
