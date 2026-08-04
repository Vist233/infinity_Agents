"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useLanguage();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-lg w-full rounded-2xl border border-red-200 bg-red-50 p-6">
        <h2 className="text-lg font-semibold text-red-700">{t("error.pageTitle")}</h2>
        <p className="mt-2 text-sm text-red-600">{t("error.pageDescription")}</p>
        <div className="mt-4 flex gap-2">
          <Button onClick={reset}>{t("error.retry")}</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            {t("error.reload")}
          </Button>
        </div>
      </div>
    </div>
  );
}
