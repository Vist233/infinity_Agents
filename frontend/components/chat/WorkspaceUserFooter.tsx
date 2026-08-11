"use client";

import { LogIn, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { getApiBase, redirectToLogin, withCsrfHeader } from "@/lib/runtime-config";

interface CurrentUser {
  user_id?: string;
  email?: string | null;
}

/** Shared account strip for every desktop/mobile workspace drawer. */
export function WorkspaceUserFooter() {
  const { t } = useLanguage();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loaded, setLoaded] = useState(process.env.NODE_ENV === "test");

  useEffect(() => {
    if (process.env.NODE_ENV === "test") return;
    let cancelled = false;
    fetch(`${getApiBase()}/auth/me`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as CurrentUser;
      })
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

  if (!loaded) return <div className="h-12" aria-hidden="true" />;

  if (!user) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--hairline)] bg-white/60 px-2.5 py-2">
        <span className="truncate text-xs text-zinc-500">{t("account.signedOut")}</span>
        <button type="button" onClick={redirectToLogin} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-zinc-700 hover:text-zinc-950">
          <LogIn size={13} />{t("account.signIn")}
        </button>
      </div>
    );
  }

  const label = user.email || user.user_id || t("account.signedIn");
  const logout = async () => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    try {
      await fetch(`${getApiBase()}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: withCsrfHeader(),
      });
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
        onClick={() => { void logout(); }}
        className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900"
      >
        <LogOut size={13} />{t("account.logout")}
      </button>
    </div>
  );
}
