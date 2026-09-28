import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import MarkdownRenderer from "@/components/markdown-renderer";
import { LogIn, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Message, SessionRunState, ToolTimelineEntry } from "@/lib/chat-state";
import { RunStatus } from "@/components/chat/RunStatus";
import type { RefObject } from "react";
import { useLanguage } from "@/lib/i18n";

function ProductLogo({ size = "h-6 w-6" }: { size?: string }) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/icon.png" alt="Infinity Agents" className={`${size} rounded-full object-cover`} />
    );
}

interface MessagePaneProps {
  messages: Message[];
  toolTimeline: ToolTimelineEntry[];
  legacyTextOnly: boolean;
  sessionId: string | null;
  isLoading: boolean;
  runState: SessionRunState;
  statusText: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  authStatus: "checking" | "authenticated" | "unauthenticated";
  onLogin: () => void;
}

export function MessagePane({
  messages,
  toolTimeline,
  legacyTextOnly,
  sessionId,
  isLoading,
  runState,
  statusText,
  scrollRef,
  authStatus,
  onLogin,
}: MessagePaneProps) {
  const { t } = useLanguage();
  return (
    <ScrollArea className="flex-1 overflow-y-auto" ref={scrollRef}>
      <div className="max-w-3xl mx-auto w-full px-4 pt-10 pb-32">
        {authStatus === "unauthenticated" ? (
          <div className="h-[60vh] flex flex-col items-center justify-center space-y-4 text-center">
            <div className="w-12 h-12 rounded-full border border-zinc-200 flex items-center justify-center shadow-sm bg-white">
              <ProductLogo size="h-8 w-8" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-medium tracking-tight">{t("auth.signInTitle")}</h2>
              <p className="text-sm text-zinc-500 max-w-md">{t("auth.signInDescription")}</p>
            </div>
            <Button onClick={onLogin} className="gap-2 rounded-xl">
              <LogIn size={16} />
              {t("auth.signIn")}
            </Button>
          </div>
        ) : messages.length === 0 ? (
          <div className="h-[60vh] flex flex-col items-center justify-center space-y-4">
            <div className="w-12 h-12 rounded-full border border-zinc-200 flex items-center justify-center shadow-sm">
              <ProductLogo size="h-8 w-8" />
            </div>
            <h2 className="text-2xl font-medium tracking-tight">{t("home.emptyTitle")}</h2>
          </div>
        ) : (
          <div className="space-y-8">
            {messages.map((message, index) => {
              const isLast = index === messages.length - 1;
              return (
                <div key={index} className={`flex gap-4 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`flex w-full max-w-3xl gap-4 ${message.role === "user" ? "flex-row-reverse" : ""}`}>
                    <Avatar
                      className={`h-8 w-8 shrink-0 border ${
                        message.role === "user" ? "border-zinc-300" : "border-zinc-200 bg-zinc-900 text-white"
                      }`}
                    >
                      <AvatarFallback className="bg-transparent">
                        {message.role === "user" ? <User size={16} /> : <ProductLogo />}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col gap-1.5 grow">
                      <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">
                        {message.role === "user" ? t("role.you") : t("role.assistant")}
                      </span>
                      <div className={`text-[15px] leading-7 ${message.role === "user" ? "text-zinc-700 whitespace-pre-wrap" : "text-zinc-900"}`}>
                        {message.role === "assistant" ? (
                          isLoading && isLast ? (
                            <div className="whitespace-pre-wrap">{message.content}</div>
                          ) : (
                            <MarkdownRenderer content={message.content} sessionId={sessionId} />
                          )
                        ) : (
                          message.content
                        )}
                        {isLoading && isLast && <RunStatus isLoading={isLoading} statusText={statusText} runState={runState} />}
                        {runState.terminal === "success" && isLast && runState.tokenInfo && process.env.NODE_ENV !== "production" && (
                          <div className="text-xs text-zinc-400 mt-1">
                            Done · Tokens: prompt {runState.tokenInfo.prompt} · resp {runState.tokenInfo.response} · total{" "}
                            {runState.tokenInfo.total}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {legacyTextOnly && (
              <div data-testid="legacy-history-label" className="text-center text-[11px] text-zinc-400">
                Legacy text-only history
              </div>
            )}
            {toolTimeline.length > 0 && (
              <section data-testid="tool-timeline" aria-label="Tool timeline" className="rounded-2xl border border-zinc-200 bg-white/70 p-3 space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">Tool activity</div>
                {toolTimeline.map((entry) => (
                  <details key={entry.toolCallId} data-testid={`tool-trace-${entry.toolCallId}`} className="rounded-xl border border-zinc-200 bg-zinc-50/80 px-3 py-2">
                    <summary className="cursor-pointer list-none text-sm text-zinc-700 flex items-center justify-between gap-3">
                      <span className="font-medium">{entry.toolName}</span>
                      <span className={`text-xs ${entry.status === "failed" ? "text-red-600" : entry.status === "succeeded" ? "text-emerald-600" : "text-amber-600"}`}>
                        {entry.status}
                      </span>
                    </summary>
                    <div className="mt-2 space-y-1 text-xs text-zinc-500 break-words">
                      <div>Correlation: {entry.correlationId}</div>
                      {entry.argumentsSummary && <div>Arguments: {entry.argumentsSummary}</div>}
                      {entry.summary && <div>Result: {entry.summary}</div>}
                    </div>
                  </details>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
