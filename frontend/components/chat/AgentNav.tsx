"use client";

import { FileText } from "lucide-react";

interface AgentNavProps {
  onNavigate: (path: string) => void;
}

// Public v1 exposes only PaperAgent. CodeAgent / TraitRecognize are not shipped
// as usable entries yet.
export function AgentNav({ onNavigate }: AgentNavProps) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 px-2">Agents</div>
      <div className="space-y-1">
        <button
          className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-xl bg-zinc-900 text-zinc-50 shadow-sm"
          title="PaperAgent"
          onClick={() => onNavigate("/")}
        >
          <FileText size={16} />
          <span className="truncate">PaperAgent</span>
        </button>
      </div>
    </div>
  );
}
