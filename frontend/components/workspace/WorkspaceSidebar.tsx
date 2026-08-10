"use client";

import type { ReactNode } from "react";
import { AgentNav, type WorkspaceSection } from "@/components/chat/AgentNav";
import { UserFooter } from "@/components/workspace/UserFooter";

/**
 * One desktop sidebar contract for every workspace. Keeping the width here
 * prevents Analysis, Task Center, and Image Judge from drifting apart again.
 */
export const WORKSPACE_SIDEBAR_CLASS =
  "hidden min-h-0 w-[320px] shrink-0 flex-col border-r border-[var(--hairline)] bg-[var(--surface-1)] p-3 backdrop-blur-xl md:flex print:hidden";

interface WorkspaceSidebarProps {
  active: WorkspaceSection;
  onNavigate: (path: string) => void;
  children?: ReactNode;
  showVersion?: boolean;
}

export function WorkspaceSidebar({ active, onNavigate, children, showVersion = false }: WorkspaceSidebarProps) {
  return (
    <aside className={WORKSPACE_SIDEBAR_CLASS} data-testid="workspace-sidebar">
      <AgentNav active={active} onNavigate={onNavigate} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <div className="mt-3 space-y-2">
        <UserFooter />
        {showVersion && <div className="px-1 text-center text-[10px] tracking-tight text-zinc-400">v1.0.0 @ 2026</div>}
      </div>
    </aside>
  );
}
