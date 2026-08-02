"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Bot, LogIn, LogOut, Plus, SendHorizontal, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import MarkdownRenderer from "@/components/markdown-renderer";
import type { Message } from "@/lib/chat-state";

export function OidcChat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch("/v1/models", { credentials: "same-origin" }).then((response) => setSignedIn(response.ok)).catch(() => setSignedIn(false));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading, notice]);

  const startNewChat = () => { setMessages([]); setInput(""); setNotice(null); };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = input.trim();
    if (!content || isLoading) return;
    setInput(""); setNotice(null);
    if (!signedIn) { setNotice("请先登录，然后继续对话。"); return; }
    const next = [...messages, { role: "user" as const, content }, { role: "assistant" as const, content: "" }];
    setMessages(next); setIsLoading(true);
    try {
      const response = await fetch("/v1/chat/completions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: next.filter((item) => item.role === "user" || item.content), stream: true }) });
      if (response.status === 401) { setMessages(messages); setSignedIn(false); setNotice("登录状态已失效，请重新登录。"); return; }
      if (!response.ok || !response.body) throw new Error("暂时无法连接模型服务。");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
            if (typeof delta === "string") setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, content: item.content + delta } : item));
          } catch {
            // Ignore a malformed provider frame while continuing the response.
          }
        }
        if (done) break;
      }
    } catch (error) {
      setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, content: item.content || "抱歉，当前无法完成请求。" } : item));
      setNotice(error instanceof Error ? error.message : "请求失败，请稍后重试。");
    } finally { setIsLoading(false); }
  };

  return <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
    <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl print:hidden">
      <div className="px-2 pt-2 pb-4"><div className="text-sm font-semibold tracking-tight">Infinity Agents</div><div className="mt-1 text-xs text-zinc-400">Your focused AI workspace</div></div>
      <Button variant="outline" className="justify-start gap-2 bg-white/90 border-[var(--hairline)] shadow-sm hover:bg-white rounded-xl" onClick={startNewChat}><Plus size={16} />New Chat</Button>
      <div className="mt-5 px-2 text-[11px] uppercase tracking-[0.22em] text-zinc-400">Workspace</div>
      <div className="mt-2 rounded-xl bg-zinc-900 px-3 py-2 text-sm text-zinc-50 shadow-sm">Infinity Chat</div>
      <div className="flex-1" /><div className="p-2 text-xs text-zinc-400 text-center">ZhangYvJing account</div>
    </aside>
    <main className="flex-1 flex flex-col relative min-w-0">
      <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between sticky top-0 bg-[var(--surface-1)] backdrop-blur-xl z-10 print:hidden">
        <div className="text-sm font-semibold tracking-tight text-zinc-700">Infinity Chat</div>
        {signedIn ? <a className="inline-flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-900" href="/logout"><LogOut size={16} />退出</a> : <a className="inline-flex items-center gap-2 text-sm font-medium text-zinc-700 hover:text-zinc-950" href="/login"><LogIn size={16} />登录</a>}
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-4 pt-10 pb-36">
          {messages.length === 0 ? <div className="h-[60vh] flex flex-col items-center justify-center space-y-4"><div className="w-12 h-12 rounded-full border border-zinc-200 flex items-center justify-center shadow-sm"><Bot size={24} /></div><h1 className="text-2xl font-medium tracking-tight">How can I help you today?</h1><p className="text-sm text-zinc-400">{signedIn ? "开始一段新对话。" : "输入消息后会提示你登录。"}</p></div> : <div className="space-y-8">{messages.map((message, index) => <div key={index} className={`flex gap-4 ${message.role === "user" ? "justify-end" : "justify-start"}`}><div className={`flex w-full max-w-3xl gap-4 ${message.role === "user" ? "flex-row-reverse" : ""}`}><div className={`h-8 w-8 shrink-0 rounded-full border flex items-center justify-center ${message.role === "user" ? "border-zinc-300" : "border-zinc-200 bg-zinc-900 text-white"}`}>{message.role === "user" ? <User size={16} /> : <Bot size={16} />}</div><div className="flex flex-col gap-1.5 grow"><span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">{message.role === "user" ? "You" : "Assistant"}</span><div className="text-[15px] leading-7 text-zinc-900">{message.role === "assistant" ? (isLoading && index === messages.length - 1 ? <div className="whitespace-pre-wrap">{message.content || "正在思考…"}</div> : <MarkdownRenderer content={message.content} sessionId={null} />) : <div className="whitespace-pre-wrap">{message.content}</div>}</div></div></div></div>)}</div>}
        </div>
      </div>
      <div className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-white via-white/95 to-transparent pt-10 print:hidden"><div className="max-w-3xl mx-auto px-4 pb-8">{notice && <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice} {!signedIn && <a className="ml-1 font-semibold underline" href="/login">去登录</a>}</div>}<form onSubmit={submit} className="relative"><textarea rows={1} value={input} onChange={(event) => { setInput(event.target.value); event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 220)}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder="Message Infinity..." className="w-full bg-white/95 border border-[var(--hairline-strong)] rounded-2xl py-4 pl-4 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] resize-none shadow-sm" /><Button type="submit" size="icon" disabled={!input.trim() || isLoading} className="absolute right-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-xl !bg-zinc-700 hover:!bg-zinc-900 disabled:!bg-zinc-200"><SendHorizontal className="h-4 w-4 text-white" /></Button></form><p className="text-[11px] text-center text-zinc-400 mt-3">AI can make mistakes. Check important info.</p></div></div>
    </main>
  </div>;
}
