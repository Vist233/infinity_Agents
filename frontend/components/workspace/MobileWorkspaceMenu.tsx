"use client";

import { ArrowDownToLine, Menu, Plus, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AgentNav } from "@/components/workspace/AgentNav";
import { WorkspaceUserFooter } from "@/components/workspace/WorkspaceUserFooter";
import { useLanguage } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

interface MobileTaskItem {
  task_id: string;
  title: string;
  statusLabel: string;
}

interface MobileImageJudgeExample {
  id: string;
  title: string;
  description: string;
}

interface MobileWorkspaceMenuProps {
  active: "analysis" | "tasks" | "traits";
  taskItems?: MobileTaskItem[];
  onNewTask?: () => void;
  activeTaskId?: string;
  imageJudgeExamples?: MobileImageJudgeExample[];
  imageJudgeSelectedId?: string;
  imageJudgeShowDownload?: boolean;
  onSelectImageJudgeExample?: (id: string) => void;
  onOpenImageJudgeDownload?: () => void;
}

/** Shared mobile drawer so every workspace exposes the same navigation. */
export function MobileWorkspaceMenu({
  active,
  taskItems,
  onNewTask,
  activeTaskId,
  imageJudgeExamples,
  imageJudgeSelectedId,
  imageJudgeShowDownload,
  onSelectImageJudgeExample,
  onOpenImageJudgeDownload,
}: MobileWorkspaceMenuProps) {
  const router = useRouter();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  const navigate = (path: string) => {
    setOpen(false);
    router.push(path);
  };

  const drawer = open ? (
    <div className="fixed inset-0 z-[60] md:hidden" role="dialog" aria-modal="true" aria-label="Workspace menu">
      <button type="button" className="absolute inset-0 bg-zinc-900/25" aria-label="Close workspace menu" onClick={() => setOpen(false)} />
      <aside className="relative z-10 flex h-full min-h-0 w-[min(82vw,300px)] flex-col overflow-hidden border-r border-[var(--hairline)] bg-[var(--surface-1)] p-3 shadow-2xl">
        <div className="mb-3 flex justify-end">
          <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100" aria-label="Close workspace menu" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <AgentNav active={active} onNavigate={navigate} />
        <div className="mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          {imageJudgeExamples ? (
            <section>
              {onOpenImageJudgeDownload ? (
                <Button
                  variant="outline"
                  className={`w-full justify-start gap-2 rounded-xl bg-white/90 ${imageJudgeShowDownload ? "border-zinc-900" : ""}`}
                  onClick={() => { onOpenImageJudgeDownload(); setOpen(false); }}
                >
                  <ArrowDownToLine size={16} />
                  {t("image.download")}
                </Button>
              ) : null}
              <div className="mt-4 px-2 text-[11px] uppercase tracking-[0.2em] text-zinc-400">{t("image.examples")}</div>
              <div className="mt-2 space-y-1">
                {imageJudgeExamples.map((example) => (
                  <button
                    key={example.id}
                    type="button"
                    onClick={() => { onSelectImageJudgeExample?.(example.id); setOpen(false); }}
                    className={`w-full rounded-xl px-3 py-3 text-left transition-colors ${example.id === imageJudgeSelectedId && !imageJudgeShowDownload ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}
                  >
                    <div className="text-sm font-medium">{example.title}</div>
                    <div className={`mt-1 text-xs ${example.id === imageJudgeSelectedId && !imageJudgeShowDownload ? "text-zinc-300" : "text-zinc-400"}`}>{example.description}</div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {taskItems ? (
            <section>
              {onNewTask ? (
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2 rounded-xl bg-white/90"
                  onClick={() => { onNewTask(); setOpen(false); }}
                >
                  <Plus size={16} />
                  {t("tasks.newTask")}
                </Button>
              ) : null}
              <div className="px-2 text-[11px] uppercase tracking-[0.2em] text-zinc-400">{t("tasks.title")}</div>
              <div className="mt-2 space-y-1">
                {taskItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-400">{t("tasks.empty")}</div>
                ) : taskItems.map((item) => (
                  <button
                    key={item.task_id}
                    type="button"
                    onClick={() => navigate(`/task-center/tasks/${item.task_id}`)}
                    className={`w-full rounded-xl px-3 py-2 text-left transition-colors ${item.task_id === activeTaskId ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}
                  >
                    <div className="truncate text-xs font-medium">{item.title}</div>
                    <div className={`mt-1 text-[10px] ${item.task_id === activeTaskId ? "text-zinc-300" : "text-zinc-400"}`}>{item.statusLabel}</div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
        <div className="mt-auto shrink-0 pt-3"><WorkspaceUserFooter /></div>
      </aside>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--hairline)] bg-white/80 text-zinc-600 hover:bg-white"
        aria-label="Open workspace menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu size={18} />
      </button>
      {typeof document !== "undefined" ? createPortal(drawer, document.body) : null}
    </>
  );
}
