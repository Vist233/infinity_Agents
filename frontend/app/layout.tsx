import type { Metadata } from "next";
import "./globals.css";
import { ToasterProvider } from "@/components/providers/toaster-provider";
import { LanguageProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Infinity Agents",
  description: "A focused multi-agent workspace for code, papers, and trait analysis.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased bg-[var(--app-bg)] text-foreground">
        <LanguageProvider>{children}</LanguageProvider>
        <ToasterProvider />
      </body>
    </html>
  );
}
