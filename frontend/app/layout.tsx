import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { ToasterProvider } from "@/components/providers/toaster-provider";
import { LanguageProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Infinity Agents",
  description: "A focused multi-agent workspace for code, papers, and trait analysis.",
};

function requestLanguage(cookieHeader: string | null, acceptLanguage: string | null): "zh" | "en" {
  const stored = cookieHeader?.match(/(?:^|;\s*)infinity-agents-language=(zh|en)(?:;|$)/)?.[1];
  if (stored === "zh" || stored === "en") return stored;
  if (!acceptLanguage) return "zh";
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((value) => value.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .sort((left, right) => right.q - left.q);
  for (const { tag } of ranked) {
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "zh";
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const initialLanguage = requestLanguage(requestHeaders.get("cookie"), requestHeaders.get("accept-language"));
  return (
    <html lang={initialLanguage === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body className="antialiased bg-[var(--app-bg)] text-foreground">
        <LanguageProvider initialLanguage={initialLanguage}>{children}</LanguageProvider>
        <ToasterProvider />
      </body>
    </html>
  );
}
