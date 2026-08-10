"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { AgentNav, type WorkspaceSection } from "@/components/chat/AgentNav";
import { UserFooter } from "@/components/workspace/UserFooter";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";

interface MobileWorkspaceDrawerProps {
  active: WorkspaceSection;
  onNavigate: (path: string) => void;
  children?: ReactNode;
}

export function MobileWorkspaceDrawer({ active, onNavigate, children }: MobileWorkspaceDrawerProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 md:hidden"
        aria-label={t("workspace.openMenu")}
        aria-expanded={open}
        data-testid="mobile-workspace-menu"
        onClick={() => setOpen(true)}
      >
        <Menu size={19} />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          style={{ position: "fixed", inset: 0, zIndex: 50, width: "100vw", height: "100vh" }}
          role="dialog"
          aria-modal="true"
          aria-label={t("nav.workspace")}
          data-testid="mobile-workspace-drawer"
        >
          <button
            type="button"
            className="absolute inset-0 bg-zinc-950/30"
            style={{ position: "fixed", inset: 0, zIndex: 0, width: "100vw", height: "100vh" }}
            aria-label={t("workspace.closeMenu")}
            data-testid="mobile-workspace-backdrop"
            onPointerDown={(event) => { event.preventDefault(); setOpen(false); }}
            onClick={() => setOpen(false)}
          />
          <aside
            className="relative z-[1] flex h-full w-[min(86vw,340px)] flex-col border-r border-[var(--hairline)] bg-[var(--surface-1)] p-3 shadow-2xl"
            style={{ width: "min(86vw, 340px)" }}
          >
            <div className="flex items-center justify-between">
              <div className="px-2 text-[11px] uppercase tracking-[0.22em] text-zinc-400">{t("nav.workspace")}</div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("workspace.closeMenu")}
                data-testid="mobile-workspace-close"
                onClick={(event) => { event.stopPropagation(); setOpen(false); }}
              >
                <X size={18} />
              </Button>
            </div>
            <div className="mt-1">
              <AgentNav active={active} onNavigate={(path) => { setOpen(false); onNavigate(path); }} />
            </div>
            {children && <div className="mt-4 min-h-0 flex-1 border-t border-[var(--hairline)] pt-4" onClick={() => setOpen(false)}>{children}</div>}
            <div className="mt-4">
              <UserFooter compact />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
