"use client"

import { Moon } from "lucide-react"
import { Button } from "@/components/ui/button"

export function ChatHeader() {
  return (
    <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-900">PaperAgent</h1>
        <span className="text-zinc-300">|</span>
        <span className="text-sm text-zinc-500">Scientific conversational assistant</span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="size-9 text-zinc-600 hover:text-zinc-900">
          <Moon className="size-5" />
        </Button>
        <Button variant="ghost" className="text-sm text-red-500 hover:text-red-600">
          Logout
        </Button>
      </div>
    </header>
  )
}
