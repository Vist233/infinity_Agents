"use client"

import React from "react"

import { Plus, Code2, FileText, Users, FlaskConical, MoreHorizontal, Folder } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

interface NavItem {
  icon: React.ReactNode
  label: string
  active?: boolean
}

interface RecentItem {
  icon: React.ReactNode
  label: string
}

const navItems: NavItem[] = [
  { icon: <Code2 className="size-4" />, label: "CodeAgent" },
  { icon: <FileText className="size-4" />, label: "PaperAgent", active: true },
  { icon: <Users className="size-4" />, label: "TraitRecognize" },
]

const recentItems: RecentItem[] = []

export function LeftSidebar() {
  return (
    <aside className="flex h-screen w-[240px] flex-col border-r border-zinc-200 bg-white">
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex size-8 items-center justify-center rounded bg-zinc-900 text-white">
          <FlaskConical className="size-4" />
        </div>
        <span className="text-base font-semibold text-zinc-900">PardusAI</span>
      </div>

      {/* New Analysis Button */}
      <div className="px-3 py-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
        >
          <Plus className="size-4" />
          New Analysis
        </Button>
      </div>

      {/* Main Navigation */}
      <nav className="px-3 py-2">
        {navItems.map((item) => (
          <button
            key={item.label}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              item.active
                ? "bg-zinc-100 font-medium text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      {/* Recent Activity */}
      <div className="flex-1 overflow-hidden px-3 pt-4">
        <h3 className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Recent Activity
        </h3>
        <ScrollArea className="h-[calc(100%-2rem)]">
          <div className="space-y-1">
            {recentItems.map((item) => (
              <button
                key={item.label}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* User Profile */}
      <div className="border-t border-zinc-200 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Avatar className="size-8 bg-emerald-500 text-white">
              <AvatarFallback className="bg-emerald-500 text-sm font-medium text-white">
                YZ
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-zinc-900">Yu Jing Zhang</span>
              <span className="text-xs text-zinc-500">Pro Plan</span>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="size-8 text-zinc-400 hover:text-zinc-600">
            <MoreHorizontal className="size-4" />
          </Button>
        </div>
      </div>
    </aside>
  )
}
