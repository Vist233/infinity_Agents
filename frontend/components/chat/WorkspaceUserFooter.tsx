"use client";

import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { getCurrentUser, logout as logoutCurrentUser, type CurrentUser } from "@/lib/api/auth";
import { useLanguage } from "@/lib/i18n";

/** Shared account strip for every desktop/mobile workspace drawer. */
export function WorkspaceUserFooter() {
  const { t } = useLanguage();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((nextUser) => {
        if (!cancelled) {
          setUser(nextUser);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  if (!loaded || !user) return null;

  const label = user.name || user.email || user.id || t("account.signedIn");
  const handleLogout = async () => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    try {
      await logoutCurrentUser();
    } finally {
      window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--hairline)] bg-white/60 px-2.5 py-2">
      <span className="min-w-0 truncate text-xs font-medium text-zinc-700" title={label}>{label}</span>
      <button
        type="button"
        aria-label={t("account.logout")}
        title={t("account.logout")}
        onClick={() => { void handleLogout(); }}
        className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900"
      >
        <LogOut size={13} />{t("account.logout")}
      </button>
    </div>
  );
}
