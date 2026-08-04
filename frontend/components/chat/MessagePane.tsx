import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import MarkdownRenderer from "@/components/markdown-renderer";
import { Bot, LogIn, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Message, SessionRunState } from "@/lib/chat-state";
import { RunStatus } from "@/components/chat/RunStatus";
import type { RefObject } from "react";
import { useLanguage } from "@/lib/i18n";

interface MessagePaneProps {
  messages: Message[];
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
      <div id="chat-export-content" className="max-w-3xl mx-auto w-full px-4 pt-10 pb-32">
        {authStatus === "unauthenticated" ? (
          <div className="h-[60vh] flex flex-col items-center justify-center space-y-4 text-center">
            <div className="w-12 h-12 rounded-full border border-zinc-200 flex items-center justify-center shadow-sm bg-white">
              <Bot size={24} />
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
              <Bot size={24} />
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
                        {message.role === "user" ? <User size={16} /> : <Bot size={16} className="text-zinc-100" />}
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
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
