"use client"

import { cn } from "@/lib/utils"

interface NavItem {
  label: string
  active?: boolean
  indent?: boolean
}

const navItems: NavItem[] = [
  { label: "Executive Summary", active: true },
  { label: "Frequency of Off-Targets", indent: true },
  { label: "Detection Methods", indent: true },
  { label: "Strategic Implications", indent: true },
  { label: "References" },
  { label: "Method Comparison" },
]

export function RightSidebar() {
  return (
    <aside className="hidden w-[200px] shrink-0 border-l border-zinc-200 bg-white p-4 xl:block">
      <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-zinc-400">
        On this page
      </h3>
      <nav className="space-y-1">
        {navItems.map((item) => (
          <a
            key={item.label}
            href="#"
            className={cn(
              "block rounded-md px-2 py-1.5 text-sm transition-colors",
              item.indent && "pl-4",
              item.active
                ? "font-medium text-zinc-900"
                : "text-zinc-500 hover:text-zinc-700"
            )}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </aside>
  )
}
