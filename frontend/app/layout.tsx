import type { Metadata } from "next";
import "./globals.css";
import { ToasterProvider } from "@/components/providers/toaster-provider";

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
    <html lang="en">
      <body className="antialiased bg-[var(--app-bg)] text-foreground">
        {children}
        <ToasterProvider />
      </body>
    </html>
  );
}
