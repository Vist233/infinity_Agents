"use client";

import { useRouter } from "next/navigation";
import { ArrowDownToLine, Check, ExternalLink, FileImage, Microscope } from "lucide-react";
import { AgentNav } from "@/components/chat/AgentNav";
import { Button } from "@/components/ui/button";

const RELEASE_URL = "https://github.com/Vist233/infinity_Agents/releases/latest";

const steps = [
  ["1", "Install", "Download the latest package for your operating system and launch ImageJudge."],
  ["2", "Choose images", "Select one reference image and a target folder. Folder scanning is recursive by default."],
  ["3", "Set the rule", "Describe the visual categories or comparison rule in plain language."],
  ["4", "Review results", "Inspect PASS, REVIEW, and FAILED rows, then export the structured CSV or SQLite data."],
] as const;

export default function ImageJudgePage() {
  const router = useRouter();

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
          <Button asChild size="sm" className="rounded-xl">
            <a href={RELEASE_URL} target="_blank" rel="noreferrer" aria-label="Download latest release">
              <ArrowDownToLine className="h-4 w-4" />
              Download latest release
            </a>
          </Button>
        </header>

        <div className="max-w-5xl mx-auto px-5 py-10 md:px-8 md:py-14 space-y-8">
          <section className="rounded-3xl border border-zinc-200 bg-white/90 p-7 md:p-10 shadow-sm backdrop-blur">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600">
                <FileImage className="h-3.5 w-3.5" />
                Desktop visual classification
              </div>
              <h1 className="mt-5 text-4xl font-semibold tracking-tight md:text-5xl">ImageJudge</h1>
              <p className="mt-4 text-lg leading-8 text-zinc-600">
                A focused desktop tool for reference-guided image classification. Use one reference image to
                classify a folder of targets into the categories you define.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button asChild size="lg" className="rounded-xl">
                  <a href={RELEASE_URL} target="_blank" rel="noreferrer" aria-label="Download latest release">
                    <ArrowDownToLine className="h-4 w-4" />
                    Download latest release
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline" className="rounded-xl border-zinc-200">
                  <a href={RELEASE_URL} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    View release notes
                  </a>
                </Button>
              </div>
              <p className="mt-3 text-xs text-zinc-400">Windows: ZIP with ImageJudge.exe · Linux: amd64 DEB package</p>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-white/85 p-6 shadow-sm">
              <h2 className="text-base font-semibold">What it is for</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-600">
                ImageJudge is designed for trait recognition and other visual category tasks where a human can
                describe the rule and provide a representative reference image.
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white/85 p-6 shadow-sm">
              <h2 className="text-base font-semibold">What you get</h2>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-zinc-600">
                {["Reference-first image order", "Structured PASS / REVIEW / FAILED results", "Local SQLite and CSV projections"].map((item) => (
                  <li key={item} className="flex items-start gap-2"><Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600" />{item}</li>
                ))}
              </ul>
            </div>
          </section>

          <section className="rounded-3xl border border-zinc-200 bg-white/90 p-7 md:p-8 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">Quick start</h2>
                <p className="mt-2 text-sm text-zinc-500">The default workflow keeps the important choices visible and the advanced controls out of the way.</p>
              </div>
              <span className="text-xs uppercase tracking-[0.2em] text-zinc-400">Usage</span>
            </div>
            <div className="mt-7 grid gap-4 md:grid-cols-2">
              {steps.map(([number, title, description]) => (
                <div key={number} className="rounded-2xl border border-zinc-200 bg-zinc-50/80 p-5">
                  <div className="flex items-center gap-3"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">{number}</span><h3 className="font-medium">{title}</h3></div>
                  <p className="mt-3 text-sm leading-6 text-zinc-600">{description}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
