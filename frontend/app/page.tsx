"use client";

import React, { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SendHorizontal, User, Bot, Plus } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      const scrollContainer = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
      }
    }
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg: Message = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMsg] }),
      });

      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        
        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          const otherMsgs = prev.slice(0, -1);
          return [...otherMsgs, { ...lastMsg, content: lastMsg.content + chunk }];
        });
      }
    } catch (error) {
      console.error("Failed to fetch:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-white text-zinc-900 font-sans">
      {/* 侧边栏 - 极简点缀 */}
      <div className="w-[260px] bg-zinc-50 border-r border-zinc-200 hidden md:flex flex-col p-3">
        <Button variant="outline" className="justify-start gap-2 bg-white border-zinc-200 shadow-sm hover:bg-zinc-100">
          <Plus size={16} />
          New Chat
        </Button>
        <div className="flex-1" />
        <div className="p-2 text-xs text-zinc-400 text-center tracking-tighter">
          v1.0.0 @ 2026
        </div>
      </div>

      {/* 主对话区 */}
      <main className="flex-1 flex flex-col relative">
        {/* Top Bar */}
        <header className="h-14 border-b border-zinc-100 flex items-center px-4 justify-between sticky top-0 bg-white/80 backdrop-blur-md z-10">
          <div className="text-sm font-semibold tracking-tight text-zinc-500">Paper Agent</div>
          <Button variant="ghost" size="sm" className="text-zinc-500">Share</Button>
        </header>

        <ScrollArea className="flex-1 overflow-y-auto" ref={scrollRef}>
          <div className="max-w-3xl mx-auto w-full px-4 pt-10 pb-32">
            {messages.length === 0 ? (
              // 初始欢迎状态
              <div className="h-[60vh] flex flex-col items-center justify-center space-y-4">
                <div className="w-12 h-12 rounded-full border border-zinc-200 flex items-center justify-center shadow-sm">
                  <Bot size={24} />
                </div>
                <h2 className="text-2xl font-medium tracking-tight">How can I help you today?</h2>
              </div>
            ) : (
              // 消息列表
              <div className="space-y-8">
                {messages.map((m, i) => (
                  <div key={i} className={`flex gap-4 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`flex w-full max-w-3xl gap-4 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                      <Avatar className={`h-8 w-8 shrink-0 border ${m.role === 'user' ? 'border-zinc-300' : 'border-zinc-200 bg-zinc-900 text-white'}`}>
                        <AvatarFallback className="bg-transparent">
                          {m.role === "user" ? <User size={16} /> : <Bot size={16} className="text-zinc-100" />}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col gap-1.5 grow">
                        <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">
                          {m.role === "user" ? "You" : "Assistant"}
                        </span>
                        <div className={`text-[15px] leading-7 whitespace-pre-wrap ${m.role === "user" ? "text-zinc-700" : "text-zinc-900"}`}>
                          {m.content}
                          {isLoading && i === messages.length - 1 && !m.content && (
                            <span className="inline-block w-1.5 h-4 bg-zinc-900 animate-pulse ml-1 align-middle" />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* 固定底部的输入框 */}
        <div className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-white via-white to-transparent pt-10">
          <div className="max-w-3xl mx-auto px-4 pb-8">
            <form onSubmit={handleSubmit} className="relative group">
              <div className="relative flex items-center">
                <textarea
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  placeholder="Message Infinity..."
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl py-4 pl-4 pr-12 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-300 transition-all resize-none shadow-sm"
                />
                <Button 
                  type="submit" 
                  size="icon" 
                  disabled={isLoading || !input.trim()} 
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-xl !bg-zinc-700 hover:!bg-black disabled:!bg-zinc-200 transition-all duration-300 hover:scale-110 active:scale-95"
                >
                  <SendHorizontal className="h-4 w-4 text-white" />
                </Button>
              </div>
              <p className="text-[11px] text-center text-zinc-400 mt-3">
                AI can make mistakes. Check important info.
              </p>  
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}