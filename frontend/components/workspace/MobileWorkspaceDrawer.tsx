"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "textarea:not([disabled])",
      "select:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(focusableSelector);
      if (first) first.focus();
      else panel.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    const focusFrame = window.requestAnimationFrame(focusFirst);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  function handleDrawerContentClick(event: MouseEvent<HTMLElement>) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("[data-workspace-drawer-dismiss='true']")) setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 md:hidden"
        ref={triggerRef}
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
            ref={panelRef}
            className="relative z-[1] flex h-full w-[min(86vw,340px)] flex-col border-r border-[var(--hairline)] bg-[var(--surface-1)] p-3 shadow-2xl"
            style={{ width: "min(86vw, 340px)" }}
            tabIndex={-1}
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
            {children && <div className="mt-4 min-h-0 flex-1 border-t border-[var(--hairline)] pt-4" onClick={handleDrawerContentClick}>{children}</div>}
            <div className="mt-4">
              <UserFooter compact />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
