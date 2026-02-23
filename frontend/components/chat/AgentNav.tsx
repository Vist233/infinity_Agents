"use client";

import { FileText, Microscope, Terminal } from "lucide-react";

interface AgentNavProps {
  onNavigate: (path: string) => void;
}

export function AgentNav({ onNavigate }: AgentNavProps) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-400 px-2">Agents</div>
      <div className="space-y-1">
        <button
          className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-xl text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900 transition-all duration-150"
          title="CodeAgent"
          onClick={() => onNavigate("/code-agent")}
        >
          <Terminal size={16} />
          <span className="truncate">CodeAgent</span>
        </button>
        <button
          className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-xl bg-zinc-900 text-zinc-50 shadow-sm"
          title="PaperAgent"
          onClick={() => onNavigate("/")}
        >
          <FileText size={16} />
          <span className="truncate">PaperAgent</span>
        </button>
        <button
          className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-xl text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900 transition-all duration-150"
          title="TraitRecognize"
          onClick={() => onNavigate("/trait-agent")}
        >
          <Microscope size={16} />
          <span className="truncate">TraitRecognize</span>
        </button>
      </div>
    </div>
  );
}
