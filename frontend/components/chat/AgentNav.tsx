"use client";

import { FileText, Microscope, Terminal } from "lucide-react";

interface AgentNavProps {
  onNavigate: (path: string) => void;
  active: "paper" | "code" | "image-judge";
}

const items = [
  { id: "paper", label: "PaperAgent", path: "/", icon: FileText },
  { id: "code", label: "CodeAgent", path: "/code-agent", icon: Terminal },
  { id: "image-judge", label: "ImageJudge", path: "/image-judge", icon: Microscope },
] as const;

export function AgentNav({ onNavigate, active }: AgentNavProps) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 px-2">Agents</div>
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
              title={item.label}
              onClick={() => onNavigate(item.path)}
            >
              <Icon size={16} />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
