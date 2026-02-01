"use client"

import { Search, Sparkles, Paperclip, ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export function ChatInput() {
  return (
    <div className="border-t border-zinc-200 bg-white px-6 py-4">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3">
          <Textarea
            placeholder="Ask PaperAgent to analyze methodology, results, or data..."
            className="min-h-[60px] resize-none border-0 bg-transparent p-2 text-sm placeholder:text-zinc-400 focus-visible:ring-0"
          />
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-2 rounded-full border-zinc-200 bg-white text-sm text-zinc-700"
              >
                <Search className="size-4" />
                Search 30+ Papers
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 rounded-full border-zinc-200 bg-white text-sm text-zinc-700"
              >
                <Sparkles className="size-4 text-pink-500" />
                Compare Methods
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-zinc-400 hover:text-zinc-600"
              >
                <Paperclip className="size-4" />
              </Button>
            </div>
            <Button
              size="icon"
              className="size-9 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-zinc-400">
          PardusAI can make mistakes. Verify important information from the citations
          provided.
        </p>
      </div>
    </div>
  )
}
