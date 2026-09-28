"use client";

import type { LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { AgentNav, type WorkspaceSection } from "@/components/chat/AgentNav";
import { MobileWorkspaceMenu } from "@/components/chat/MobileWorkspaceMenu";
import { WorkspaceUserFooter } from "@/components/chat/WorkspaceUserFooter";
import { ScrollArea } from "@/components/ui/scroll-area";

interface DiscoveryChromeProps {
  active: WorkspaceSection;
  title: string;
  icon: LucideIcon;
  sidebar?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** Shared responsive shell for the authenticated Discovery workspaces. */
export function DiscoveryChrome({ active, title, icon: Icon, sidebar, actions, children }: DiscoveryChromeProps) {
  const router = useRouter();
  return (
    <div className="flex h-screen bg-transparent font-sans text-zinc-900">
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-[var(--hairline)] bg-[var(--surface-1)] p-3 backdrop-blur-xl md:flex print:hidden">
        <AgentNav active={active} onNavigate={(path) => router.push(path)} />
        {sidebar ? <div className="mt-5 min-h-0 flex-1">{sidebar}</div> : <div className="flex-1" />}
        <WorkspaceUserFooter />
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[var(--hairline)] bg-[var(--surface-1)] px-4 backdrop-blur-xl print:hidden">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight text-zinc-700">
            <MobileWorkspaceMenu active={active} />
            <Icon className="h-4 w-4 shrink-0 text-zinc-500" />
            <span className="truncate">{title}</span>
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
        <ScrollArea className="min-h-0 flex-1">
          {children}
        </ScrollArea>
      </main>
    </div>
  );
}
