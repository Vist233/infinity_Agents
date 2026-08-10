"use client";

import { useEffect, useState } from "react";
import { LogOut, UserCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCurrentUser, logout } from "@/lib/api/auth";
import { redirectToLogin } from "@/lib/runtime-config";
import { useLanguage } from "@/lib/i18n";

interface UserFooterProps {
  compact?: boolean;
}

function fallbackName(email: string | null | undefined, userId: string | null, fallback: string): string {
  if (email) return email.split("@")[0] || email;
  return userId || fallback;
}

export function UserFooter({ compact = false }: UserFooterProps) {
  const { t } = useLanguage();
  const [userId, setUserId] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getCurrentUser()
      .then((user) => {
        if (!mounted) return;
        setUserId(user?.id ?? null);
        setName(user?.name ?? null);
        setEmail(user?.email ?? null);
      })
      .catch(() => {
        // The page can still render a stable footer while auth is loading.
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      window.location.assign("/");
    } catch (err) {
      setLogoutError(err instanceof Error ? err.message : t("auth.logoutFailed"));
      setLoggingOut(false);
    }
  }

  const label = loading ? "…" : name || fallbackName(email, userId, t("auth.accountFallback"));
  const canLogout = Boolean(email || name || userId);
  return (
    <div className="border-t border-[var(--hairline)] px-1 pt-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900"
          title={email || label}
          onClick={() => {
            if (!email && !loading) redirectToLogin();
          }}
        >
          <UserCircle size={16} className="shrink-0 text-zinc-500" />
          <span className="truncate">{label}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon" : "sm"}
          className={compact ? "h-8 w-8 shrink-0 text-zinc-500 hover:text-zinc-900" : "h-8 shrink-0 px-2 text-xs text-zinc-500 hover:text-zinc-900"}
          aria-label={t("auth.logout")}
          title={t("auth.logout")}
          disabled={loggingOut || loading || !canLogout}
          onClick={() => { void handleLogout(); }}
        >
          <LogOut size={14} />
          {!compact && <span>{loggingOut ? t("auth.loggingOut") : t("auth.logout")}</span>}
        </Button>
      </div>
      {logoutError && <div role="alert" className="mt-1 truncate px-1.5 text-[10px] text-red-600" title={logoutError}>{t("auth.logoutFailed")}</div>}
    </div>
  );
}
