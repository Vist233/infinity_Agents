"use client"

import { Bot, ThumbsUp, Copy, RefreshCw, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface Citation {
  id: string
  page: string
}

interface Reference {
  title: string
  author: string
  year: string
  page: string
}

export function ChatMessages() {
  return (
    <div className="flex flex-col gap-6 pb-6">
      {/* User Message */}
      <div className="flex justify-end">
        <div className="max-w-[700px] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-3">
          <p className="text-sm text-zinc-900">
            Analyze the potential off-target effects of CRISPR-Cas9 mentioned in the
            uploaded papers, specifically focusing on the 2026 findings.
          </p>
        </div>
      </div>

      {/* AI Response */}
      <div className="flex gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white">
          <Bot className="size-4" />
        </div>
        <div className="flex-1 space-y-4">
          <div className="prose prose-zinc max-w-none">
            <h2 className="text-xl font-semibold text-zinc-900">
              Executive Summary of Off-Target Analysis
            </h2>
            <p className="text-sm leading-relaxed text-zinc-700">
              Based on the comprehensive analysis of the provided dataset, including the
              Beijing Transport University 2026 findings, the off-target effects of
              CRISPR-Cas9 remain a significant area of study. The recent papers highlight
              a shift towards high-fidelity variants that minimize non-specific binding.
            </p>

            <ul className="space-y-3 text-sm text-zinc-700">
              <li className="flex flex-wrap items-start gap-1">
                <strong className="text-zinc-900">Frequency of Off-Targets:</strong>
                <span>
                  The 2026 data indicates a reduction in off-target frequency by 15.7%
                  when using modified sgRNA structures
                </span>
                <CitationBadge id="1" page="42" />
                <span>.</span>
              </li>
              <li className="flex flex-wrap items-start gap-1">
                <strong className="text-zinc-900">Detection Methods:</strong>
                <span>
                  New sequencing protocols (CIRCLE-seq v2) have improved detection
                  sensitivity
                </span>
                <CitationBadge id="3" page="105" />
                <span>.</span>
              </li>
              <li className="flex flex-wrap items-start gap-1">
                <strong className="text-zinc-900">Strategic Implications:</strong>
                <span>
                  For clinical applications, the consensus suggests mandatory whole-genome
                  sequencing verification post-editing.
                </span>
              </li>
            </ul>

            <p className="text-sm leading-relaxed text-zinc-700">
              The &quot;Data Analysis Flow&quot; extracted from the report suggests a multi-step
              verification process involving both in-silico prediction and in-vivo
              validation.
            </p>
          </div>

          {/* Reference Cards */}
          <div className="grid grid-cols-2 gap-3">
            <ReferenceCard
              title="Optimizing sgRNA Design"
              author="Zhang et al."
              year="2026"
              page="42"
            />
            <ReferenceCard
              title="High-Fidelity Cas9 Variants"
              author="Chen & Liu"
              year="2025"
              page="105"
            />
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-sm text-zinc-500 hover:text-zinc-700"
            >
              <ThumbsUp className="size-4" />
              Helpful
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-sm text-zinc-500 hover:text-zinc-700"
            >
              <Copy className="size-4" />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-sm text-zinc-500 hover:text-zinc-700"
            >
              <RefreshCw className="size-4" />
              Regenerate
            </Button>
          </div>
        </div>
      </div>

      {/* Follow-up User Message */}
      <div className="flex justify-end">
        <div className="max-w-[700px] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-3">
          <p className="text-sm text-zinc-900">
            Can you compare the method from Zhang et al. with the standard wild-type Cas9
            protocol?
          </p>
        </div>
      </div>

      {/* Loading AI Response */}
      <div className="flex gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white">
          <Bot className="size-4" />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <span className="size-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
            <span className="size-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
            <span className="size-2 animate-bounce rounded-full bg-zinc-400" />
          </div>
          <span className="text-sm text-zinc-500">
            Analyzing 2 methods across 30+ papers...
          </span>
        </div>
      </div>
    </div>
  )
}

function CitationBadge({ id, page }: Citation) {
  return (
    <Badge
      variant="secondary"
      className="ml-1 cursor-pointer bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-700 hover:bg-sky-200"
    >
      [{id}, p.{page}]
    </Badge>
  )
}

function ReferenceCard({ title, author, year, page }: Reference) {
  return (
    <Card className="flex cursor-pointer items-start gap-3 border-zinc-200 p-3 transition-colors hover:bg-zinc-50">
      <div className="flex size-9 shrink-0 items-center justify-center rounded bg-zinc-100">
        <FileText className="size-4 text-zinc-500" />
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-zinc-900">{title}</span>
        <span className="text-xs text-zinc-500">
          {author}, {year} • Page {page}
        </span>
      </div>
    </Card>
  )
}
