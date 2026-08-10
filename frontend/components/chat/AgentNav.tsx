"use client";

import { FileText, ListTodo, Microscope } from "lucide-react";
import { useLanguage } from "@/lib/i18n";

export type WorkspaceSection = "analysis" | "tasks" | "traits";

interface AgentNavProps {
  onNavigate: (path: string) => void;
  active: WorkspaceSection;
}

const items = [
  { id: "analysis", labelKey: "nav.analysis", path: "/", icon: FileText },
  { id: "tasks", labelKey: "nav.tasks", path: "/code-agent", icon: ListTodo },
  { id: "traits", labelKey: "nav.traits", path: "/image-judge", icon: Microscope },
] as const;

export function AgentNav({ onNavigate, active }: AgentNavProps) {
  const { t } = useLanguage();
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 px-2">{t("nav.workspace")}</div>
      <div className="space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              className={`w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-xl transition-all duration-150 ${
                selected
                  ? "bg-zinc-900 text-zinc-50 shadow-sm"
                  : "text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900"
              }`}
              title={t(item.labelKey)}
              aria-current={selected ? "page" : undefined}
              onClick={() => onNavigate(item.path)}
            >
              <Icon size={16} />
              <span className="truncate">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
